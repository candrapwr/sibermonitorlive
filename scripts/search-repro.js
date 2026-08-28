/** Repro: login admin → reload (flicker search area?) → pencarian YouTube & TikTok. */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3001';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const log = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // login admin
  await page.fill('#loginUser', 'admin');
  await page.fill('#loginPass', 'admin123');
  await page.click('#loginBtn');
  await page.waitForTimeout(2000);
  const badge = await page.locator('#userBadge').textContent();
  log(badge.includes('admin'), `login admin: ${badge}`);

  // area pencarian tampil?
  log(await page.locator('.search-area').isVisible(), 'search-area tampil setelah login');

  // reload 3x — apakah search-area kadang hilang (flicker / sesi drop)?
  for (let i = 1; i <= 3; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const visible = await page.locator('.search-area').isVisible();
    const badge2 = await page.locator('#userBadge').textContent();
    log(visible && badge2.includes('admin'), `reload ${i}: search-area=${visible}, badge=${badge2}`);
  }

  // pencarian YOUTUBE via UI
  await page.click('#ptYoutube');
  await page.fill('#searchInput', 'news live');
  await page.click('#searchBtn');
  await page.waitForTimeout(6000);
  const ytCards = await page.locator('.stream-card').count();
  log(ytCards > 10, `pencarian YouTube: ${ytCards} kartu`);

  // pencarian TIKTOK via UI (harus trending + banner info)
  await page.click('#ptTikTok, #ptTiktok').catch(() => {});
  await page.fill('#searchInput', 'demo dpr');
  await page.click('#searchBtn');
  await page.waitForTimeout(40000);
  const ttCards = await page.locator('.stream-card').count();
  const notice = await page.locator('.search-notice').count();
  log(ttCards > 0, `pencarian TikTok: ${ttCards} kartu (fallback trending)`);
  log(notice > 0, `banner penjelasan trending tampil: ${notice > 0}`);

  await page.screenshot({ path: '/tmp/search_repro.png' });
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
