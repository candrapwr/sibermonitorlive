/**
 * Database layer — SQLite.
 *
 * Driver utama: better-sqlite3 (matang, sinkron, prebuilt).
 * Fallback: node:sqlite bawaan Node (experimental) jika better-sqlite3
 * tidak tersedia. API keduanya identik untuk pemakaian di file ini.
 */
const path = require('path');
const fs = require('fs');

let Database, driverName;
try {
  Database = require('better-sqlite3');
  driverName = 'better-sqlite3';
} catch (_) {
  ({ DatabaseSync: Database } = require('node:sqlite'));
  driverName = 'node:sqlite';
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'livemon.db'));

// WAL + checkpoint agresif: data segera dipindahkan ke file utama sehingga
// aman terhadap proses di-kill (WAL besar yang belum di-checkpoint
// berisiko di-reset saat pembukaan berikutnya).
db.exec('PRAGMA journal_mode = WAL;');
try { db.exec('PRAGMA wal_autocheckpoint = 16;'); } catch (_) { /* node:sqlite: abaikan */ }
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');
console.log(`[db] SQLite aktif via ${driverName}`);

db.exec(`
CREATE TABLE IF NOT EXISTS streams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  platform       TEXT NOT NULL CHECK (platform IN ('tiktok','youtube')),
  source_key     TEXT NOT NULL,            -- tiktok: 'username' (tanpa @) | youtube: 'videoId'
  url            TEXT NOT NULL,
  label          TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  saved          INTEGER NOT NULL DEFAULT 1,
  -- state terbaru (denormalisasi agar list cepat)
  is_live        INTEGER NOT NULL DEFAULT 0,
  viewers        INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  display_name   TEXT,
  handle         TEXT,
  avatar_url     TEXT,
  cover_url      TEXT,
  started_at     INTEGER,
  last_checked   INTEGER,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (platform, source_key)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id  INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  is_live    INTEGER NOT NULL,
  viewers    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snapshots_stream ON snapshots(stream_id, ts);
`);

// Migrasi ringan untuk DB lama (sebelum fitur player inline)
try {
  db.exec('ALTER TABLE streams ADD COLUMN playback_url TEXT');
} catch (_) { /* kolom sudah ada */ }
// Migrasi: fallback FLV (sebagian room TikTok hanya menyediakan FLV, tanpa HLS)
try {
  db.exec('ALTER TABLE streams ADD COLUMN playback_flv_url TEXT');
} catch (_) { /* kolom sudah ada */ }

/* Pengguna, sesi login, dan kategori (portal multi-user) */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Penugasan kategori per user viewer: hanya kategori inilah yang terlihat
-- oleh user tsb (dikendalikan super admin).
CREATE TABLE IF NOT EXISTS user_categories (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, category_id)
);
`);

// Migrasi: pemilik stream & kategori
try {
  db.exec('ALTER TABLE streams ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
} catch (_) { /* kolom sudah ada */ }
try {
  db.exec('ALTER TABLE streams ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
} catch (_) { /* kolom sudah ada */ }

/* ------------------------------------------------------------------ */
/* Users & sessions                                                    */
/* ------------------------------------------------------------------ */

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.created_at,
           GROUP_CONCAT(uc.category_id) AS category_ids
    FROM users u
    LEFT JOIN user_categories uc ON uc.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at
  `).all().map(u => ({ ...u, category_ids: u.category_ids ? u.category_ids.split(',').map(Number) : [] }));
}

/** Upsert admin master (dari env) — password selalu disinkronkan dari env. */
function upsertAdmin(username, passwordHash) {
  db.prepare(`
    INSERT INTO users (username, password_hash, role, created_at)
    VALUES (?, ?, 'admin', ?)
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin'
  `).run(String(username).toLowerCase(), passwordHash, Date.now());
}

function createUser(username, passwordHash, role) {
  const res = db.prepare(`
    INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)
  `).run(String(username).toLowerCase(), passwordHash, role === 'admin' ? 'admin' : 'viewer', Date.now());
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(Number(res.lastInsertRowid));
}

function deleteUser(id) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  const res = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return res.changes > 0;
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
}

