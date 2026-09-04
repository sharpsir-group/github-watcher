#!/bin/bash
# Universal Deploy Script for GitHub Watcher
# Usage: deploy.sh <repo-key>
# Example: deploy.sh "your-org/your-repo"
#
# Exit codes (classified for the webhook server):
#   0  success
#   10 deterministic build failure (compile error, empty dist)
#   20 transient infra failure (timeout, git fetch, network)
#   30 fatal environment (missing clone, lock held, disk)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
LOG_DIR="$SCRIPT_DIR/logs"
RELEASES_ROOT="${RELEASES_ROOT:-/opt/bitnami/apache/releases}"
DEFAULT_BUILD_TIMEOUT_SEC=900
KEEP_RELEASES=5
KEEP_LOGS=100

# Exit-code constants
EXIT_OK=0
EXIT_BUILD=10
EXIT_TRANSIENT=20
EXIT_FATAL=30

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log_error() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${RED}ERROR: $1${NC}"
}

log_success() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${GREEN}SUCCESS: $1${NC}"
}

log_warning() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] ${YELLOW}WARNING: $1${NC}"
}

die() {
    local code="$1"
    shift
    log_error "$*"
    exit "$code"
}

# --- args ---
if [ -z "${1:-}" ]; then
    log_error "No repository key provided"
    echo "Usage: $0 <repo-key>"
    exit "$EXIT_FATAL"
fi

REPO_KEY="$1"

if command -v jq &> /dev/null; then
    USE_JQ=true
else
    USE_JQ=false
fi

get_json_value() {
    local key="$1"
    node -e "
        const config = require('$CONFIG_FILE');
        const repo = config.repos['$REPO_KEY'];
        if (!repo) { console.error('Repo not found'); process.exit(1); }
        const value = $key;
        if (typeof value === 'object') {
            console.log(JSON.stringify(value));
        } else {
            console.log(value || '');
        }
    "
}

log "Loading configuration for: $REPO_KEY"

if [ ! -f "$CONFIG_FILE" ]; then
    die "$EXIT_FATAL" "Config file not found: $CONFIG_FILE"
fi

if [ "$USE_JQ" = true ]; then
    REPO_CONFIG=$(jq -r ".repos[\"$REPO_KEY\"]" "$CONFIG_FILE")
    if [ "$REPO_CONFIG" = "null" ]; then
        die "$EXIT_FATAL" "Repository '$REPO_KEY' not found in config"
    fi

    NAME=$(echo "$REPO_CONFIG" | jq -r '.name')
    LOCAL_PATH=$(echo "$REPO_CONFIG" | jq -r '.localPath')
    DEPLOY_PATH=$(echo "$REPO_CONFIG" | jq -r '.deployPath')
    BRANCH=$(echo "$REPO_CONFIG" | jq -r '.branch')
    BUILD_CMD=$(echo "$REPO_CONFIG" | jq -r '.buildCmd')
    DIST_FOLDER=$(echo "$REPO_CONFIG" | jq -r '.distFolder')
    PRE_BUILD=$(echo "$REPO_CONFIG" | jq -c '.preBuild // []')
    POST_DEPLOY=$(echo "$REPO_CONFIG" | jq -c '.postDeploy // []')
    BUILD_TIMEOUT_SEC=$(echo "$REPO_CONFIG" | jq -r '.buildTimeoutSec // empty')
else
    NAME=$(get_json_value "repo.name")
    LOCAL_PATH=$(get_json_value "repo.localPath")
    DEPLOY_PATH=$(get_json_value "repo.deployPath")
    BRANCH=$(get_json_value "repo.branch")
    BUILD_CMD=$(get_json_value "repo.buildCmd")
    DIST_FOLDER=$(get_json_value "repo.distFolder")
    PRE_BUILD=$(get_json_value "repo.preBuild || []")
    POST_DEPLOY=$(get_json_value "repo.postDeploy || []")
    BUILD_TIMEOUT_SEC=$(get_json_value "repo.buildTimeoutSec || ''")
fi

if [ -z "${BUILD_TIMEOUT_SEC:-}" ] || [ "$BUILD_TIMEOUT_SEC" = "null" ]; then
    BUILD_TIMEOUT_SEC="${BUILD_TIMEOUT:-$DEFAULT_BUILD_TIMEOUT_SEC}"
fi

