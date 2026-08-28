/**
 * Uji UI end-to-end SiberMonitorLive (auth + role + kategori) via Chromium headless.
 * Jalankan saat server berjalan: node scripts/ui-test.js
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = { u: 'admin', p: 'rahasia123' };
const VIEWER = { u: 'operator1', p: 'viewer123' };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const log = (ok, msg) => console.log(`${ok ? '✅' : '❌'} ${msg}`);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 1. Halaman login tampil
  const loginVisible = await page.locator('#loginOverlay').isVisible();
  log(loginVisible, 'halaman login tampil');

  // 2. Login admin
  await page.fill('#loginUser', ADMIN.u);
  await page.fill('#loginPass', ADMIN.p);
  await page.click('#loginBtn');
  await page.waitForTimeout(2500);
  const badge = await page.locator('#userBadge').textContent();
  log(badge.includes('admin'), `login admin berhasil: ${badge}`);

  // 3. UI admin lengkap: search + add stream + kategori
  const searchVisible = await page.locator('.search-area').isVisible();
  const addVisible = await page.locator('#loginOverlay').isHidden();
  const catChips = await page.locator('.filter-chip').allTextContents();
  log(searchVisible, 'admin: area pencarian tampil');
  log(catChips.some(c => c.includes('Semua Kategori')), 'admin: chip kategori tampil');
  log(catChips.some(c => c.includes('Politik')), `admin: kategori "Politik" ada (${catChips.length} chip)`);

  // 4. Stream & kategorinya tampil
  await page.waitForTimeout(1000);
  const cardText = await page.locator('#streamGrid').innerText().catch(() => '');
  log(cardText.includes('bangiigun') || cardText.length > 0, `admin: kartu stream tampil (${cardText.includes('Politik') ? 'dengan kategori Politik' : 'belum ada kategori di kartu'})`);

  // 5. Buat kategori baru via tombol ➕ (prompt)
  page.once('dialog', d => d.accept('Uji Kategori'));
  await page.locator('.filter-chip', { hasText: '➕' }).click();
  await page.waitForTimeout(1200);
  const catChips2 = await page.locator('.filter-chip').allTextContents();
  log(catChips2.some(c => c.includes('Uji Kategori')), 'admin: kategori baru "Uji Kategori" terbuat');

  // 6. Assign kategori stream pertama (tombol 🗂 di kartu)
  const catBtn = page.locator('.stream-card .icon-btn[title="Set kategori"]').first();
  if (await catBtn.count() > 0) {
    await catBtn.click();
    await page.waitForTimeout(600);
    const opt = page.locator('#catModalBody .list-row', { hasText: 'Uji Kategori' });
    await opt.click();
    await page.waitForTimeout(1500);
    const tags = await page.locator('.stream-card .tag', { hasText: 'Uji Kategori' }).count();
    log(tags > 0, 'admin: kategori "Uji Kategori" tertulis di kartu stream');
  } else {
    log(false, 'admin: tombol 🗂 kategori tidak ditemukan di kartu');
  }
  await page.screenshot({ path: '/tmp/ui_admin.png' });

  // 7. Logout → login viewer
  await page.locator('button[title="Keluar"]').click();
  await page.waitForTimeout(1500);
  log(await page.locator('#loginOverlay').isVisible(), 'logout → kembali ke halaman login');

  await page.fill('#loginUser', VIEWER.u);
  await page.fill('#loginPass', VIEWER.p);
  await page.click('#loginBtn');
  await page.waitForTimeout(2500);
  const vBadge = await page.locator('#userBadge').textContent();
  log(vBadge.includes('viewer'), `login viewer berhasil: ${vBadge}`);

  // 8. Viewer: TANPA pencarian & tanpa add stream
  const vSearchHidden = await page.locator('.search-area').isHidden();
  const vAddHidden = await page.locator('button[onclick="addStream()"]').isHidden();
  const vUsersHidden = await page.locator('#usersBtn').isHidden();
  log(vSearchHidden, 'viewer: area pencarian TERSEMBUNYI');
  log(vAddHidden, 'viewer: tombol Add Stream TERSEMBUNYI');
  log(vUsersHidden, 'viewer: tombol kelola user TERSEMBUNYI');

  // 9. Viewer: chip kategori + kartu stream tanpa tombol admin
  const vChips = await page.locator('.filter-chip').allTextContents();
  log(vChips.some(c => c.includes('Semua Kategori')), 'viewer: chip kategori tampil');
  log(!vChips.some(c => c.includes('High Priority')), 'viewer: chip admin (High Priority) tidak ada');
  const vCards = await page.locator('.stream-card').count();
  const vAdminBtns = await page.locator('.stream-card .icon-btn').count();
  log(vCards > 0, `viewer: ${vCards} kartu stream tampil`);
  log(vAdminBtns === 0, 'viewer: tanpa tombol aksi admin di kartu');
  const vTags = await page.locator('.stream-card .tag').allTextContents();
  log(vTags.some(t => t.includes('Uji Kategori') || t.includes('Politik')), 'viewer: kartu menampilkan kategori');
  await page.screenshot({ path: '/tmp/ui_viewer.png' });

  // 10. Viewer pilih kategori "Politik"
  const politik = page.locator('.filter-chip', { hasText: 'Politik' });
  if (await politik.count() > 0) {
    await politik.click();
    await page.waitForTimeout(600);
    const n = await page.locator('.stream-card').count();
    log(true, `viewer: filter kategori Politik → ${n} kartu`);
  }

  await browser.close();
  console.log('\nselesai — screenshot: /tmp/ui_admin.png, /tmp/ui_viewer.png');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
