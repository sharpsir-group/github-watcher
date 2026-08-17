#!/usr/bin/env node
/**
 * GitHub Webhook Server
 * Listens for GitHub push events and triggers deployments
 * 
 * Usage: node webhook-server.js
 * Port: 9001 (configurable via PORT env var)
 */

const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 9001;
const SCRIPT_DIR = __dirname;
const CONFIG_FILE = path.join(SCRIPT_DIR, 'config.json');
const ENV_FILE = path.join(SCRIPT_DIR, '.env');
const DEPLOY_SCRIPT = path.join(SCRIPT_DIR, 'deploy.sh');

/** Default reconcile interval: 5 minutes */
const DEFAULT_RECONCILE_INTERVAL_MS = 300000;
/** Cap consecutive-failure backoff around 1 hour (12 × 5 min ticks) */
const MAX_FAILURE_BACKOFF_TICKS = 12;

// Load all secrets and credentials from .env file
function loadEnv() {
    const env = {};
    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key && valueParts.length > 0) {
                    env[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
    }
    return env;
}

// Load configuration
function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('Config file not found:', CONFIG_FILE);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

// Verify GitHub webhook signature
function verifySignature(payload, signature, secret) {
    if (!signature || !secret) {
        return false;
    }
    
    const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const hmac = crypto.createHmac('sha256', secret);
    const digest = hmac.update(payload).digest('hex');
    
    try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
    } catch (e) {
        return false;
    }
}

// Global deploy queue: serializes builds across all repos (configurable concurrency)
let maxConcurrentDeploys = 1;
const queue = [];
const queued = new Set();
const running = new Set();
let activeDeploys = 0;

// Reconciliation state
let isReconciling = false;
/** @type {Map<string, { failures: number, skipUntilTick: number }>} */
const reconcileBackoff = new Map();
let reconcileTick = 0;
/** Targets that already logged a missing-stamp warning */
const stampWarned = new Set();
let reconcileTimer = null;

function getMaxConcurrentDeploys(config) {
    const n = config?.maxConcurrentDeploys;
    if (typeof n === 'number' && n >= 1 && Number.isFinite(n)) {
        return Math.floor(n);
    }
    return 1;
}

function getReconcileIntervalMs(config) {
    if (config?.reconcileEnabled === false) {
        return 0;
    }
    const n = config?.reconcileIntervalMs;
    if (typeof n === 'number' && n >= 0 && Number.isFinite(n)) {
        return Math.floor(n);
    }
    return DEFAULT_RECONCILE_INTERVAL_MS;
}

/**
 * Parse deploy stamp from index.html:
 *   <!-- deploy: 2026-08-17T15:21:10Z 13ffecd -->
 */