/** Buat sesi login → token cookie. */
function createSession(userId, ttlMs = 7 * 24 * 3600 * 1000) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + ttlMs);
  return token;
}

/** Ambil user dari token sesi (null bila kadaluarsa/tidak ada). */
function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

function listCategories() {
  return db.prepare('SELECT id, name FROM categories ORDER BY name').all();
}

/** Kategori yang TERLIHAT seorang user: admin = semua; viewer = hanya yang ditugaskan. */
function listCategoriesForUser(userId, role) {
  if (role === 'admin') return listCategories();
  return db.prepare(`
    SELECT c.id, c.name FROM categories c
    JOIN user_categories uc ON uc.category_id = c.id
    WHERE uc.user_id = ?
    ORDER BY c.name
  `).all(userId);
}

/** Daftar id kategori yang ditugaskan ke seorang user. */
function getUserCategoryIds(userId) {
  return db.prepare('SELECT category_id FROM user_categories WHERE user_id = ?')
    .all(userId).map(r => r.category_id);
}

/** Tetapkan kategori user (replace seluruh penugasan). */
function setUserCategories(userId, categoryIds) {
  const valid = new Set(listCategories().map(c => c.id));
  const set = [...new Set((categoryIds || []).map(Number).filter(id => valid.has(id)))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT OR IGNORE INTO user_categories (user_id, category_id) VALUES (?, ?)');
    for (const cid of set) ins.run(userId, cid);
  });
  tx();
  return set;
}

function createCategory(name) {
  const res = db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
    .run(String(name).trim(), Date.now());
  return db.prepare('SELECT id, name FROM categories WHERE id = ?').get(Number(res.lastInsertRowid));
}

function deleteCategory(id) {
  // stream dalam kategori → kategori dilepas (ON DELETE SET NULL);
  // penugasan user_categories ikut terhapus (ON DELETE CASCADE)
  const res = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return res.changes > 0;
}

/** Klaim stream lama (created_by NULL) milik admin pertama — untuk migrasi. */
function migrateStreamsOwner(adminId) {
  db.prepare('UPDATE streams SET created_by = ? WHERE created_by IS NULL').run(adminId);
}

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

const STREAM_COLS = `
  s.id, s.platform, s.source_key, s.url, s.label, s.priority, s.saved,
  s.is_live, s.viewers, s.title, s.display_name, s.handle, s.avatar_url, s.cover_url,
  s.started_at, s.last_checked, s.last_error, s.created_at, s.playback_url, s.playback_flv_url,
  s.created_by, s.category_id, c.name AS category_name
`;
const STREAM_FROM = `FROM streams s LEFT JOIN categories c ON c.id = s.category_id`;

function listStreams() {
  return db.prepare(`SELECT ${STREAM_COLS} ${STREAM_FROM} ORDER BY s.created_at DESC`).all();
}

/** Daftar yang dilihat user biasa: hanya saved milik admin DAN dalam kategori
 *  yang ditugaskan super admin kepadanya. */
function listStreamsForViewer(userId) {
  return db.prepare(`
    SELECT ${STREAM_COLS} ${STREAM_FROM}
    WHERE s.saved = 1
      AND s.created_by IN (SELECT id FROM users WHERE role = 'admin')
      AND s.category_id IN (SELECT category_id FROM user_categories WHERE user_id = ?)
    ORDER BY s.created_at DESC
  `).all(userId);
}

function getStream(id) {
  return db.prepare(`SELECT ${STREAM_COLS} ${STREAM_FROM} WHERE s.id = ?`).get(id);
}

function findStream(platform, sourceKey) {
  return db.prepare(`SELECT ${STREAM_COLS} ${STREAM_FROM} WHERE s.platform = ? AND s.source_key = ?`).get(platform, sourceKey);
}

