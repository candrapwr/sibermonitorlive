/**
 * Konfigurasi PM2 — SiberMonitorLive
 *
 * Pakai:  pm2 start ecosystem.config.cjs
 *
 * ⚠️ CATATAN PENTING soal PORT/env:
 *  - pm2 restart TIDAK membaca ulang env di file ini — env tersimpan saat
 *    start pertama. Ganti env = wajib:  pm2 delete sibermonitor-live
 *    lalu  pm2 start ecosystem.config.cjs
 *  - Alternatif lebih gampang: buat file .env di folder ini (lihat
 *    .env.example) — cukup `pm2 restart` biasa, tanpa delete.
 *  - Env di sini MENANG dari .env (hapus baris PORT di bawah bila ingin
 *    mengatur port lewat .env).
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
        PORT: 8012,
        ADMIN_USER: 'admin',
        ADMIN_PASS: 'gantiPasswordIni',
        POLL_INTERVAL_SEC: 60
      }
    }
  ]
};
