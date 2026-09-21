/**
 * Impor cookie TikTok ke comment profile.
 * Login/session tidak wajib; file boleh berisi cookie anonim atau kosong.
 *
 * Jalankan di server saat aplikasi berhenti:
 *   node scripts/import-comment-cookies.js cookies-tiktok-comments.json
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = process.env.TIKTOK_COMMENT_PROFILE_DIR ||
  path.join(__dirname, '..', 'data', 'chromium-comment-profile');
const SRC = process.argv[2] || path.join(__dirname, '..', 'cookies-tiktok-comments.json');

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('❌ File cookie komentar tidak ditemukan:', SRC);
    process.exit(1);
  }
  let cookies;
  try { cookies = JSON.parse(fs.readFileSync(SRC, 'utf8')); } catch (err) {
    console.error('❌ JSON cookie tidak valid:', err.message);
    process.exit(1);
  }
  if (!Array.isArray(cookies)) {
    console.error('❌ Format cookie harus berupa array JSON');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, locale: 'id-ID' });
  try {
    if (cookies.length) await ctx.addCookies(cookies);
    const after = await ctx.cookies('https://www.tiktok.com');
    const hasSession = after.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
    console.log(`✅ ${cookies.length} cookie comment profile diimpor ke ${PROFILE}`);
    console.log(hasSession
      ? '   sessionid tersedia dan sudah dienkripsi ulang oleh OS server.'
      : '   Mode anonim: tidak ada sessionid, ini normal dan tidak memerlukan login.');
    console.log('   Hapus file JSON cookie setelah selesai.');
  } finally {
    await ctx.close().catch(() => {});
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
