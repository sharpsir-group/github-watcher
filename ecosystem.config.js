const path = require('path');
const BASE = __dirname;

module.exports = {
  apps: [{
    name: 'github-watcher',
    script: 'webhook-server.js',
    cwd: BASE,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: 9001
    },
    error_file: path.join(BASE, 'logs', 'pm2-error.log'),
    out_file: path.join(BASE, 'logs', 'pm2-out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};

