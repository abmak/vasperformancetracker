#!/bin/sh
# First-initialisation hook for the PostgreSQL primary (runs inside the
# container, as postgres, only when PGDATA is empty).
#
# It does the things the image cannot do on its own for a two-container setup:
#   1. a `replicator` role for the standby's streaming connection
#   2. an application role (`vas_app`) so the API does not run as the superuser
#   3. a pg_hba line allowing replication from the OTHER container — initdb only
#      trusts replication from 127.0.0.1, which is not where the standby connects
#      from on the compose network
#   4. ownership of the database + schema by the app role, so the migration and
#      the app's own CREATE TABLE statements are allowed to run as that role
set -eu

: "${POSTGRES_REPLICATION_PASSWORD:?POSTGRES_REPLICATION_PASSWORD is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${PG_APP_USER:=vas_app}"
: "${POSTGRES_DB:=vas_revenue_tracking}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') THEN
      CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${POSTGRES_REPLICATION_PASSWORD}';
    ELSE
      ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '${POSTGRES_REPLICATION_PASSWORD}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_APP_USER}') THEN
      CREATE ROLE ${PG_APP_USER} LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}' CREATEDB;
    ELSE
      ALTER ROLE ${PG_APP_USER} WITH LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}' CREATEDB;
    END IF;
  END
  \$\$;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- The app role owns the data it creates (the migration drops and recreates
  -- schema public, and dbFailoverEvents/guide create tables at runtime).
  ALTER DATABASE "$POSTGRES_DB" OWNER TO ${PG_APP_USER};
  ALTER SCHEMA public OWNER TO ${PG_APP_USER};
  GRANT ALL ON SCHEMA public TO ${PG_APP_USER};

  -- Failover must be able to promote the standby: a PostgreSQL replica rejects
  -- writes until it has been promoted, so the app needs this one superuser-only
  -- function (granted explicitly rather than making the app a superuser).
  GRANT EXECUTE ON FUNCTION pg_promote(boolean, integer) TO ${PG_APP_USER};
  -- …and the System Health "pause/resume replication" control needs these two
  -- (also superuser-only by default).
  GRANT EXECUTE ON FUNCTION pg_wal_replay_pause() TO ${PG_APP_USER};
  GRANT EXECUTE ON FUNCTION pg_wal_replay_resume() TO ${PG_APP_USER};
  GRANT pg_monitor TO ${PG_APP_USER};
EOSQL

# Replication from another container (any address) — still unreachable from
# outside, because the port is only published on 127.0.0.1.
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c 'SELECT pg_reload_conf();' >/dev/null

echo "pg-init: replicator + ${PG_APP_USER} roles ready, replication hba added"
