// pm2 process config for hosts WITHOUT Docker or root (e.g. Ultra.cc shared
// slots). On a normal server use docker-compose.yml instead — see
// docs/deployment.md.
//
// .cjs (not .js) because package.json sets "type": "module" and pm2 loads this
// config as CommonJS.
//
// Usage on the box (after `npm ci && npm run build`):
//   pm2 start ecosystem.config.cjs && pm2 save
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'scbot-test',
      script: 'dist/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Restart before the slot's OOM killer fires. The canvas achievements
      // render is the main spike — tune this to the slot's real ceiling
      // (watch `pm2 monit` / `pm2 info scbot-test`). Too low → restart loops
      // mid-render; too high → the host kills it instead of pm2.
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        // Keep SQLite + backups inside the app dir so they survive restarts.
        // `mkdir -p data` on the box first.
        DB_PATH: path.join(__dirname, 'data', 'db.sqlite'),
      },
    },
  ],
};
