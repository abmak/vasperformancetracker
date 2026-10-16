const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { execFile } = require('child_process');
const router = express.Router();
const db = require('../config/database');
const { isMasterAdmin } = require('../middleware/permissions');
const { recordFailoverEvent } = require('../config/dbFailoverEvents');

/**
 * GET /api/system/health — master-admin system health panel.
 *
 * One endpoint, many checkers:
 *  - dbTarget / failover state / per-instance liveness (direct PostgreSQL probes)
 *  - streaming replication state from pg_stat_replication + the standby itself
 *  - incident timeline: recentEvents (daemon) + system_events DB table
 *  - server stats: disk usage, memory, uptime (serverStats())
 *  - TLS certificate expiry: probes the live listener on :5000
 *  - nightly backup check: newest ~/backups/vas-pg-*.sql.gz age + integrity
 *
 * Probes use throwaway PostgreSQL connections with short timeouts so a dead
 * primary can never make this endpoint hang or fail.
 */

const HOME = os.homedir();
// Container-aware paths: when the app runs in Docker, $HOME is /home/node and
// the host dirs are bind-mounted elsewhere — pin them via env in the compose
// file (see docker-compose.yml).
const STATUS_FILE = process.env.DB_SYNC_STATUS_FILE
  || path.join(HOME, 'mysql-standby', 'status.json');
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(HOME, 'backups');
// Operator-editable standby copy cadence. The db-sync daemon re-reads this file
// every minute, so a save here takes effect without a daemon restart.
const SYNC_CONFIG_FILE = process.env.DB_SYNC_CONFIG_FILE
  || path.join(path.dirname(STATUS_FILE), 'sync-config.json');

// How long one connection attempt may take before the app treats that database
// as unreachable and fails over. The pools (and therefore the bounds) are owned
// by backend/src/config/database.js, so they are read from there instead of
// being duplicated here — the page can never save a value the pool rejects.
const CONNECT_TIMEOUT_LIMITS = db.__connectTimeoutLimits || {
  minSeconds: 1, maxSeconds: 120, defaultSeconds: 10,
};

// How often the frequent PostgreSQL dump tier actually runs, and its retention.
//
// The dump itself is done by scripts/db/pg-backup.sh on the host's cron (this
// process can neither dump nor reach the host's crontab), so the cadence is
// handed over in a file the script reads on every run — the host needs no
// redeploy to change it. Bounds are shared with the script's (MIN_INTERVAL /
// MAX_INTERVAL there) so a value accepted here is never rejected on the host.
const BACKUP_CONFIG_FILE = process.env.DB_BACKUP_CONFIG_FILE
  || path.join(
    process.env.DB_FAILOVER_MARKER ? path.dirname(process.env.DB_FAILOVER_MARKER) : path.join(HOME, 'pg-standby'),
    'backup-config.json'
  );
const BACKUP_INTERVAL_LIMITS = { minMinutes: 1, maxMinutes: 60, defaultMinutes: 10 };
// The tier's cron line runs every minute, so a saved change is acted on within
// one minute without touching the host.
const BACKUP_INTERVAL_PICKUP_SECONDS = 60;

/**
 * The saved dump cadence, or the built-in default.
 *
 * `source` is reported rather than guessed: 'default' means nobody has chosen a
 * value, so the card never claims a cadence the operator did not set.
 */
function backupIntervalConfig() {
  const cfg = readJsonSafe(BACKUP_CONFIG_FILE);
  const minutes = Number(cfg && cfg.intervalMinutes);
  if (Number.isInteger(minutes)
    && minutes >= BACKUP_INTERVAL_LIMITS.minMinutes
    && minutes <= BACKUP_INTERVAL_LIMITS.maxMinutes) {
    return {
      minutes,
      source: 'config',
      updatedAt: cfg.updatedAt || null,
      updatedBy: cfg.updatedBy || null,
    };
  }
  return {
    minutes: BACKUP_INTERVAL_LIMITS.defaultMinutes,
    source: 'default',
    updatedAt: null,
    updatedBy: null,
  };
}

