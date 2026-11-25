const fs = require("fs");
const path = require("path");

const live = process.env.SAILGG_LIVE || "/var/www/releases/sailgg/live";
const envFile = path.join("/home/digitalpeers/sailgg", ".env.production");

/** Parse KEY=VALUE lines from .env.production into a plain object for PM2 `env`. */
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1);
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: "sailgg",
      cwd: live,
      script: "server/index.mjs",
      interpreter: "/opt/node22/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        PORT: 3100,
        HOST: "127.0.0.1",
        ...loadEnvFile(envFile),
      },
    },
  ],
};
