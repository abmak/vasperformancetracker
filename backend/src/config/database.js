const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../env');

/**
 * PostgreSQL Database pool with query compatibility layer for mysql2 callers.
 *
 * Primary  → DB_HOST / DB_PORT            (PostgreSQL instance)
 * Standby  → DB_STANDBY_HOST / DB_STANDBY_PORT (replica instance if configured)
 */

const PRIMARY_HOST = process.env.DB_HOST || '127.0.0.1';
const PRIMARY_PORT = Number(process.env.DB_PORT || 5432);
const STANDBY_HOST = process.env.DB_STANDBY_HOST || '127.0.0.1';
const STANDBY_PORT = Number(process.env.DB_STANDBY_PORT || 0);
const STANDBY_ENABLED = process.env.DB_STANDBY_ENABLED !== 'false' && STANDBY_PORT > 0;
const FORCE_TARGET = process.env.DB_FORCE_TARGET === 'standby' || process.env.DB_FORCE_TARGET === 'primary'
  ? process.env.DB_FORCE_TARGET
  : null;
const MARKER_FILE = process.env.DB_FAILOVER_MARKER
  || path.join(os.homedir(), 'pg-standby', 'FAILOVER');

// A promoted standby is a one-way door: it accepted writes the old primary
// never saw, so the two have diverged. This marker keeps that state across a
// restart, so the app can never quietly shift traffic *back* to a stale primary
// and lose those writes.
const PROMOTED_FILE = process.env.DB_PROMOTED_MARKER
  || path.join(path.dirname(MARKER_FILE), 'PROMOTED');

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08006', '08001'
]);

function makePool(host, port) {
  return new Pool({
    host,
    port,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vas_revenue_tracking',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

const pools = { primary: makePool(PRIMARY_HOST, PRIMARY_PORT) };
if (STANDBY_ENABLED) pools.standby = makePool(STANDBY_HOST, STANDBY_PORT);

// A pg Pool re-emits a failure of an *idle* client as an 'error' event on the
// pool itself, and an unhandled 'error' event tears the whole process down.
// Losing a backend — a server restart, a dropped connection, an operator
// stopping the container — must degrade into a log line, never a crash.
for (const name of Object.keys(pools)) {
  pools[name].on('error', (err) => {
    console.error('[db-pool:' + name + '] idle client error: ' + err.message);
  });
}

let activeName = FORCE_TARGET && pools[FORCE_TARGET] ? FORCE_TARGET : 'primary';
if (!FORCE_TARGET && STANDBY_ENABLED && activeName === 'primary') {
  try {
    fs.accessSync(MARKER_FILE);
    activeName = 'standby';
    console.warn('[db-failover] failover marker present — starting on STANDBY');
  } catch (e) { /* normal start on primary */ }
}
let active = pools[activeName];
let standbyPromoted = fs.existsSync(PROMOTED_FILE);

function isConnectionError(err) {
  return Boolean(err && (CONNECTION_ERROR_CODES.has(err.code) || err.message?.includes('Connection terminated')));
}

/**
 * The failover marker file is the app's memory of "we are not on the primary":
 * it is what makes the next restart come back up on the standby instead of
 * flapping onto a dead primary.
 */
function writeMarker(file, contents) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  } catch (e) {
    console.warn('[db-failover] could not write ' + file + ': ' + e.message);
  }
}

function removeMarker(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) { /* already gone */ }
}

/** Raw query against a named pool (probes/monitoring must not trigger failover). */
async function runOnPool(pool, sql, params) {
  const res = await pool.query(transpileSQL(sql), params || []);
  return res.rows || [];
}

/**
 * Promote the standby so it can accept writes.
 *
 * MySQL replicas are writable, so the original failover could just point the
 * pool at the standby. A PostgreSQL streaming replica rejects writes outright
 * ("cannot execute INSERT in a read-only transaction"), so promotion is a
 * required step, not an optimisation. pg_promote() is executed on the standby
 * itself and returns once it has left recovery (or timed out).
 */
