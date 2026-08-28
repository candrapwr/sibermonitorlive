/**
 * Login TikTok opsional (sekali saja) untuk membuka pencarian keyword penuh.
 *
 * Jalankan: npm run login
 * - Membuka jendela browser VISIBLE (bukan headless)
 * - Anda login dengan akun TikTok sendiri (QR/telepon/Google — apa pun)
 * - Skrip mendeteksi login berhasil lalu menutup browser
 * - Sesi tersimpan di data/chromium-profile — pencarian keyword
 *   otomatis aktif setelah ini (tanpa perlu login ulang selama sesi valid)
 *
 * Catatan: monitoring & add-by-URL tetap berfungsi TANPA login;
 * login hanya memperluas fitur pencarian keyword.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = process.env.CHROMIUM_PROFILE_DIR || path.join(__dirname, '..', 'data', 'chromium-profile');
fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });

(async () => {
  console.log('Membuka browser untuk login TikTok...');
  console.log('Login dengan akun Anda sendiri (QR code / nomor telepon / Google / Apple).');
  console.log('Setelah berhasil, jendela akan tertutup otomatis.\n');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    locale: 'id-ID',
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Deteksi login: cookie sessionid muncul
  const deadline = Date.now() + 5 * 60 * 1000; // maks 5 menit
  let logged = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const cookies = await ctx.cookies('https://www.tiktok.com');
    if (cookies.some(c => c.name === 'sessionid')) { logged = true; break; }
    if (ctx.pages().length === 0) break; // user menutup jendela
  }

  if (logged) {
    console.log('✅ Login berhasil — sesi tersimpan di profil browser SiberMonitorLive.');
    console.log('   Pencarian keyword TikTok sekarang aktif.');
    await ctx.close();
  } else {
    console.log('⚠️  Login tidak terdeteksi (waktu habis atau jendela ditutup).');
    console.log('   Monitoring tetap berfungsi tanpa login.');
    try { await ctx.close(); } catch (_) { /* abaikan */ }
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
