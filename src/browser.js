/**
 * Manager browser Playwright bersama (shared, singleton).
 *
 * - Chromium headless dengan persistent profile (data/chromium-profile)
 *   agar cookie/token anti-bot TikTok tersimpan antar restart.
 * - Semua operasi TikTok dieksekusi sekuensial via antrean agar tidak
 *   membuka banyak tab sekaligus (mengurangi risiko rate-limit/blokir).
 * - Browser diluncurkan malas (lazy) saat permintaan pertama.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PROFILE_DIR = process.env.CHROMIUM_PROFILE_DIR || path.join(__dirname, '..', 'data', 'chromium-profile');
fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });

const HEADLESS = process.env.HEADLESS !== 'false';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _context = null;
let _launching = null;
let _queue = Promise.resolve();

async function getContext() {
  if (_context) return _context;
  if (_launching) return _launching;

  _launching = (async () => {
    _context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      userAgent: UA,
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-notifications'
      ]
    });
    // Recycle jika browser mati tak terduga
    _context.on('close', () => { _context = null; _launching = null; });
    console.log('[browser] Chromium persistent context siap:', PROFILE_DIR);
    return _context;
  })();

  try {
    return await _launching;
  } catch (err) {
    _context = null;
    _launching = null;
    throw err;
  }
}

/**
 * Jalankan fn(context) secara sekuensial (antrean global).
 * Mendapat konteks browser aktif; jika halaman error/gagal,
 * context tetap dipertahankan (cookie aman).
 */
async function withContext(fn) {
  const run = _queue.then(async () => fn(await getContext()));
  // Antrean tidak pernah reject agar antrian berikut tetap jalan,
  // tapi error diteruskan ke pemanggil.
  _queue = run.catch(() => {});
  return run;
}

/** Tutup browser (dipakai saat shutdown). */
async function closeBrowser() {
  if (_context) {
    const ctx = _context;
    _context = null;
    _launching = null;
    try { await ctx.close(); } catch (_) { /* abaikan */ }
  }
}

/**
 * Bersihkan sisa proses Chromium dari run sebelumnya yang tidak mati rapi
 * (mis. server di-kill -9). Chromium basi seperti ini menahan lock pada
 * profil persisten sehingga browser baru gagal diluncurkan.
 *
 * Identifikasi presisi lewat path profil di command line proses —
 * browser Chrome milik pengguna TIDAK tersentuh.
 */
function killStaleBrowsers(extraProfileDirs = []) {
  const { execSync } = require('child_process');
  const profileDirs = [...new Set([
    PROFILE_DIR,
    ...extraProfileDirs
  ].filter(Boolean).map(dir => path.resolve(String(dir))))];
  let killed = 0;
  try {
    const out = execSync('ps -eo pid,args', { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      // Hanya proses headless Chromium yang memakai profil milik aplikasi.
      // Chrome biasa milik user dan browser login (HEADLESS=false) tidak disentuh.
      if (!profileDirs.some(dir => line.includes(dir))) continue;
      if (!/chrom|headless/i.test(line)) continue;
      if (!/(?:--headless(?:[=\s]|$)|headless[_-]?shell)/i.test(line)) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (!Number.isNaN(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGKILL');
          killed++;
        } catch (_) { /* sudah mati */ }
      }
    }
  } catch (_) { /* ps tidak tersedia → lewati */ }

  // Hapus berkas singleton lock basi (peninggalan crash) agar bisa relaunch
  for (const profileDir of profileDirs) {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.rmSync(path.join(profileDir, f), { force: true }); } catch (_) { /* abaikan */ }
    }
  }
  return killed;
}

module.exports = { getContext, withContext, closeBrowser, killStaleBrowsers };
