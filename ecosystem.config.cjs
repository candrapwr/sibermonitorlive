/**
 * Konfigurasi PM2 — SiberMonitorLive
 *
 * Pakai:  pm2 start ecosystem.config.cjs
 * Ganti ADMIN_USER/ADMIN_PASS sesuai kebutuhan sebelum start.
 */
module.exports = {
  apps: [
    {
      name: 'sibermonitor-live',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,          // WAJIB 1 — antrean browser & SQLite single-process
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        ADMIN_USER: 'admin',
        ADMIN_PASS: 'gantiPasswordIni',
        POLL_INTERVAL_SEC: 60
      }
    }
  ]
};
