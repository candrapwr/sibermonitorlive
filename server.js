/**
 * SiberMonitorLive — server Express.
 * REST API untuk monitoring stream + serve frontend statis.
 *
 * Auth: login cookie-session. Admin master di-set via env
 * (ADMIN_USER / ADMIN_PASS). User lain dibuat admin lewat UI.
 * Viewer (user biasa): hanya melihat list Saved buatan admin, tanpa pencarian.
 */

// Muat file .env (bila ada) PALING AWAL — sebelum modul lain membaca env.
// Variabel yang sudah ter-set di environment (mis. dari PM2) TIDAK ditimpa.
(function loadDotEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val; // environment asli menang
    }
    console.log('[env] .env dimuat');
  } catch (e) {
    console.warn('[env] gagal membaca .env:', e.message);
  }
})();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const poller = require('./src/poller');
const tiktok = require('./src/providers/tiktok');
const youtube = require('./src/providers/youtube');
const { closeBrowser, killStaleBrowsers } = require('./src/browser');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.json());

/* ------------------------------------------------------------------ */
/* Versi aset dinamis (cache-busting)                                  */
/*                                                                     */
/* style.css / app.js / vendor diberi query ?v=<mtime-size> sehingga   */
/* browser selalu memuat versi terbaru setelah file berubah — tanpa   */
/* hard refresh, tanpa restart server (mtime dibaca ulang tiap request) */
/* ------------------------------------------------------------------ */

const PUBLIC_DIR = path.join(__dirname, 'public');

function fileVersion(rel) {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, rel));
    return st.mtimeMs.toString(36) + '-' + st.size.toString(36);
  } catch {
    return '0';
  }
}

// index.html diproses per-request: token __V_*__ diganti versi file.
// Isi file di-cache dan hanya dibaca ulang kalau index.html berubah.
const ASSET_TOKENS = {
  __V_CSS__: () => fileVersion('style.css'),
  __V_JS__: () => fileVersion('app.js'),
  __V_HLS__: () => fileVersion('vendor/hls.min.js'),
  __V_FLV__: () => fileVersion('vendor/mpegts.js')
};
let indexCache = { mtime: 0, html: '' };

function renderIndex() {
  const p = path.join(PUBLIC_DIR, 'index.html');
  const st = fs.statSync(p);
  if (indexCache.mtime !== st.mtimeMs) {
    indexCache = { mtime: st.mtimeMs, html: fs.readFileSync(p, 'utf8') };
  }
  let html = indexCache.html;
  for (const [token, fn] of Object.entries(ASSET_TOKENS)) {
    html = html.split(token).join(fn());
  }
  return html;
}

// Halaman utama TIDAK di-cache supaya token versi selalu segar;
// asetnya sendiri boleh di-cache browser karena URL berubah tiap edit.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderIndex());
});

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

/* ------------------------------------------------------------------ */
/* Password & sesi                                                     */
/* ------------------------------------------------------------------ */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/** Middleware: wajib login; viewer-only endpoints dicek terpisah. */
app.use('/api', (req, res, next) => {
  // /img dibuka tanpa login: cover/avatar memang aset publik CDN (login overlay
  // tetap melindungi halaman); anti-abuse ditangani allowlist + rate-limit.
  if (req.path === '/auth/login' || req.path === '/health' || req.path === '/assets-version' || req.path === '/img') return next();
  const user = db.getSessionUser(parseCookies(req).sid);
  if (!user) return res.status(401).json({ error: 'Belum login' });
  req.user = user;
  next();
});

/** Guard khusus admin. */
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang boleh melakukan aksi ini' });
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Proxy gambar (cover/avatar)                                         */
/*                                                                     */
/* CDN TikTok/YouTube menolak request <img> langsung dari origin lain  */
/* ("Access Denied" — cek referer/tanda tangan). Server mengambil      */
/* gambarnya dengan header yang benar lalu menyajikannya dari origin   */
/* sendiri. Host dibatasi allowlist supaya tidak jadi open-proxy.      */
/* ------------------------------------------------------------------ */

const IMG_HOST_ALLOW = [
  /\.tiktokcdn(-us)?\.com$/i,
  /\.tiktok\.com$/i,
  /\.ytimg\.com$/i,
  /\.youtube\.com$/i,
  /\.ggpht\.com$/i,
  /\.googleusercontent\.com$/i
];
const IMG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* Cache disk: user pertama men-fetch dari CDN, sisanya dilayani dari disk.
   Tanpa ini, cache browser tiap user terpisah → N user = N fetch CDN. */
