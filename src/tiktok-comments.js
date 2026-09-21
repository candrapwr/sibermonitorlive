/**
 * TikTok LIVE comment manager.
 *
 * Uses a separate persistent Chromium profile so the search/login profile is
 * never reused. Comments are read from the public LIVE page DOM; no TikTok
 * account session is required. The manager keeps a bounded in-memory buffer
 * and exposes a small subscription API for SSE.
 */
const path = require('path');
const { chromium } = require('playwright');

const PROFILE_DIR = process.env.TIKTOK_COMMENT_PROFILE_DIR ||
  path.join(__dirname, '..', 'data', 'chromium-comment-profile');
// Default mengikuti HEADLESS aplikasi (production biasanya true). Untuk CAPTCHA,
// jalankan TIKTOK_COMMENT_HEADLESS=false secara eksplisit.
const HEADLESS = process.env.TIKTOK_COMMENT_HEADLESS !== undefined
  ? process.env.TIKTOK_COMMENT_HEADLESS !== 'false'
  : process.env.HEADLESS !== 'false';
const MAX_COMMENTS = Math.max(20, parseInt(process.env.TIKTOK_COMMENT_BUFFER, 10) || 200);
const PAGE_TIMEOUT = 60000;
const CAPTCHA_RE = /captcha|verifikasi bahwa anda manusia|verify you are human|unusual traffic|security check|robot check|permintaan mencurigakan/i;
const LOGIN_COOKIES = new Set([
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'multi_sids',
  'uid_tt', 'uid_tt_ss', 'sid_ucp_v1', 'ssid_ucp_v1'
]);

let context = null;
let launching = null;
const rooms = new Map(); // stream id -> room state

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function now() { return Date.now(); }

function roomState(streamId) {
  let room = rooms.get(streamId);
  if (!room) {
    room = {
      streamId,
      page: null,
      task: null,
      stopRequested: false,
      status: 'idle',
      error: null,
      comments: [],
      seen: new Set(),
      subscribers: new Set(),
      lastActivity: 0
    };
    rooms.set(streamId, room);
  }
  return room;
}

async function getContext() {
  if (context) return context;
  if (launching) return launching;
  launching = (async () => {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-notifications'
      ]
    });
    context.on('close', () => { context = null; launching = null; });
    console.log(`[comments] profil anonim siap: ${PROFILE_DIR} (headless=${HEADLESS})`);
    return context;
  })();
  try { return await launching; } catch (err) {
    context = null;
    launching = null;
    throw err;
  }
}

async function assertAnonymous(ctx) {
  const cookies = await ctx.cookies('https://www.tiktok.com');
  const login = cookies.filter(c => LOGIN_COOKIES.has(c.name));
  if (login.length) {
    throw new Error(`Profil komentar mengandung session login: ${login.map(c => c.name).join(', ')}`);
  }
}

function emit(room, event) {
  for (const sub of room.subscribers) {
    try { sub(event); } catch (_) { /* subscriber disconnect */ }
  }
}

