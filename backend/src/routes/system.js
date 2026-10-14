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
// Nightly backups are now pg_dump archives (vas-pg-<date>.sql.gz). The legacy
// MySQL names are still listed so the card keeps working during the MySQL
// rollback window instead of flashing "no backups found".
function backupCheck() {
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^vas(-pg)?-.*\.sql\.gz$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    if (!files.length) return { configured: true, ok: false, problem: 'no vas-pg-*.sql.gz backups found in ~/backups' };
    const newest = files[0];
    const ageHours = Number(((Date.now() - Date.parse(newest.mtime)) / 3600000).toFixed(1));
    // <1KB gzip ≈ empty dump (the old cron bug — spaces-privilege issue)
    const looksEmpty = newest.sizeBytes < 1000;
    return {
      configured: true,
      ok: ageHours < 26 && !looksEmpty,
      newest: { name: newest.name, sizeBytes: newest.sizeBytes, ageHours, mtime: newest.mtime },
      backupCount: files.length,
      engine: newest.name.startsWith('vas-pg-') ? 'postgres' : 'mysql',
      problem: looksEmpty ? 'newest backup looks empty (<1KB)' : ageHours >= 26 ? 'no fresh backup in 26h' : null,
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

    const backup = backupCheck();

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

module.exports = router;