const IMG_CACHE_DIR = path.join(__dirname, 'data', 'img-cache');
const IMG_CACHE_TTL_MS = 24 * 3600 * 1000; // selaras cache browser (1 hari)
const IMG_CACHE_MAX_BYTES = 200 * 1024 * 1024; // batas 200MB, sisakan ruang disk

function imgCachePath(url) {
  return path.join(IMG_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex'));
}

/** Deteksi content-type dari magic bytes (file cache tanpa ekstensi). */
function sniffImageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.length > 12 && buf.subarray(4, 8).toString() === 'ftyp') return 'image/avif';
  return 'application/octet-stream';
}

/** Buang entri terlama bila cache melebihi batas (dijalankan asinkron, best-effort). */
function trimImgCache() {
  fs.readdir(IMG_CACHE_DIR, (err, files) => {
    if (err) return;
    const stats = [];
    let pending = files.length;
    if (!pending) return;
    for (const f of files) {
      const p = path.join(IMG_CACHE_DIR, f);
      fs.stat(p, (e2, st) => {
        if (!e2) stats.push({ p, mtime: st.mtimeMs, size: st.size });
        if (--pending === 0) {
          const total = stats.reduce((a, s) => a + s.size, 0);
          if (total <= IMG_CACHE_MAX_BYTES) return;
          stats.sort((a, b) => a.mtime - b.mtime); // terlama dulu
          let over = total - IMG_CACHE_MAX_BYTES;
          for (const s of stats) {
            if (over <= 0) break;
            fs.unlink(s.p, () => {});
            over -= s.size;
          }
        }
      });
    }
  });
}

async function fetchCdnImage(target) {
  const r = await fetch(target, {
    headers: {
      'User-Agent': IMG_UA,
      'Accept': 'image/*',
      // Referer platform asli — sebagian CDN menolak tanpa ini
      'Referer': target.hostname.includes('tiktok') ? 'https://www.tiktok.com/' : 'https://www.youtube.com/'
    },
    signal: AbortSignal.timeout(8000)
  });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok || !ct.startsWith('image/')) return null;
  return Buffer.from(await r.arrayBuffer());
}

/* Rate-limit ringan per IP (in-memory) — pengaman karena /api/img publik. */
const IMG_RATE_LIMIT = 120;            // max request/menit/IP
const IMG_RATE_WINDOW_MS = 60 * 1000;
const imgRate = new Map();             // ip → { count, resetAt }

function imgRateAllow(ip) {
  const now = Date.now();
  let e = imgRate.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + IMG_RATE_WINDOW_MS };
    imgRate.set(ip, e);
  }
  if (imgRate.size > 1000) { // bersihkan entri basi sesekali
    for (const [k, v] of imgRate) if (now > v.resetAt) imgRate.delete(k);
  }
  return ++e.count <= IMG_RATE_LIMIT;
}

/** Fallback visual bila CDN menolak (URL bertanda tangan kedaluwarsa) dan
    cache pun kosong: avatar huruf / kotak netral — selalu 200, tanpa img pecah. */
