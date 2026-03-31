# GitHub Watcher - Auto-Deploy System

Universal webhook-based auto-deploy system for GitHub repositories.

## Components

```
/home/bitnami/github-watcher/
├── config.json          # Repository configurations
├── deploy.sh            # Build and deploy script
├── webhook-server.js    # HTTP webhook receiver (port 9001)
├── ecosystem.config.js  # PM2 configuration
├── .secrets             # Webhook secrets (chmod 600)
├── logs/                # Deployment logs
└── README.md            # This file
```

## Service Management (PM2)

```bash
# Check status
pm2 status

# View logs
pm2 logs github-watcher

# View logs (last 100 lines)
pm2 logs github-watcher --lines 100

# Restart service
pm2 restart github-watcher

# Stop/Start
pm2 stop github-watcher
pm2 start github-watcher

# Monitor (interactive dashboard)
pm2 monit

# Reload (zero-downtime)
pm2 reload github-watcher
```

## Manual Deployment

Run a deployment manually without webhook:

```bash
/home/bitnami/github-watcher/deploy.sh "sharpsir-group/1gh-of-hungary-sotheby-s-website"
```

## Webhook Endpoint

- **URL:** `http://54.93.171.71:9001/`
- **Method:** POST
- **Health Check:** `http://54.93.171.71:9001/health`

## GitHub Webhook Setup

1. Go to your GitHub repository → Settings → Webhooks → Add webhook

2. Configure:
   - **Payload URL:** `http://54.93.171.71:9001/`
   - **Content type:** `application/json`
   - **Secret:** Copy from `/home/bitnami/github-watcher/.secrets` (the value for your repo's secret key)
   - **SSL verification:** Disable (using HTTP)
   - **Events:** Just the push event
   - **Active:** ✓

3. Save and test with "Redeliver" on a recent delivery

## Adding a New Repository

### 1. Clone the repository

```bash
cd /home/bitnami
git clone git@github.com:your-org/your-repo.git
```

### 2. Add to config.json

```json
{
  "repos": {
    "your-org/your-repo": {
      "name": "My App",
      "localPath": "/home/bitnami/your-repo",
      "deployPath": "/home/bitnami/htdocs/my-app",
      "branch": "main",
      "preBuild": [
        {
          "file": "vite.config.ts",
          "find": "export default defineConfig({",
          "replace": "export default defineConfig({\n  base: \"/my-app/\","
        }
      ],
      "buildCmd": "npm install && npm run build",
      "distFolder": "dist",
      "postDeploy": [],
      "secret": "WEBHOOK_SECRET_MYAPP"
    }
  }
}
```

### 3. Generate and add secret

```bash
# Generate secret
openssl rand -hex 32

# Add to .secrets file
echo "WEBHOOK_SECRET_MYAPP=<generated-secret>" >> /home/bitnami/github-watcher/.secrets
```

### 4. Create deploy directory

```bash
mkdir -p /home/bitnami/htdocs/my-app
```

### 5. Configure GitHub webhook

Follow the "GitHub Webhook Setup" section above.

### 6. Test

```bash
/home/bitnami/github-watcher/deploy.sh "your-org/your-repo"
```

## Configuration Options

| Field | Description |
|-------|-------------|
| `name` | Display name for logs |
| `localPath` | Path to cloned repository |
| `deployPath` | Where to copy built files |
| `branch` | Branch to deploy (ignores pushes to other branches) |
| `preBuild` | Array of find/replace patches applied before build |
| `buildCmd` | Shell command to build the project |
| `distFolder` | Folder containing built files (relative to repo) |
| `postDeploy` | Array of commands to run after deployment |
| `secret` | Key name in .secrets file for webhook verification |

## preBuild Patches

Patches are applied before build and reverted after. Example:

```json
{
  "file": "vite.config.ts",
  "find": "export default defineConfig({",
  "replace": "export default defineConfig({\n  base: \"/app/\","
}
```

## Logs

Deployment logs are saved to:
```
/home/bitnami/github-watcher/logs/<repo-name>_<timestamp>.log
```

View recent logs:
```bash
ls -lt /home/bitnami/github-watcher/logs/ | head -10
cat /home/bitnami/github-watcher/logs/<latest-log-file>
```

## Troubleshooting

### Webhook not receiving requests
- Check AWS Security Group has port 9001 open
- Test with: `curl http://54.93.171.71:9001/health`

### Signature verification failing
- Ensure secret in GitHub matches value in `.secrets` file
- Check the secret key name in config.json matches the key in .secrets

### Build failing
- Check logs in `/home/bitnami/github-watcher/logs/`
- Run manual deploy to see full output

### Service not starting
```bash
pm2 logs github-watcher --lines 50
pm2 describe github-watcher
```

## Current Configured Repositories

| Repo | Deploy Path |
|------|-------------|
| sharpsir-group/1gh-of-hungary-sotheby-s-website | /home/bitnami/htdocs/hu-ai |

