#!/usr/bin/env node
/**
 * Standby database sync daemon — installed on the VPS at
 * ~/mysql-standby/sync-standby.js and run under pm2 as "db-sync".
 *
 * Every DB_SYNC_INTERVAL_MS (default 2 min), when the app is running on the
 * PRIMARY (no failover marker):
 *   - dumps the primary with mysqldump --single-transaction
 *   - restores that dump into the standby instance (port DB_STANDBY_PORT)
 *   - keeps an hourly gzipped snapshot (last 6) in ~/backups/standby-snapshots
 *
 * When the failover marker exists (the app switched to the standby because
 * the primary crashed), it stops forward-syncing (which would clobber newer
 * standby data with stale primary data) and instead watches the primary:
 *   - after FAILBACK_AFTER_HEALTHY consecutive healthy primary probes it
 *     restores the primary FROM the standby (double pass to close the gap),
 *     verifies table counts match, deletes the marker — and the app
 *     automatically switches back to the primary.
 *
 * No npm dependencies: reads .env.production directly, drives the mysql
 * client tools via spawn. Passwords travel through the MYSQL_PWD env var,
 * never the command line.
 *
 * Usage:
 *   node sync-standby.js            run forever (pm2 mode)
 *   node sync-standby.js --once     run a single cycle and exit
 *   node sync-standby.js --status   print current state and exit
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const HOME = os.homedir();
const ENV_FILE = process.env.STANDBY_ENV_FILE
  || '/var/www/performancetracking/app/backend/.env.production';

function loadEnvFile(file) {
  const out = {};
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch (e) { /* missing file handled below */ }
  return out;
}

const env = loadEnvFile(ENV_FILE);
const DB_NAME = env.DB_NAME || 'vas_revenue_tracking';
const DB_USER = env.DB_USER || 'vas_user';
const DB_PASSWORD = env.DB_PASSWORD || '';
const PRIMARY = { host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306) };
const STANDBY = { host: env.DB_STANDBY_HOST || '127.0.0.1', port: Number(env.DB_STANDBY_PORT || 3307) };
const MARKER = env.DB_FAILOVER_MARKER || path.join(HOME, 'mysql-standby', 'FAILOVER');
const LOG_DIR = path.join(HOME, 'mysql-standby', 'log');
const LOG_FILE = path.join(LOG_DIR, 'sync.log');
const STATUS_FILE = process.env.DB_SYNC_STATUS_FILE || path.join(HOME, 'mysql-standby', 'status.json');
const SNAP_DIR = path.join(HOME, 'backups', 'standby-snapshots');
const INTERVAL_MS = Number(env.DB_SYNC_INTERVAL_MS || 600000);
const TIMEOUT_MS = Number(env.DB_SYNC_TIMEOUT_MS || 180000);
const FAILBACK_AFTER_HEALTHY = 2; // consecutive healthy primary probes before failback
const SNAP_INTERVAL_MS = 60 * 60 * 1000;
const SNAP_KEEP = 6;
const ONCE = process.argv.includes('--once');
const STATUS = process.argv.includes('--status');

if (!DB_PASSWORD) {
  console.error('[fatal] could not read DB_PASSWORD from ' + ENV_FILE);
  process.exit(1);
}

// ---------------------------------------------------------------- logging --
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > 512 * 1024) {
      const tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-200).join('\n');
      fs.writeFileSync(LOG_FILE, tail);
    }
  } catch (e) { /* ignore */ }
}
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLog();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ignore */ }
  console.log(line);
}

// Repeated identical messages (e.g. "primary still down") are logged at most
// once per 10 minutes instead of every cycle.
const lastMsgByKey = {};
function logOnce(key, msg) {
  const now = Date.now();
  const prev = lastMsgByKey[key];
  if (!prev || prev.msg !== msg || now - prev.t > 10 * 60 * 1000) {
    lastMsgByKey[key] = { msg, t: now };
    log(msg);
  }
}

// ------------------------------------------------------------ child procs --
function childEnv() {
  const e = Object.assign({}, process.env);
  e.MYSQL_PWD = DB_PASSWORD;
  return e;
}

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv() });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL'); reject(new Error(cmd + ' timed out')); }
    }, timeoutMs || TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cmd + ' exited ' + code + ': ' + stderr.trim().slice(0, 500)));
    });
  });
}

function runInput(cmd, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: childEnv() });
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL'); reject(new Error(cmd + ' timed out')); }
    }, timeoutMs || TIMEOUT_MS);
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code === 0) resolve({ stderr });
      else reject(new Error(cmd + ' exited ' + code + ': ' + stderr.trim().slice(0, 500)));
    });
    child.stdin.on('error', () => { /* EPIPE if server dies mid-write; close handles it */ });
    child.stdin.end(input);
  });
}

