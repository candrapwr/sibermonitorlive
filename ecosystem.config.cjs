/**
 * Konfigurasi PM2 — SiberMonitorLive
 *
 * Pakai:  pm2 start ecosystem.config.cjs
 *
 * 💡 Konfigurasi (ADMIN_USER/ADMIN_PASS/PORT/dll) dikelola lewat file .env
 *    di folder ini — lihat .env.example. File ini SENGAJA tidak menyetel
 *    nilai tersebut supaya .env selalu menjadi sumber kebenaran.
 *
 * ⚠️ Mengubah file .env cukup dengan `pm2 restart sibermonitor-live`
 *    (aplikasi membaca ulang .env setiap start proses).
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
        NODE_ENV: 'production'
      }
    }
  ]
};