// About an hour of dumps at the current cadence — the same rule the script
// applies, so the card's retention line matches what really gets kept.
function backupKeepCount(minutes) {
  return Math.max(2, Math.ceil(60 / minutes));
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function fileAgeSeconds(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
}

// ------------------------------------------------------------ db probes ----
// `pg_is_in_recovery()` is what separates a live primary from a live *read-only
// replica* — the health page shows it because a replica cannot take writes.
async function probeServer(host, port) {
  const client = new Client({
    host,
    port,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 4000,
    statement_timeout: 4000,
    query_timeout: 4000,
  });
  try {
    await client.connect();
    // pg_is_wal_replay_paused() raises "recovery is not in progress" on a
    // primary, so it is only reached through the CASE (which PostgreSQL
    // evaluates lazily) — never unconditionally.
    const res = await client.query(
      `SELECT pg_is_in_recovery() AS in_recovery,
              CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() END AS replay_paused`
    );
    return {
      up: true,
      inRecovery: res.rows[0].in_recovery,
      replayPaused: res.rows[0].replay_paused,
    };
  } catch (e) {
    return { up: false, error: e.code || e.message };
  } finally {
    try { await client.end(); } catch (e) { /* ignore */ }
  }
}

/**
 * Streaming replication state, read from two places:
 *  - the primary knows what each replica has *sent/acked* (pg_stat_replication)
 *  - the standby knows what it has *received/replayed* and how stale it is
 * Neither query moves the app's active target.
 */
async function replicationStatus(targets) {
  if (!targets.standby) return { configured: false };

  const out = {
    configured: true,
    engine: 'postgres',
    streaming: false,
    senders: 0,
    state: null,
    syncState: null,
    lagBytes: null,
    lagSeconds: null,
    standbyInRecovery: null,
    replayPaused: null,
    lastReplayAt: null,
    primaryLsn: null,
    standbyReplayLsn: null,
    error: null,
  };

  try {
    const rows = await db.__queryOnTarget(
      'primary',
      `SELECT application_name, state, sync_state, sent_lsn, replay_lsn,
              pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
         FROM pg_stat_replication`
    );
    out.senders = rows.length;
    if (rows.length) {
      const r = rows[0];
      out.state = r.state;
      out.syncState = r.sync_state;
      out.streaming = r.state === 'streaming';
      out.lagBytes = r.lag_bytes === null ? null : Number(r.lag_bytes);
      out.primaryLsn = r.sent_lsn ? String(r.sent_lsn) : null;
      out.standbyReplayLsn = r.replay_lsn ? String(r.replay_lsn) : null;
    }
  } catch (e) {
    out.error = 'primary: ' + e.message;
  }

  try {
    const rows = await db.__queryOnTarget(
      'standby',
      `SELECT pg_is_in_recovery() AS in_recovery,
              CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() END AS replay_paused,
              pg_last_wal_replay_lsn() AS replay_lsn,
              pg_last_xact_replay_timestamp() AS last_replay_at,
              ROUND(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))) AS lag_seconds`
    );
    if (rows.length) {
      const r = rows[0];
      out.standbyInRecovery = r.in_recovery;
      out.replayPaused = r.replay_paused;
      out.lagSeconds = r.lag_seconds === null ? null : Number(r.lag_seconds);
      out.lastReplayAt = r.last_replay_at ? new Date(r.last_replay_at).toISOString() : null;
      if (!out.standbyReplayLsn && r.replay_lsn) out.standbyReplayLsn = String(r.replay_lsn);
    }
  } catch (e) {
    out.error = (out.error ? out.error + '; ' : '') + 'standby: ' + e.message;
  }

  return out;
}

async function recentDbEvents() {
  try {
    const [rows] = await db.query(
      'SELECT event_type, severity, message, created_at FROM system_events ORDER BY id DESC LIMIT 15'
    );
    return rows.map((r) => ({
      type: r.event_type,
      severity: r.severity,
      message: r.message,
      at: new Date(r.created_at).toISOString(),
      source: 'db',
    }));
  } catch (e) {
    return null; // table may not exist yet
  }
}

// ---------------------------------------------------------- server stats ---
function serverStats() {
  const out = {};
  try {
    const total = os.totalmem();
    const free = os.freemem();
    out.memory = {
      totalMb: Math.round(total / 1048576),
      freeMb: Math.round(free / 1048576),
      usedPct: Math.round(((total - free) / total) * 100),
    };
    out.loadAvg = os.loadavg().map((n) => Number(n.toFixed(2)));
    out.uptimeSeconds = Math.round(process.uptime());
  } catch (e) { /* ignore */ }
  try {
    // Disk via statfs (Node 18.15+); falls back gracefully.
    const fsStat = fs.statfsSync(path.sep);
    const total = Number(fsStat.blocks) * Number(fsStat.bsize);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    out.disk = {
      totalGb: Number((total / 1073741824).toFixed(1)),
      freeGb: Number((free / 1073741824).toFixed(1)),
      usedPct: Math.round(((total - free) / total) * 100),
    };
  } catch (e) {
    out.disk = null; // not supported — UI hides the card
  }
  return out;
}

// ------------------------------------------------------------- tls cert ----
function tlsCertExpiry() {
  // The TLS terminator is vas-https on :5000 (proxy → Express :5001) with a
  // short-lived cert (renewed externally every ~6 days), so expiry is read
  // from the running server itself.
  return new Promise((resolve) => {
    let settled = false;
    const socket = require('tls').connect(
      { host: '127.0.0.1', port: 5000, rejectUnauthorized: false },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.valid_to) return finish(null);
          const expiresAt = new Date(cert.valid_to);
          finish({
            expiresAt: expiresAt.toISOString(),
            daysLeft: Number(((expiresAt - Date.now()) / 86400000).toFixed(1)),
            selfSigned: !cert.issuer || !cert.issuer.O,
          });
        } catch (e) { finish(null); }
      }
    );
    function finish(v) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* ignore */ }
      resolve(v);
    }
    socket.setTimeout(4000, () => finish(null));
    socket.on('error', () => finish(null));
  });
}