function readDeployedSha(deployPath) {
    if (!deployPath) return null;
    const indexPath = path.join(deployPath, 'index.html');
    if (!fs.existsSync(indexPath)) return null;
    try {
        const html = fs.readFileSync(indexPath, 'utf8');
        const m = html.match(/<!--\s*deploy:\s+\S+\s+(\S+)\s*-->/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

/**
 * Resolve remote tip via git ls-remote (30s timeout).
 * Uses HOME + PATH so gh credential helper works for private repos.
 */
async function readRemoteSha(localPath, branch) {
    if (!localPath || !branch) return null;
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['-C', localPath, 'ls-remote', 'origin', branch],
            {
                timeout: 30000,
                env: {
                    ...process.env,
                    PATH: '/opt/bitnami/node/bin:/usr/local/bin:/usr/bin:/bin',
                    HOME: '/home/bitnami',
                    GIT_TERMINAL_PROMPT: '0'
                }
            }
        );
        const first = (stdout || '').trim().split(/\s+/)[0];
        return first || null;
    } catch (err) {
        const msg = err?.stderr || err?.message || String(err);
        console.error(
            `[${new Date().toISOString()}] ls-remote failed for ${localPath} (${branch}): ${msg}`
                .replace(/\n/g, ' ')
                .slice(0, 300)
        );
        return null;
    }
}

/** Prefix-compare short deploy stamps against full remote shas */
function shasMatch(deployed, remote) {
    if (!deployed || !remote) return false;
    const a = deployed.toLowerCase();
    const b = remote.toLowerCase();
    const n = Math.min(a.length, b.length);
    if (n < 7) return false;
    return a.slice(0, n) === b.slice(0, n);
}

function shouldSkipForBackoff(repoKey) {
    const entry = reconcileBackoff.get(repoKey);
    if (!entry || entry.failures === 0) return false;
    return reconcileTick < entry.skipUntilTick;
}

function noteDeployFailure(repoKey) {
    const prev = reconcileBackoff.get(repoKey) || { failures: 0, skipUntilTick: 0 };
    const failures = prev.failures + 1;
    // Skip 1, 2, 4, … ticks (capped)
    const skipTicks = Math.min(2 ** Math.min(failures - 1, 10), MAX_FAILURE_BACKOFF_TICKS);
    reconcileBackoff.set(repoKey, {
        failures,
        skipUntilTick: reconcileTick + skipTicks
    });
    console.log(
        `[${new Date().toISOString()}] Reconcile backoff for ${repoKey}: ` +
        `failures=${failures}, skip ${skipTicks} tick(s)`
    );
}

function clearDeployFailure(repoKey) {
    if (reconcileBackoff.has(repoKey)) {
        reconcileBackoff.delete(repoKey);
    }
}

/**
 * Collect per-target sync status (used by /status and reconcile).
 * Does not enqueue deploys.
 */
async function collectTargetStatus() {
    const config = loadConfig();
    const targets = [];

    for (const [repoKey, entry] of Object.entries(config.repos || {})) {
        const branch = entry.branch || 'main';
        const deployed = readDeployedSha(entry.deployPath);
        const remote = await readRemoteSha(entry.localPath, branch);
        const inSync = shasMatch(deployed, remote);
        targets.push({
            key: repoKey,
            name: entry.name || repoKey,
            branch,
            deployed,
            remote: remote ? remote.slice(0, Math.max(deployed?.length || 0, 8)) : null,
            remoteFull: remote,
            inSync,
            running: running.has(repoKey),
            queued: queued.has(repoKey),
            backoff: reconcileBackoff.get(repoKey) || null
        });
    }

    return {
        timestamp: new Date().toISOString(),
        queueDepth: queueDepth(),
        activeDeploys,
        isReconciling,
        reconcileTick,
        targets
    };
}

/**
 * Sweep all targets; enqueue deploy when deployed stamp ≠ remote tip.
 */
async function reconcile(trigger = 'interval') {
    if (isReconciling) {
        console.log(`[${new Date().toISOString()}] Reconcile skipped (already running)`);
        return { skipped: true, reason: 'already_running' };
    }

    isReconciling = true;
    reconcileTick += 1;
    const ts = new Date().toISOString();
    console.log(`[${ts}] Reconcile sweep starting (trigger=${trigger}, tick=${reconcileTick})`);

    const queuedKeys = [];
    const inSyncKeys = [];
    const skippedKeys = [];

    try {
        const config = loadConfig();
        for (const [repoKey, entry] of Object.entries(config.repos || {})) {
            if (!entry.deployPath || !entry.localPath) {
                skippedKeys.push(repoKey);
                continue;
            }

            if (shouldSkipForBackoff(repoKey)) {
                const b = reconcileBackoff.get(repoKey);
                console.log(
                    `[${new Date().toISOString()}] Reconcile: ${repoKey} skipped (backoff until tick ${b.skipUntilTick})`
                );
                skippedKeys.push(repoKey);
                continue;
            }

            const deployed = readDeployedSha(entry.deployPath);
            if (!deployed) {
                if (!stampWarned.has(repoKey)) {
                    stampWarned.add(repoKey);
                    console.log(
                        `[${new Date().toISOString()}] Reconcile: ${repoKey} has no deploy stamp — skipping`
                    );
                }
                skippedKeys.push(repoKey);
                continue;
            }

            const branch = entry.branch || 'main';
            const remote = await readRemoteSha(entry.localPath, branch);
            if (!remote) {
                skippedKeys.push(repoKey);
                continue;
            }

            if (shasMatch(deployed, remote)) {
                inSyncKeys.push(repoKey);
                continue;
            }

            const remoteShort = remote.slice(0, deployed.length);
            console.log(
                `[${new Date().toISOString()}] Reconcile: ${repoKey} ` +
                `deployed=${deployed} remote=${remoteShort} → queued`
            );
            enqueueDeploy(repoKey);
            queuedKeys.push(repoKey);
        }
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Reconcile sweep error:`, err);
    } finally {
        isReconciling = false;
    }

    console.log(
        `[${new Date().toISOString()}] Reconcile sweep done: ` +
        `inSync=${inSyncKeys.length} queued=${queuedKeys.length} skipped=${skippedKeys.length}`
    );

    return {
        skipped: false,
        inSync: inSyncKeys.length,
        queued: queuedKeys,
        skippedCount: skippedKeys.length
    };
}

function isLoopback(req) {
    const addr = req.socket?.remoteAddress || '';
    return (
        addr === '127.0.0.1' ||
        addr === '::1' ||
        addr === '::ffff:127.0.0.1'
    );
}

function startReconcileTimer() {
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
    let config;
    try {
        config = loadConfig();
    } catch {
        return;
    }
    const intervalMs = getReconcileIntervalMs(config);
    if (intervalMs <= 0) {
        console.log(`[${new Date().toISOString()}] Reconcile disabled (reconcileEnabled=false or interval 0)`);
        return;
    }
    console.log(`[${new Date().toISOString()}] Reconcile interval: ${intervalMs}ms`);
    reconcileTimer = setInterval(() => {
        reconcile('interval').catch((err) => {
            console.error(`[${new Date().toISOString()}] Reconcile interval error:`, err);
        });
    }, intervalMs);
    // Unref so the timer alone does not keep the process alive during shutdown tests
    if (typeof reconcileTimer.unref === 'function') {
        reconcileTimer.unref();
    }
}

/**
 * Resolve a push to a config entry.
 *
 * Preferred (multi-branch, equal targets):
 *   config.repos["org/repo@main"], config.repos["org/repo@cdto"], …
 *
 * Legacy (single-branch):
 *   config.repos["org/repo"] with a matching `.branch` field
 *
 * Returns { key, config } | { ignored, configuredBranch } | null
 */
function resolveRepoConfig(config, repoFullName, branch) {
    const branchKey = `${repoFullName}@${branch}`;
    if (config.repos[branchKey]) {
        return { key: branchKey, config: config.repos[branchKey] };
    }

    const legacy = config.repos[repoFullName];
    if (legacy) {
        if (legacy.branch && branch !== legacy.branch) {
            return { ignored: true, configuredBranch: legacy.branch };
        }
        return { key: repoFullName, config: legacy };
    }

    // Same repo has @branch targets, but not this branch → ignore (not 404).
    const prefix = `${repoFullName}@`;
    const siblings = Object.keys(config.repos).filter((k) => k.startsWith(prefix));
    if (siblings.length > 0) {
        const configured = siblings.map((k) => k.slice(prefix.length)).join(', ');
        return { ignored: true, configuredBranch: configured };
    }

    return null;
}

function queueDepth() {
    return queue.length + activeDeploys;
}

function enqueueDeploy(repoKey) {
    const config = loadConfig();
    maxConcurrentDeploys = getMaxConcurrentDeploys(config);

    if (running.has(repoKey) || queued.has(repoKey)) {
        console.log(`[${new Date().toISOString()}] Deploy coalesced for ${repoKey} (already running or queued)`);
        return { status: 'coalesced', depth: queueDepth() };
    }

    const position = queueDepth() + 1;
    const willStartNow = activeDeploys < maxConcurrentDeploys;

    queue.push(repoKey);
    queued.add(repoKey);
    console.log(
        `[${new Date().toISOString()}] Deploy queued for ${repoKey} ` +
        `(position ${position}, depth ${queueDepth()})`
    );

    pump();

    if (willStartNow && running.has(repoKey)) {
        return { status: 'started', depth: queueDepth() };
    }
    return { status: 'queued', position, depth: queueDepth() };
}

function pump() {
    const config = loadConfig();
    maxConcurrentDeploys = getMaxConcurrentDeploys(config);

    while (activeDeploys < maxConcurrentDeploys && queue.length > 0) {
        const repoKey = queue.shift();
        queued.delete(repoKey);
        running.add(repoKey);
        activeDeploys++;

        runDeploy(repoKey, (code) => {
            running.delete(repoKey);
            activeDeploys--;

            if (code === 0) {
                clearDeployFailure(repoKey);
                console.log(`[${new Date().toISOString()}] Deployment successful for ${repoKey}`);
            } else {
                noteDeployFailure(repoKey);
                console.error(`[${new Date().toISOString()}] Deployment failed for ${repoKey}`);
            }

            const remaining = queue.length;
            if (remaining > 0) {
                console.log(`[${new Date().toISOString()}] ${remaining} deploy(s) remaining in queue`);
            }

            pump();
        });
    }
}

// Run deployment script
function runDeploy(repoKey, callback) {
    console.log(`[${new Date().toISOString()}] Starting deployment for: ${repoKey}`);
    
    const dotenv = loadEnv();
    
    const deploy = spawn(DEPLOY_SCRIPT, [repoKey], {
        cwd: SCRIPT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PATH: '/opt/bitnami/node/bin:/usr/local/bin:/usr/bin:/bin',
            HOME: '/home/bitnami',
            ...dotenv
        }
    });
    
    let output = '';
    let errorOutput = '';
    
    deploy.stdout.on('data', (data) => {
        const str = data.toString();
        output += str;
        process.stdout.write(str);
    });
    
    deploy.stderr.on('data', (data) => {
        const str = data.toString();
        errorOutput += str;
        process.stderr.write(str);
    });
    
    deploy.on('close', (code) => {
        console.log(`[${new Date().toISOString()}] Deployment finished with code: ${code}`);
        callback(code, output, errorOutput);
    });
    
    deploy.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] Deployment error:`, err);
        callback(1, '', err.message);
    });
}