function fallbackImageSvg(letter) {
  const ch = (String(letter || '').match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">` +
    `<rect width="200" height="200" fill="#14141f"/>` +
    `<text x="100" y="128" font-family="Arial,sans-serif" font-size="86" font-weight="700" ` +
    `fill="#00f2ea" text-anchor="middle">${ch}</text></svg>`;
}

app.get('/api/img', async (req, res) => {
  if (!imgRateAllow(req.ip || 'unknown')) {
    return res.status(429).set('Retry-After', '10').json({ error: 'Terlalu banyak request gambar' });
  }
  const raw = String(req.query.u || '');
  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'URL gambar tidak valid' });
  }
  if (target.protocol !== 'https:' || !IMG_HOST_ALLOW.some(re => re.test(target.hostname))) {
    return res.status(403).json({ error: 'Host gambar tidak diizinkan' });
  }

  fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
  const cacheFile = imgCachePath(raw);
  res.set('Cache-Control', 'public, max-age=86400'); // cache browser 1 hari

  // 1) Cache disk segar → langsung sajikan (tanpa sentuh CDN)
  try {
    const st = fs.statSync(cacheFile);
    if (Date.now() - st.mtimeMs < IMG_CACHE_TTL_MS) {
      const buf = fs.readFileSync(cacheFile);
      const ct = sniffImageType(buf);
      if (ct !== 'application/octet-stream') {
        return res.set('Content-Type', ct).set('X-Img-Cache', 'hit').send(buf);
      }
    }
  } catch (_) { /* belum ada di cache */ }

  // 2) Ambil dari CDN, simpan ke cache, sajikan
  try {
    const buf = await fetchCdnImage(target);
    if (!buf) throw new Error('CDN menolak');
    fs.writeFile(cacheFile, buf, () => trimImgCache()); // tulis asinkron, best-effort
    res.set('Content-Type', sniffImageType(buf)).set('X-Img-Cache', 'miss').send(buf);
  } catch {
    // 3) CDN gagal → fallback cache basi; kalau tidak ada → gambar fallback
    try {
      const buf = fs.readFileSync(cacheFile);
      res.set('Content-Type', sniffImageType(buf)).set('X-Img-Cache', 'stale').send(buf);
    } catch {
      res.set('Content-Type', 'image/svg+xml')
        .set('Cache-Control', 'public, max-age=3600')
        .set('X-Img-Cache', 'fallback')
        .send(fallbackImageSvg(req.query.t));
    }
  }
});

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */

function detectPlatform(url) {
  const u = String(url);
  if (/tiktok\.com/i.test(u)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  return null;
}

async function resolveStream(url) {
  const platform = detectPlatform(url);
  if (!platform) {
    const err = new Error('URL tidak dikenali — gunakan URL TikTok (@user/live) atau YouTube (watch?v=… / youtu.be / @channel)');
    err.status = 400;
    throw err;
  }
  if (platform === 'tiktok') {
    const username = tiktok.parseUrl(url);
    if (!username) {
      const err = new Error('URL TikTok tidak valid — contoh: https://www.tiktok.com/@username/live');
      err.status = 400;
      throw err;
    }
    const info = await tiktok.getStreamInfo(username);
    return { platform, info };
  }
  const info = await youtube.resolve(url);
  return { platform, info };
}

/** Sanitasi snapshot info dari client (hasil pencarian) — hanya field dikenal. */
function sanitizeInfo(raw, url) {
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  return {
    platform: s(raw.platform),
    source_key: s(raw.source_key),
    url: s(raw.url) || String(url).trim(),
    is_live: !!raw.is_live,
    private_live: !!raw.private_live,
    viewers: n(raw.viewers),
    title: s(raw.title),
    display_name: s(raw.display_name),
    handle: s(raw.handle),
    avatar_url: /^https:\/\//.test(String(raw.avatar_url || '')) ? raw.avatar_url : undefined,
    cover_url: /^https:\/\//.test(String(raw.cover_url || '')) ? raw.cover_url : undefined,
    started_at: Number.isFinite(Number(raw.started_at)) ? Number(raw.started_at) : undefined,
    playback_url: /^https:\/\//.test(String(raw.playback_url || '')) ? raw.playback_url : undefined,
    playback_flv_url: /^https:\/\//.test(String(raw.playback_flv_url || '')) ? raw.playback_flv_url : undefined
  };
}

function wrapAsync(fn) {  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      const status = err.status || (err.code === 'NOT_LIVE' || err.code === 'NO_DATA' || err.code === 'SEARCH_BLOCKED' ? 422 : 502);
      res.status(status).json({ error: err.message || 'Terjadi kesalahan' });
    });
  };
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

app.post('/api/auth/login', wrapAsync(async (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? db.getUserByUsername(username) : null;
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    await new Promise(r => setTimeout(r, 600)); // rempat brute force
    return res.status(401).json({ error: 'Username atau password salah' });
  }
  const token = db.createSession(user.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  res.json({ id: user.id, username: user.username, role: user.role });
}));

app.post('/api/auth/logout', (req, res) => {
  db.deleteSession(parseCookies(req).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.user);
});

/* ------------------------------------------------------------------ */
/* Users (admin)                                                       */
/* ------------------------------------------------------------------ */

app.get('/api/users', adminOnly, (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/users', adminOnly, wrapAsync(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || String(password).length < 5) {
    return res.status(400).json({ error: 'Username & password (min 5 karakter) wajib diisi' });
  }
  if (db.getUserByUsername(username)) {
    return res.status(409).json({ error: `User "${username}" sudah ada` });
  }
  const user = db.createUser(username, hashPassword(password), role);
  res.status(201).json(user);
}));