// -------------------------------------------------------------- backups ----
// PostgreSQL dumps run in three tiers from one script (scripts/db/pg-backup.sh),
// each with its own retention, so there is always a restore point that is
// minutes, hours and days old:
//
//   vas-pg-10m-<date>-<HHMM>.sql.gz    every N min (configurable, default 10) keep ~1 hour of them
//   vas-pg-hourly-<date>-<HH>.sql.gz   hourly         keep newest 24 (last day)
//   vas-pg-<date>.sql.gz               nightly        keep 14 days
//
// The 10m prefix is the frequent tier's stable id, not its interval: cron wakes
// it every minute and pg-backup.sh decides whether it is due, using the saved
// cadence (BACKUP_CONFIG_FILE, defined with the other settings above), which is
// why the card's title, staleness threshold and retention all derive from it.
//
// The legacy MySQL names (vas-<date>.sql.gz) are still counted so the card keeps
// working during the MySQL rollback window instead of flashing "no backups".
function backupTiers(intervalMinutes) {
  return [
    // key, name prefix/pattern, label, and how stale the tier may get before it
    // counts as broken (a missed frequent run must not hide in a green card).
    // The frequent tier's label and threshold follow the configured cadence:
    // 1.5 intervals of silence means a run was missed, whatever the interval is.
    {
      key: 'tenMin',
      match: (n) => n.startsWith('vas-pg-10m-'),
      label: `every ${intervalMinutes} min`,
      maxAgeHours: (intervalMinutes / 60) * 1.5,
    },
    { key: 'hourly', match: (n) => n.startsWith('vas-pg-hourly-'), label: 'hourly', maxAgeHours: 2 },
    { key: 'nightly', match: (n) => /^vas-pg-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(n), label: 'nightly', maxAgeHours: 26 },
  ];
}

