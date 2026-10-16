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
#   *    * * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=10m    >> $HOME/backups/pg-backup.log 2>&1
#   5    * * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=hourly >> $HOME/backups/pg-backup.log 2>&1
#   15   2 * * * /var/www/performancetracking/pg/scripts/db/pg-backup.sh --tier=nightly >> $HOME/backups/pg-backup.log 2>&1
#
# The 10m tier is the one that runs every minute and decides for itself whether
# it is DUE, so its interval is not baked into the cron line: the master admin
# sets it on the System Health page and this script picks it up from
# ~/pg-standby/backup-config.json (see "frequent-tier interval" below). The other
# two tiers stay clock-anchored by cron. The 10m prefix in the file name is the
# tier's stable id, not its current interval — the health page shows the real
# one — and keeping it preserves the naming/retention the page already matches.
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
      echo "usage: $(basename "$0") [--tier=10m|hourly|nightly] [--dry-run]   (default: nightly)"
      exit 0
      ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "$(date -Iseconds) ERROR: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

case "$TIER" in
  10m|hourly|nightly) ;;
  *) echo "$(date -Iseconds) ERROR: unknown tier '$TIER' (expected 10m, hourly or nightly)" >&2; exit 2 ;;
esac

KEEP_HOURLY="${PG_BACKUP_KEEP_HOURLY:-24}"   # 24 x 1h  = the last day
KEEP_DAYS="${PG_BACKUP_KEEP_DAYS:-14}"       # 14 nights

# ---- frequent-tier interval ------------------------------------------------
# How often the 10m tier actually dumps. Written by the app (System Health →
# the dump card) into a file shared with the container; read here so the host
# needs no redeploy to change cadence. Bounds match the endpoint's, so a value
# the page accepted is never rejected here. Failing closed on an unreadable or
# silly value means a bad file can only ever slow the tier back to its default —
# never stop it, and never dump in a tight loop.
MIN_INTERVAL=1
MAX_INTERVAL=60
DEFAULT_INTERVAL=10
INTERVAL_CONFIG="${PG_BACKUP_CONFIG_FILE:-$HOME/pg-standby/backup-config.json}"

read_interval_minutes() {
  local minutes=""
  if [[ -r "$INTERVAL_CONFIG" ]]; then
    minutes="$(sed -n 's/.*"intervalMinutes"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$INTERVAL_CONFIG" 2>/dev/null | head -1)"
  fi
  if [[ ! "$minutes" =~ ^[0-9]+$ ]] || (( minutes < MIN_INTERVAL )) || (( minutes > MAX_INTERVAL )); then
    minutes="${PG_BACKUP_INTERVAL_MINUTES:-$DEFAULT_INTERVAL}"
  fi
  if [[ ! "$minutes" =~ ^[0-9]+$ ]] || (( minutes < MIN_INTERVAL )) || (( minutes > MAX_INTERVAL )); then
    minutes="$DEFAULT_INTERVAL"
  fi
  printf '%s' "$minutes"
}

INTERVAL_MIN="$DEFAULT_INTERVAL"
KEEP_10M="${PG_BACKUP_KEEP_10M:-}"
if [[ "$TIER" == "10m" ]]; then
  INTERVAL_MIN="$(read_interval_minutes)"
  # Keep about an hour of the tier (6 files at the 10-minute default, exactly as
  # before this was configurable) rather than a fixed count that would shrink to
  # minutes at a short interval or stretch to half a day at a long one.
  if [[ -z "$KEEP_10M" ]]; then
    KEEP_10M=$(( (60 + INTERVAL_MIN - 1) / INTERVAL_MIN ))
    (( KEEP_10M < 2 )) && KEEP_10M=2
  fi
fi
KEEP_10M="${KEEP_10M:-6}"

mkdir -p "$BACKUPS_DIR"

# ---- is the frequent tier due? ---------------------------------------------
# Cron wakes this tier every minute; elapsed time — not the clock — decides
# whether to dump, so any interval works, a late or missed cron minute heals
# itself on the next one, and a failed run is retried a minute later instead of
# being skipped for a whole window.
LAST_RUN_FILE=""
if [[ "$TIER" == "10m" ]]; then
  INTERVAL_SEC=$(( INTERVAL_MIN * 60 ))
  LAST_RUN_FILE="$BACKUPS_DIR/.pg-backup-10m.last"
  NOW="$(date +%s)"
  LAST_RUN=0
  [[ -r "$LAST_RUN_FILE" ]] && LAST_RUN="$(cat "$LAST_RUN_FILE" 2>/dev/null || echo 0)"
  [[ "$LAST_RUN" =~ ^[0-9]+$ ]] || LAST_RUN=0
  ELAPSED=$(( NOW - LAST_RUN ))
  # 30s of slack: a cron minute that lands slightly early is still due.
  if (( LAST_RUN > 0 && ELAPSED < INTERVAL_SEC - 30 )); then
    echo "$(date -Iseconds) 10m: not due — $((ELAPSED / 60)) of ${INTERVAL_MIN} min elapsed (interval $INTERVAL_CONFIG)"
    exit 0
  fi
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  if [[ "$TIER" == "10m" ]]; then
    echo "$(date -Iseconds) $TIER: dry run — due, would dump now (interval ${INTERVAL_MIN} min, keep ${KEEP_10M}, config $INTERVAL_CONFIG)"
  else
    echo "$(date -Iseconds) $TIER: dry run — would dump now"
  fi
  exit 0
fi

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
echo "$(date -Iseconds) $TIER: wrote $FILE ($SIZE bytes from $SOURCE, interval ${INTERVAL_MIN} min)"

# Only a completed dump resets the due clock — a failure above leaves it due, so
# the next cron minute retries.
if [[ -n "$LAST_RUN_FILE" ]]; then
  date +%s > "$LAST_RUN_FILE"
fi

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