app.delete('/api/users/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });
  if (db.getUserById(id)?.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ error: 'Minimal harus ada satu admin' });
  }
  const ok = db.deleteUser(id);
  if (!ok) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ ok: true });
});

// Tetapkan kategori yang boleh dilihat seorang user (admin)
app.patch('/api/users/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'Admin melihat semua kategori — penugasan hanya untuk viewer' });
  }
  if (!req.body || !Array.isArray(req.body.category_ids)) {
    return res.status(400).json({ error: 'Body harus berisi category_ids (array)' });
  }
  const set = db.setUserCategories(id, req.body.category_ids);
  res.json({ ok: true, user_id: id, category_ids: set });
});

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

// Kategori: admin melihat semua; viewer HANYA yang ditugaskan super admin
app.get('/api/categories', (req, res) => {
  res.json(db.listCategoriesForUser(req.user.id, req.user.role));
});

app.post('/api/categories', adminOnly, wrapAsync(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nama kategori wajib diisi' });
  }
  try {
    res.status(201).json(db.createCategory(name));
  } catch (err) {
    return res.status(409).json({ error: `Kategori "${name}" sudah ada` });
  }
}));

app.delete('/api/categories/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = db.deleteCategory(id);
  if (!ok) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

// Daftar stream — viewer hanya melihat saved buatan admin DALAM kategori yang ditugaskan
/** Versi gambar tersimpan (mtime) — cache-buster <img>: URL berubah HANYA
    saat file gambar di toko benar-benar berganti (mis. setelah 🔄 manual). */
function imgVersion(id) {
  let v = 0;
  for (const type of ['cover', 'avatar']) {
    try {
      const st = fs.statSync(imgStorePath(id, type));
      if (st.mtimeMs > v) v = st.mtimeMs;
    } catch (_) { /* belum ada */ }
  }
  return v ? v.toString(36) : undefined;
}

app.get('/api/streams', (req, res) => {
  const streams = req.user.role === 'admin' ? db.listStreams() : db.listStreamsForViewer(req.user.id);
  for (const s of streams) s.img_v = imgVersion(s.id);
  res.json(streams);
});

// Tambah stream dari URL → otomatis masuk Saved (admin).
// Body opsional `info` (snapshot dari hasil pencarian): bila ada dan cocok
// platform-nya, stream LANGSUNG tersimpan instan tanpa resolve — detail
// (playback URL, viewers terbaru) diisi ulang oleh refresh di background.
app.post('/api/streams', adminOnly, wrapAsync(async (req, res) => {
  const { url, label, category_id, info: infoFromClient } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'URL wajib diisi' });
  }

  let platform = detectPlatform(url);
  let info = null;
  let dariClient = false; // true = info berasal dari snapshot pencarian (perlu refresh background)

  // Jalur cepat: pakai snapshot dari hasil pencarian (tidak perlu resolve)
  if (infoFromClient && typeof infoFromClient === 'object' && infoFromClient.source_key) {
    const clientPlatform = String(infoFromClient.platform || '');
    if (!platform || platform === clientPlatform) {
      platform = platform || clientPlatform;
      info = sanitizeInfo(infoFromClient, url);
      dariClient = true;
    }
  }

  // Jalur lengkap: resolve via provider (buka halaman live / HTTP)
  if (!info) {
    ({ platform, info } = await resolveStream(String(url).trim()));
  }
  if (!info.source_key) {
    return res.status(422).json({ error: 'Sumber stream tidak bisa diidentifikasi dari URL tersebut' });
  }

  const existing = db.findStream(platform, info.source_key);
  if (existing) {
    const updated = db.updateStreamMeta(existing.id, {
      saved: true,
      label: label || existing.label,
      category_id: category_id !== undefined ? category_id : undefined
    });
    const refreshed = db.updateStreamState(existing.id, {
      is_live: !!info.is_live,
      private_live: !!info.private_live,
      viewers: info.viewers ?? 0,
      title: info.title,
      display_name: info.display_name,
      handle: info.handle,
      avatar_url: info.avatar_url,
      cover_url: info.cover_url,
      started_at: info.started_at,
      playback_url: info.playback_url,
      playback_flv_url: info.playback_flv_url,
      error: null
    });
    if (dariClient) {
      setImmediate(() => poller.refreshStream(existing.id).catch(() => {}));
    }
    // simpan (baru/duplikat) → unduh gambar ke toko sekali
    downloadStreamImages(refreshed || updated).catch(() => {});
    return res.json({ stream: refreshed || updated, duplicated: true });
  }

  let stream = db.insertStream({
    platform,
    source_key: info.source_key,
    url: info.url,
    label,
    priority: 'normal',
    created_by: req.user.id,
    category_id: category_id || null
  });
  stream = db.updateStreamState(stream.id, {
    is_live: !!info.is_live,
    private_live: !!info.private_live,
    viewers: info.viewers ?? 0,
    title: info.title,
    display_name: info.display_name,
    handle: info.handle,
    avatar_url: info.avatar_url,
    cover_url: info.cover_url,
    started_at: info.started_at,
    playback_url: info.playback_url,
    playback_flv_url: info.playback_flv_url,
    error: null
  });
  db.insertSnapshot(stream.id, info.is_live, info.viewers);
  // Simpan dari hasil pencarian (instan) → lengkapi playback/viewer di background
  if (dariClient) {
    setImmediate(() => poller.refreshStream(stream.id).catch(() => {}));
  }
  // simpan baru → unduh gambar ke toko sekali
  downloadStreamImages(stream).catch(() => {});
  res.status(201).json({ stream });
}));

