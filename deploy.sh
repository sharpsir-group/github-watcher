#!/bin/bash
# Universal Deploy Script for GitHub Watcher
# Usage: deploy.sh <repo-key>
# Example: deploy.sh "your-org/your-repo"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"
LOG_DIR="$SCRIPT_DIR/logs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

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

# Check if repo key is provided
if [ -z "$1" ]; then
    log_error "No repository key provided"
    echo "Usage: $0 <repo-key>"
    exit 1
fi

REPO_KEY="$1"

# Check if jq is available, if not use node for JSON parsing
if command -v jq &> /dev/null; then
    USE_JQ=true
else
    USE_JQ=false
fi

# Function to get JSON value using node (fallback)
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

# Load configuration
log "Loading configuration for: $REPO_KEY"

if [ "$USE_JQ" = true ]; then
    REPO_CONFIG=$(jq -r ".repos[\"$REPO_KEY\"]" "$CONFIG_FILE")
    if [ "$REPO_CONFIG" = "null" ]; then
        log_error "Repository '$REPO_KEY' not found in config"
        exit 1
    fi
    
    NAME=$(echo "$REPO_CONFIG" | jq -r '.name')
    LOCAL_PATH=$(echo "$REPO_CONFIG" | jq -r '.localPath')
    DEPLOY_PATH=$(echo "$REPO_CONFIG" | jq -r '.deployPath')
    BRANCH=$(echo "$REPO_CONFIG" | jq -r '.branch')
    BUILD_CMD=$(echo "$REPO_CONFIG" | jq -r '.buildCmd')
    DIST_FOLDER=$(echo "$REPO_CONFIG" | jq -r '.distFolder')
    PRE_BUILD=$(echo "$REPO_CONFIG" | jq -c '.preBuild // []')
    POST_DEPLOY=$(echo "$REPO_CONFIG" | jq -c '.postDeploy // []')
else
    NAME=$(get_json_value "repo.name")
    LOCAL_PATH=$(get_json_value "repo.localPath")
    DEPLOY_PATH=$(get_json_value "repo.deployPath")
    BRANCH=$(get_json_value "repo.branch")
    BUILD_CMD=$(get_json_value "repo.buildCmd")
    DIST_FOLDER=$(get_json_value "repo.distFolder")
    PRE_BUILD=$(get_json_value "repo.preBuild || []")
    POST_DEPLOY=$(get_json_value "repo.postDeploy || []")
fi

# Create log file for this deployment
SAFE_REPO_NAME=$(echo "$REPO_KEY" | tr '/' '_')
LOG_FILE="$LOG_DIR/${SAFE_REPO_NAME}_$(date '+%Y%m%d_%H%M%S').log"

log "Deploying: $NAME"
log "Log file: $LOG_FILE"

# Redirect all output to log file as well
exec > >(tee -a "$LOG_FILE") 2>&1

log "Configuration loaded:"
log "  Local Path: $LOCAL_PATH"
log "  Deploy Path: $DEPLOY_PATH"
log "  Branch: $BRANCH"
log "  Build Command: $BUILD_CMD"
log "  Dist Folder: $DIST_FOLDER"

# Change to repo directory
cd "$LOCAL_PATH"
log "Changed to directory: $(pwd)"

# Store original file contents for patches (for revert)
declare -A ORIGINAL_FILES

# Function to apply preBuild patches
apply_patches() {
    log "Applying preBuild patches..."
    
    if [ "$USE_JQ" = true ]; then
        PATCH_COUNT=$(echo "$PRE_BUILD" | jq 'length')
    else
        PATCH_COUNT=$(node -e "console.log(($PRE_BUILD).length)")
    fi
    
    if [ "$PATCH_COUNT" -eq 0 ]; then
        log "No patches to apply"
        return
    fi
    
    for ((i=0; i<PATCH_COUNT; i++)); do
        if [ "$USE_JQ" = true ]; then
            PATCH_FILE=$(echo "$PRE_BUILD" | jq -r ".[$i].file")
        else
            PATCH_FILE=$(node -e "console.log(($PRE_BUILD)[$i].file)")
        fi
        
        FULL_PATH="$LOCAL_PATH/$PATCH_FILE"
        
        if [ -f "$FULL_PATH" ]; then
            # Store original content (only first time per file)
            if [ -z "${ORIGINAL_FILES[$PATCH_FILE]+x}" ]; then
                ORIGINAL_FILES["$PATCH_FILE"]=$(cat "$FULL_PATH")
            fi
            
            # Apply patch via node — reads config.json directly to avoid
            # bash escaping issues with regex special characters.
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
        else
            log_warning "Patch file not found: $FULL_PATH"
        fi
    done
}

# Function to revert patches
revert_patches() {
    log "Reverting patches..."
    
    for PATCH_FILE in "${!ORIGINAL_FILES[@]}"; do
        FULL_PATH="$LOCAL_PATH/$PATCH_FILE"
        echo "${ORIGINAL_FILES[$PATCH_FILE]}" > "$FULL_PATH"
        log "Reverted: $PATCH_FILE"
    done
}