function addComment(room, comment) {
  const text = String(comment.text || '').trim();
  const author = String(comment.author || '').trim();
  if (!text || !author || text.length > 1000) return;
  const key = `${author}\u0000${text}`;
  // DOM can contain the same item in multiple nested nodes. A short-lived
  // content key prevents duplicate events without requiring platform IDs.
  if (room.seen.has(key)) return;
  room.seen.add(key);
  if (room.seen.size > MAX_COMMENTS * 4) {
    room.seen = new Set([...room.seen].slice(-MAX_COMMENTS * 2));
  }
  const item = {
    id: `${room.streamId}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    stream_id: room.streamId,
    author,
    text,
    received_at: now()
  };
  room.comments.push(item);
  if (room.comments.length > MAX_COMMENTS) room.comments.splice(0, room.comments.length - MAX_COMMENTS);
  room.lastActivity = item.received_at;
  emit(room, { type: 'comment', comment: item });
}

async function scrapeComments(room, page) {
  const result = await page.evaluate(() => {
    const bad = /^(LIVE|Penonton|Ikuti|Kirim|Komentar|mengikuti host|sudah bergabung|mengirim|membagikan LIVE|No\.\s*\d+|Baru|Lihat semua|Perusahaan|Program|Ketentuan dan Kebijakan|©\s*\d{4}|Mawar|Rose|Gift|Like|Follow|×\s*\d+)$/i;
    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('[data-e2e="chat-message"]')) {
      const parts = String(el.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      if (parts.length < 2) continue;
      // TikTok web format: author, optional badge/rank, then comment text.
      const comment = parts[parts.length - 1];
      let author = parts[parts.length - 2];
      if (/^No\.\s*\d+$/i.test(author) && parts.length >= 3) author = parts[parts.length - 3];
      if (!author || !comment || author === comment || bad.test(author) || bad.test(comment)) continue;
      if (author.length > 120 || comment.length < 1 || comment.length > 1000) continue;
      const key = author + '\u0000' + comment;
      if (!seen.has(key)) { seen.add(key); out.push({ author, text: comment }); }
    }
    return out.slice(-80);
  }).catch(() => []);
  for (const item of result) addComment(room, item);
}

async function runRoom(room, stream) {
  room.status = 'connecting';
  room.error = null;
  emit(room, { type: 'status', status: room.status });
  const ctx = await getContext();
  await assertAnonymous(ctx);
  const page = await ctx.newPage();
  room.page = page;
  page.on('close', () => { if (room.page === page) room.page = null; });
  try {
    const username = String(stream.source_key || '').replace(/^@/, '');
    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, {
      waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT
    });
    room.status = 'connected';
    emit(room, { type: 'status', status: room.status });
    while (!room.stopRequested) {
      const body = await page.locator('body').innerText().catch(() => '');
      if (CAPTCHA_RE.test(body)) {
        room.status = 'needs_verification';
        room.error = 'TikTok meminta verifikasi CAPTCHA pada profil komentar';
        emit(room, { type: 'status', status: room.status, error: room.error });
        await sleep(5000);
        continue;
      }
      await scrapeComments(room, page);
      await sleep(2000);
    }
  } finally {
    await page.close().catch(() => {});
    room.page = null;
  }
  room.status = 'stopped';
  emit(room, { type: 'status', status: room.status });
}

async function start(streamId, stream) {
  const room = roomState(streamId);
  if (room.task) return snapshot(room);
  room.stopRequested = false;
  room.task = runRoom(room, stream)
    .catch(err => {
      room.status = 'error';
      room.error = err.message;
      emit(room, { type: 'status', status: room.status, error: room.error });
      console.error(`[comments] stream #${streamId}:`, err.message);
    })
    .finally(() => { room.task = null; });
  return snapshot(room);
}

async function stop(streamId) {
  const room = rooms.get(streamId);
  if (!room) return;
  room.stopRequested = true;
  const page = room.page;
  if (page) await page.close().catch(() => {});
  if (room.task) await room.task.catch(() => {});
  if (room.subscribers.size === 0) rooms.delete(streamId);

  // Satu akun hanya membuka satu room komentar. Tutup context persistent
  // agar proses Chromium juga benar-benar terminate setelah modal ditutup.
  if (context) {
    const ctx = context;
    context = null;
    launching = null;
    await ctx.close().catch(() => {});
  }
}

function subscribe(streamId, fn) {
  const room = roomState(streamId);
  room.subscribers.add(fn);
  return () => {
    room.subscribers.delete(fn);
    if (!room.subscribers.size && room.status === 'stopped') rooms.delete(streamId);
  };
}

function snapshot(room) {
  return {
    stream_id: room.streamId,
    status: room.status,
    error: room.error,
    comments: room.comments.slice(-MAX_COMMENTS),
    last_activity: room.lastActivity
  };
}

function get(streamId) {
  const room = rooms.get(streamId);
  return room ? snapshot(room) : { stream_id: streamId, status: 'idle', error: null, comments: [], last_activity: 0 };
}

async function close() {
  for (const id of [...rooms.keys()]) await stop(id);
  if (context) {
    const ctx = context;
    context = null;
    launching = null;
    await ctx.close().catch(() => {});
  }
}

module.exports = { start, stop, subscribe, get, close, PROFILE_DIR };