// ------------------------------------------------------------- sql helpers --
const q = (s) => '`' + String(s).replace(/`/g, '``') + '`';

function connectArgs(target) {
  // Callers must prepend '--no-defaults' themselves: ~/.my.cnf on the VPS
  // points at the primary and would otherwise supply host/user/password to
  // every spawn we make. (mysqldump only accepts --no-defaults as the very
  // first argument, so it cannot live inside this helper.)
  return ['-h', target.host, '-P', String(target.port), '-u', DB_USER];
}

async function probe(target, label) {
  try {
    await runCapture('mysql', ['--no-defaults'].concat(connectArgs(target)).concat(['-e', 'SELECT 1', DB_NAME]), 15000);
    return true;
  } catch (e) {
    logOnce('probe-' + label, label + ' probe failed: ' + String(e.message).split('\n')[0]);
    return false;
  }
}

async function dumpFrom(target) {
  const res = await runCapture('mysqldump', ['--no-defaults',
    '--single-transaction', '--routines', '--triggers', '--events',
    '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF',
    '--add-drop-table', '--default-character-set=utf8mb4',
  ].concat(connectArgs(target)).concat([DB_NAME]));
  return res.stdout;
}

async function restoreTo(target, dumpBuf) {
  const prelude = 'CREATE DATABASE IF NOT EXISTS ' + q(DB_NAME) + ';\nUSE ' + q(DB_NAME) + ';\n';
  await runInput('mysql', ['--no-defaults'].concat(connectArgs(target))
    .concat(['--default-character-set=utf8mb4']),
    Buffer.concat([Buffer.from(prelude), dumpBuf]));
}

async function tableCount(target) {
  const res = await runCapture('mysql', ['--no-defaults'].concat(connectArgs(target)).concat([
    '-N', '-e',
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='" +
    DB_NAME.replace(/'/g, "\\'") + "'",
  ]));
  return parseInt(res.stdout.toString().trim(), 10) || 0;
}

// --------------------------------------------------------------- status file
function writeStatusFile(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (e) { /* first run */ }
  const next = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(next)); } catch (e) { /* non-fatal */ }
}

// Incident feed for the admin System Health page (merged with DB events by
// the /api/system/health endpoint). Same-message pushes are deduplicated to
// one per 10 minutes so the feed never fills with repeats.
const lastPush = {};
function pushEvent(type, message) {
  const now = Date.now();
  if (lastPush[type + '|' + message] && now - lastPush[type + '|' + message] < 10 * 60 * 1000) return;
  lastPush[type + '|' + message] = now;
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (e) { /* first run */ }
  const events = Array.isArray(cur.recentEvents) ? cur.recentEvents : [];
  events.unshift({ type, message: String(message).slice(0, 300), at: new Date().toISOString() });
  cur.recentEvents = events.slice(0, 20);
  cur.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(cur)); } catch (e) { /* non-fatal */ }
}