SAFE_REPO_NAME=$(echo "$REPO_KEY" | tr '/' '_')
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SAFE_REPO_NAME}_$(date '+%Y%m%d_%H%M%S').log"

log "Deploying: $NAME"
log "Log file: $LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

log "Configuration loaded:"
log "  Local Path: $LOCAL_PATH"
log "  Deploy Path: $DEPLOY_PATH"
log "  Branch: $BRANCH"
log "  Build Command: $BUILD_CMD"
log "  Dist Folder: $DIST_FOLDER"
log "  Build Timeout: ${BUILD_TIMEOUT_SEC}s"

if [ ! -d "$LOCAL_PATH" ]; then
    die "$EXIT_FATAL" "Local path does not exist: $LOCAL_PATH"
fi
if [ ! -d "$LOCAL_PATH/.git" ]; then
    die "$EXIT_FATAL" "Not a git repository: $LOCAL_PATH"
fi

APP_SUBPATH="$(basename "$DEPLOY_PATH")"
RELEASE_BASE="$RELEASES_ROOT/$APP_SUBPATH"
mkdir -p "$RELEASE_BASE"

# State for cleanup / traps
declare -a PATCHED_FILES=()
LOCK_FD=""
LOCK_FILE="$LOCAL_PATH/.deploy.lock"
PREV_RELEASE=""
NEW_RELEASE=""
TARGET_SHA=""
SWAP_DONE=0
PATCHES_APPLIED=0

# --- helpers ---

is_transient_output() {
    local text="$1"
    echo "$text" | grep -Eiq \
        'ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ENOTFOUND|socket hang up|network|fetch failed|getaddrinfo|registry\.npmjs|npm ERR! network|temporary failure|Connection timed out|Could not resolve host|TLS handshake timeout'
}

classify_build_failure() {
    local build_exit="$1"
    local build_log="$2"
    if [ "$build_exit" -eq 124 ] || [ "$build_exit" -eq 137 ]; then
        echo "$EXIT_TRANSIENT"
        return
    fi
    if is_transient_output "$build_log"; then
        echo "$EXIT_TRANSIENT"
        return
    fi
    echo "$EXIT_BUILD"
}