/**
 * When Apache proxies https://host/webhook/github-watcher/* to this process,
 * req.url may still include the /webhook/github-watcher prefix. Normalize so
 * health checks and routing match the same paths as a direct :9001 hit.
 */
function getRequestPath(rawUrl) {
    let pathname = (rawUrl || '/').split('?')[0] || '/';
    // Apache mod_proxy sometimes forwards the proxied URI as "//" (trailing slash on mount).
    pathname = pathname.replace(/\/{2,}/g, '/');
    const prefix = '/webhook/github-watcher';
    if (!pathname.startsWith(prefix)) {
        return pathname;
    }
    let rest = pathname.slice(prefix.length);
    if (rest === '' || rest === '/') {
        return '/';
    }
    if (!rest.startsWith('/')) {
        rest = '/' + rest;
    }
    return rest;
}

// Create HTTP server
const server = http.createServer((req, res) => {
    const timestamp = new Date().toISOString();
    const reqPath = getRequestPath(req.url);
    
    // Health check endpoint
    if (req.method === 'GET' && (reqPath === '/' || reqPath === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            service: 'github-watcher',
            timestamp 
        }));
        return;
    }

    // Sync status: deployed stamp vs remote tip for every target
    if (req.method === 'GET' && reqPath === '/status') {
        collectTargetStatus()
            .then((status) => {
                const allInSync = status.targets.every((t) => t.inSync);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...status, allInSync }, null, 2));
            })
            .catch((err) => {
                console.error(`[${timestamp}] /status error:`, err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to collect status' }));
            });
        return;
    }

    // Force an immediate reconcile sweep (loopback only)
    if (req.method === 'POST' && reqPath === '/reconcile') {
        if (!isLoopback(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Loopback only' }));
            return;
        }
        // Drain body if any, then start reconcile without blocking the response forever
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1024) req.destroy();
        });
        req.on('end', () => {
            reconcile('manual')
                .then((result) => {
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'accepted', ...result }));
                })
                .catch((err) => {
                    console.error(`[${timestamp}] /reconcile error:`, err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Reconcile failed' }));
                });
        });
        return;
    }
    
    // Only accept POST requests for webhooks
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }
    
    let body = '';
    
    req.on('data', chunk => {
        body += chunk.toString();
        // Limit body size to 10MB
        if (body.length > 10 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
        }
    });
    
    req.on('end', () => {
        console.log(`[${timestamp}] Received webhook request`);
        
        // Load fresh config and env for each request
        let config, secrets;
        try {
            config = loadConfig();
            secrets = loadEnv();
        } catch (e) {
            console.error(`[${timestamp}] Error loading config:`, e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server configuration error' }));
            return;
        }
        
        // Parse payload
        let payload;
        try {
            payload = JSON.parse(body);
        } catch (e) {
            console.error(`[${timestamp}] Invalid JSON payload`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        
        // Extract repository info
        const repoFullName = payload.repository?.full_name;
        if (!repoFullName) {
            console.error(`[${timestamp}] No repository info in payload`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No repository info in payload' }));
            return;
        }
        
        const ref = payload.ref || '';
        const branch = ref.replace('refs/heads/', '');
        console.log(`[${timestamp}] Repository: ${repoFullName} branch: ${branch || '(none)'}`);

        const resolved = resolveRepoConfig(config, repoFullName, branch);
        if (!resolved) {
            console.log(`[${timestamp}] Repository not configured: ${repoFullName}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Repository not configured' }));
            return;
        }
        if (resolved.ignored) {
            console.log(
                `[${timestamp}] Ignoring push to branch: ${branch} ` +
                `(configured: ${resolved.configuredBranch})`
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ignored',
                reason: `Push to ${branch}, not ${resolved.configuredBranch}`
            }));
            return;
        }

        const { key: repoKey, config: repoConfig } = resolved;

        // Verify signature
        const signature = req.headers['x-hub-signature-256'];
        const secretKey = repoConfig.secret;
        const secretValue = secrets[secretKey];
        
        if (secretValue) {
            if (!verifySignature(body, signature, secretValue)) {
                console.error(`[${timestamp}] Invalid signature for ${repoKey}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid signature' }));
                return;
            }
            console.log(`[${timestamp}] Signature verified`);
        } else {
            console.log(`[${timestamp}] Warning: No secret configured for ${repoKey}`);
        }
        
        // Respond immediately to GitHub
        const enqueueResult = enqueueDeploy(repoKey);
        const statusMessage = enqueueResult.status === 'coalesced'
            ? `Deployment coalesced for ${repoConfig.name} (already running or queued)`
            : enqueueResult.status === 'started'
                ? `Deployment started for ${repoConfig.name}`
                : `Deployment queued for ${repoConfig.name} (position ${enqueueResult.position})`;

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'accepted',
            message: statusMessage,
            target: repoKey,
            queue: { status: enqueueResult.status, depth: enqueueResult.depth }
        }));
    });
    
    req.on('error', (err) => {
        console.error(`[${timestamp}] Request error:`, err);
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('GitHub Watcher - Webhook Server');
    console.log('='.repeat(50));
    console.log(`Started at: ${new Date().toISOString()}`);
    console.log(`Listening on: http://0.0.0.0:${PORT}`);
    console.log(`Config file: ${CONFIG_FILE}`);
    console.log(`Env file: ${ENV_FILE}`);
    console.log('='.repeat(50));
    
    // Log configured repos
    try {
        const config = loadConfig();
        console.log('Configured repositories:');
        Object.keys(config.repos).forEach(repo => {
            const entry = config.repos[repo];
            console.log(`  - ${repo} → ${entry.name} [${entry.branch || '?'}] ${entry.deployPath || ''}`);
        });
    } catch (e) {
        console.error('Warning: Could not load config:', e.message);
    }
    console.log('='.repeat(50));

    startReconcileTimer();
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