let promotionInFlight = null;

async function promoteStandby(reason) {
  if (!pools.standby) return false;
  if (standbyPromoted) return true;
  // Failover fires from several in-flight queries at once; without this, each
  // one would try to promote the same replica concurrently.
  if (promotionInFlight) return promotionInFlight;

  promotionInFlight = (async () => {
    try {
      const before = await runOnPool(pools.standby, 'SELECT pg_is_in_recovery() AS in_recovery');
      if (!before.length) return false;
      if (before[0].in_recovery === true) {
        console.warn('[db-failover] standby is still a read-only replica — promoting it (' + reason + ')');
        await runOnPool(pools.standby, 'SELECT pg_promote(true, 60) AS promoted');
      }
      const after = await runOnPool(pools.standby, 'SELECT pg_is_in_recovery() AS in_recovery');
      if (!after.length || after[0].in_recovery === true) {
        console.error('[db-failover] standby promotion did not complete — refusing to switch');
        return false;
      }
      standbyPromoted = true;
      writeMarker(PROMOTED_FILE, new Date().toISOString() + '\n' + reason + '\n');
      console.warn('[db-failover] standby promoted — it now owns the data');
      return true;
    } catch (e) {
      console.error('[db-failover] standby promotion failed: ' + e.message);
      return false;
    } finally {
      promotionInFlight = null;
    }
  })();

  return promotionInFlight;
}

function setTarget(name, reason) {
  if (name === activeName || !pools[name]) return false;
  activeName = name;
  active = pools[name];
  console.warn('[db-failover] switched to ' + name.toUpperCase() + ' (' + reason + ')');
  if (name === 'standby') {
    writeMarker(MARKER_FILE, new Date().toISOString() + '\n' + reason + '\n');
  } else {
    removeMarker(MARKER_FILE);
  }
  try {
    const { recordFailoverEvent } = require('./dbFailoverEvents');
    if (name === 'standby') {
      recordFailoverEvent(
        'FAILOVER_START',
        standbyPromoted
          ? 'Primary database unreachable — standby promoted and now serving the app.'
          : 'Primary database unreachable — app switched to standby.',
        { reason }
      );
    } else {
      recordFailoverEvent('FAILOVER_END', 'Primary database healthy — app switched back.', { reason });
    }
  } catch (e) {}
  return true;
}

async function failoverAndRetry(runOnActive, err, label, visited) {
  if (!isConnectionError(err)) throw err;
  const otherName = activeName === 'primary' ? 'standby' : 'primary';
  if (!visited || visited.has(otherName) || !pools[otherName]) {
    throw err;
  }
  const reason = err.code + (label ? ' (' + label + ')' : '');

  if (otherName === 'standby') {
    // Never hand writes to a replica that is still read-only.
    const promoted = await promoteStandby(reason);
    if (!promoted) {
      try {
        const { recordFailoverEvent } = require('./dbFailoverEvents');
        recordFailoverEvent(
          'INFO',
          'Primary unreachable and the standby could not be promoted — staying on the primary and returning errors rather than writing to a read-only replica.',
          { reason }
        );
      } catch (e) {}
      throw err;
    }
  } else if (standbyPromoted && process.env.DB_FAILBACK_ALLOW_AFTER_PROMOTION !== 'true') {
    // The primary missed every write made after the promotion, so switching
    // back would silently roll the data back. An operator rebuilds it first.
    try {
      const { recordFailoverEvent } = require('./dbFailoverEvents');
      recordFailoverEvent(
        'INFO',
        'Primary is reachable again, but the promoted standby owns newer data — failback is blocked until the primary is rebuilt (see the database runbook).',
        { reason }
      );
    } catch (e) {}
    throw err;
  }

  if (!setTarget(otherName, reason)) throw err;
  visited.add(otherName);
  return runOnActive();
}