function backupCheck(intervalMinutes) {
  const tiersForRun = backupTiers(intervalMinutes);
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^vas(-pg)?-.*\.sql\.gz$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    if (!files.length) return { configured: true, ok: false, problem: 'no vas-pg-*.sql.gz backups found in ~/backups' };

    const now = Date.now();
    const ageHoursOf = (f) => (now - Date.parse(f.mtime)) / 3600000;
    // <1KB gzip ≈ empty dump (the old cron bug — spaces-privilege issue)
    const empty = (f) => f.sizeBytes < 1000;

    // files are newest-first, so [0] of each tier is that tier's newest dump.
    const tiers = {};
    for (const t of tiersForRun) {
      const own = files.filter((f) => t.match(f.name));
      const newestOfTier = own[0] || null;
      const ageHours = newestOfTier ? Number(ageHoursOf(newestOfTier).toFixed(2)) : null;
      tiers[t.key] = {
        label: t.label,
        count: own.length,
        newest: newestOfTier && {
          name: newestOfTier.name,
          sizeBytes: newestOfTier.sizeBytes,
          ageHours,
          mtime: newestOfTier.mtime,
        },
        // Each tier stands on its own: a fresh 10-minute dump cannot make a
        // nightly tier that stopped days ago look healthy.
        ok: newestOfTier ? ageHours < t.maxAgeHours && !empty(newestOfTier) : false,
      };
    }

    const newest = files[0];
    const ageHours = Number(ageHoursOf(newest).toFixed(1));
    const looksEmpty = empty(newest);
    // The card's light tracks the nightly dump when there is one, because that
    // is the copy of last resort; otherwise it falls back to the newest file.
    const safety = tiers.nightly.newest
      ? files.find((f) => f.name === tiers.nightly.newest.name)
      : newest;
    const safetyAgeHours = Number(ageHoursOf(safety).toFixed(1));
    const safetyEmpty = empty(safety);
    // An empty (<1KB) dump is a broken dump, not merely an old one: it is worth
    // naming even when it sits in a tier other than the nightly one, because
    // that tier would otherwise quietly keep handing back six useless files.
    // files are newest-first, so find() names the most recent bad dump.
    const firstEmpty = (files.find(empty) || {}).name || null;

    return {
      configured: true,
      // Green only when the nightly copy of last resort is fresh and readable;
      // per-tier detail lives in `tiers` so this light stays meaningful.
      ok: safetyAgeHours < 26 && !safetyEmpty,
      newest: { name: newest.name, sizeBytes: newest.sizeBytes, ageHours, mtime: newest.mtime },
      backupCount: files.length,
      engine: newest.name.startsWith('vas-pg-') ? 'postgres' : 'mysql',
      tiers,
      problem: firstEmpty
        ? `empty dump: ${firstEmpty} (<1KB)`
        : safetyAgeHours >= 26 ? 'no fresh backup in 26h' : null,
    };
  } catch (e) {
    // Dev machines have no ~/backups — neutral state, not an error.
    if (e.code === 'ENOENT') return { configured: false };
    return { configured: true, ok: false, problem: 'cannot read backups dir: ' + e.message };
  }
}

// -------------------------------------------------------------- timeline ---
function mergeTimelines(daemonEvents, dbEvents) {
  const daemon = (daemonEvents || []).map((e) => ({ ...e, source: 'daemon' }));
  const merged = [...(dbEvents || []), ...daemon]
    .sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1))
    .slice(0, 20);
  return merged;
}

// ----------------------------------------------------------- copy cadence --
// How often the retained MySQL standby is refreshed. Bounds match the daemon's
// (scripts/db/standby/sync-standby.js) so the page can never save a value the
// daemon would reject.
const SYNC_INTERVAL_LIMITS = { minMinutes: 1, maxMinutes: 1440, defaultMinutes: 10 };
const SYNC_INTERVAL_PICKUP_SECONDS = 60;

/**
 * The saved cadence plus where it came from.
 *
 * `source` matters: 'default' means nobody has ever chosen a value, so the page
 * shows the fallback without pretending it was configured.
 */
function syncIntervalConfig() {
  const cfg = readJsonSafe(SYNC_CONFIG_FILE);
  const minutes = Number(cfg && cfg.intervalMinutes);
  if (Number.isFinite(minutes)
    && minutes >= SYNC_INTERVAL_LIMITS.minMinutes
    && minutes <= SYNC_INTERVAL_LIMITS.maxMinutes) {
    return {
      minutes,
      source: 'config',
      updatedAt: cfg.updatedAt || null,
      updatedBy: cfg.updatedBy || null,
    };
  }
  const envMs = Number(process.env.DB_SYNC_INTERVAL_MS);
  if (Number.isFinite(envMs) && envMs > 0) {
    return { minutes: Math.round(envMs / 60000), source: 'env', updatedAt: null, updatedBy: null };
  }
  return {
    minutes: SYNC_INTERVAL_LIMITS.defaultMinutes,
    source: 'default',
    updatedAt: null,
    updatedBy: null,
  };
}

