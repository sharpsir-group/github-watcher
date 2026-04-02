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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9001;
const SCRIPT_DIR = __dirname;
const CONFIG_FILE = path.join(SCRIPT_DIR, 'config.json');
const SECRETS_FILE = path.join(SCRIPT_DIR, '.secrets');
const DEPLOY_SCRIPT = path.join(SCRIPT_DIR, 'deploy.sh');
const AWS_CREDENTIALS_FILE = path.join(SCRIPT_DIR, '.aws-credentials');

// Load secrets from .secrets file
function loadSecrets() {
    const secrets = {};
    if (fs.existsSync(SECRETS_FILE)) {
        const content = fs.readFileSync(SECRETS_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key && valueParts.length > 0) {
                    secrets[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
    }
    return secrets;
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

// Load AWS credentials from .aws-credentials file
function loadAwsCredentials() {
    const creds = {};
    if (fs.existsSync(AWS_CREDENTIALS_FILE)) {
        const content = fs.readFileSync(AWS_CREDENTIALS_FILE, 'utf8');
        content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key && valueParts.length > 0) {
                    creds[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
    }
    return creds;
}

// Deploy queue: prevents concurrent deploys for the same repo
const deployState = {};

function getRepoState(repoKey) {
    if (!deployState[repoKey]) {
        deployState[repoKey] = { running: false, pending: false };
    }
    return deployState[repoKey];
}

function queueDeploy(repoKey) {
    const state = getRepoState(repoKey);

    if (state.running) {
        state.pending = true;
        console.log(`[${new Date().toISOString()}] Deploy already running for ${repoKey}, queued next run`);
        return;
    }

    state.running = true;
    state.pending = false;

    runDeploy(repoKey, (code, output, error) => {
        if (code === 0) {
            console.log(`[${new Date().toISOString()}] Deployment successful for ${repoKey}`);
        } else {
            console.error(`[${new Date().toISOString()}] Deployment failed for ${repoKey}`);
        }

        state.running = false;

        if (state.pending) {
            console.log(`[${new Date().toISOString()}] Running queued deploy for ${repoKey}`);
            queueDeploy(repoKey);
        }
    });
}

// Run deployment script
function runDeploy(repoKey, callback) {
    console.log(`[${new Date().toISOString()}] Starting deployment for: ${repoKey}`);
    
    const awsCreds = loadAwsCredentials();
    const secrets = loadSecrets();
    
    const deploy = spawn(DEPLOY_SCRIPT, [repoKey], {
        cwd: SCRIPT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PATH: '/opt/bitnami/node/bin:/usr/local/bin:/usr/bin:/bin',
            HOME: '/home/bitnami',
            ...(awsCreds.AWS_ACCESS_KEY_ID && { AWS_ACCESS_KEY_ID: awsCreds.AWS_ACCESS_KEY_ID }),
            ...(awsCreds.AWS_SECRET_ACCESS_KEY && { AWS_SECRET_ACCESS_KEY: awsCreds.AWS_SECRET_ACCESS_KEY }),
            ...(awsCreds.AWS_DEFAULT_REGION && { AWS_DEFAULT_REGION: awsCreds.AWS_DEFAULT_REGION }),
            ...(secrets.CF_API_TOKEN && { CF_API_TOKEN: secrets.CF_API_TOKEN })
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

// Create HTTP server
const server = http.createServer((req, res) => {
    const timestamp = new Date().toISOString();
    
    // Health check endpoint
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            service: 'github-watcher',
            timestamp 
        }));
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
        
        // Load fresh config and secrets for each request
        let config, secrets;
        try {
            config = loadConfig();
            secrets = loadSecrets();
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
        
        console.log(`[${timestamp}] Repository: ${repoFullName}`);
        
        // Find repo config
        const repoConfig = config.repos[repoFullName];
        if (!repoConfig) {
            console.log(`[${timestamp}] Repository not configured: ${repoFullName}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Repository not configured' }));
            return;
        }
        
        // Check branch
        const ref = payload.ref || '';
        const branch = ref.replace('refs/heads/', '');
        if (repoConfig.branch && branch !== repoConfig.branch) {
            console.log(`[${timestamp}] Ignoring push to branch: ${branch} (configured: ${repoConfig.branch})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'ignored', 
                reason: `Push to ${branch}, not ${repoConfig.branch}` 
            }));
            return;
        }
        
        // Verify signature
        const signature = req.headers['x-hub-signature-256'];
        const secretKey = repoConfig.secret;
        const secretValue = secrets[secretKey];
        
        if (secretValue) {
            if (!verifySignature(body, signature, secretValue)) {
                console.error(`[${timestamp}] Invalid signature for ${repoFullName}`);
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid signature' }));
                return;
            }
            console.log(`[${timestamp}] Signature verified`);
        } else {
            console.log(`[${timestamp}] Warning: No secret configured for ${repoFullName}`);
        }
        
        // Respond immediately to GitHub
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'accepted', 
            message: `Deployment started for ${repoConfig.name}` 
        }));
        
        // Queue deployment (prevents concurrent deploys for same repo)
        queueDeploy(repoFullName);
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
    console.log(`Secrets file: ${SECRETS_FILE}`);
    console.log('='.repeat(50));
    
    // Log configured repos
    try {
        const config = loadConfig();
        console.log('Configured repositories:');
        Object.keys(config.repos).forEach(repo => {
            console.log(`  - ${repo} (${config.repos[repo].name})`);
        });
    } catch (e) {
        console.error('Warning: Could not load config:', e.message);
    }
    console.log('='.repeat(50));
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