/**
 * Transpiles MySQL-style SQL to PostgreSQL syntax:
 * 1. Converts ? parameter placeholders to $1, $2, ...
 * 2. Converts backticks `table` to "table"
 * 3. Appends RETURNING id for INSERT queries if not already present
 */
function transpileSQL(sql) {
  if (typeof sql !== 'string') return sql;

  let paramIndex = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let out = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prevChar = i > 0 ? sql[i - 1] : '';

    if (char === "'" && prevChar !== '\\') {
      if (!inDoubleQuote && !inBacktick) inSingleQuote = !inSingleQuote;
      out += char;
    } else if (char === '"' && prevChar !== '\\') {
      if (!inSingleQuote && !inBacktick) inDoubleQuote = !inDoubleQuote;
      out += char;
    } else if (char === '`' && prevChar !== '\\') {
      inBacktick = !inBacktick;
      out += '"';
    } else if (char === '?' && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      out += `$${paramIndex++}`;
    } else {
      out += char;
    }
  }

  // Translate common MySQL constructs to PostgreSQL
  out = out
    .replace(/\bINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bBIGINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bAUTO_INCREMENT\b/gi, '')
    .replace(/\bIFNULL\(/gi, 'COALESCE(')
    .replace(/\bENUM\([^)]+\)/gi, 'VARCHAR(50)')
    .replace(/\b(LONGTEXT|MEDIUMTEXT|TINYTEXT)\b/gi, 'TEXT')
    .replace(/\)\s*ENGINE\s*=\s*\w+[^;]*/gi, ')')
    .replace(/\bDEFAULT\s+CHARSET\s*=\s*\w+/gi, '')
    .replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/gi, '')
    .replace(/\bUNIQUE\s+KEY\s+\w+\s*/gi, 'UNIQUE ')
    .replace(/,\s*INDEX\s+\w+\s*\([^)]+\)/gi, '')
    .replace(/\bDATABASE\(\)/gi, 'current_database()')
    .replace(/\bCURDATE\(\)/gi, 'CURRENT_DATE')
    .replace(/\bAS\s+UNSIGNED\b/gi, 'AS INTEGER');

  // Translate GROUP_CONCAT(...) to PostgreSQL STRING_AGG(...)
  out = out.replace(/GROUP_CONCAT\s*\(\s*(DISTINCT\s+)?([\s\S]*?)\)/gi, (match, distinct, inner) => {
    distinct = distinct ? 'DISTINCT ' : '';
    let separator = "','";
    let orderBy = '';
    let expr = inner.trim();

    const sepMatch = expr.match(/\s+SEPARATOR\s+('[^']*')/i);
    if (sepMatch) {
      separator = sepMatch[1];
      expr = expr.replace(/\s+SEPARATOR\s+'[^']*'/i, '').trim();
    }

    const orderMatch = expr.match(/\s+ORDER\s+BY\s+([\s\S]+)$/i);
    if (orderMatch) {
      orderBy = ' ORDER BY ' + orderMatch[1].trim();
      expr = expr.replace(/\s+ORDER\s+BY\s+[\s\S]+$/i, '').trim();
    }

    expr = expr.replace(/^DISTINCT\s+/i, '').trim();
    return `STRING_AGG(${distinct}${expr}, ${separator}${orderBy})`;
  });

  let isInsertIgnore = false;
  if (/\bINSERT\s+IGNORE\s+INTO\b/i.test(out)) {
    isInsertIgnore = true;
    out = out.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  }

  const trimmed = out.trim();
  const isInsert = /^INSERT\s+INTO/i.test(trimmed);
  const hasReturning = /\bRETURNING\b/i.test(trimmed);
  const hasOnConflict = /\bON\s+CONFLICT\b/i.test(trimmed);

  if (isInsertIgnore && !hasOnConflict) {
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING;');
  } else if (isInsert && !hasReturning && !hasOnConflict) {
    out = out.replace(/;?\s*$/, ' RETURNING *;');
  }

  return out;
}

