#!/usr/bin/env node
/**
 * GitHub Webhook Server
 * Listens for GitHub push events and triggers deployments
 *
 * Usage: node webhook-server.js
 * Port: 9001 (configurable via PORT env var)
 *
 * Deploy exit codes (from deploy.sh):
 *   0  success
 *   10 deterministic build failure → exponential reconcile backoff
 *   20 transient infra failure → fast retry (30s, 120s) then backoff
 *   30 fatal environment → max backoff
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
const RELEASES_ROOT = process.env.RELEASES_ROOT || '/opt/bitnami/apache/releases';

/** Default reconcile interval: 5 minutes */
const DEFAULT_RECONCILE_INTERVAL_MS = 300000;
/** Cap consecutive-failure backoff around 1 hour (12 × 5 min ticks) */
const MAX_FAILURE_BACKOFF_TICKS = 12;
/** Parent watchdog — above deploy.sh's default 900s build timeout */
const DEFAULT_DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
/** Cache ls-remote results briefly so /status is cheap */
const REMOTE_SHA_CACHE_MS = 60000;
/** Fast-retry delays for transient (exit 20) failures */
const TRANSIENT_RETRY_DELAYS_MS = [30000, 120000];

const EXIT_OK = 0;
const EXIT_BUILD = 10;
const EXIT_TRANSIENT = 20;
const EXIT_FATAL = 30;

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

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('Config file not found:', CONFIG_FILE);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

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
/** @type {Map<string, { startedAt: number, pid: number|null }>} */
const runningMeta = new Map();
/** Pushes that arrived while a deploy was already running/queued */
const dirty = new Set();
let activeDeploys = 0;

// Reconciliation state
let isReconciling = false;
/**
 * @type {Map<string, {
 *   failures: number,
 *   skipUntilTick: number,
 *   lastCode: number|null,
 *   kind: 'build'|'transient'|'fatal'|null,
 *   transientRetries: number
 * }>}
 */
const reconcileBackoff = new Map();
let reconcileTick = 0;
const stampWarned = new Set();
let reconcileTimer = null;

/** @type {Map<string, { sha: string|null, at: number }>} */
const remoteShaCache = new Map();

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