// ------------------------------------------------------------ cpu probe ---
// Instantaneous CPU snapshot: sample per-core times twice, 300ms apart.
async function cpuUsage() {
  const snap = () => os.cpus().map((c) => ({ ...c.times }));
  const s1 = snap();
  await new Promise((r) => setTimeout(r, 300));
  const s2 = snap();
  let busyAll = 0;
  let totalAll = 0;
  const cores = [];
  for (let i = 0; i < s2.length; i++) {
    const a = s1[i];
    const b = s2[i];
    const busy = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
    const total = busy + (b.idle - a.idle);
    busyAll += busy;
    totalAll += total;
    cores.push(total > 0 ? Math.round((busy / total) * 100) : 0);
  }
  return {
    usagePct: totalAll > 0 ? Math.round((busyAll / totalAll) * 100) : null,
    cores,
    coreCount: s2.length,
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
  };
}

// ------------------------------------------------------------- snapshots ---
// Hourly standby snapshots taken by the sync daemon (~/backups/standby-snapshots).
function snapshotCheck() {
  try {
    const dir = path.join(BACKUPS_DIR, 'standby-snapshots');
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql.gz'))
      .map((f) => ({
        name: f,
        sizeBytes: fs.statSync(path.join(dir, f)).size,
        mtime: fs.statSync(path.join(dir, f)).mtime.toISOString(),
      }))
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    if (!files.length) return { count: 0 };
    const ageHours = Number(((Date.now() - Date.parse(files[0].mtime)) / 3600000).toFixed(1));
    return { count: files.length, newest: { name: files[0].name, ageHours, sizeBytes: files[0].sizeBytes } };
  } catch (e) {
    return null; // dev machine / dir missing
  }
}

// ------------------------------------------------------------------- pm2 ---
function pm2List() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const arr = JSON.parse(stdout);
        resolve(arr.map((p) => ({
          name: p.name,
          status: p.pm2_env && p.pm2_env.status,
          memMb: Math.round(((p.monit && p.monit.memory) || 0) / 1048576),
          restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
          uptimeMs: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
        })));
      } catch (e) { resolve(null); }
    });
  });
}

// isMasterAdmin() is a boolean predicate, not middleware — wrap it.
function requireMasterAdmin(req, res, next) {
  if (!isMasterAdmin(req)) {
    return res.status(403).json({ error: 'Master admin access required' });
  }
  next();
}

