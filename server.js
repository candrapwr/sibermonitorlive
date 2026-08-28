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
const path = require('path');
const db = require('./src/db');
const poller = require('./src/poller');
const tiktok = require('./src/providers/tiktok');
const youtube = require('./src/providers/youtube');
const { closeBrowser, killStaleBrowsers } = require('./src/browser');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(express.json());
// no-cache: frontend sering berubah — pastikan browser selalu pakai versi terbaru
app.use(express.static(path.join(__dirname, 'public'), {
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
  if (req.path === '/auth/login' || req.path === '/health') return next();
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

function wrapAsync(fn) {
  return (req, res) => {
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
app.get('/api/streams', (req, res) => {
  res.json(req.user.role === 'admin' ? db.listStreams() : db.listStreamsForViewer(req.user.id));
});

// Tambah stream dari URL → resolve info live → otomatis masuk Saved (admin)
app.post('/api/streams', adminOnly, wrapAsync(async (req, res) => {
  const { url, label, category_id } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'URL wajib diisi' });
  }

  const { platform, info } = await resolveStream(String(url).trim());
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

// Paksa refresh satu stream sekarang (admin)
app.post('/api/streams/:id/refresh', adminOnly, wrapAsync(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stream = await poller.refreshStream(id);
  if (!stream) return res.status(404).json({ error: 'Stream tidak ditemukan' });
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
