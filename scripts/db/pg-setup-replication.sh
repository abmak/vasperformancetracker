#!/usr/bin/env bash
# Clone the primary into the standby volume and start streaming replication.
#
# Run once, after the primary is up (ideally after the data migration), from the
# directory that holds docker-compose.pg.yml:
#
#   scripts/db/pg-setup-replication.sh
#   scripts/db/pg-setup-replication.sh --force   # re-clone a broken standby
#
# Safe to re-run: an already-streaming standby is left alone.
#
# Environment (same values as the compose file):
#   PG_PROJECT       compose project name  (default perf-tracking-pg)
#   PG_COMPOSE_FILE  compose file          (default docker-compose.pg.yml)
#   PG_ENV_FILE      secrets file          (default .env.pg)
set -euo pipefail

# Git Bash on Windows rewrites POSIX-looking arguments (/var/lib/...) into C:\...
# paths before docker sees them. Both are ignored on Linux, where this runs in
# production, but they make a local rehearsal behave like production.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

COMPOSE_FILE="${PG_COMPOSE_FILE:-docker-compose.pg.yml}"
ENV_FILE="${PG_ENV_FILE:-.env.pg}"
FORCE="${1:-}"
PGDATA_PATH="/var/lib/postgresql/data/pgdata"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE (PG_SUPERUSER_PASSWORD, PG_REPLICATION_PASSWORD, PG_APP_PASSWORD)" >&2
  exit 1
fi

# The env file decides the compose project name, so read it before anything that
# depends on it.
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a
: "${PG_REPLICATION_PASSWORD:?PG_REPLICATION_PASSWORD missing from $ENV_FILE}"

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
PG_IMAGE="$(compose config --images | grep '^postgres' | head -1)"

# ------------------------------------------------------------ already running?
if [[ "$FORCE" != "--force" ]]; then
  if docker exec pg-standby true 2>/dev/null; then
    state="$(docker exec pg-standby psql -U postgres -tAc \
      "SELECT CASE WHEN pg_is_in_recovery() THEN 'replica' ELSE 'promoted' END" 2>/dev/null || true)"
    if [[ "$state" == "replica" ]]; then
      echo "==> standby is already streaming — nothing to clone"
      docker exec pg-primary psql -U postgres -c \
        "SELECT application_name, state, sync_state FROM pg_stat_replication"
      exit 0
    fi
    echo "==> standby exists but its role is '$state' — use --force to re-clone it" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------ primary ready?
echo "==> bringing up pg-primary"
compose up -d pg-primary
for _ in $(seq 1 30); do
  docker exec pg-primary pg_isready -U postgres -d "${PG_DATABASE:-vas_revenue_tracking}" >/dev/null 2>&1 && break
  sleep 2
done
docker exec pg-primary pg_isready -U postgres >/dev/null

replicator_ok="$(docker exec pg-primary psql -U postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = 'replicator'")"
if [[ "$replicator_ok" != "1" ]]; then
  echo "==> pg-primary has no 'replicator' role — was its PGDATA initialised by pg-init/01-replication.sh?" >&2
  exit 1
fi

# The standby service must be stopped and removed before its volume is cloned,
# otherwise the running server would keep writing to the directory we replace.
compose rm -sf pg-standby >/dev/null 2>&1 || true

echo "==> wiping the standby volume"
compose run --rm --no-deps --user root --entrypoint sh pg-standby \
  -c "rm -rf '$PGDATA_PATH' && mkdir -p '$PGDATA_PATH' && chown -R 999:999 /var/lib/postgresql/data && chmod 700 '$PGDATA_PATH'"

# `compose run` (not a bare `docker run`) so the volume and network belong to the
# compose project — a hand-made volume makes every later `compose up` warn.
echo "==> cloning the primary (pg_basebackup)"
compose run --rm --no-deps --user 999:999 \
  -e PGPASSWORD="$PG_REPLICATION_PASSWORD" \
  --entrypoint pg_basebackup pg-standby \
  -h pg-primary -p 5432 -U replicator -D "$PGDATA_PATH" -X stream -R -P -v

echo "==> starting pg-standby"
compose up -d pg-standby

echo "==> waiting for the standby to accept read connections"
for _ in $(seq 1 30); do
  docker exec pg-standby psql -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 2
done

echo
echo "==> replication status (primary view)"
docker exec pg-primary psql -U postgres -c \
  "SELECT application_name, state, sync_state, sent_lsn, replay_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes
     FROM pg_stat_replication"
echo "==> replication status (standby view)"
docker exec pg-standby psql -U postgres -c \
  "SELECT pg_is_in_recovery() AS in_recovery, pg_last_wal_replay_lsn() AS replay_lsn, pg_is_wal_replay_paused() AS replay_paused"
echo
echo "==> image: $PG_IMAGE"