router.get('/health', requireMasterAdmin, async (req, res) => {
  try {
    const sync = readJsonSafe(STATUS_FILE);
    const targets = db.__dbTargets || {};
    const standbyConfigured = Boolean(targets.standby);

    const appOk = await (async () => {
      try { await db.query('SELECT 1'); return true; } catch (e) { return false; }
    })();

    // Probe the PRIMARY directly when we are not serving from it (if we ARE
    // serving from it, the appOk probe already proves it).
    const probePrimary =
      db.__dbTarget === 'primary' ? Promise.resolve({ up: appOk })
        : targets.primary ? probeServer(targets.primary.host, targets.primary.port)
          : Promise.resolve({ up: null, error: 'unknown target' });

    // The standby is never the pool's initial target, so probe it directly
    // whenever it is configured (cheap: one 4s-bounded connection).
    const probeStandby = standbyConfigured && targets.standby
      ? probeServer(targets.standby.host, targets.standby.port)
      : Promise.resolve(null);

    const [primary, standby, replication, dbEvents, tls, stats, cpu, processes, snapshots] = await Promise.all([
      probePrimary,
      probeStandby,
      replicationStatus(targets),
      recentDbEvents(),
      tlsCertExpiry(),
      Promise.resolve(serverStats()),
      cpuUsage(),
      pm2List(),
      Promise.resolve(snapshotCheck()),
    ]);

    const dumpInterval = backupIntervalConfig();
    const backup = backupCheck(dumpInterval.minutes);
    const standbySync = syncIntervalConfig();

    res.json({
      timestamp: new Date().toISOString(),
      engine: db.__engine || 'postgres',
      app: { databaseReachable: appOk },
      dbTarget: db.__dbTarget,
      failover: {
        enabled: Boolean(db.__failoverEnabled),
        standbyConfigured,
        active: fs.existsSync((db.__markers && db.__markers.failover)
          || process.env.DB_FAILOVER_MARKER
          || path.join(HOME, 'pg-standby', 'FAILOVER')),
        // A promoted standby has taken writes the old primary never saw, so
        // failing back needs an operator to rebuild the primary first.
        standbyPromoted: Boolean(db.__standbyPromoted),
        failbackAllowed: db.__failbackAllowed !== false,
        // How long a connection attempt may take before the app declares a
        // database unreachable and moves to the other one. Reconciled here so a
        // hand-edited config file on the VPS is picked up on the next refresh.
        connectionTimeout: db.__reconcileConnectionTimeout(),
      },
      instances: {
        primary: primary && {
          up: primary.up,
          error: primary.error || null,
          address: targets.primary,
          inRecovery: primary.inRecovery === undefined ? null : primary.inRecovery,
        },
        standby: standby && {
          up: standby.up,
          error: standby.error || null,
          address: targets.standby,
          inRecovery: standby.inRecovery === undefined ? null : standby.inRecovery,
          replayPaused: standby.replayPaused === undefined ? null : standby.replayPaused,
        },
      },
      replication,
      sync: sync && {
        lastSyncOk: sync.lastSyncOk || null,
        lastSyncSecondsAgo: fileAgeSeconds(sync.lastSyncOk),
        lastSyncDurationSeconds: sync.lastSyncSeconds || null,
        lastSyncBytes: sync.lastSyncBytes || null,
        lastSyncError: sync.lastSyncError || null,
        failbackProbeCount: sync.failbackProbeCount || 0,
        failbackProbeRequired: sync.failbackProbeRequired || 0,
        lastFailback: sync.lastFailback || null,
        daemonUpdatedAt: sync.updatedAt || null,
        daemonSecondsAgo: fileAgeSeconds(sync.updatedAt),
      },
      // The retained MySQL standby's copy cadence. The PostgreSQL standby the app
      // actually runs on streams instead and has no interval, so this is
      // reported separately rather than mixed into `replication`.
      standbySync: {
        ...standbySync,
        // What the daemon last reported running, and where it says that came
        // from. It can lag a fresh save until the next config poll, which is what
        // the page tells the operator. The daemon's own report wins over this
        // endpoint's inference: DB_SYNC_INTERVAL_MS lives in the daemon's env
        // file, which the app cannot see.
        source: (sync && sync.intervalSource) || standbySync.source,
        effectiveMinutes: sync && Number.isFinite(Number(sync.intervalMinutes))
          ? Number(sync.intervalMinutes)
          : standbySync.minutes,
        minMinutes: SYNC_INTERVAL_LIMITS.minMinutes,
        maxMinutes: SYNC_INTERVAL_LIMITS.maxMinutes,
        pickupSeconds: SYNC_INTERVAL_PICKUP_SECONDS,
      },
      // How often the frequent PostgreSQL dump runs, and where that came from.
      // The label, threshold and retention on the backup card all follow it, so
      // the card can never advertise a cadence the dumps do not use.
      backupInterval: {
        ...dumpInterval,
        minMinutes: BACKUP_INTERVAL_LIMITS.minMinutes,
        maxMinutes: BACKUP_INTERVAL_LIMITS.maxMinutes,
        defaultMinutes: BACKUP_INTERVAL_LIMITS.defaultMinutes,
        keepFiles: backupKeepCount(dumpInterval.minutes),
        configFile: BACKUP_CONFIG_FILE,
        pickupSeconds: BACKUP_INTERVAL_PICKUP_SECONDS,
      },
      server: stats,
      cpu,
      processes,
      snapshots,
      tls: tls && {
        expiresAt: tls.expiresAt,
        daysLeft: tls.daysLeft,
        selfSigned: Boolean(tls.selfSigned),
      },
      backup,
      timeline: mergeTimelines(sync && sync.recentEvents, dbEvents),
    });
  } catch (e) {
    console.error('[system-health]', e);
    res.status(500).json({ error: 'health check failed' });
  }
});

