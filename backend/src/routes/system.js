const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql2 = require('mysql2/promise');
const router = express.Router();
const db = require('../config/database');
const { isMasterAdmin } = require('../middleware/permissions');

/**
 * GET /api/system/health — master-admin system health panel.
 *
 * Reports, without giving the caller any data out of the database:
 *  - dbTarget:        which MySQL the app is currently serving from
 *  - failover:        standby configured / marker state
 *  - appDatabase:     SELECT 1 against the pool (works on either target)
 *  - primary/standby: per-instance liveness from the sync daemon's status.json
 *                     plus a direct probe of the non-active instance when possible
 *  - sync:            last sync time/duration from status.json
 *
 * Direct probes run against explicit host:port using a NEW mysql2 connection
 * (never the shared pool) so a primary crash cannot poison this endpoint.
 */

const HOME = os.homedir();
const STATUS_FILE = process.env.DB_SYNC_STATUS_FILE
  || path.join(HOME, 'mysql-standby', 'status.json');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function fileAgeSeconds(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
}

async function probeServer(host, port) {
  let conn;
  try {
    conn = await mysql2.createConnection({
      host,
      port,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 4000,
    });
    await conn.ping();
    return { up: true };
  } catch (e) {
    return { up: false, error: e.code || e.message };
  } finally {
    if (conn) { try { await conn.destroy(); } catch (e) { /* ignore */ } }
  }
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
    let primary = null;
    let standby = null;

    const probePrimary =
      db.__dbTarget === 'primary' ? Promise.resolve({ up: appOk })
        : targets.primary ? probeServer(targets.primary.host, targets.primary.port)
          : Promise.resolve({ up: null, error: 'unknown target' });

    // The standby is never the pool's initial target, so probe it directly
    // whenever it is configured (cheap: one cached 4s-bounded connection).
    const probeStandby = standbyConfigured && targets.standby
      ? probeServer(targets.standby.host, targets.standby.port)
      : Promise.resolve(null);

    [primary, standby] = await Promise.all([probePrimary, probeStandby]);

    res.json({
      timestamp: new Date().toISOString(),
      app: { databaseReachable: appOk },
      dbTarget: db.__dbTarget,
      failover: {
        enabled: Boolean(db.__failoverEnabled),
        standbyConfigured,
        active: fs.existsSync(process.env.DB_FAILOVER_MARKER
          || path.join(HOME, 'mysql-standby', 'FAILOVER')),
      },
      instances: {
        primary: primary && { up: primary.up, error: primary.error || null, address: targets.primary },
        standby: standby && { up: standby.up, error: standby.error || null, address: targets.standby },
      },
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
    });
  } catch (e) {
    console.error('[system-health]', e);
    res.status(500).json({ error: 'health check failed' });
  }
});

module.exports = router;
