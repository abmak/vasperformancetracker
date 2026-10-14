# PostgreSQL runbook (production VPS)

The app used MySQL 8 on the host (`127.0.0.1:3306`, standby `3307`). It now runs
on **PostgreSQL 18 in Docker** with the same two-door layout, so the failover
layer in `backend/src/config/database.js` works unchanged:

| Door | Address | Role |
| --- | --- | --- |
| `pg-primary` | `127.0.0.1:5432` | the app writes here |
| `pg-standby` | `127.0.0.1:5433` | streaming replica — **read-only until promoted** |

Both publish on the loopback interface only. MySQL is left running and untouched
during the rollback window.

## Files

| File | Role |
| --- | --- |
| `docker-compose.pg.yml` | the primary + standby containers |
| `scripts/db/pg-init/01-replication.sh` | first-init hook: `replicator` + `vas_app` roles, replication `pg_hba` line, grants |
| `scripts/db/pg-setup-replication.sh` | clones the primary into the standby (`pg_basebackup`) and starts streaming |
| `scripts/db/migrate-mysql-to-postgres.js` | one-shot data migration (45 tables, verified row counts) |
| `scripts/db/setup-postgres-functions.js`<br>`scripts/db/setup-postgres-compat-layer.js` | MySQL-compat functions/operators the legacy SQL relies on (needs superuser) |
| `scripts/db/pg-backup.sh` | tiered `pg_dump` → `~/backups/vas-pg*.sql.gz` (10-min / hourly / nightly + retention) |

Secrets live in `.env.pg` next to the compose file (chmod 600):

```
PG_SUPERUSER_PASSWORD=…     # postgres superuser (admin/one-off scripts only)
PG_REPLICATION_PASSWORD=…   # the standby's replication login
PG_APP_PASSWORD=…           # the API's own role (vas_app)
PG_PRIMARY_PORT=5432
PG_STANDBY_PORT=5433
```

The API's own credentials go in `backend/.env.production` as `DB_HOST=127.0.0.1`,
`DB_PORT=5432`, `DB_USER=vas_app`, `DB_PASSWORD=<PG_APP_PASSWORD>`,
`DB_NAME=vas_revenue_tracking`, `DB_STANDBY_HOST=127.0.0.1`,
`DB_STANDBY_PORT=5433`, `DB_STANDBY_ENABLED=true`.

## First-time setup

```bash
cd /var/www/performancetracking/pg
docker compose --env-file .env.pg -f docker-compose.pg.yml up -d pg-primary
# data migration runs as vas_app, straight from MySQL
docker run --rm --network host -v "$PWD/scripts:/app/scripts" --workdir /app/backend \
  -e PG_HOST=127.0.0.1 -e PG_PORT=5432 -e PG_USER=vas_app -e PG_PASSWORD="$PG_APP_PASSWORD" \
  -e MYSQL_HOST=127.0.0.1 -e MYSQL_USER=root -e MYSQL_PASSWORD=… \
  ghcr.io/abmak/vasperformancetracker:latest node /app/scripts/db/migrate-mysql-to-postgres.js
# compat layer (superuser required), then the standby
docker run --rm --network host -v "$PWD/scripts:/app/scripts" --workdir /app/backend \
  -e DB_HOST=127.0.0.1 -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASSWORD="$PG_SUPERUSER_PASSWORD" \
  ghcr.io/abmak/vasperformancetracker:latest node /app/scripts/db/setup-postgres-compat-layer.js
bash scripts/db/pg-setup-replication.sh
```

## Failover — what actually happens

A PostgreSQL replica **rejects writes**, so switching to it is not enough:

1. the query fails with a connection error;
2. the app probes the standby and calls `pg_promote()` on it;
3. **only after** it has left recovery does the app move traffic, write
   `~/pg-standby/FAILOVER`, and log `FAILOVER_START`;
4. if promotion fails, the app keeps returning errors on the primary rather than
   writing to a read-only replica.

`~/pg-standby/PROMOTED` records that a promotion happened.

**Failback is deliberately not automatic.** Once the standby has been promoted
it owns writes the old primary never saw; switching back would silently roll the
data back, so the app blocks it and says so in the health page. To fail back:

```bash
# 1. on the OLD primary: wipe it and re-clone from the promoted server
docker compose --env-file .env.pg -f docker-compose.pg.yml rm -sf pg-standby
bash scripts/db/pg-setup-replication.sh --force     # clones pg-primary → standby
# 2. then restart the app with DB_FORCE_TARGET=primary and remove the markers
rm -f ~/pg-standby/FAILOVER ~/pg-standby/PROMOTED
```

The runbook decision is an operator call because only a human knows whether the
old primary's data can be discarded.

## Backups & restore

One script, three tiers — they differ only in how often they run and how many
are kept, so there is always a restore point that is minutes, hours and days old:

| Tier | Runs | File | Kept | Recovers from |
| --- | --- | --- | --- | --- |
| 10-minute | `*/10 * * * *` | `vas-pg-10m-<date>-<HHMM>.sql.gz` | newest 6 (1 hour) | a mistake made minutes ago |
| hourly | `5 * * * *` | `vas-pg-hourly-<date>-<HH>.sql.gz` | newest 24 (1 day) | something noticed later today |
| nightly | `15 2 * * *` | `vas-pg-<date>.sql.gz` | 14 days | anything from the past fortnight |

