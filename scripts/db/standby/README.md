# Standby Database (Automatic Failover)

The backend keeps working if the primary MySQL crashes. This is a
dump-based warm standby on the **same VPS** — it protects against MySQL
crashes, corruption, OOM kills and bad migrations. It does **not** protect
against total VPS loss (for that you would need a second server).

## Architecture

```
                ┌─────────────────── VPS 196.189.155.179 ───────────────────┐
                │                                                           │
 Express API ───┼─► primary MySQL :3306  ◄──── mysqldump every 2 min ───┐   │
 (perf-tracking │        │ crashed?                                     │   │
  api + vas-    │        ▼                                              │   │
  https :5000)  │   [FAILOVER marker file]            sync daemon       │   │
                │        │ app auto-switches ──► standby MySQL :3307 ◄──┘   │
                │        │                          (pm2: mysql-standby)    │
                │        │ app auto-switches back                           │
                │        └── after primary healthy 2× and primary has       │
                │            been restored FROM standby (pm2: db-sync)      │
                └───────────────────────────────────────────────────────────┘
```

| Component | pm2 name | What it does |
|---|---|---|
| Standby MySQL 8.0 | `mysql-standby` | Second instance on 127.0.0.1:3307, memory-tuned (~300 MB), binary copy at `~/mysql-standby/bin/mysqld` so AppArmor doesn't block the home datadir |
| Sync daemon | `db-sync` | `~/mysql-standby/sync-standby.js` — forward-syncs every 2 min, handles failback |
| Failover layer | — | `backend/src/config/database.js` proxy pool: on connection error, retry once on the other target; marker file survives restarts |
| Snapshots | cron | Hourly gzipped dumps in `~/backups/standby-snapshots/` (last 6) + existing nightly cron backup |

**Recovery point:** ≤ 2 minutes of writes (sync interval). During failback
the primary is restored from the standby in two passes, so writes made
while on the standby are preserved.
**Recovery time:** seconds — the switch is a pool reconfiguration, no pm2
restart, no DNS, no config edit.

## Key paths (VPS)

| Path | Purpose |
|---|---|
| `~/mysql-standby/my-standby.cnf` | Standby instance config (port 3307) |
| `~/mysql-standby/data/` | Standby datadir |
| `~/mysql-standby/log/{error,sync}.log` | Standby + sync daemon logs |
| `~/mysql-standby/FAILOVER` | Marker file — present while the app is served by the standby |
| `/var/www/performancetracking/app/backend/.env.production` | `DB_STANDBY_HOST/PORT/ENABLED` added by installer |

## Day-to-day commands (on the VPS)

```bash
# Status: is the app on primary or standby? are both MySQL instances up?
pm2 ls
tail -20 ~/mysql-standby/log/sync.log
node ~/mysql-standby/sync-standby.js --status
curl -s http://127.0.0.1:5001/api/health   # shows "dbTarget":"primary"|"standby"

# Force one sync cycle now
node ~/mysql-standby/sync-standby.js --once

# Manual failover to standby (e.g. planned maintenance of primary):
#   pin target, restart, then stop primary
pm2 delete db-sync            # so it doesn't reverse-sync over your plan
echo maintenance > ~/mysql-standby/FAILOVER
pm2 restart perf-tracking-api --update-env DB_FORCE_TARGET=standby
# … to return: remove the pin, restart; app goes back to primary
pm2 restart perf-tracking-api --update-env DB_FORCE_TARGET=primary
pm2 start ~/mysql-standby/sync-standby.js --name db-sync

# Look at the standby directly (same credentials as primary)
mysql -h127.0.0.1 -P3307 -u vas_user -p vas_revenue_tracking
```

## Reinstall / update the daemon after code changes

The daemon runs from `~/mysql-standby/` (outside the release dirs so
deploys don't touch it). To ship a new version of `scripts/db/standby/sync-standby.js`:

```bash
node scripts/deploy.js ship          # deploy normally
ssh … 'bash /var/www/performancetracking/app/current/scripts/db/standby/install-on-vps.sh'
```

The installer is idempotent; re-running updates the daemon copy and restarts `db-sync`.

## How a real incident plays out

1. Primary mysqld dies (crash / OOM / corruption).
2. The very next API query fails with a connection error → `database.js`
   switches the pool to the standby and retries (log line
   `[db-failover] switched to STANDBY (ECONNREFUSED)`) and writes the
   marker file. Users see at most one failed request.
3. `db-sync` sees the marker, stops forward-syncing, waits for the primary.
4. You fix the primary (e.g. `pm2 restart mysql-standby` isn't it —
   `sudo systemctl start mysql`) — no action needed for the app; it stays live.
5. Once the primary answers 2 probes, `db-sync` restores the primary **from**
   the standby (protecting writes made during the outage), verifies table
   counts, deletes the marker.
6. The app notices the marker is gone within 30s and fails back. Log:
   `FAILBACK COMPLETE — primary restored and verified`.

## Limits & notes

- Other apps on this VPS (jobsethiopia, liblelib, phpmyadmin) use the same
  primary mysqld but are **not** failover-aware; they'd be down while the
  primary is down. Ask if you want them covered too.
- Same-VPS replica ≠ off-site backup. Snapshots live on the same disk.
- The standby binds to 127.0.0.1 only — not reachable from outside the VPS.
- The standby's MySQL root account is locked to `auth_socket` (OS root only);
  app access uses `vas_user` with the same password as the primary.
- pm2 boot persistence was added (`@reboot pm2 resurrect` in crontab +
  `pm2 save`). Verify after any planned reboot: `pm2 ls`.
