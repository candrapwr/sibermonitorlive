/**
 * Impor cookie sesi TikTok (dari export-cookies.js) ke profil di server ini.
 *
 * Jalankan di SERVER TUJUAN (app harus mati):
 *   node scripts/import-cookies.js cookies-tiktok.json
 *
 * Cookie akan dienkripsi ulang dengan kunci OS server — solusi lintas-OS
 * (profil tidak bisa disalin langsung Mac↔Linux karena beda kunci enkripsi).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = process.env.CHROMIUM_PROFILE_DIR || path.join(__dirname, '..', 'data', 'chromium-profile');
const SRC = process.argv[2] || path.join(__dirname, '..', 'cookies-tiktok.json');

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('❌ File cookie tidak ditemukan:', SRC);
    process.exit(1);
  }
  const cookies = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const penting = cookies.filter(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
  if (penting.length === 0) {
    console.error('❌ File tidak berisi sessionid — ekspor ulang dari komputer sumber');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, locale: 'id-ID' });
  await ctx.addCookies(cookies);
  // verifikasi langsung
  const after = await ctx.cookies('https://www.tiktok.com');
  const ok = after.some(c => c.name === 'sessionid');
  await ctx.close();

  if (ok) {
    console.log(`✅ ${cookies.length} cookie diimpor & terenkripsi ulang — sessionid AKTIF`);
    console.log('   Hapus file cookie JSON-nya setelah selesai (berisi sesi rahasia).');
  } else {
    console.error('❌ Impor gagal — sessionid tidak terbaca setelah addCookies');
    process.exit(1);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