# Function to run postDeploy commands
run_post_deploy() {
    log "Running postDeploy commands..."
    
    if [ "$USE_JQ" = true ]; then
        CMD_COUNT=$(echo "$POST_DEPLOY" | jq 'length')
    else
        CMD_COUNT=$(node -e "console.log(($POST_DEPLOY).length)")
    fi
    
    if [ "$CMD_COUNT" -eq 0 ]; then
        log "No postDeploy commands"
        return
    fi
    
    for ((i=0; i<CMD_COUNT; i++)); do
        if [ "$USE_JQ" = true ]; then
            CMD=$(echo "$POST_DEPLOY" | jq -r ".[$i]")
        else
            CMD=$(node -e "console.log(($POST_DEPLOY)[$i])")
        fi
        
        # Replace $DEPLOY_PATH variable
        CMD="${CMD//\$DEPLOY_PATH/$DEPLOY_PATH}"
        
        log "Executing: $CMD"
        eval "$CMD"
    done
}

# Function to invalidate CloudFront cache
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
        return
    fi
    
    if [ -z "$CF_PATHS" ]; then
        log_warning "CloudFront distribution set but no invalidation paths configured"
        return
    fi
    
    if ! command -v aws &> /dev/null; then
        log_warning "AWS CLI not installed, skipping CloudFront invalidation"
        log_warning "Please invalidate manually: distribution=$CF_DIST_ID"
        return
    fi
    
    # Build paths argument
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
        log_warning "Manual invalidation needed: distribution=$CF_DIST_ID paths=$PATHS_ARG"
    fi
}

# Function to purge Cloudflare cache (CDN + Worker Cache API)
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
        return
    fi

    # Resolve the API token from environment variable named by apiTokenKey
    local CF_TOKEN="${!CF_TOKEN_KEY}"
    if [ -z "$CF_TOKEN" ]; then
        log_warning "Cloudflare API token not found (key: $CF_TOKEN_KEY). Check .secrets file."
        return
    fi

    if [ "$CF_PURGE_ALL" = "true" ]; then
        log "Purging all Cloudflare cache for zone: $CF_ZONE_ID"
        local PURGE_BODY='{"purge_everything":true}'
    else
        log "No purge method configured for Cloudflare zone $CF_ZONE_ID, skipping"
        return
    fi

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

# Main deployment process
main() {
    log "========================================="
    log "Starting deployment for: $NAME"
    log "========================================="
    
    # Step 1: Git pull
    log "Step 1: Pulling latest changes from $BRANCH..."
    git fetch origin
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
    log_success "Git pull completed"
    
    # Step 2: Apply preBuild patches
    log "Step 2: Applying preBuild patches..."
    apply_patches
    log_success "Patches applied"
    
    # Step 3: Build
    log "Step 3: Running build command..."
    if ! eval "$BUILD_CMD"; then
        log_error "Build command failed!"
        revert_patches
        exit 1
    fi
    
    # Verify dist folder exists and has files
    if [ ! -d "$LOCAL_PATH/$DIST_FOLDER" ] || [ -z "$(ls -A "$LOCAL_PATH/$DIST_FOLDER" 2>/dev/null)" ]; then
        log_error "Build output folder '$DIST_FOLDER' is missing or empty!"
        revert_patches
        exit 1
    fi
    log_success "Build completed"
    
    # Step 4: Deploy
    log "Step 4: Copying files to deploy path..."
    rm -rf "$DEPLOY_PATH"/*
    cp -r "$LOCAL_PATH/$DIST_FOLDER"/* "$DEPLOY_PATH/"
    
    # Stamp index.html with deploy timestamp to bust CDN caches on revalidation
    local DEPLOY_TS
    DEPLOY_TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    local DEPLOY_COMMIT
    DEPLOY_COMMIT=$(cd "$LOCAL_PATH" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    if [ -f "$DEPLOY_PATH/index.html" ]; then
        sed -i "s|</head>|<!-- deploy: $DEPLOY_TS $DEPLOY_COMMIT -->\n</head>|" "$DEPLOY_PATH/index.html"
        log "Stamped index.html: deploy=$DEPLOY_TS commit=$DEPLOY_COMMIT"
    fi
    log_success "Files copied to $DEPLOY_PATH"
    
    # Step 5: Run postDeploy commands
    log "Step 5: Running postDeploy commands..."
    run_post_deploy
    log_success "PostDeploy commands completed"
    
    # Step 6: Revert patches
    log "Step 6: Reverting patches..."
    revert_patches
    log_success "Patches reverted"
    
    # Step 7: Invalidate CloudFront cache
    log "Step 7: Invalidating CloudFront cache..."
    invalidate_cloudfront
    log_success "CloudFront invalidation step completed"
    
    # Step 8: Purge Cloudflare cache (prerendered HTML + CDN)
    log "Step 8: Purging Cloudflare cache..."
    purge_cloudflare_cache
    log_success "Cloudflare cache purge step completed"
    
    log "========================================="
    log_success "Deployment completed successfully!"
    log "========================================="
}

# Run main with error handling
if main; then
    exit 0
else
    log_error "Deployment failed!"
    # Try to revert patches on failure
    revert_patches
    exit 1
fi