// ---------------------------------------------------------------- snapshots --
let lastSnapshot = 0;
async function maybeSnapshot(dumpBuf) {
  const now = Date.now();
  if (now - lastSnapshot < SNAP_INTERVAL_MS) return;
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'vas-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.sql.gz';
    fs.writeFileSync(path.join(SNAP_DIR, name), zlib.gzipSync(dumpBuf, { level: 6 }));
    lastSnapshot = now;
    const kept = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.sql.gz')).length;
    writeStatusFile({ lastSnapshotAt: new Date().toISOString(), snapshotCount: kept, lastSnapshotBytes: dumpBuf.length });
    // prune old snapshots beyond SNAP_KEEP
    const snaps = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.sql.gz'))
      .map((f) => ({ f, t: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const s of snaps.slice(SNAP_KEEP)) {
      try { fs.unlinkSync(path.join(SNAP_DIR, s.f)); } catch (e) { /* ignore */ }
    }
    log('snapshot saved: ' + name + ' (' + Math.round(dumpBuf.length / 1024) + ' KB raw)');
  } catch (e) {
    logOnce('snap', 'snapshot failed (non-fatal): ' + e.message);
  }
}

// ------------------------------------------------------------- main cycles --
let healthyStreak = 0;

async function forwardSync() {
  if (fs.existsSync(MARKER)) return failoverCheck(); // race guard: failover happened just now
  if (!(await probe(PRIMARY, 'primary'))) {
    writeStatusFile({ primaryUp: false, standbyUp: null, lastSyncError: 'primary unreachable' });
    pushEvent('SYNC_SKIPPED', 'primary unreachable — forward sync skipped, standby keeps last good data');
    logOnce('fwd-primary', 'primary unreachable — skipping forward sync (standby keeps last good data)');
    return;
  }
  if (!(await probe(STANDBY, 'standby'))) {
    writeStatusFile({ primaryUp: true, standbyUp: false, lastSyncError: 'standby unreachable' });
    pushEvent('STANDBY_DOWN', 'standby unreachable — pm2 should be restarting it (mysql-standby)');
    logOnce('fwd-standby', 'standby unreachable — skipping (pm2 should be restarting it)');
    return;
  }
  if (fs.existsSync(MARKER)) return failoverCheck(); // re-check right before touching standby
  const t0 = Date.now();
  try {
    const dump = await dumpFrom(PRIMARY);
    await restoreTo(STANDBY, dump);
    writeStatusFile({
      primaryUp: true,
      standbyUp: true,
      lastSyncOk: new Date().toISOString(),
      lastSyncSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      lastSyncBytes: dump.length,
      lastSyncError: null,
    });
    pushEvent('SYNC_OK', 'synced primary → standby (' + Math.round(dump.length / 1024) + ' KB in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    log('forward sync ok: ' + Math.round(dump.length / 1024) + ' KB in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await maybeSnapshot(dump);
  } catch (e) {
    writeStatusFile({ primaryUp: true, standbyUp: true, lastSyncError: String(e.message).slice(0, 200) });
    throw e;
  }
}

async function reverseSyncOnce(source, dest, label) {
  const t0 = Date.now();
  const dump = await dumpFrom(source);
  await restoreTo(dest, dump);
  log(label + ': ' + Math.round(dump.length / 1024) + ' KB in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  return dump;
}


async function failoverCheck() {
  if (!fs.existsSync(MARKER)) { healthyStreak = 0; return; }
  writeStatusFile({ failoverActive: true });
  if (!(await probe(PRIMARY, 'primary'))) {
    healthyStreak = 0;
    writeStatusFile({ primaryUp: false });
    pushEvent('FAILOVER_ACTIVE', 'FAILOVER ACTIVE — app served by standby; primary still down');
    logOnce('fo-wait', 'FAILOVER ACTIVE — app is served by the standby; primary still down');
    if (!(await probe(STANDBY, 'standby'))) {
      writeStatusFile({ standbyUp: false });
      logOnce('fo-standby-down', 'CRITICAL: failover active but standby is also unreachable!');
    } else {
      writeStatusFile({ standbyUp: true });
    }
    return;
  }
  writeStatusFile({ primaryUp: true });
  healthyStreak += 1;
  writeStatusFile({ failbackProbeCount: healthyStreak, failbackProbeRequired: FAILBACK_AFTER_HEALTHY });
  logOnce('fo-healthy', 'primary is back (' + healthyStreak + '/' + FAILBACK_AFTER_HEALTHY + ' healthy probes)');
  if (healthyStreak < FAILBACK_AFTER_HEALTHY) return;

  log('FAILBACK: restoring primary from standby…');
  if (!(await probe(STANDBY, 'standby'))) {
    log('FAILBACK aborted: standby unreachable — staying in failover mode');
    healthyStreak = 0;
    return;
  }
  try {
    pushEvent('FAILBACK_STARTED', 'primary is healthy again — restoring primary from standby (2 passes)');
    await reverseSyncOnce(STANDBY, PRIMARY, 'failback pass 1 (standby → primary)');
    const cStandby = await tableCount(STANDBY);
    const cPrimary = await tableCount(PRIMARY);
    if (cPrimary !== cStandby) {
      throw new Error('table count mismatch after restore: primary=' + cPrimary + ' standby=' + cStandby);
    }
    await reverseSyncOnce(STANDBY, PRIMARY, 'failback pass 2 (closes writes made during pass 1)');
    fs.unlinkSync(MARKER);
    healthyStreak = 0;
    writeStatusFile({
      failoverActive: false,
      failbackProbeCount: 0,
      failbackProbeRequired: FAILBACK_AFTER_HEALTHY,
      lastFailback: new Date().toISOString(),
    });
    pushEvent('FAILBACK_COMPLETED', 'failback complete — primary restored from standby and verified (' + cPrimary + ' tables)');
    log('FAILBACK COMPLETE — primary restored and verified (' + cPrimary + ' tables). App will switch back automatically.');
  } catch (e) {
    writeStatusFile({ lastFailbackError: String(e.message).slice(0, 200) });
    log('FAILBACK failed, will retry next cycle: ' + e.message);
  }
}

async function runCycle() {
  try {
    if (fs.existsSync(MARKER)) await failoverCheck();
    else await forwardSync();
  } catch (e) {
    logOnce('cycle-error', 'sync cycle error: ' + e.message);
    if (ONCE) throw e; // --once callers need the failure reflected in exit code
  }
}


async function printStatus() {
  const p = await probe(PRIMARY, 'primary');
  const s = await probe(STANDBY, 'standby');
  const marker = fs.existsSync(MARKER);
  console.log(JSON.stringify({
    primary: p ? 'up' : 'down',
    standby: s ? 'up' : 'down',
    failoverActive: marker,
    logFile: LOG_FILE,
  }, null, 2));
}

process.on('uncaughtException', (err) => { log('uncaught exception: ' + (err && err.stack || err)); process.exit(1); });
process.on('unhandledRejection', (err) => { log('unhandled rejection: ' + (err && (err.stack || err.message) || err)); });

if (STATUS) { printStatus(); }
else if (ONCE) {
  runCycle().then(() => process.exit(0)).catch((e) => { log('once-mode error: ' + e.message); process.exit(1); });
}
else {
  log('db-sync daemon starting (interval ' + (INTERVAL_MS / 1000) + 's, primary ' +
    PRIMARY.host + ':' + PRIMARY.port + ' → standby ' + STANDBY.host + ':' + STANDBY.port + ')');
  writeStatusFile({ daemonStartedAt: new Date().toISOString() });
  runCycle().catch(() => { });
  setInterval(() => runCycle().catch(() => { }), INTERVAL_MS);
}