// Ubah metadata: label / priority / saved / kategori (admin)
app.patch('/api/streams/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = db.getStream(id);
  if (!stream) return res.status(404).json({ error: 'Stream tidak ditemukan' });

  const { label, priority, saved, category_id } = req.body || {};
  if (priority && !['normal', 'high'].includes(priority)) {
    return res.status(400).json({ error: 'priority harus normal | high' });
  }
  if (category_id !== undefined && category_id !== null && category_id !== '') {
    const exists = db.listCategories().some(c => c.id === parseInt(category_id, 10));
    if (!exists) return res.status(400).json({ error: 'Kategori tidak ditemukan' });
  }
  const updated = db.updateStreamMeta(id, { label, priority, saved, category_id });
  res.json(updated);
});

// Hapus stream dari monitoring (admin)
app.delete('/api/streams/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ok = db.deleteStream(id);
  if (!ok) return res.status(404).json({ error: 'Stream tidak ditemukan' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Toko gambar per stream                                              */
/*                                                                     */
/* Cover/avatar stream tersimpan permanen di data/img-store/<id>-<tipe> */
/* dan HANYA diperbarui saat: (1) stream disimpan pertama kali,         */
/* (2) admin menekan 🔄 refresh manual. Poller otomatis TIDAK pernah    */
/* mengunduh gambar — app selalu load dari file lokal.                 */
/* Endpoint /img/:id/:type publik (halaman tetap dilindungi login).     */
/* ------------------------------------------------------------------ */

const IMG_STORE_DIR = path.join(__dirname, 'data', 'img-store');

function imgStorePath(id, type) {
  return path.join(IMG_STORE_DIR, `${id}-${type}`);
}

/** Unduh cover+avatar stream ke toko (best-effort, tulis atomik). */
async function downloadStreamImages(stream) {
  if (!stream || !stream.id) return;
  fs.mkdirSync(IMG_STORE_DIR, { recursive: true });
  for (const type of ['cover', 'avatar']) {
    const raw = stream[type === 'cover' ? 'cover_url' : 'avatar_url'];
    if (!raw) continue;
    try {
      const target = new URL(raw);
      if (target.protocol !== 'https:' || !IMG_HOST_ALLOW.some(re => re.test(target.hostname))) continue;
      const buf = await fetchCdnImage(target);
      if (!buf || !buf.length) continue;
      const tmp = imgStorePath(stream.id, type) + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, imgStorePath(stream.id, type)); // atomik: tidak pernah setengah jadi
    } catch (e) { console.error('[img] unduh gagal #%s %s dari %s:', stream.id, type, raw.slice(0, 80), e.message); }
  }
  console.log('[img] selesai unduh #%s (cover:%s avatar:%s)', stream.id, stream.cover_url ? 1 : 0, stream.avatar_url ? 1 : 0);
}

/** Seed sekali saat start untuk stream yang belum punya gambar tersimpan. */
function seedMissingImages() {
  const streams = db.listStreams();
  const missing = streams.filter(s =>
    !fs.existsSync(imgStorePath(s.id, 'cover')) || !fs.existsSync(imgStorePath(s.id, 'avatar')));
  if (!missing.length) return;
  console.log(`[img] seed ${missing.length} stream yang belum punya gambar tersimpan…`);
  // sekuensial & di background — tidak menahan startup
  missing.reduce((p, s) => p.then(() => downloadStreamImages(s)), Promise.resolve())
    .catch(() => {});
}

// Sajikan gambar tersimpan — TIDAK menyentuh CDN sama sekali.
app.get('/img/:id/:type', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const type = req.params.type === 'avatar' ? 'avatar' : 'cover';
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  // no-cache → revalidasi murah (304) tiap render; gambar baru setelah 🔄 langsung terlihat
  res.set('Cache-Control', 'no-cache');
  try {
    const buf = fs.readFileSync(imgStorePath(id, type));
    if (buf.length) return res.set('Content-Type', sniffImageType(buf)).send(buf);
  } catch (_) { /* belum ada file */ }
  res.set('Content-Type', 'image/svg+xml').send(fallbackImageSvg(req.query.t));
});

// Paksa refresh satu stream sekarang (admin)
app.post('/api/streams/:id/refresh', adminOnly, wrapAsync(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = await poller.refreshStream(id);
  if (!stream) return res.status(404).json({ error: 'Stream tidak ditemukan' });
  // AWAIT unduhan gambar: respons baru dikirim setelah file toko diperbarui,
  // supaya re-render di UI langsung menampilkan cover/avatar baru
  await downloadStreamImages(stream).catch(() => {});
  stream.img_v = imgVersion(id);
  res.json(stream);
}));

