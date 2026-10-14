#!/usr/bin/env bash
# Nightly PostgreSQL backup for the VAS Performance Tracker.
#
#   ~/backups/vas-pg-<YYYY-MM-DD>.sql.gz
#
# The System Health page reads exactly this pattern (and treats a <1KB file as a
# failed dump), so keep the naming.
#
# Install on the VPS (replacing the old mysqldump line — keep that one too while
# MySQL is retained as the rollback path):
#   15 2 * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh >> $HOME/backups/pg-backup.log 2>&1
#
# Plain-SQL format on purpose: restorable with psql, and greppable when you need
# to find one row. --no-owner keeps it restorable into a cluster whose roles
# differ from production's.
set -euo pipefail

# Git Bash on Windows rewrites /var/lib/... arguments; ignored on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

CONTAINER="${PG_CONTAINER:-pg-primary}"
DATABASE="${PG_DATABASE:-vas_revenue_tracking}"
PG_USER_NAME="${PG_BACKUP_USER:-postgres}"
BACKUPS_DIR="${BACKUPS_DIR:-$HOME/backups}"
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$BACKUPS_DIR"
FILE="$BACKUPS_DIR/vas-pg-$(date +%F).sql.gz"
TMP="$FILE.tmp"

if ! docker exec "$CONTAINER" pg_isready -U "$PG_USER_NAME" >/dev/null 2>&1; then
  echo "$(date -Iseconds) ERROR: $CONTAINER is not accepting connections — no backup written" >&2
  exit 1
fi

docker exec "$CONTAINER" pg_dump -U "$PG_USER_NAME" --no-owner --clean --if-exists "$DATABASE" \
  | gzip -6 > "$TMP"

# Never leave a half-written (or empty) dump in place: the health check would
# report it as a fresh, healthy backup.
SIZE="$(wc -c < "$TMP")"
if [[ "$SIZE" -lt 1000 ]] || ! gzip -t "$TMP" 2>/dev/null; then
  echo "$(date -Iseconds) ERROR: dump failed validation ($SIZE bytes) — keeping the previous backup" >&2
  rm -f "$TMP"
  exit 1
fi

mv "$TMP" "$FILE"
echo "$(date -Iseconds) wrote $FILE ($SIZE bytes)"

find "$BACKUPS_DIR" -maxdepth 1 -name 'vas-pg-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Iseconds) pruned backups older than ${KEEP_DAYS} days"