```bash
bash scripts/db/pg-backup.sh --tier=10m      # manual run of one tier
bash scripts/db/pg-backup.sh                 # no argument = nightly (as before)
crontab -l                                   # */10, 5 * * *, 15 2 * * *
```

Steady-state footprint is small: each dump is ~2.1 MB, so 6 + 24 + 14 files ≈
95 MB. Retention is per tier, and the nightly `-mtime` prune is scoped to
`vas-pg-YYYY-MM-DD` names so it can never sweep away the shorter tiers.

The script picks whichever container is **out of recovery**, so a backup taken
after a failover comes from the promoted standby rather than the old primary
(dumping a read-only replica would produce a file that looks fresh but is
stale). If no writable server is found it exits non-zero and writes nothing. A
`flock` guard means a slow dump is skipped rather than stacked.

Restore (into a rebuilt/empty cluster) — pick the tier by how far back you need:

```bash
ls -t ~/backups/vas-pg-hourly-*.sql.gz | head -1                  # newest hourly
ls -t ~/backups/vas-pg-hourly-*.sql.gz | head -1 | xargs -I{} gunzip -c {} \
  | docker exec -i pg-primary psql -U postgres -d vas_revenue_tracking
```

Dumps are plain SQL, `--no-owner --clean --if-exists`, so they restore into a
cluster with different role names and drop/recreate objects cleanly.

## Operations

```bash
docker exec pg-primary psql -U postgres -c "SELECT * FROM pg_stat_replication"
docker exec pg-standby psql -U postgres -c "SELECT pg_is_in_recovery(), pg_is_wal_replay_paused()"
docker logs --tail 50 pg-primary
```

- **Pause/resume replication** — System Health → *Streaming replication
  controller* (runs `pg_wal_replay_pause()/resume()` on the standby). Gaps
  accumulate while paused; promote only if you accept losing them.
- **A standby that fell too far behind** — re-clone it:
  `bash scripts/db/pg-setup-replication.sh --force` (replaces its volume).
- **Health page** — `GET /api/system/health` reports `engine`, `failover`
  (`standbyPromoted`, `failbackAllowed`), live instance probes, and the
  `replication` block (state, lag bytes/seconds, `standbyInRecovery`).
- **MySQL** is still on the host for rollback; its `mysqldump` cron and the
  `db-sync` daemon keep running until PostgreSQL has proven itself.

## Production state (cut over 2026-10-14, commit `4ffe4f9`)

The VPS now runs on PostgreSQL. Live layout:

```
/var/www/performancetracking/pg/docker-compose.pg.yml   the primary + standby
/var/www/performancetracking/pg/.env.pg                 generated secrets (600)
/var/www/performancetracking/pg/scripts/db/…            migration + ops scripts
/home/feveneyasu/pg-standby/                            FAILOVER / PROMOTED markers
/home/feveneyasu/backups/vas-pg-10m-*.sql.gz           10-minute pg_dump (keep 6)
/home/feveneyasu/backups/vas-pg-hourly-*.sql.gz        hourly pg_dump (keep 24)
/home/feveneyasu/backups/vas-pg-<date>.sql.gz          nightly pg_dump (cron 02:15, keep 14d)
```

Migration result: **45/45 tables, every row count identical to MySQL**
(users 9, roles 12, permissions 83, role_permissions 427, partner_revenue 515,
channel_entities 57, audit_trail 899). 30 API endpoints (VAS dashboard, reports,
partners, targets, revenue, actions, audit, roles, users, chat, guide, and the
whole Indirect Channel surface) all returned 200 through the app on PostgreSQL,
plus a real write (replication pause → resume, both events recorded).

**Gotcha:** `~/.my.cnf` on the VPS holds a *stale* password for `vas_user` — the
mysql client works, mysql2 does not. Use the credentials in
`backend/.env.production` (the ones the app itself uses) when re-running the
migration.

**Rollback** (any time during the MySQL window):

```bash
docker compose -f /var/www/performancetracking/app/docker-compose.yml down
cp ~/backups/env.production.pre-pg-<stamp> /var/www/performancetracking/app/backend/.env.production
docker tag ghcr.io/abmak/vasperformancetracker:pre-pg-20261014 ghcr.io/abmak/vasperformancetracker:latest
docker compose -f /var/www/performancetracking/app/docker-compose.yml up -d
# MySQL never stopped, so this restores the previous behaviour immediately
```

**Follow-ups worth knowing:**

- Root filesystem is ~91% full (2.0 GB free) after adding the PG stack; watch it.
  The tiered dumps add ~95 MB steady state on the same filesystem the database
  lives on, so a full disk takes the backups down with the cluster.
- There is deliberately **no replication slot** for the standby: if the standby
  is down long enough for the primary to recycle WAL it needs a re-clone
  (`pg-setup-replication.sh --force`) rather than a restart.
- The old `~/mysql-standby` mount and the pm2 `db-sync` daemon remain for the
  MySQL rollback window; nothing in the app depends on them any more.
- `scripts/db/check-pg-tables.js` still contains a hard-coded local password and
  is a local-only debugging aid.
