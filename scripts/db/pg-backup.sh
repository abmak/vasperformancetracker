#!/usr/bin/env bash
# Tiered PostgreSQL backup for the VAS Performance Tracker.
#
#   nightly   ~/backups/vas-pg-<YYYY-MM-DD>.sql.gz            (keep 14 days)
#   hourly    ~/backups/vas-pg-hourly-<YYYY-MM-DD>-<HH>.sql.gz (keep newest 24)
#   10m       ~/backups/vas-pg-10m-<YYYY-MM-DD>-<HHMM>.sql.gz  (keep newest 6)
#
# Every tier writes the same validated plain-SQL pg_dump; they differ only in
# how often they run and how many are kept. That gives three restore horizons:
# recover from a mistake made minutes ago (10m), earlier today (hourly), or
# last week (nightly).
#
# The System Health page reads the `vas-pg-*.sql.gz` pattern in this directory
# and treats a <1KB file as a failed dump, so keep the naming.
#
# Install on the VPS (replacing the old mysqldump line — keep that one too while
# MySQL is retained as the rollback path):
#   */10 * * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=10m    >> $HOME/backups/pg-backup.log 2>&1
#   5    * * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=hourly >> $HOME/backups/pg-backup.log 2>&1
#   15   2 * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=nightly >> $HOME/backups/pg-backup.log 2>&1
#
# Running with no arguments keeps the original behaviour (= --tier=nightly), so
# the pre-existing cron line and the runbook restore command both still work.
#
# Plain-SQL format on purpose: restorable with psql, and greppable when you need
# to find one row. --no-owner keeps it restorable into a cluster whose roles
# differ from production's.
set -euo pipefail

# Git Bash on Windows rewrites /var/lib/... arguments; ignored on Linux.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

CONTAINER="${PG_CONTAINER:-pg-primary}"
FAILOVER_CONTAINER="${PG_FAILOVER_CONTAINER:-pg-standby}"
DATABASE="${PG_DATABASE:-vas_revenue_tracking}"
PG_USER_NAME="${PG_BACKUP_USER:-postgres}"
BACKUPS_DIR="${BACKUPS_DIR:-$HOME/backups}"

# ---- tier selection --------------------------------------------------------
TIER="${PG_BACKUP_TIER:-nightly}"
for arg in "$@"; do
  case "$arg" in
    --tier=*) TIER="${arg#--tier=}" ;;
    --nightly|-n) TIER=nightly ;;
    -h|--help)
      echo "usage: $(basename "$0") [--tier=10m|hourly|nightly]   (default: nightly)"
      exit 0
      ;;
    *) echo "$(date -Iseconds) ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

case "$TIER" in
  10m|hourly|nightly) ;;
  *) echo "$(date -Iseconds) ERROR: unknown tier '$TIER' (expected 10m, hourly or nightly)" >&2; exit 2 ;;
esac

KEEP_10M="${PG_BACKUP_KEEP_10M:-6}"          # 6 x 10m  = the last hour
KEEP_HOURLY="${PG_BACKUP_KEEP_HOURLY:-24}"   # 24 x 1h  = the last day
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-14}"       # 14 nights

mkdir -p "$BACKUPS_DIR"

# One dump per tier at a time. A tier that is still running is skipped rather
# than stacked up, so a slow dump can never pile up cron jobs behind it.
LOCK="$BACKUPS_DIR/.pg-backup-$TIER.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Iseconds) $TIER: previous run still in progress — skipping"
  exit 0
fi

# ---- pick the writable server ---------------------------------------------
# Normally pg-primary. After a failover the app promotes pg-standby and the old
# primary becomes a read-only replica — dumping it would produce a backup that
# looks fresh but is stale, which is worse than no backup at all. So take the
# dump from whichever container is actually out of recovery.
SOURCE=""
for candidate in "$CONTAINER" "$FAILOVER_CONTAINER"; do
  if ! docker exec "$candidate" pg_isready -U "$PG_USER_NAME" >/dev/null 2>&1; then
    continue
  fi
  in_recovery="$(docker exec "$candidate" psql -U "$PG_USER_NAME" -tAc 'SELECT pg_is_in_recovery()' 2>/dev/null || echo '')"
  if [[ "$in_recovery" == "f" ]]; then
    SOURCE="$candidate"
    break
  fi
done

if [[ -z "$SOURCE" ]]; then
  echo "$(date -Iseconds) $TIER: ERROR: no writable PostgreSQL container found ($CONTAINER, $FAILOVER_CONTAINER) — no backup written" >&2
  exit 1
fi

# ---- name the dump ---------------------------------------------------------
case "$TIER" in
  nightly) FILE="$BACKUPS_DIR/vas-pg-$(date +%F).sql.gz" ;;
  hourly)  FILE="$BACKUPS_DIR/vas-pg-hourly-$(date +%F-%H).sql.gz" ;;
  10m)     FILE="$BACKUPS_DIR/vas-pg-10m-$(date +%F-%H%M).sql.gz" ;;
esac
TMP="$FILE.tmp"

docker exec "$SOURCE" pg_dump -U "$PG_USER_NAME" --no-owner --clean --if-exists "$DATABASE" \
  | gzip -6 > "$TMP"

# Never leave a half-written (or empty) dump in place: the health check would
# report it as a fresh, healthy backup.
SIZE="$(wc -c < "$TMP")"
if [[ "$SIZE" -lt 1000 ]] || ! gzip -t "$TMP" 2>/dev/null; then
  echo "$(date -Iseconds) $TIER: ERROR: dump failed validation ($SIZE bytes) — keeping the previous backup" >&2
  rm -f "$TMP"
  exit 1
fi

mv "$TMP" "$FILE"
echo "$(date -Iseconds) $TIER: wrote $FILE ($SIZE bytes from $SOURCE)"

# ---- per-tier retention ----------------------------------------------------
# Names are date-ordered, so a reverse sort lists newest first.
prune_to_count() {
  local pattern="$1" keep="$2" label="$3"
  mapfile -t stale < <(
    find "$BACKUPS_DIR" -maxdepth 1 -name "$pattern" -printf '%f\n' | sort -r | tail -n +"$((keep + 1))"
  )
  local f
  for f in "${stale[@]:-}"; do
    [[ -n "$f" ]] && rm -f "$BACKUPS_DIR/$f"
  done
  echo "$(date -Iseconds) $label: pruned to newest $keep (${#stale[@]} removed)"
}

case "$TIER" in
  10m)     prune_to_count 'vas-pg-10m-*.sql.gz'    "$KEEP_10M"    "$TIER" ;;
  hourly)  prune_to_count 'vas-pg-hourly-*.sql.gz' "$KEEP_HOURLY" "$TIER" ;;
  nightly)
    # Scoped to the nightly name only — the 10m/hourly tiers have their own,
    # much shorter retention and must not be swept away by a 14-day rule.
    find "$BACKUPS_DIR" -maxdepth 1 -name 'vas-pg-[0-9][0-9][0-9][0-9]-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
    echo "$(date -Iseconds) $TIER: pruned backups older than ${KEEP_DAYS} days"
    ;;
esac