sweep_orphans() {
    # Kill leftover build children whose cwd is under LOCAL_PATH (best-effort).
    local pids
    pids=$(pgrep -f "$LOCAL_PATH" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        log_warning "Sweeping leftover processes under $LOCAL_PATH: $pids"
        # shellcheck disable=SC2086
        kill -TERM $pids 2>/dev/null || true
        sleep 2
        # shellcheck disable=SC2086
        kill -KILL $pids 2>/dev/null || true
    fi
}

revert_patches() {
    if [ "${PATCHES_APPLIED:-0}" -eq 0 ]; then
        return 0
    fi
    log "Reverting patches via git checkout..."
    local f
    for f in "${PATCHED_FILES[@]:-}"; do
        if [ -n "$f" ] && [ -f "$LOCAL_PATH/$f" ]; then
            (cd "$LOCAL_PATH" && git checkout -- "$f") || true
            log "Reverted: $f"
        fi
    done
    PATCHES_APPLIED=0
}

release_lock() {
    if [ -n "${LOCK_FD:-}" ]; then
        flock -u "$LOCK_FD" 2>/dev/null || true
        eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
        LOCK_FD=""
    fi
}

cleanup_on_exit() {
    local code=$?
    # Auto-rollback if we swapped but verification failed / we aborted after swap
    if [ "$SWAP_DONE" -eq 1 ] && [ -n "${PREV_RELEASE:-}" ] && [ "$code" -ne 0 ]; then
        log_warning "Post-swap failure — rolling back to previous release"
        rollback_to "$PREV_RELEASE" || true
        SWAP_DONE=0
    fi
    revert_patches || true
    release_lock || true
    # Remove unfinished release dir if we never swapped to it
    if [ "$SWAP_DONE" -eq 0 ] && [ -n "${NEW_RELEASE:-}" ] && [ -d "${NEW_RELEASE:-}" ]; then
        if [ ! -L "$DEPLOY_PATH" ] || [ "$(readlink -f "$DEPLOY_PATH" 2>/dev/null || true)" != "$(readlink -f "$NEW_RELEASE" 2>/dev/null || true)" ]; then
            log "Removing unfinished release: $NEW_RELEASE"
            rm -rf "$NEW_RELEASE" || true
        fi
    fi
}

trap cleanup_on_exit EXIT
trap 'die "$EXIT_FATAL" "Interrupted by signal"' INT TERM

acquire_lock() {
    # Prefer FD 200; fall back if already in use
    LOCK_FD=200
    eval "exec ${LOCK_FD}>\"$LOCK_FILE\"" || die "$EXIT_FATAL" "Cannot open lock file: $LOCK_FILE"
    if ! flock -n "$LOCK_FD"; then
        die "$EXIT_FATAL" "Deploy lock held for $LOCAL_PATH — another deploy is in progress"
    fi
    log "Acquired deploy lock: $LOCK_FILE"
}

apply_patches() {
    log "Applying preBuild patches..."

    local PATCH_COUNT
    if [ "$USE_JQ" = true ]; then
        PATCH_COUNT=$(echo "$PRE_BUILD" | jq 'length')
    else
        PATCH_COUNT=$(node -e "console.log(($PRE_BUILD).length)")
    fi

    if [ "$PATCH_COUNT" -eq 0 ]; then
        log "No patches to apply"
        return 0
    fi

    local i PATCH_FILE FULL_PATH
    for ((i=0; i<PATCH_COUNT; i++)); do
        if [ "$USE_JQ" = true ]; then
            PATCH_FILE=$(echo "$PRE_BUILD" | jq -r ".[$i].file")
        else
            PATCH_FILE=$(node -e "console.log(($PRE_BUILD)[$i].file)")
        fi

        FULL_PATH="$LOCAL_PATH/$PATCH_FILE"

        if [ -f "$FULL_PATH" ]; then
            # Track for git checkout revert (dedupe)
            local seen=0
            local existing
            for existing in "${PATCHED_FILES[@]:-}"; do
                if [ "$existing" = "$PATCH_FILE" ]; then
                    seen=1
                    break
                fi
            done
            if [ "$seen" -eq 0 ]; then
                PATCHED_FILES+=("$PATCH_FILE")
            fi

            node -e "
                const fs = require('fs');
                const config = require('$CONFIG_FILE');
                const patch = config.repos['$REPO_KEY'].preBuild[$i];
                const filePath = '$FULL_PATH';
                const content = fs.readFileSync(filePath, 'utf8');

                if (patch.regex) {
                    const re = new RegExp(patch.find, 'g');
                    if (re.test(content)) {
                        re.lastIndex = 0;
                        fs.writeFileSync(filePath, content.replace(re, patch.replace));
                        console.log('Patched (regex): $PATCH_FILE');
                    } else {
                        console.log('Regex not matched in $PATCH_FILE (may already be correct)');
                    }
                } else {
                    if (content.includes(patch.find)) {
                        fs.writeFileSync(filePath, content.replace(patch.find, patch.replace));
                        console.log('Patched: $PATCH_FILE');
                    } else {
                        console.log('Pattern not found in $PATCH_FILE (may already be patched)');
                    }
                }
            "
            PATCHES_APPLIED=1
        else
            log_warning "Patch file not found: $FULL_PATH"
        fi
    done
}

run_post_deploy() {
    log "Running postDeploy commands..."

    local CMD_COUNT
    if [ "$USE_JQ" = true ]; then
        CMD_COUNT=$(echo "$POST_DEPLOY" | jq 'length')
    else
        CMD_COUNT=$(node -e "console.log(($POST_DEPLOY).length)")
    fi

    if [ "$CMD_COUNT" -eq 0 ]; then
        log "No postDeploy commands"
        return 0
    fi

    local i CMD
    for ((i=0; i<CMD_COUNT; i++)); do
        if [ "$USE_JQ" = true ]; then
            CMD=$(echo "$POST_DEPLOY" | jq -r ".[$i]")
        else
            CMD=$(node -e "console.log(($POST_DEPLOY)[$i])")
        fi

        CMD="${CMD//\$DEPLOY_PATH/$DEPLOY_PATH}"

        log "Executing: $CMD"
        eval "$CMD"
    done
}

invalidate_cloudfront() {
    log "Checking CloudFront invalidation config..."

    local CF_DIST_ID=""
    local CF_PATHS=""

    if [ "$USE_JQ" = true ]; then
        CF_DIST_ID=$(jq -r ".repos[\"$REPO_KEY\"].cloudfront.distributionId // empty" "$CONFIG_FILE")
        CF_PATHS=$(jq -r ".repos[\"$REPO_KEY\"].cloudfront.invalidationPaths // [] | .[]" "$CONFIG_FILE")
    else
        CF_DIST_ID=$(node -e "
            const config = require('$CONFIG_FILE');
            const repo = config.repos['$REPO_KEY'];
            console.log((repo.cloudfront && repo.cloudfront.distributionId) || '');
        ")
        CF_PATHS=$(node -e "
            const config = require('$CONFIG_FILE');
            const repo = config.repos['$REPO_KEY'];
            const paths = (repo.cloudfront && repo.cloudfront.invalidationPaths) || [];
            paths.forEach(p => console.log(p));
        ")
    fi

    if [ -z "$CF_DIST_ID" ]; then
        log "No CloudFront distribution configured, skipping invalidation"
        return 0
    fi

    if [ -z "$CF_PATHS" ]; then
        log_warning "CloudFront distribution set but no invalidation paths configured"
        return 0
    fi

    if ! command -v aws &> /dev/null; then
        log_warning "AWS CLI not installed, skipping CloudFront invalidation"
        return 0
    fi

    local PATHS_ARG=""
    while IFS= read -r path; do
        if [ -n "$path" ]; then
            PATHS_ARG="$PATHS_ARG \"$path\""
        fi
    done <<< "$CF_PATHS"

    log "Invalidating CloudFront distribution: $CF_DIST_ID"
    log "Paths: $PATHS_ARG"

    local CF_OUTPUT
    if CF_OUTPUT=$(eval aws cloudfront create-invalidation \
        --distribution-id "$CF_DIST_ID" \
        --paths $PATHS_ARG 2>&1); then
        log_success "CloudFront invalidation created"
        log "$CF_OUTPUT"
    else
        log_warning "CloudFront invalidation failed (check AWS credentials/permissions)"
        log_warning "Output: $CF_OUTPUT"
    fi
}

purge_cloudflare_cache() {
    log "Checking Cloudflare cache purge config..."

    local CF_ZONE_ID=""
    local CF_PURGE_ALL=""
    local CF_TOKEN_KEY=""

    if [ "$USE_JQ" = true ]; then
        CF_ZONE_ID=$(jq -r ".repos[\"$REPO_KEY\"].cloudflare.zoneId // empty" "$CONFIG_FILE")
        CF_PURGE_ALL=$(jq -r ".repos[\"$REPO_KEY\"].cloudflare.purgeEverything // empty" "$CONFIG_FILE")
        CF_TOKEN_KEY=$(jq -r ".repos[\"$REPO_KEY\"].cloudflare.apiTokenKey // empty" "$CONFIG_FILE")
    else
        CF_ZONE_ID=$(node -e "
            const config = require('$CONFIG_FILE');
            const repo = config.repos['$REPO_KEY'];
            console.log((repo.cloudflare && repo.cloudflare.zoneId) || '');
        ")
        CF_PURGE_ALL=$(node -e "
            const config = require('$CONFIG_FILE');
            const repo = config.repos['$REPO_KEY'];
            console.log((repo.cloudflare && repo.cloudflare.purgeEverything) || '');
        ")
        CF_TOKEN_KEY=$(node -e "
            const config = require('$CONFIG_FILE');
            const repo = config.repos['$REPO_KEY'];
            console.log((repo.cloudflare && repo.cloudflare.apiTokenKey) || '');
        ")
    fi

    if [ -z "$CF_ZONE_ID" ]; then
        log "No Cloudflare zone configured, skipping cache purge"
        return 0
    fi

    local CF_TOKEN="${!CF_TOKEN_KEY}"
    if [ -z "$CF_TOKEN" ]; then
        log_warning "Cloudflare API token not found (key: $CF_TOKEN_KEY). Check .env file."
        return 0
    fi

    if [ "$CF_PURGE_ALL" != "true" ]; then
        log "No purge method configured for Cloudflare zone $CF_ZONE_ID, skipping"
        return 0
    fi

    log "Purging all Cloudflare cache for zone: $CF_ZONE_ID"
    local PURGE_BODY='{"purge_everything":true}'
    local PURGE_OUTPUT
    if PURGE_OUTPUT=$(curl -s -X POST \
        "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
        -H "Authorization: Bearer $CF_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$PURGE_BODY" 2>&1); then

        local PURGE_SUCCESS
        PURGE_SUCCESS=$(echo "$PURGE_OUTPUT" | node -e "
            let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
                try { console.log(JSON.parse(d).success); } catch { console.log('false'); }
            });
        ")

        if [ "$PURGE_SUCCESS" = "true" ]; then
            log_success "Cloudflare cache purged successfully"
        else
            log_warning "Cloudflare cache purge returned error"
            log_warning "$PURGE_OUTPUT"
        fi
    else
        log_warning "Cloudflare cache purge request failed"
        log_warning "$PURGE_OUTPUT"
    fi
}

write_htaccess() {
    local dest="$1"
    local rewrite_base="/${APP_SUBPATH}/"
    cat > "$dest/.htaccess" <<HTEOF
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase ${rewrite_base}
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . ${rewrite_base}index.html [L]
</IfModule>

<IfModule mod_headers.c>
    <FilesMatch "^index\\.html\$">
        Header set Cache-Control "no-cache, no-store, must-revalidate"
        Header set Pragma "no-cache"
        Header set Expires "0"
    </FilesMatch>
    <FilesMatch "\\.(js|css|woff2)\$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</IfModule>
HTEOF
    log "Generated .htaccess: RewriteBase ${rewrite_base}"
}

current_release_target() {
    if [ -L "$DEPLOY_PATH" ]; then
        readlink -f "$DEPLOY_PATH" 2>/dev/null || true
    else
        echo ""
    fi
}

rollback_to() {
    local target="$1"
    if [ -z "$target" ] || [ ! -d "$target" ]; then
        log_error "Cannot rollback — target missing: $target"
        return 1
    fi
    local tmp="$DEPLOY_PATH.rollback.$$"
    ln -s "$target" "$tmp"
    mv -T "$tmp" "$DEPLOY_PATH"
    log_success "Rolled back symlink to: $target"
}

migrate_to_symlink_if_needed() {
    # First deploy for this app: move the existing real directory aside and
    # leave a symlink so rollback always has a previous release.
    if [ -L "$DEPLOY_PATH" ]; then
        PREV_RELEASE="$(current_release_target)"
        log "Deploy path is already a symlink → $PREV_RELEASE"
        return 0
    fi

    if [ -d "$DEPLOY_PATH" ]; then
        local legacy="$RELEASE_BASE/legacy-$(date -u '+%Y%m%dT%H%M%SZ')"
        log "Migrating existing deploy directory to $legacy"
        mv "$DEPLOY_PATH" "$legacy"
        PREV_RELEASE="$legacy"
        ln -s "$legacy" "$DEPLOY_PATH"
        log_success "Migration complete — $DEPLOY_PATH now points at $legacy"
        return 0
    fi

    # Nothing there yet — create parent and leave PREV empty
    mkdir -p "$(dirname "$DEPLOY_PATH")"
    PREV_RELEASE=""
    log "No existing deploy at $DEPLOY_PATH — fresh publish"
}

free_space_ok() {
    local dist_dir="$1"
    local dist_kb
    dist_kb=$(du -sk "$dist_dir" 2>/dev/null | awk '{print $1}')
    if [ -z "$dist_kb" ] || [ "$dist_kb" -eq 0 ]; then
        return 1
    fi
    local need_kb=$((dist_kb * 3))
    local avail_kb
    avail_kb=$(df -Pk "$RELEASE_BASE" | awk 'NR==2 {print $4}')
    if [ -z "$avail_kb" ]; then
        log_warning "Could not determine free space; proceeding"
        return 0
    fi
    if [ "$avail_kb" -lt "$need_kb" ]; then
        log_error "Insufficient disk: need ~${need_kb}KB free, have ${avail_kb}KB on $RELEASE_BASE"
        return 1
    fi
    log "Disk check OK: dist=${dist_kb}KB need≈${need_kb}KB avail=${avail_kb}KB"
    return 0
}

publish_release() {
    local dist_dir="$LOCAL_PATH/$DIST_FOLDER"
    local short_sha
    short_sha=$(echo "$TARGET_SHA" | cut -c1-12)
    NEW_RELEASE="$RELEASE_BASE/$short_sha"

    if [ -d "$NEW_RELEASE" ]; then
        log_warning "Release dir already exists for $short_sha — replacing"
        rm -rf "$NEW_RELEASE"
    fi

    mkdir -p "$NEW_RELEASE"
    cp -a "$dist_dir"/. "$NEW_RELEASE/"

    local DEPLOY_TS
    DEPLOY_TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    if [ -f "$NEW_RELEASE/index.html" ]; then
        # Avoid double-stamping if dist already has a stamp from a prior attempt
        if ! grep -q '<!-- deploy:' "$NEW_RELEASE/index.html"; then
            sed -i "s|</head>|<!-- deploy: $DEPLOY_TS $short_sha -->\n</head>|" "$NEW_RELEASE/index.html"
        else
            sed -i -E "s|<!-- deploy: [^>]+ -->|<!-- deploy: $DEPLOY_TS $short_sha -->|" "$NEW_RELEASE/index.html"
        fi
        log "Stamped index.html: deploy=$DEPLOY_TS commit=$short_sha"
    else
        die "$EXIT_BUILD" "Build output has no index.html"
    fi

    write_htaccess "$NEW_RELEASE"

    # Atomic symlink swap via rename(2)
    local tmp="$DEPLOY_PATH.new.$$"
    ln -s "$NEW_RELEASE" "$tmp"
    mv -T "$tmp" "$DEPLOY_PATH"
    SWAP_DONE=1
    log_success "Symlink swapped: $DEPLOY_PATH → $NEW_RELEASE"
}

read_served_stamp() {
    local index="$DEPLOY_PATH/index.html"
    if [ ! -f "$index" ]; then
        echo ""
        return
    fi
    grep -oE '<!--[[:space:]]*deploy:[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]*-->' "$index" \
        | head -1 \
        | sed -E 's/.*deploy:[[:space:]]+[^[:space:]]+[[:space:]]+([^[:space:]]+)[[:space:]]*-->/\1/'
}

verify_publish() {
    local short_sha
    short_sha=$(echo "$TARGET_SHA" | cut -c1-12)
    local served
    served=$(read_served_stamp)

    if [ -z "$served" ]; then
        die "$EXIT_BUILD" "Post-publish verification failed: no deploy stamp in served index.html"
    fi

    # Prefix match (stamp is short sha)
    local n=${#served}
    local expect
    expect=$(echo "$TARGET_SHA" | cut -c1-"$n")
    if [ "${served,,}" != "${expect,,}" ]; then
        die "$EXIT_BUILD" "Post-publish stamp mismatch: served=$served expected=$expect (target=$short_sha)"
    fi
    log_success "Filesystem stamp verified: $served"

    # HTTP check — transport failure is warning only
    local url="http://127.0.0.1/${APP_SUBPATH}/"
    local http_body
    if http_body=$(curl -fsS --max-time 10 -H "Host: intranet.sharpsir.group" "$url" 2>/dev/null); then
        if echo "$http_body" | grep -q "deploy:.*$served"; then
            log_success "HTTP stamp verified via $url"
        else
            log_warning "HTTP response did not contain expected stamp $served (continuing — filesystem OK)"
        fi
    else
        log_warning "HTTP verification failed for $url (continuing — filesystem OK)"
    fi
}

prune_releases() {
    log "Pruning old releases (keep $KEEP_RELEASES)..."
    local current
    current=$(current_release_target)
    local current_real=""
    if [ -n "$current" ]; then
        current_real=$(readlink -f "$current" 2>/dev/null || true)
    fi

    # Newest first; keep first KEEP_RELEASES, never prune the currently-served dir
    local kept=0
    local d d_real
    while IFS= read -r d; do
        [ -z "$d" ] && continue
        d_real=$(readlink -f "$d" 2>/dev/null || true)
        if [ -n "$current_real" ] && [ "$d_real" = "$current_real" ]; then
            kept=$((kept + 1))
            continue
        fi
        if [ "$kept" -lt "$KEEP_RELEASES" ]; then
            kept=$((kept + 1))
            continue
        fi
        log "Pruning release: $d"
        rm -rf "$d"
    done < <(find "$RELEASE_BASE" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')
}

prune_logs() {
    local total
    total=$(find "$LOG_DIR" -type f -name '*.log' 2>/dev/null | wc -l)
    if [ "$total" -le "$KEEP_LOGS" ]; then
        return 0
    fi
    log "Pruning deploy logs (have $total, keep $KEEP_LOGS)..."
    local to_delete=$((total - KEEP_LOGS))
    # Avoid SIGPIPE under pipefail: collect paths first
    local -a old_logs=()
    mapfile -t old_logs < <(
        find "$LOG_DIR" -type f -name '*.log' -printf '%T@ %p\n' 2>/dev/null \
            | sort -n \
            | awk '{print $2}' \
            | head -n "$to_delete"
    )
    local f
    for f in "${old_logs[@]:-}"; do
        [ -n "$f" ] && rm -f "$f"
    done
}

# --- main ---

main() {
    log "========================================="
    log "Starting deployment for: $NAME"
    log "========================================="

    acquire_lock

    # Step 1: fetch + pin SHA + clean tree
    log "Step 1: Fetching origin/$BRANCH and pinning TARGET_SHA..."
    cd "$LOCAL_PATH"
    if ! git fetch origin; then
        die "$EXIT_TRANSIENT" "git fetch failed"
    fi

    if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
        die "$EXIT_FATAL" "Remote branch origin/$BRANCH not found"
    fi

    TARGET_SHA=$(git rev-parse "origin/$BRANCH")
    log "Pinned TARGET_SHA=$TARGET_SHA"

    git checkout "$BRANCH" 2>/dev/null || git checkout -B "$BRANCH" "origin/$BRANCH"
    git reset --hard "$TARGET_SHA"

    # Drop untracked leftovers that could mask a broken commit, keep node_modules
    git clean -ffd -e node_modules -e .deploy.lock
    rm -rf "$LOCAL_PATH/$DIST_FOLDER"
    log_success "Working tree reset to $TARGET_SHA"

    # Step 2: patches
    log "Step 2: Applying preBuild patches..."
    apply_patches
    log_success "Patches applied"

    # Step 3: build with timeout
    log "Step 3: Running build (timeout ${BUILD_TIMEOUT_SEC}s)..."
    local BUILD_LOG
    BUILD_LOG=$(mktemp)
    local BUILD_EXIT=0
    set +e
    timeout -k 30s "${BUILD_TIMEOUT_SEC}s" bash -c "$BUILD_CMD" > >(tee -a "$BUILD_LOG") 2>&1
    BUILD_EXIT=$?
    set -e

    if [ "$BUILD_EXIT" -ne 0 ]; then
        sweep_orphans
        local class
        class=$(classify_build_failure "$BUILD_EXIT" "$(cat "$BUILD_LOG")")
        rm -f "$BUILD_LOG"
        if [ "$BUILD_EXIT" -eq 124 ]; then
            die "$class" "Build timed out after ${BUILD_TIMEOUT_SEC}s"
        fi
        die "$class" "Build command failed with exit $BUILD_EXIT"
    fi
    rm -f "$BUILD_LOG"

    if [ ! -d "$LOCAL_PATH/$DIST_FOLDER" ] || [ -z "$(ls -A "$LOCAL_PATH/$DIST_FOLDER" 2>/dev/null)" ]; then
        die "$EXIT_BUILD" "Build output folder '$DIST_FOLDER' is missing or empty"
    fi
    log_success "Build completed"

    # Step 4: free space + migrate + publish
    log "Step 4: Publishing immutable release..."
    if ! free_space_ok "$LOCAL_PATH/$DIST_FOLDER"; then
        die "$EXIT_FATAL" "Insufficient disk space to publish"
    fi

    migrate_to_symlink_if_needed
    # Capture previous target again in case migrate updated it
    if [ -z "${PREV_RELEASE:-}" ]; then
        PREV_RELEASE="$(current_release_target)"
    fi

    publish_release
    log_success "Release published"

    # Step 5: verify (mismatch → die → trap rolls back)
    log "Step 5: Verifying served stamp..."
    verify_publish
    # Verification passed — clear auto-rollback trigger
    SWAP_DONE=0
    log_success "Publish verified"

    # Step 6: postDeploy
    log "Step 6: Running postDeploy commands..."
    run_post_deploy
    log_success "PostDeploy commands completed"

    # Step 7: revert patches
    log "Step 7: Reverting patches..."
    revert_patches
    log_success "Patches reverted"

    # Step 8: CDN
    log "Step 8: Invalidating CloudFront cache..."
    invalidate_cloudfront
    log_success "CloudFront invalidation step completed"

    log "Step 9: Purging Cloudflare cache..."
    purge_cloudflare_cache
    log_success "Cloudflare cache purge step completed"

    # Step 10: prune
    prune_releases
    prune_logs

    release_lock

    log "========================================="
    log_success "Deployment completed successfully!"
    log "  commit=$TARGET_SHA"
    log "  release=$NEW_RELEASE"
    log "========================================="
}

main
exit "$EXIT_OK"