// Replication controller — pause/resume WAL replay on the standby.
//
// PostgreSQL's native equivalent of "stop copying" is pg_wal_replay_pause():
// the standby keeps receiving WAL but stops applying it, so nothing is lost and
// resume() catches straight up. (This replaces the MySQL db-sync pm2 toggle.)
router.post('/sync/:action', requireMasterAdmin, async (req, res) => {
  const action = String(req.params.action);
  if (action !== 'pause' && action !== 'resume') {
    return res.status(400).json({ error: 'action must be pause or resume' });
  }
  const targets = db.__dbTargets || {};
  if (!targets.standby) {
    return res.status(400).json({ error: 'no standby is configured (DB_STANDBY_PORT is unset)' });
  }

  const fn = action === 'pause' ? 'pg_wal_replay_pause' : 'pg_wal_replay_resume';
  try {
    await db.__queryOnTarget('standby', `SELECT ${fn}()`);
  } catch (e) {
    return res.status(500).json({ error: fn + '() failed: ' + e.message });
  }

  let state = null;
  try {
    const rows = await db.__queryOnTarget(
      'standby',
      'SELECT CASE WHEN pg_is_in_recovery() THEN pg_is_wal_replay_paused() END AS paused'
    );
    state = rows.length ? rows[0].paused : null;
  } catch (e) { /* best-effort */ }

  try {
    await recordFailoverEvent(
      action === 'pause' ? 'SYNC_PAUSED' : 'SYNC_RESUMED',
      'Standby WAL replay ' + (action === 'pause' ? 'PAUSED' : 'RESUMED')
        + ' by ' + (req.user.email || req.user.username || 'master admin')
    );
  } catch (e) { /* best-effort */ }

  res.json({
    ok: true,
    action,
    replayPaused: state,
    warning: action === 'pause'
      ? 'Replay paused — the standby stops applying WAL until you resume, so a promotion right now would lose everything written since the pause.'
      : null,
  });
});

// Standby copy cadence — how often the retained MySQL standby is refreshed.
//
// Saved to a small JSON file that the db-sync daemon re-reads every minute, so a
// change lands without restarting the daemon and without shell access on the
// VPS. This is NOT the PostgreSQL path: the standby the app serves from streams
// continuously and has no interval to tune.
router.put('/standby-interval', requireMasterAdmin, async (req, res) => {
  const { minMinutes, maxMinutes } = SYNC_INTERVAL_LIMITS;
  const minutes = Number(req.body ? req.body.minutes : undefined);
  if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) {
    return res.status(400).json({
      error: `minutes must be a whole number between ${minMinutes} and ${maxMinutes}`,
    });
  }

  const previous = syncIntervalConfig();
  const updatedBy = (req.user && (req.user.email || req.user.username)) || 'master admin';
  const payload = { intervalMinutes: minutes, updatedAt: new Date().toISOString(), updatedBy };

  // Write-then-rename: the daemon reads this file every minute and must never
  // catch it half-written, which would look to it like "no config at all".
  const tmp = SYNC_CONFIG_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(SYNC_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, SYNC_CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean up */ }
    console.error('[system-standby-interval]', e);
    return res.status(500).json({ error: 'could not save ' + SYNC_CONFIG_FILE + ': ' + e.message });
  }

  try {
    await recordFailoverEvent(
      'INFO',
      `Standby copy interval changed ${previous.minutes} min → ${minutes} min by ${updatedBy}`,
      { configFile: SYNC_CONFIG_FILE, source: previous.source }
    );
  } catch (e) { /* best-effort audit trail */ }

  res.json({
    ok: true,
    ...syncIntervalConfig(),
    previousMinutes: previous.minutes,
    pickupSeconds: SYNC_INTERVAL_PICKUP_SECONDS,
  });
});

