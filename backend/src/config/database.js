const mysql = require('mysql2/promise');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../env');

/**
 * Database pool with automatic standby failover.
 *
 * Primary  → DB_HOST / DB_PORT            (the live MySQL on this VPS)
 * Standby  → DB_STANDBY_HOST / DB_STANDBY_PORT   (replica instance, port 3307)
 *
 * Behaviour:
 *  - Every query runs against the active target. If it fails with a
 *    connection-level error, we instantly switch to the other target and
 *    retry the same query once. SQL-level errors (syntax, duplicates, …)
 *    never trigger a switch.
 *  - While serving from the standby, a marker file is kept on disk so the
 *    state survives process restarts, and the sync daemon
 *    (scripts/db/standby/sync-standby.js) can see a failover happened.
 *  - When the daemon has restored the primary from the standby it deletes
 *    the marker file; we notice that within 30s and switch back.
 *  - DB_FORCE_TARGET=standby|primary pins the target at startup (for
 *    testing or maintenance).
 *
 * Without DB_STANDBY_* variables this module behaves exactly like a plain
 * mysql2 pool — local development is unaffected.
 */

const PRIMARY_HOST = process.env.DB_HOST || '127.0.0.1';
const PRIMARY_PORT = Number(process.env.DB_PORT || 3306);
const STANDBY_HOST = process.env.DB_STANDBY_HOST || '127.0.0.1';
const STANDBY_PORT = Number(process.env.DB_STANDBY_PORT || 0);
const STANDBY_ENABLED = process.env.DB_STANDBY_ENABLED !== 'false' && STANDBY_PORT > 0;
const FORCE_TARGET = process.env.DB_FORCE_TARGET === 'standby' || process.env.DB_FORCE_TARGET === 'primary'
  ? process.env.DB_FORCE_TARGET
  : null;
const MARKER_FILE = process.env.DB_FAILOVER_MARKER
  || path.join(os.homedir(), 'mysql-standby', 'FAILOVER');

// Errors that mean "we cannot reach/talk to this server" — safe to fail over.
// SQL-level errors (syntax, constraints, …) are intentionally excluded.
const CONNECTION_ERROR_CODES = new Set([
  // Node/system errors
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EAI_AGAIN',
  // mysql2 protocol errors
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'PROTOCOL_PACKETS_OUT_OF_ORDER',
  // MySQL server errors
  'ER_SERVER_SHUTDOWN', 'ER_HOST_NOT_FOUND', 'ER_UNKNOWN_HOST',
  'ER_TOO_MANY_CONNECTIONS', 'ER_CON_COUNT_ERROR', 'ER_BAD_DB_ERROR',
  'ER_ACCESS_DENIED_ERROR', 'ER_CLIENT_INTERACTION_TIMEOUT',
]);

function makePool(host, port) {
  return mysql.createPool({
    host,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    maxIdle: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
    connectTimeout: 10000,
  });
}

const pools = { primary: makePool(PRIMARY_HOST, PRIMARY_PORT) };
if (STANDBY_ENABLED) pools.standby = makePool(STANDBY_HOST, STANDBY_PORT);

let activeName = FORCE_TARGET && pools[FORCE_TARGET] ? FORCE_TARGET : 'primary';
// Survive restarts in the middle of an incident: if the marker file is there,
// the previous process had failed over to the standby.
if (!FORCE_TARGET && STANDBY_ENABLED && activeName === 'primary') {
  try {
    fs.accessSync(MARKER_FILE);
    activeName = 'standby';
    console.warn('[db-failover] failover marker present — starting on STANDBY');
  } catch (e) { /* no marker → normal start on primary */ }
}
let active = pools[activeName];

function writeMarker() {
  if (!STANDBY_ENABLED) return;
  try {
    if (activeName === 'standby') {
      fs.writeFileSync(MARKER_FILE, new Date().toISOString() + '\n');
    } else {
      fs.unlinkSync(MARKER_FILE);
    }
  } catch (e) {
    console.warn('[db-failover] could not update marker file:', e.message);
  }
}

function isConnectionError(err) {
  return Boolean(err && CONNECTION_ERROR_CODES.has(err.code));
}

function setTarget(name, reason) {
  if (name === activeName || !pools[name]) return false;
  activeName = name;
  active = pools[name];
  console.warn('[db-failover] switched to ' + name.toUpperCase() + ' (' + reason + ')');
  writeMarker();
  return true;
}

function failoverAndRetry(runOnActive, err, label) {
  if (!isConnectionError(err)) throw err;
  const otherName = activeName === 'primary' ? 'standby' : 'primary';
  if (!setTarget(otherName, err.code + (label ? ' (' + label + ')' : ''))) throw err;
  return runOnActive();
}

// query/execute: transparent passthrough with one retry on the other target.
function runWithRetryAsync(runOnActive) {
  return runOnActive(active).catch((err) =>
    failoverAndRetry(() => runWithRetryAsync(runOnActive), err)
  );
}

async function failoverGetConnection() {
  try {
    return await active.getConnection();
  } catch (err) {
    return failoverAndRetry(() => active.getConnection(), err, 'getConnection');
  }
}

// Watch for the marker file disappearing — the sync daemon removes it after
// it has re-synced the recovered primary, which is our cue to fail back.
if (STANDBY_ENABLED) {
  const failbackTimer = setInterval(() => {
    if (activeName !== 'standby') return;
    try {
      fs.accessSync(MARKER_FILE);
    } catch (e) {
      setTarget('primary', 'failover marker cleared — primary recovered');
    }
  }, 30000);
  failbackTimer.unref();
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    // Introspection hooks used by the health endpoint / ops scripts.
    if (prop === '__dbTarget') return activeName;
    if (prop === '__failoverEnabled') return STANDBY_ENABLED;
    if (prop === '__dbTargets') {
      return {
        primary: { host: PRIMARY_HOST, port: PRIMARY_PORT },
        standby: STANDBY_ENABLED ? { host: STANDBY_HOST, port: STANDBY_PORT } : null,
      };
    }
    if (prop === 'query' || prop === 'execute') {
      return (...args) => runWithRetryAsync((pool) => pool[prop].apply(pool, args));
    }
    if (prop === 'getConnection') return failoverGetConnection;
    const value = active[prop];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});