// Riwayat snapshot sebuah stream
app.get('/api/streams/:id/history', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.getStream(id)) return res.status(404).json({ error: 'Stream tidak ditemukan' });
  res.json(db.getSnapshots(id));
});

// Resolve info stream on-demand dari URL (player hasil pencarian TikTok — admin)
app.post('/api/resolve', adminOnly, wrapAsync(async (req, res) => {
  const { url } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'URL wajib diisi' });
  }
  const { info } = await resolveStream(String(url).trim());
  res.json(info);
}));

// Pencarian live by keyword (admin; viewer tidak punya akses pencarian)
app.get('/api/search', adminOnly, wrapAsync(async (req, res) => {
  const platform = String(req.query.platform || '');
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  if (!q) return res.status(400).json({ error: 'Parameter q wajib diisi' });
  if (platform === 'tiktok') {
    return res.json(await tiktok.searchLive(q, 30));
  }
  if (platform === 'youtube') {
    return res.json(await youtube.searchLive(q, 20, page));
  }
  return res.status(400).json({ error: 'platform harus tiktok | youtube' });
}));

// Statistik untuk stats bar
app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'SiberMonitorLive', time: Date.now() });
});

// Versi aset saat ini — dipakai frontend untuk deteksi perubahan CSS/JS
// (CSS di-hot-swap tanpa reload; JS → reload otomatis saat aman)
app.get('/api/assets-version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ css: fileVersion('style.css'), js: fileVersion('app.js') });
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

// Admin master dari env (password disinkronkan setiap start)
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
  console.warn('[auth] ⚠ ADMIN_PASS tidak diset di env — memakai default "admin123" (GANTI untuk production!)');
}
const admin = db.upsertAdmin(ADMIN_USER, hashPassword(ADMIN_PASS || 'admin123'));
db.migrateStreamsOwner(db.getUserByUsername(ADMIN_USER).id);
db.cleanExpiredSessions();
console.log(`[auth] admin master siap: "${ADMIN_USER}" (role admin)`);

const server = app.listen(PORT, () => {
  console.log(`[server] SiberMonitorLive berjalan di http://localhost:${PORT}`);
  // Matikan Chromium basi dari run sebelumnya (menahan lock profil persisten)
  const killed = killStaleBrowsers();
  if (killed > 0) {
    console.log(`[browser] ${killed} proses Chromium basi dari run sebelumnya dihentikan`);
  }
  poller.startPoller();
  seedMissingImages(); // isi toko gambar untuk stream lama (sekali, background)
});

async function shutdown() {
  console.log('[server] shutdown…');
  poller.stopPoller();
  server.close();
  await closeBrowser();
  db.close(); // checkpoint WAL → data aman saat proses berhenti
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
