/**
 * Ekspor cookie TikTok dari comment profile ke JSON terpisah.
 * Login tidak diperlukan; comment profile dapat berjalan anonim.
 *
 * Jalankan:
 *   node scripts/export-comment-cookies.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = process.env.TIKTOK_COMMENT_PROFILE_DIR ||
  path.join(__dirname, '..', 'data', 'chromium-comment-profile');
const OUT = process.env.TIKTOK_COMMENT_COOKIES_FILE ||
  path.join(__dirname, '..', 'cookies-tiktok-comments.json');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, locale: 'id-ID' });
  try {
    const cookies = await ctx.cookies(['https://www.tiktok.com', 'https://www.tiktok.com/']);
    fs.writeFileSync(OUT, JSON.stringify(cookies, null, 1), { mode: 0o600 });
    try { fs.chmodSync(OUT, 0o600); } catch (_) {}
    const session = cookies.filter(c => c.name === 'sessionid' || c.name === 'sessionid_ss');
    console.log(`✅ ${cookies.length} cookie comment profile diekspor → ${OUT}`);
    if (session.length) {
      console.log(`   sessionid ditemukan (${session.map(c => c.name).join(', ')}).`);
    } else {
      console.log('   ℹ️ Tidak ada sessionid. Ini normal untuk comment profile anonim.');
    }
    console.log('   File ini rahasia. Hapus setelah selesai diimpor ke server.');
  } finally {
    await ctx.close().catch(() => {});
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
