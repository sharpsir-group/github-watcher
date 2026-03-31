<p align="center">
  <h1 align="center">GitHub Watcher</h1>
  <p align="center">
    Zero-dependency webhook server that auto-deploys your repos on <code>git push</code>.
    <br />
    No CI provider needed. Just Node.js and a server.
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg" alt="Node >= 14" />
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="Zero Dependencies" />
</p>

---

## Why

You push to `main`. Your site is live 30 seconds later. No GitHub Actions YAML, no build minutes to burn, no vendor lock-in.

GitHub Watcher is a single Node.js process that receives GitHub webhook events, pulls your code, builds it, and deploys it -- all from a JSON config file.

## Features

- **Zero dependencies** -- runs on Node.js standard library only
- **Multi-repo** -- deploy any number of repositories from one instance
- **Branch filtering** -- only deploy pushes to the branch you care about
- **Signature verification** -- validates `X-Hub-Signature-256` using HMAC-SHA256
- **Pre-build patching** -- apply find/replace patches before build, auto-reverted after
- **Post-deploy hooks** -- run arbitrary commands after deployment (restart services, notify, etc.)
- **CloudFront invalidation** -- optional CDN cache busting via AWS CLI
- **Deploy queue** -- concurrent pushes to the same repo are queued, not dropped
- **Deploy stamping** -- injects commit hash + timestamp into `index.html` for traceability
- **Health check** -- `GET /health` endpoint for uptime monitoring
- **PM2 ready** -- ships with an `ecosystem.config.js` for production process management

## Architecture

```
GitHub ──webhook POST──▶ webhook-server.js ──spawn──▶ deploy.sh
                              │                           │
                         config.json                 git pull
                         .secrets                    pre-build patches
                                                     build
                                                     copy to deploy path
                                                     post-deploy hooks
                                                     revert patches
                                                     CloudFront invalidation
```

## Quick Start

### 1. Clone

```bash
git clone https://github.com/sharpsir-group/github-watcher.git
cd github-watcher
```

### 2. Configure

```bash
cp config.example.json config.json
```

Edit `config.json` with your repositories:

```json
{
  "repos": {
    "your-org/your-repo": {
      "name": "My App",
      "localPath": "/home/deploy/your-repo",
      "deployPath": "/var/www/my-app",
      "branch": "main",
      "preBuild": [],
      "buildCmd": "npm ci && npm run build",
      "distFolder": "dist",
      "postDeploy": [],
      "cloudfront": {},
      "secret": "WEBHOOK_SECRET_MY_APP"
    }
  }
}
```

### 3. Add secrets

```bash
# Generate a webhook secret
openssl rand -hex 32

# Create the secrets file
cat > .secrets << 'EOF'
WEBHOOK_SECRET_MY_APP=<paste-generated-secret-here>
EOF

chmod 600 .secrets
```

### 4. Clone your target repo

```bash
git clone git@github.com:your-org/your-repo.git /home/deploy/your-repo
mkdir -p /var/www/my-app
```

### 5. Start

```bash
# Direct
node webhook-server.js

# Or with PM2 (recommended)
pm2 start ecosystem.config.js
pm2 save
```

### 6. Add the webhook on GitHub

Go to your repository **Settings > Webhooks > Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `http://your-server:9001/` |
| Content type | `application/json` |
| Secret | The value from your `.secrets` file |
| Events | Just the `push` event |

## Configuration Reference

### Repository Config (`config.json`)

| Field | Type | Description |
|---|---|---|
| `name` | string | Display name used in logs |
| `localPath` | string | Absolute path to the cloned repository |
| `deployPath` | string | Where built files are copied to |
| `branch` | string | Only deploy pushes to this branch |
| `preBuild` | array | Find/replace patches applied before build (auto-reverted) |
| `buildCmd` | string | Shell command to build the project |
| `distFolder` | string | Build output directory (relative to repo root) |
| `postDeploy` | array | Shell commands to run after deployment |
| `cloudfront` | object | Optional CloudFront CDN invalidation config |
| `secret` | string | Key name in `.secrets` for webhook signature verification |

### Pre-Build Patches

Patches let you modify source files before build without polluting your git history. They are automatically reverted after the build completes (or fails).

```json
{
  "preBuild": [
    {
      "file": "vite.config.ts",
      "find": "export default defineConfig({",
      "replace": "export default defineConfig({\n  base: \"/app/\","
    }
  ]
}
```

### CloudFront Invalidation

If your deploy path is behind a CloudFront distribution, configure automatic cache invalidation:

```json
{
  "cloudfront": {
    "distributionId": "E1XXXXXXXXXX",
    "invalidationPaths": ["/*"]
  }
}
```

Requires AWS CLI installed and credentials in `.aws-credentials`:

```bash
cat > .aws-credentials << 'EOF'
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_DEFAULT_REGION=us-east-1
EOF

chmod 600 .aws-credentials
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/` or `/health` | Health check -- returns `{"status":"ok"}` |
| `POST` | `/` | Webhook receiver -- accepts GitHub push events |

## Deployment Pipeline

When a valid push event is received, the deploy script runs these steps in order:

1. **Git pull** -- `fetch` + `reset --hard` to the configured branch
2. **Pre-build patches** -- apply configured find/replace transformations
3. **Build** -- run the configured build command
4. **Deploy** -- copy build output to the deploy path
5. **Stamp** -- inject deploy timestamp and commit hash into `index.html`
6. **Post-deploy hooks** -- run any configured post-deploy commands
7. **Revert patches** -- restore patched files to their original state
8. **CDN invalidation** -- create CloudFront invalidation if configured

If the build fails at any step, patches are reverted and the deploy is aborted.

## Running with PM2

The included `ecosystem.config.js` is ready for production use:

```bash
# Start
pm2 start ecosystem.config.js

# Persist across reboots
pm2 save
pm2 startup

# Monitor
pm2 monit

# View logs
pm2 logs github-watcher
```

## Manual Deploy

Trigger a deploy without a webhook:

```bash
./deploy.sh "your-org/your-repo"
```

## File Structure

```
github-watcher/
├── webhook-server.js      # HTTP server -- receives and validates webhooks
├── deploy.sh              # Build and deploy pipeline
├── config.json            # Repository configurations (git-ignored)
├── config.example.json    # Example configuration
├── ecosystem.config.js    # PM2 process manager config
├── .secrets               # Webhook secrets (git-ignored, chmod 600)
├── .aws-credentials       # AWS credentials for CloudFront (git-ignored, chmod 600)
├── logs/                  # Deployment logs (git-ignored)
└── README.md
```

## Security

- Webhook signatures are verified using HMAC-SHA256 (`X-Hub-Signature-256`)
- Secrets and credentials are stored in separate files with `600` permissions
- Sensitive files (`.secrets`, `.aws-credentials`, `config.json`, `logs/`) are git-ignored
- Request body size is capped at 10 MB
- The server binds to `0.0.0.0` -- use a firewall or reverse proxy to restrict access

## Requirements

- **Node.js** >= 14
- **Git** (on the server)
- **PM2** (optional, recommended for production)
- **AWS CLI** (optional, only for CloudFront invalidation)

## License

[MIT](LICENSE)
