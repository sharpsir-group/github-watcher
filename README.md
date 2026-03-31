<p align="center">
  <a href="https://sharpsir.group">
    <img src="https://raw.githubusercontent.com/sharpsir-group/.github/main/brand/logo-blue.png" alt="Sharp Sotheby's International Realty" width="400" />
  </a>
</p>

<h3 align="center">GitHub Watcher</h3>

<p align="center">
  Zero-dependency webhook server that auto-deploys your repos on <code>git push</code>.<br />
  No CI provider needed — just Node.js, a JSON config, and a server.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D14-brightgreen.svg" alt="Node >= 14" />
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="Zero Dependencies" />
  <img src="https://img.shields.io/github/stars/sharpsir-group/github-watcher?style=flat" alt="Stars" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/HMAC--SHA256-2B037A?style=flat&logo=letsencrypt&logoColor=white" alt="HMAC-SHA256" />
  <img src="https://img.shields.io/badge/PM2-2B037A?style=flat&logo=pm2&logoColor=white" alt="PM2" />
  <img src="https://img.shields.io/badge/Apache-D22128?style=flat&logo=apache&logoColor=white" alt="Apache" />
  <img src="https://img.shields.io/badge/GitHub_Webhooks-2088FF?style=flat&logo=github&logoColor=white" alt="GitHub Webhooks" />
  <img src="https://img.shields.io/badge/CloudFront-232F3E?style=flat&logo=amazonaws&logoColor=white" alt="CloudFront" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Lovable-FF6B6B?style=flat&logo=heart&logoColor=white" alt="Lovable" />
</p>

---

### Why

We build apps in [Lovable](https://lovable.dev), which syncs every change to a GitHub repo. GitHub Watcher bridges the gap between Lovable's cloud development and our self-hosted infrastructure: every time Lovable pushes to `main`, this server pulls the code, patches it for our subpath deployment (e.g. `/hrms/`, `/pipeline/`), builds it, and copies the output to the web server — all without touching the Lovable project files.

No GitHub Actions YAML, no build minutes to burn, no vendor lock-in. Just a single Node.js process, a JSON config, and a GitHub webhook.

### The Problem

| Scenario | GitHub Actions | GitHub Watcher |
|---|---|---|
| Build minutes | Limited free tier, then paid | Unlimited — your own CPU |
| Self-hosted deploy | Needs SSH keys, runners, or third-party actions | Built-in — deploys locally |
| Subpath SPA patching | Custom scripts in YAML | First-class `preBuild` config |
| CloudFront invalidation | Extra action + AWS credentials in secrets | Built-in, one config key |
| Webhook secret rotation | Update repo settings + re-deploy secrets | Edit `.secrets`, restart PM2 |
| Debugging deploys | Scroll through action logs in browser | `pm2 logs github-watcher` or `./logs/` |

### Features

- **Zero dependencies** — runs on Node.js standard library only
- **Multi-repo** — deploy any number of repositories from one instance
- **Branch filtering** — only deploy pushes to the branch you care about
- **Signature verification** — validates `X-Hub-Signature-256` using HMAC-SHA256
- **Pre-build patching** — apply find/replace patches before build, auto-reverted after
- **Post-deploy hooks** — run arbitrary commands after deployment (restart services, notify, etc.)
- **CloudFront invalidation** — optional CDN cache busting via AWS CLI
- **Deploy queue** — concurrent pushes to the same repo are queued, not dropped
- **Deploy stamping** — injects commit hash + timestamp into `index.html` for traceability
- **Health check** — `GET /health` endpoint for uptime monitoring
- **PM2 ready** — ships with an `ecosystem.config.js` for production process management

### Architecture

```
Lovable ──push──▶ GitHub ──webhook POST──▶ webhook-server.js ──spawn──▶ deploy.sh
                                                │                           │
                                           config.json                 git pull
                                           .secrets                    pre-build patches
                                                                       build
                                                                       copy to deploy path
                                                                       post-deploy hooks
                                                                       revert patches
                                                                       CloudFront invalidation
```

### Quick Start

#### 1. Clone

```bash
git clone https://github.com/sharpsir-group/github-watcher.git
cd github-watcher
```

#### 2. Configure

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
      "buildCmd": "npm install --include=dev && npm run build",
      "distFolder": "dist",
      "postDeploy": [],
      "cloudfront": {},
      "secret": "WEBHOOK_SECRET_MY_APP"
    }
  }
}
```

> **Note:** Use `npm install --include=dev` instead of `npm ci` in `buildCmd`. PM2 sets `NODE_ENV=production`, which causes `npm install` / `npm ci` to skip devDependencies (including build tools like Vite). The `--include=dev` flag ensures they are always installed.

#### 3. Add secrets

```bash
openssl rand -hex 32

cat > .secrets << 'EOF'
WEBHOOK_SECRET_MY_APP=<paste-generated-secret-here>
EOF

chmod 600 .secrets
```

#### 4. Clone your target repo

```bash
git clone git@github.com:your-org/your-repo.git /home/deploy/your-repo
mkdir -p /var/www/my-app
```

#### 5. Start

```bash
# Direct
node webhook-server.js

# Or with PM2 (recommended)
pm2 start ecosystem.config.js
pm2 save
```

#### 6. Add the webhook on GitHub

Go to your repository **Settings > Webhooks > Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `http://your-server:9001/` |
| Content type | `application/json` |
| Secret | The value from your `.secrets` file |
| Events | Just the `push` event |

