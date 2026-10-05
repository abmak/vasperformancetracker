#!/usr/bin/env bash
#
# Runs ON the production VPS. Driven by `node scripts/deploy.js` from the dev
# machine (this box has no outbound internet, so it can never `git pull` — the
# artifacts are shipped to it instead, but always extracted from a committed
# revision).
#
# Design notes
#   • Keeps the existing directory layout, so pm2, the .env.production file,
#     node_modules, uploads/ and acme-challenges/ are never disturbed. Only the
#     deployed source (backend/src, backend/package*.json, frontend/dist) moves.
#   • Every applied commit is snapshotted under .deploy/releases/<sha>/ so any
#     earlier commit can be restored with one `rollback` call.
#   • Swaps are staged into *.new and only then moved into place, so a failure
#     mid-way cannot leave the app half-written.
#
set -euo pipefail

APP_DIR="${VAS_APP_DIR:-/var/www/performancetracking/app}"
PM2_NAME="${VAS_PM2_NAME:-perf-tracking-api}"
DEPLOY_ROOT="$APP_DIR/.deploy"
RELEASES="$DEPLOY_ROOT/releases"
INCOMING="$DEPLOY_ROOT/incoming"
BUNDLE_PATHS=(backend/src backend/package.json backend/package-lock.json)

cd "$APP_DIR"

die() { echo "ERROR: $*" >&2; exit 1; }

# snapshot <sha> — record the currently-live source so this commit can be restored
snapshot() {
  local sha="$1" rel="$RELEASES/$1"
  local paths=()
  for p in "${BUNDLE_PATHS[@]}"; do [ -e "$p" ] && paths+=("$p"); done
  mkdir -p "$rel"
  tar -czf "$rel/backend.tgz" "${paths[@]}"
  # Stored with the same `dist/`-rooted layout as the incoming artifact, so
  # rollback can use the same --strip-components=1 extraction as apply.
  if [ -d frontend/dist ]; then tar -czf "$rel/dist.tgz" -C frontend dist; fi
  echo "$sha" > "$DEPLOY_ROOT/CURRENT"
}

# swap_in <extract-root> — move staged backend source into place
swap_in() {
  local src="$1"
  [ -d "$src/backend/src" ] || die "staged backend/src is missing"
  rm -rf backend/src.new
  cp -a "$src/backend/src" backend/src.new
  rm -rf backend/src.old
  mv backend/src backend/src.old
  mv backend/src.new backend/src
  rm -rf backend/src.old
  cp -a "$src/backend/package.json" backend/package.json
  if [ -f "$src/backend/package-lock.json" ]; then
    cp -a "$src/backend/package-lock.json" backend/package-lock.json
  fi
}

# swap_dist <dist.tgz> — replace frontend/dist atomically
swap_dist() {
  local tgz="$1"
  rm -rf frontend/dist.new
  mkdir -p frontend/dist.new
  tar -xzf "$tgz" -C frontend/dist.new --strip-components=1
  rm -rf frontend/dist.old
  if [ -d frontend/dist ]; then mv frontend/dist frontend/dist.old; fi
  mv frontend/dist.new frontend/dist
  rm -rf frontend/dist.old
}

apply() {
  local sha="$1" keep="${2:-6}"
  [ -d "$INCOMING" ] || die "no incoming artifacts — run the local deploy script"
  rm -rf "$DEPLOY_ROOT/stage"
  mkdir -p "$DEPLOY_ROOT/stage"
  tar -xzf "$INCOMING/backend.tar.gz" -C "$DEPLOY_ROOT/stage"
  swap_in "$DEPLOY_ROOT/stage"
  if [ -f "$INCOMING/dist.tar.gz" ]; then swap_dist "$INCOMING/dist.tar.gz"; fi

  snapshot "$sha"

  # prune everything older than `keep`
  ( cd "$RELEASES" && ls -1dt */ 2>/dev/null | sed -n "$((keep+1)),\$p" | while read -r d; do rm -rf "$d"; done )

  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true
  echo "APPLIED $sha"
}

rollback() {
  local sha="$1"
  [ -n "$sha" ] || die "rollback needs a release id"
  local rel="$RELEASES/$sha"
  [ -d "$rel" ] || die "unknown release: $sha (run: remote-deploy.sh list)"
  rm -rf "$DEPLOY_ROOT/rb"
  mkdir -p "$DEPLOY_ROOT/rb"
  tar -xzf "$rel/backend.tgz" -C "$DEPLOY_ROOT/rb"
  swap_in "$DEPLOY_ROOT/rb"
  if [ -f "$rel/dist.tgz" ]; then swap_dist "$rel/dist.tgz"; fi
  echo "$sha" > "$DEPLOY_ROOT/CURRENT"
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || true
  echo "ROLLED_BACK $sha"
}

list() {
  echo "current=$(cat "$DEPLOY_ROOT/CURRENT" 2>/dev/null || echo none)"
  if [ -d "$RELEASES" ]; then
    ls -1dt "$RELEASES"/*/ 2>/dev/null | sed "s#$RELEASES/##; s#/\$##" || true
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  apply)    apply "$@" ;;
  rollback) rollback "$@" ;;
  list)     list ;;
  *) echo "usage: remote-deploy.sh {apply <sha> [keep] | rollback <sha> | list}" >&2; exit 1 ;;
esac
