#!/bin/bash
# Node SSR deploy for HumaticAI-LLC/sailgg (TanStack Start + Nitro node-server)
set -euo pipefail

REPO_KEY="${1:-HumaticAI-LLC/sailgg}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
LOCAL_PATH="/home/digitalpeers/sailgg"
BRANCH="main"
RELEASES_ROOT="${RELEASES_ROOT:-/var/www/releases/sailgg}"
LIVE_LINK="${DEPLOY_PATH:-/var/www/releases/sailgg/live}"
BUILD_LOG="$SCRIPT_DIR/logs/sailgg_last_build.log"
ENV_FILE="${SAILGG_ENV_FILE:-$LOCAL_PATH/.env.production}"
KEEP_RELEASES=5

export PATH="/home/digitalpeers/.bun/bin:/opt/node22/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
export NITRO_PRESET=node-server
# This host has ~1 GiB RAM. Bun ignores V8 heap flags, so the build runs on Node 22
# with a hard heap cap. A cgroup scope stops the build before the OOM killer
# takes SSH or the live app.
BUILD_NODE="/opt/node22/bin/node"
BUILD_HEAP_MB=512
BUILD_MEM_MAX="640M"
BUILD_SWAP_MAX="256M"
export NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=${BUILD_HEAP_MB}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

rollback_to() {
  local prev="$1"
  if [ -z "$prev" ] || [ ! -d "$prev" ]; then
    log "ERROR: rollback target missing ($prev)"
    return 1
  fi
  log "ROLLBACK: $LIVE_LINK -> $prev"
  ln -sfn "$prev" "$LIVE_LINK"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k 3100/tcp 2>/dev/null || true
    sleep 1
  fi
  pm2 delete sailgg 2>/dev/null || true
  pm2 start "$SCRIPT_DIR/ecosystem.sailgg.config.cjs"
  pm2 save 2>/dev/null || true
}

http_code() {
  local path="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:3100${path}" 2>/dev/null || echo "000"
}

mkdir -p "$SCRIPT_DIR/logs" "$RELEASES_ROOT"

LOCK_FILE="$SCRIPT_DIR/logs/sailgg-deploy.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ERROR: another sailgg deploy is already running ($LOCK_FILE)"
  exit 75
fi

MEM_AVAIL_KB="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
log "MemAvailable ${MEM_AVAIL_KB} kB (build heap ${BUILD_HEAP_MB} MiB, cgroup max ${BUILD_MEM_MAX})"
if [ "${MEM_AVAIL_KB:-0}" -lt 180000 ]; then
  log "WARN: under 180 MiB available — build stays inside its cgroup and may use a little swap"
fi

if [ ! -d "$LOCAL_PATH/.git" ]; then
  log "ERROR: clone missing at $LOCAL_PATH"
  exit 30
fi

cd "$LOCAL_PATH"
git fetch origin "$BRANCH"
TARGET_SHA="$(git rev-parse "origin/$BRANCH")"
git reset --hard "$TARGET_SHA"
log "Pinned $TARGET_SHA"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

log "Installing dependencies (bun)..."
bun install --frozen-lockfile 2>/dev/null || bun install

log "Building with $BUILD_NODE (NITRO_PRESET=node-server)..."
rm -rf .output
if ! systemd-run --user --scope \
  -p "MemoryHigh=480M" \
  -p "MemoryMax=${BUILD_MEM_MAX}" \
  -p "MemorySwapMax=${BUILD_SWAP_MAX}" \
  -- "$BUILD_NODE" --max-old-space-size="$BUILD_HEAP_MB" ./node_modules/vite/bin/vite.js build \
  >"$BUILD_LOG" 2>&1; then
  log "ERROR: build failed (see $BUILD_LOG)"
  tail -30 "$BUILD_LOG"
  exit 10
fi

if [ ! -f ".output/server/index.mjs" ]; then
  log "ERROR: missing .output/server/index.mjs"
  exit 10
fi

SHORT_SHA="$(echo "$TARGET_SHA" | cut -c1-12)"
NEW_RELEASE="$RELEASES_ROOT/$SHORT_SHA"
rm -rf "$NEW_RELEASE"
mkdir -p "$NEW_RELEASE"
cp -a .output/. "$NEW_RELEASE/"
echo "deploy=$TARGET_SHA $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$NEW_RELEASE/DEPLOY_STAMP"

PREV_RELEASE=""
if [ -L "$LIVE_LINK" ]; then
  PREV_RELEASE="$(readlink -f "$LIVE_LINK" 2>/dev/null || true)"
fi

ln -sfn "$NEW_RELEASE" "$LIVE_LINK.new.$$"
mv -T "$LIVE_LINK.new.$$" "$LIVE_LINK"
log "Live symlink: $LIVE_LINK -> $NEW_RELEASE"

PM2_APP="$SCRIPT_DIR/ecosystem.sailgg.config.cjs"
# Reload can leave a zombie on :3100 if the old Node did not exit; ensure port is free.
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3100/tcp 2>/dev/null || true
  sleep 1
fi
pm2 delete sailgg 2>/dev/null || true
pm2 start "$PM2_APP"
pm2 save 2>/dev/null || true

# Prune old releases (not live)
CURRENT="$(readlink -f "$LIVE_LINK" 2>/dev/null || true)"
ls -1dt "$RELEASES_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
  real="$(readlink -f "$d" 2>/dev/null || echo "$d")"
  if [ -n "$CURRENT" ] && [ "$real" = "$CURRENT" ]; then continue; fi
  rm -rf "$d"
done

if command -v curl &>/dev/null; then
  sleep 4
  code_ru="$(http_code /ru)"
  code_sm="$(http_code /sitemap.xml)"
  log "Health: GET /ru -> HTTP $code_ru, GET /sitemap.xml -> HTTP $code_sm"
  if [ "$code_ru" != "200" ] || [ "$code_sm" != "200" ]; then
    log "ERROR: health check failed (need 200 on /ru and /sitemap.xml)"
    if [ -n "$PREV_RELEASE" ] && [ "$PREV_RELEASE" != "$NEW_RELEASE" ]; then
      rollback_to "$PREV_RELEASE" || true
    fi
    exit 20
  fi
  if ! curl -sS --max-time 15 http://127.0.0.1:3100/sitemap.xml | grep -q '<loc>https://sailgg.com/'; then
    log "ERROR: sitemap does not use https://sailgg.com URLs"
    if [ -n "$PREV_RELEASE" ] && [ "$PREV_RELEASE" != "$NEW_RELEASE" ]; then
      rollback_to "$PREV_RELEASE" || true
    fi
    exit 20
  fi
fi

if bash "$LOCAL_PATH/ops/apply-cloudflare-edge.sh" 2>/dev/null; then
  log "Cloudflare edge settings checked"
fi

log "SUCCESS sailgg $SHORT_SHA"
exit 0