function getDeployTimeoutMs(config, repoKey) {
    const repo = config?.repos?.[repoKey];
    if (typeof repo?.deployTimeoutMs === 'number' && repo.deployTimeoutMs > 0) {
        return Math.floor(repo.deployTimeoutMs);
    }
    if (typeof config?.deployTimeoutMs === 'number' && config.deployTimeoutMs > 0) {
        return Math.floor(config.deployTimeoutMs);
    }
    return DEFAULT_DEPLOY_TIMEOUT_MS;
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
 * Resolve remote tip via git ls-remote (30s timeout), with a short cache.
 */
async function readRemoteSha(localPath, branch, { bypassCache = false } = {}) {
    if (!localPath || !branch) return null;
    const cacheKey = `${localPath}::${branch}`;
    if (!bypassCache) {
        const hit = remoteShaCache.get(cacheKey);
        if (hit && Date.now() - hit.at < REMOTE_SHA_CACHE_MS) {
            return hit.sha;
        }
    }
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
        const first = (stdout || '').trim().split(/\s+/)[0] || null;
        remoteShaCache.set(cacheKey, { sha: first, at: Date.now() });
        return first;
    } catch (err) {
        const msg = err?.stderr || err?.message || String(err);
        console.error(
            `[${new Date().toISOString()}] ls-remote failed for ${localPath} (${branch}): ${msg}`
                .replace(/\n/g, ' ')
                .slice(0, 300)
        );
        remoteShaCache.set(cacheKey, { sha: null, at: Date.now() });
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

function classifyExit(code) {
    if (code === EXIT_TRANSIENT) return 'transient';
    if (code === EXIT_FATAL) return 'fatal';
    if (code === EXIT_BUILD) return 'build';
    // Unknown non-zero (e.g. killed by watchdog as 124-ish) → treat as transient
    if (code === 124 || code === 137 || code === 143) return 'transient';
    return 'build';
}

function noteDeployFailure(repoKey, code) {
    const kind = classifyExit(code);
    const prev = reconcileBackoff.get(repoKey) || {
        failures: 0,
        skipUntilTick: 0,
        lastCode: null,
        kind: null,
        transientRetries: 0
    };

    if (kind === 'transient') {
        const nextRetry = prev.transientRetries;
        if (nextRetry < TRANSIENT_RETRY_DELAYS_MS.length) {
            const delay = TRANSIENT_RETRY_DELAYS_MS[nextRetry];
            reconcileBackoff.set(repoKey, {
                ...prev,
                failures: prev.failures + 1,
                lastCode: code,
                kind,
                transientRetries: nextRetry + 1,
                // Don't escalate tick backoff yet — schedule a direct re-enqueue
                skipUntilTick: prev.skipUntilTick
            });
            console.log(
                `[${new Date().toISOString()}] Transient failure for ${repoKey} ` +
                `(code=${code}, retry ${nextRetry + 1}/${TRANSIENT_RETRY_DELAYS_MS.length} in ${delay}ms)`
            );
            setTimeout(() => {
                console.log(
                    `[${new Date().toISOString()}] Fast-retrying ${repoKey} after transient failure`
                );
                enqueueDeploy(repoKey, { reason: 'transient_retry' });
            }, delay);
            return;
        }
        // Exhausted fast retries → fall through to exponential backoff
        console.log(
            `[${new Date().toISOString()}] Transient retries exhausted for ${repoKey} — applying tick backoff`
        );
    }

    const failures = prev.failures + 1;
    let skipTicks;
    if (kind === 'fatal') {
        skipTicks = MAX_FAILURE_BACKOFF_TICKS;
    } else {
        skipTicks = Math.min(2 ** Math.min(failures - 1, 10), MAX_FAILURE_BACKOFF_TICKS);
    }

    reconcileBackoff.set(repoKey, {
        failures,
        skipUntilTick: reconcileTick + skipTicks,
        lastCode: code,
        kind,
        transientRetries: kind === 'transient' ? prev.transientRetries : 0
    });
    console.log(
        `[${new Date().toISOString()}] Reconcile backoff for ${repoKey}: ` +
        `kind=${kind} code=${code} failures=${failures}, skip ${skipTicks} tick(s)`
    );
}

function clearDeployFailure(repoKey) {
    if (reconcileBackoff.has(repoKey)) {
        reconcileBackoff.delete(repoKey);
    }
}

/**
 * Collect per-target sync status (used by /status and reconcile).
 * ls-remote calls run in parallel.
 */
async function collectTargetStatus() {
    const config = loadConfig();
    const deployTimeoutMs = getDeployTimeoutMs(config, null);
    const entries = Object.entries(config.repos || {});

    const targets = await Promise.all(
        entries.map(async ([repoKey, entry]) => {
            const branch = entry.branch || 'main';
            const deployed = readDeployedSha(entry.deployPath);
            const remote = await readRemoteSha(entry.localPath, branch);
            const inSync = shasMatch(deployed, remote);
            const meta = runningMeta.get(repoKey);
            const startedAt = meta?.startedAt || null;
            const runningForMs = startedAt ? Date.now() - startedAt : null;
            const timeoutMs = getDeployTimeoutMs(config, repoKey);
            const stuckForMs =
                runningForMs != null && runningForMs > timeoutMs
                    ? runningForMs - timeoutMs
                    : 0;

            let symlinkTarget = null;
            try {
                if (entry.deployPath && fs.lstatSync(entry.deployPath).isSymbolicLink()) {
                    symlinkTarget = fs.readlinkSync(entry.deployPath);
                }
            } catch {
                /* ignore */
            }

            return {
                key: repoKey,
                name: entry.name || repoKey,
                branch,
                deployed,
                remote: remote ? remote.slice(0, Math.max(deployed?.length || 0, 8)) : null,
                remoteFull: remote,
                inSync,
                running: running.has(repoKey),
                queued: queued.has(repoKey),
                dirty: dirty.has(repoKey),
                runningForMs,
                stuckForMs,
                symlinkTarget,
                backoff: reconcileBackoff.get(repoKey) || null
            };
        })
    );

    return {
        timestamp: new Date().toISOString(),
        queueDepth: queueDepth(),
        activeDeploys,
        isReconciling,
        reconcileTick,
        deployTimeoutMs,
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
        const entries = Object.entries(config.repos || {});

        // Parallel ls-remote, then decide
        const remotes = await Promise.all(
            entries.map(async ([repoKey, entry]) => {
                const branch = entry.branch || 'main';
                const remote = await readRemoteSha(entry.localPath, branch, { bypassCache: true });
                return { repoKey, entry, branch, remote };
            })
        );

        for (const { repoKey, entry, remote } of remotes) {
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
            enqueueDeploy(repoKey, { reason: 'reconcile' });
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

function enqueueDeploy(repoKey, { reason = 'webhook' } = {}) {
    const config = loadConfig();
    maxConcurrentDeploys = getMaxConcurrentDeploys(config);

    if (running.has(repoKey) || queued.has(repoKey)) {
        dirty.add(repoKey);
        console.log(
            `[${new Date().toISOString()}] Deploy coalesced for ${repoKey} ` +
            `(already running or queued; marked dirty; reason=${reason})`
        );
        return { status: 'coalesced', depth: queueDepth(), dirty: true };
    }

    const position = queueDepth() + 1;
    const willStartNow = activeDeploys < maxConcurrentDeploys;

    queue.push(repoKey);
    queued.add(repoKey);
    dirty.delete(repoKey);
    console.log(
        `[${new Date().toISOString()}] Deploy queued for ${repoKey} ` +
        `(position ${position}, depth ${queueDepth()}, reason=${reason})`
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
            runningMeta.delete(repoKey);
            activeDeploys--;

            if (code === EXIT_OK) {
                clearDeployFailure(repoKey);
                console.log(`[${new Date().toISOString()}] Deployment successful for ${repoKey}`);
            } else {
                noteDeployFailure(repoKey, code);
                console.error(
                    `[${new Date().toISOString()}] Deployment failed for ${repoKey} (code=${code})`
                );
            }

            // Re-enqueue if a push arrived while we were running
            if (dirty.has(repoKey)) {
                dirty.delete(repoKey);
                console.log(
                    `[${new Date().toISOString()}] Re-enqueueing dirty ${repoKey} after completion`
                );
                enqueueDeploy(repoKey, { reason: 'dirty' });
            }

            const remaining = queue.length;
            if (remaining > 0) {
                console.log(`[${new Date().toISOString()}] ${remaining} deploy(s) remaining in queue`);
            }

            pump();
        });
    }
}

/**
 * Kill a process group. deploy.sh is spawned detached so it owns its group.
 */
function killProcessGroup(pid, signal) {
    if (!pid) return;
    try {
        process.kill(-pid, signal);
    } catch (err) {
        if (err.code !== 'ESRCH') {
            console.error(
                `[${new Date().toISOString()}] Failed to ${signal} pgid ${pid}:`,
                err.message
            );
        }
    }
}

function runDeploy(repoKey, callback) {
    console.log(`[${new Date().toISOString()}] Starting deployment for: ${repoKey}`);

    const dotenv = loadEnv();
    const config = loadConfig();
    const timeoutMs = getDeployTimeoutMs(config, repoKey);
    const startedAt = Date.now();

    const deploy = spawn(DEPLOY_SCRIPT, [repoKey], {
        cwd: SCRIPT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group for watchdog kill
        env: {
            ...process.env,
            PATH: '/opt/bitnami/node/bin:/usr/local/bin:/usr/bin:/bin',
            HOME: '/home/bitnami',
            ...dotenv
        }
    });

    runningMeta.set(repoKey, { startedAt, pid: deploy.pid || null });

    let output = '';
    let errorOutput = '';
    let settled = false;
    let killTimer = null;
    let hardKillTimer = null;

    const settle = (code) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        callback(code, output, errorOutput);
    };

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
        settle(code == null ? 1 : code);
    });

    deploy.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] Deployment error:`, err);
        settle(EXIT_FATAL);
    });

    // Watchdog: SIGTERM the process group, then SIGKILL after 30s
    killTimer = setTimeout(() => {
        console.error(
            `[${new Date().toISOString()}] Deploy watchdog fired for ${repoKey} ` +
            `after ${timeoutMs}ms — sending SIGTERM to pgid ${deploy.pid}`
        );
        killProcessGroup(deploy.pid, 'SIGTERM');
        hardKillTimer = setTimeout(() => {
            console.error(
                `[${new Date().toISOString()}] Deploy watchdog hard-kill for ${repoKey} ` +
                `(SIGKILL pgid ${deploy.pid})`
            );
            killProcessGroup(deploy.pid, 'SIGKILL');
            // If close never fires, settle as transient timeout
            setTimeout(() => settle(124), 2000);
        }, 30000);
    }, timeoutMs);
}

/**
 * List release directories for an app subpath, newest first.
 */
function listReleases(subpath) {
    const base = path.join(RELEASES_ROOT, subpath);
    if (!fs.existsSync(base)) return [];
    return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
            const full = path.join(base, d.name);
            let mtime = 0;
            try {
                mtime = fs.statSync(full).mtimeMs;
            } catch {
                /* ignore */
            }
            return { name: d.name, path: full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Atomically repoint deployPath symlink to targetDir.
 */
function swapSymlink(deployPath, targetDir) {
    const tmp = `${deployPath}.rollback.${process.pid}.${Date.now()}`;
    fs.symlinkSync(targetDir, tmp);
    // Atomic replace (rename over existing symlink / empty path)
    fs.renameSync(tmp, deployPath);
}

/**
 * Roll an app back to its previous release directory.
 * Body: { target: "org/repo" | "org/repo@branch", to?: "<sha-or-legacy-name>" }
 */
function rollbackTarget(repoKey, toName) {
    const config = loadConfig();
    const entry = config.repos[repoKey];
    if (!entry) {
        return { ok: false, error: `Unknown target: ${repoKey}` };
    }
    if (!entry.deployPath) {
        return { ok: false, error: 'No deployPath configured' };
    }

    const subpath = path.basename(entry.deployPath);
    const releases = listReleases(subpath);
    if (releases.length === 0) {
        return { ok: false, error: `No releases under ${RELEASES_ROOT}/${subpath}` };
    }

    let currentTarget = null;
    try {
        if (fs.lstatSync(entry.deployPath).isSymbolicLink()) {
            currentTarget = fs.realpathSync(entry.deployPath);
        }
    } catch {
        /* ignore */
    }

    let chosen;
    if (toName) {
        chosen = releases.find((r) => r.name === toName || r.path.endsWith(`/${toName}`));
        if (!chosen) {
            return {
                ok: false,
                error: `Release not found: ${toName}`,
                available: releases.map((r) => r.name)
            };
        }
    } else {
        // Previous = first release that is not the current target
        chosen = releases.find((r) => {
            try {
                return fs.realpathSync(r.path) !== currentTarget;
            } catch {
                return true;
            }
        });
        if (!chosen) {
            return { ok: false, error: 'No previous release to roll back to' };
        }
    }

    try {
        swapSymlink(entry.deployPath, chosen.path);
    } catch (err) {
        return { ok: false, error: `Symlink swap failed: ${err.message}` };
    }

    const served = readDeployedSha(entry.deployPath);
    console.log(
        `[${new Date().toISOString()}] Rollback: ${repoKey} → ${chosen.path} (stamp=${served})`
    );
    return {
        ok: true,
        target: repoKey,
        release: chosen.name,
        path: chosen.path,
        servedStamp: served,
        previous: currentTarget
    };
}

function getRequestPath(rawUrl) {
    let pathname = (rawUrl || '/').split('?')[0] || '/';
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

function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > limit) {
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

const server = http.createServer((req, res) => {
    const timestamp = new Date().toISOString();
    const reqPath = getRequestPath(req.url);

    if (req.method === 'GET' && (reqPath === '/' || reqPath === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'github-watcher',
            timestamp
        }));
        return;
    }

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

    if (req.method === 'POST' && reqPath === '/reconcile') {
        if (!isLoopback(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Loopback only' }));
            return;
        }
        readBody(req, 1024)
            .then(() => reconcile('manual'))
            .then((result) => {
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'accepted', ...result }));
            })
            .catch((err) => {
                console.error(`[${timestamp}] /reconcile error:`, err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Reconcile failed' }));
            });
        return;
    }

    if (req.method === 'POST' && reqPath === '/rollback') {
        if (!isLoopback(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Loopback only' }));
            return;
        }
        readBody(req, 64 * 1024)
            .then((body) => {
                let payload = {};
                try {
                    payload = body ? JSON.parse(body) : {};
                } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                    return;
                }
                const target = payload.target;
                if (!target) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing target' }));
                    return;
                }
                const result = rollbackTarget(target, payload.to || null);
                res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            })
            .catch((err) => {
                console.error(`[${timestamp}] /rollback error:`, err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Rollback failed' }));
            });
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 10 * 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
        }
    });

    req.on('end', () => {
        console.log(`[${timestamp}] Received webhook request`);

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

        let payload;
        try {
            payload = JSON.parse(body);
        } catch (e) {
            console.error(`[${timestamp}] Invalid JSON payload`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

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

        // A real push clears backoff so a fix commit is not delayed by a prior hang
        clearDeployFailure(repoKey);

        const enqueueResult = enqueueDeploy(repoKey, { reason: 'webhook' });
        const statusMessage = enqueueResult.status === 'coalesced'
            ? `Deployment coalesced for ${repoConfig.name} (already running or queued; will re-run)`
            : enqueueResult.status === 'started'
                ? `Deployment started for ${repoConfig.name}`
                : `Deployment queued for ${repoConfig.name} (position ${enqueueResult.position})`;

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'accepted',
            message: statusMessage,
            target: repoKey,
            queue: { status: enqueueResult.status, depth: enqueueResult.depth, dirty: !!enqueueResult.dirty }
        }));
    });

    req.on('error', (err) => {
        console.error(`[${timestamp}] Request error:`, err);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('GitHub Watcher - Webhook Server');
    console.log('='.repeat(50));
    console.log(`Started at: ${new Date().toISOString()}`);
    console.log(`Listening on: http://0.0.0.0:${PORT}`);
    console.log(`Config file: ${CONFIG_FILE}`);
    console.log(`Env file: ${ENV_FILE}`);
    console.log(`Releases root: ${RELEASES_ROOT}`);
    console.log('='.repeat(50));

    try {
        const config = loadConfig();
        console.log('Configured repositories:');
        Object.keys(config.repos).forEach(repo => {
            const entry = config.repos[repo];
            console.log(`  - ${repo} → ${entry.name} [${entry.branch || '?'}] ${entry.deployPath || ''}`);
        });
        console.log(`Deploy timeout: ${getDeployTimeoutMs(config, null)}ms`);
    } catch (e) {
        console.error('Warning: Could not load config:', e.message);
    }
    console.log('='.repeat(50));

    startReconcileTimer();
});

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