Or use the GitHub CLI:

```bash
gh api repos/your-org/your-repo/hooks --method POST \
  -f 'name=web' \
  -f 'config[url]=https://your-server/webhook/github-watcher' \
  -f 'config[content_type]=json' \
  -f 'config[secret]=YOUR_SECRET_VALUE' \
  -f 'config[insecure_ssl]=0' \
  -f 'events[]=push' \
  -F 'active=true'
```

### Configuration Reference

#### Repository Config (`config.json`)

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

#### Pre-Build Patches

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

##### Deploying SPAs to a Subpath

When deploying a Vite + React Router app to a subpath (e.g. `/app/`), two patches are needed:

1. **Vite `base`** — so asset URLs (JS, CSS, images) resolve correctly
2. **React Router `basename`** — so the client-side router matches routes under the subpath

```json
{
  "preBuild": [
    {
      "file": "vite.config.ts",
      "find": "export default defineConfig(({ mode }) => ({",
      "replace": "export default defineConfig(({ mode }) => ({\n  base: \"/app/\","
    },
    {
      "file": "src/App.tsx",
      "find": "<BrowserRouter>",
      "replace": "<BrowserRouter basename=\"/app\">"
    }
  ]
}
```

Without the `basename` patch, the app will load but the router will show a 404 because it doesn't know its routes are prefixed.

#### CloudFront Invalidation

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

### API

| Method | Path | Description |
|---|---|---|
| `GET` | `/` or `/health` | Health check — returns `{"status":"ok"}` |
| `POST` | `/` | Webhook receiver — accepts GitHub push events |

### Deployment Pipeline

When a valid push event is received, the deploy script runs these steps in order:

1. **Git pull** — `fetch` + `reset --hard` to the configured branch
2. **Pre-build patches** — apply configured find/replace transformations
3. **Build** — run the configured build command
4. **Deploy** — copy build output to the deploy path
5. **Stamp** — inject deploy timestamp and commit hash into `index.html`
6. **Post-deploy hooks** — run any configured post-deploy commands
7. **Revert patches** — restore patched files to their original state
8. **CDN invalidation** — create CloudFront invalidation if configured

If the build fails at any step, patches are reverted and the deploy is aborted.

### Reverse Proxy Setup

In production, place the webhook server behind a reverse proxy (Apache, Nginx) with TLS.

#### Apache

```apache
ProxyPass /webhook/github-watcher http://127.0.0.1:9001/
ProxyPassReverse /webhook/github-watcher http://127.0.0.1:9001/
```

GitHub webhook Payload URL: `https://your-domain/webhook/github-watcher`

#### SPA `.htaccess`

Each deploy path serving a single-page app needs an `.htaccess` for client-side routing:

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /app/
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . /app/index.html [L]
</IfModule>

<IfModule mod_headers.c>
    <FilesMatch "^index\.html$">
        Header set Cache-Control "no-cache, no-store, must-revalidate"
    </FilesMatch>
    <FilesMatch "\.(js|css|woff2)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </FilesMatch>
</IfModule>
```

> **Note:** `deploy.sh` runs `rm -rf "$DEPLOY_PATH"/*` before copying, but the `*` glob does not match dotfiles, so `.htaccess` survives redeploys.

### Running with PM2

The included `ecosystem.config.js` is ready for production use:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
pm2 monit
pm2 logs github-watcher
```

### Manual Deploy

Trigger a deploy without a webhook:

```bash
./deploy.sh "your-org/your-repo"
```

### File Structure

```
github-watcher/
├── webhook-server.js      # HTTP server — receives and validates webhooks
├── deploy.sh              # Build and deploy pipeline
├── config.json            # Repository configurations (git-ignored)
├── config.example.json    # Example configuration
├── ecosystem.config.js    # PM2 process manager config
├── package.json           # npm metadata and keywords
├── .secrets               # Webhook secrets (git-ignored, chmod 600)
├── .aws-credentials       # AWS credentials for CloudFront (git-ignored, chmod 600)
├── logs/                  # Deployment logs (git-ignored)
└── README.md
```

### Security

- Webhook signatures are verified using HMAC-SHA256 (`X-Hub-Signature-256`)
- Secrets and credentials are stored in separate files with `600` permissions
- Sensitive files (`.secrets`, `.aws-credentials`, `config.json`, `logs/`) are git-ignored
- Request body size is capped at 10 MB
- The server binds to `0.0.0.0` — use a firewall or reverse proxy to restrict access

### Who Is This For?

- **Lovable developers** deploying to self-hosted infrastructure
- **Indie hackers** who want CI/CD without GitHub Actions limits
- **Self-hosters** who prefer control over third-party services
- **Teams** deploying multiple Vite/React SPAs from one server

### Requirements

- **Node.js** >= 14
- **Git** (on the server)
- **PM2** (optional, recommended for production)
- **AWS CLI** (optional, only for CloudFront invalidation)

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

### License

[MIT](LICENSE)

---

<p align="center">
  <sub>Part of the <a href="https://github.com/sharpsir-group"><strong>Sharp Matrix</strong></a> platform · <a href="https://sharpsir.group">sharpsir.group</a></sub>
</p>