// Connection attempt timeout — how long the app waits for a database connection
// before treating that target as unreachable and failing over to the other one.
//
// This is the failover *latency* knob: a lower value moves traffic to the standby
// sooner, and one that is too low fails over on a transient blip. 1 second is the
// floor on purpose — a 0 would mean "wait forever", turning a black-holed primary
// into hung requests instead of a failover.
//
// The value goes to a JSON file next to the failover marker, and the pool is
// re-pointed at it immediately: pg reads the option when it opens the *next*
// connection, so nothing already in flight is disturbed and no restart is needed.
router.put('/connection-timeout', requireMasterAdmin, async (req, res) => {
  const { minSeconds, maxSeconds } = CONNECT_TIMEOUT_LIMITS;
  const seconds = Number(req.body ? req.body.seconds : undefined);
  if (!Number.isInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) {
    return res.status(400).json({
      error: `seconds must be a whole number between ${minSeconds} and ${maxSeconds}`,
    });
  }

  const previous = db.__connectionTimeout();
  const configFile = db.__connectTimeoutConfigFile;
  const updatedBy = (req.user && (req.user.email || req.user.username)) || 'master admin';
  const payload = { connectTimeoutSeconds: seconds, updatedAt: new Date().toISOString(), updatedBy };

  // Write-then-rename: the file is read on every health check, so a partial
  // write would otherwise look like "no config — fall back to the default".
  const tmp = configFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, configFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean up */ }
    console.error('[system-connection-timeout]', e);
    return res.status(500).json({ error: 'could not save ' + configFile + ': ' + e.message });
  }

  // Apply to the live pools, then report what they actually hold.
  const applied = db.__reconcileConnectionTimeout();

  try {
    await recordFailoverEvent(
      'INFO',
      `Failover connection timeout changed ${previous.seconds}s → ${applied.seconds}s by ${updatedBy}`,
      { configFile, previousSource: previous.source, source: applied.source }
    );
  } catch (e) { /* best-effort audit trail */ }

  res.json({ ok: true, ...applied, previousSeconds: previous.seconds });
});

// Frequent PostgreSQL dump cadence — the restore-point spacing.
//
// The dump runs on the host's cron (this process cannot dump, and cannot reach
// the host's crontab), so the interval is saved to a file that scripts/db/pg-backup.sh
// reads on each run. That cron fires every minute and the script decides whether
// it is due, which is what makes any interval possible without a host change.
router.put('/backup-interval', requireMasterAdmin, async (req, res) => {
  const { minMinutes, maxMinutes } = BACKUP_INTERVAL_LIMITS;
  const minutes = Number(req.body ? req.body.minutes : undefined);
  if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) {
    return res.status(400).json({
      error: `minutes must be a whole number between ${minMinutes} and ${maxMinutes}`,
    });
  }

  const previous = backupIntervalConfig();
  const updatedBy = (req.user && (req.user.email || req.user.username)) || 'master admin';
  const payload = { intervalMinutes: minutes, updatedAt: new Date().toISOString(), updatedBy };

  // Write-then-rename: the host script reads this file on every run and must
  // never catch it half-written, which would look like "no config at all".
  const tmp = BACKUP_CONFIG_FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(BACKUP_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, BACKUP_CONFIG_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean up */ }
    console.error('[system-backup-interval]', e);
    return res.status(500).json({ error: 'could not save ' + BACKUP_CONFIG_FILE + ': ' + e.message });
  }

  const applied = backupIntervalConfig();
  try {
    await recordFailoverEvent(
      'INFO',
      `PostgreSQL dump interval changed ${previous.minutes} min → ${applied.minutes} min by ${updatedBy}`,
      { configFile: BACKUP_CONFIG_FILE, previousSource: previous.source, keepFiles: backupKeepCount(applied.minutes) }
    );
  } catch (e) { /* best-effort audit trail */ }

  res.json({
    ok: true,
    ...applied,
    previousMinutes: previous.minutes,
    keepFiles: backupKeepCount(applied.minutes),
    pickupSeconds: BACKUP_INTERVAL_PICKUP_SECONDS,
  });
});

module.exports = router;