function insertStream({ platform, source_key, url, label, priority, created_by, category_id }) {
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO streams (platform, source_key, url, label, priority, created_at, created_by, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(platform, source_key, url, label || null, priority || 'normal', now, created_by || null, category_id || null);
  return getStream(Number(res.lastInsertRowid));
}

function updateStreamState(id, state) {
  const s = getStream(id);
  if (!s) return null;
  db.prepare(`
    UPDATE streams SET
      is_live      = ?,
      viewers      = ?,
      title        = ?,
      display_name = ?,
      handle       = ?,
      avatar_url   = ?,
      cover_url    = ?,
      started_at   = ?,
      last_checked = ?,
      last_error   = ?,
      playback_url = ?,
      playback_flv_url = ?
    WHERE id = ?
  `).run(
    // Field yang tidak disebut dipertahankan — penting untuk pemanggilan
    // "update parsial" (mis. hanya {error}): status live/viewer/URL playback
    // TIDAK boleh ikut ter-reset saat sebuah cek gagal.
    state.is_live === undefined ? s.is_live : (state.is_live ? 1 : 0),
    state.viewers === undefined ? s.viewers : state.viewers,
    state.title ?? s.title,
    state.display_name ?? s.display_name,
    state.handle ?? s.handle,
    state.avatar_url ?? s.avatar_url,
    state.cover_url ?? s.cover_url,
    state.started_at ?? s.started_at,
    Date.now(),
    state.error || null,
    state.playback_url ?? s.playback_url,
    state.playback_flv_url ?? s.playback_flv_url,
    id
  );
  return getStream(id);
}

function updateStreamMeta(id, { label, priority, saved, category_id }) {
  const s = getStream(id);
  if (!s) return null;
  db.prepare(`
    UPDATE streams SET
      label       = ?,
      priority    = ?,
      saved       = ?,
      category_id = ?
    WHERE id = ?
  `).run(
    label !== undefined ? (label || null) : s.label,
    priority !== undefined ? priority : s.priority,
    saved !== undefined ? (saved ? 1 : 0) : s.saved,
    category_id !== undefined ? (category_id || null) : s.category_id,
    id
  );
  return getStream(id);
}

function deleteStream(id) {
  db.prepare('DELETE FROM snapshots WHERE stream_id = ?').run(id);
  const res = db.prepare('DELETE FROM streams WHERE id = ?').run(id);
  return res.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Snapshots (riwayat)                                                 */
/* ------------------------------------------------------------------ */

function insertSnapshot(streamId, isLive, viewers) {
  db.prepare('INSERT INTO snapshots (stream_id, ts, is_live, viewers) VALUES (?, ?, ?, ?)')
    .run(streamId, Date.now(), isLive ? 1 : 0, viewers || 0);
}

function getSnapshots(streamId, limit = 200) {
  return db.prepare(
    'SELECT ts, is_live, viewers FROM snapshots WHERE stream_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(streamId, limit);
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

function getStats() {
  const totals = db.prepare(`
    SELECT
      COUNT(*)                        AS total,
      COALESCE(SUM(saved), 0)          AS saved,
      COALESCE(SUM(is_live), 0)        AS live,
      COALESCE(SUM(viewers), 0)        AS viewers,
      COALESCE(SUM(priority='high'),0) AS high
    FROM streams
  `).get();
  return {
    totalStreams: totals.total,
    savedStreams: totals.saved,
    liveStreams: totals.live,
    totalViewers: totals.viewers,
    highPriority: totals.high
  };
}

module.exports = {
  db,
  listStreams,
  listStreamsForViewer,
  getStream,
  findStream,
  insertStream,
  updateStreamState,
  updateStreamMeta,
  deleteStream,
  insertSnapshot,
  getSnapshots,
  getStats,
  // users & auth
  getUserByUsername,
  getUserById,
  listUsers,
  upsertAdmin,
  createUser,
  deleteUser,
  countAdmins,
  createSession,
  getSessionUser,
  deleteSession,
  cleanExpiredSessions,
  // categories
  listCategories,
  listCategoriesForUser,
  getUserCategoryIds,
  setUserCategories,
  createCategory,
  deleteCategory,
  migrateStreamsOwner,
  /** Checkpoint & tutup koneksi (dipanggil saat shutdown agar WAL aman). */
  close() {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) { /* abaikan */ }
    try { db.close(); } catch (_) { /* abaikan */ }
  }
};