/**
 * Formats pg result into [rows, result] matching mysql2 interface
 */
function formatPgResult(pgRes) {
  const isCommand = pgRes.command;
  const rows = pgRes.rows ? [...pgRes.rows] : [];
  const rowCount = pgRes.rowCount || 0;

  let insertId = 0;
  if (rows.length > 0) {
    if (rows[0].id !== undefined) insertId = rows[0].id;
    else if (rows[0].ID !== undefined) insertId = rows[0].ID;
  }

  // Attach metadata onto rows array/object for mysql2 caller compatibility
  rows.insertId = insertId;
  rows.affectedRows = rowCount;
  rows.rowCount = rowCount;

  const resultMeta = {
    insertId,
    affectedRows: rowCount,
    rowCount,
    command: isCommand,
  };

  if (isCommand === 'INSERT') {
    const insertResult = {
      insertId,
      affectedRows: rowCount,
      rows,
      ...(rows[0] || {}),
    };
    return [insertResult, pgRes.fields || []];
  }

  if (isCommand === 'UPDATE' || isCommand === 'DELETE') {
    const mutationResult = {
      affectedRows: rowCount,
      rowCount,
      insertId: 0,
      rows,
    };
    return [mutationResult, pgRes.fields || []];
  }

  // SELECT or other commands
  return [rows, pgRes.fields || []];
}

async function executeQueryOnPool(pool, sql, params) {
  const transformedSql = transpileSQL(sql);
  const res = await pool.query(transformedSql, params || []);
  return formatPgResult(res);
}

function runWithRetryAsync(runOnActive, visited) {
  if (!visited) visited = new Set([activeName]);
  return runOnActive(active).catch((err) =>
    failoverAndRetry(() => runWithRetryAsync(runOnActive, visited), err, undefined, visited)
  );
}

class PgConnectionWrapper {
  constructor(client) {
    this.client = client;
  }

  async query(sql, params) {
    const transformedSql = transpileSQL(sql);
    const res = await this.client.query(transformedSql, params || []);
    return formatPgResult(res);
  }

  async execute(sql, params) {
    return this.query(sql, params);
  }

  async beginTransaction() {
    await this.client.query('BEGIN');
  }

  async commit() {
    await this.client.query('COMMIT');
  }

  async rollback() {
    await this.client.query('ROLLBACK');
  }

  release() {
    this.client.release();
  }
}

async function failoverGetConnection() {
  const client = await active.connect();
  return new PgConnectionWrapper(client);
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === '__dbTarget') return activeName;
    if (prop === '__engine') return 'postgres';
    if (prop === '__failoverEnabled') return STANDBY_ENABLED;
    if (prop === '__standbyPromoted') return standbyPromoted;
    if (prop === '__failbackAllowed') {
      return !standbyPromoted || process.env.DB_FAILBACK_ALLOW_AFTER_PROMOTION === 'true';
    }
    if (prop === '__markers') return { failover: MARKER_FILE, promoted: PROMOTED_FILE };
    if (prop === '__dbTargets') {
      return {
        primary: { host: PRIMARY_HOST, port: PRIMARY_PORT },
        standby: STANDBY_ENABLED ? { host: STANDBY_HOST, port: STANDBY_PORT } : null,
      };
    }
    // Monitoring (System Health) probes a specific instance without ever
    // moving the app's active target — including the read-only standby.
    if (prop === '__queryOnTarget') {
      return (name, sql, params) => {
        const pool = pools[name];
        if (!pool) return Promise.reject(new Error('unknown db target: ' + name));
        return runOnPool(pool, sql, params);
      };
    }
    if (prop === '__promoteStandby') return promoteStandby;
    if (prop === 'query' || prop === 'execute') {
      return (sql, params) => runWithRetryAsync((pool) => executeQueryOnPool(pool, sql, params));
    }
    if (prop === 'getConnection') return failoverGetConnection;
    const value = active[prop];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});
