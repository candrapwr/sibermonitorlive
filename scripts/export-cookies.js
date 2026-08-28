/**
 * Ekspor cookie sesi TikTok dari profil lokal → JSON (untuk dipindah ke server).
 *
 * Jalankan di KOMPUTER SUMBER (app harus mati):
 *   node scripts/export-cookies.js
 * Hasil: cookies-tiktok.json (RAHASIA — berisi sesi aktif, jangan dibagikan)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = process.env.CHROMIUM_PROFILE_DIR || path.join(__dirname, '..', 'data', 'chromium-profile');
const OUT = path.join(__dirname, '..', 'cookies-tiktok.json');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, locale: 'id-ID' });
  const cookies = await ctx.cookies(['https://www.tiktok.com', 'https://www.tiktok.com/']);
  await ctx.close();

  const penting = cookies.filter(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
  if (penting.length === 0) {
    console.error('❌ Tidak ada cookie sessionid di profil lokal — login dulu: npm run login');
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(cookies, null, 1));
  console.log(`✅ ${cookies.length} cookie diekspor (${penting.map(c => c.name).join(', ')}) → ${OUT}`);
  console.log('   File ini RAHASIA (berisi sesi aktif). Kirim ke server lalu jalankan import-cookies.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
