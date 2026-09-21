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
  const key = `${comment.type || 'comment'}\u0000${author}\u0000${text}`;
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
    type: comment.type || 'comment',
    author,
    text,
    ...(comment.gift ? { gift: comment.gift, quantity: comment.quantity || 1, gift_image: comment.gift_image || null } : {}),
    received_at: now()
  };
  room.comments.push(item);
  if (room.comments.length > MAX_COMMENTS) room.comments.splice(0, room.comments.length - MAX_COMMENTS);
  room.lastActivity = item.received_at;
  emit(room, { type: item.type, comment: item });
}

async function scrapeComments(room, page, options = {}) {
  const result = await page.evaluate(() => {
    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    let order = 0;
    const add = (item, node) => {
      const key = `${item.type}\u0000${item.author}\u0000${item.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        const rect = node?.getBoundingClientRect?.();
        out.push({ ...item, _order: order++, _top: rect ? rect.top : order });
      }
    };

    for (const el of document.querySelectorAll('[data-e2e="chat-message"]')) {
      const owner = el.querySelector('[data-e2e="message-owner-name"]');
      const author = clean(owner?.getAttribute('title') || owner?.textContent);
      const content = [...el.querySelectorAll(':scope .w-full.break-words')]
        .map(node => clean(node.textContent)).filter(Boolean);
      const parts = String(el.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const text = content[content.length - 1] || parts[parts.length - 1];
      if (author && text && author !== text && text.length <= 1000) add({ type: 'comment', author, text }, el);
    }

    for (const el of document.querySelectorAll('[data-index]')) {
      const owner = el.querySelector('[data-e2e="message-owner-name"]');
      if (!owner) continue;
      const action = clean(el.innerText);
      if (!/\b(mengirim|sent)\b/i.test(action)) continue;
      const author = clean(owner.getAttribute('title') || owner.textContent);
      const actionMatch = action.match(/\b(?:mengirim|sent)\b\s+(.+?)\s+[×x]\s*\d+/i);
      const giftFromText = clean(actionMatch?.[1]);
      const giftNode = [...el.querySelectorAll('span')].find(span => {
        const value = clean(span.textContent);
        return value && giftFromText && value === giftFromText;
      });
      const gift = giftFromText || clean(giftNode?.textContent);
      const quantityMatch = action.match(/[×x]\s*(\d+)/i);
      const quantity = quantityMatch ? parseInt(quantityMatch[1], 10) : 1;
      const giftImage = giftNode?.nextElementSibling?.querySelector('img')?.src || null;
      if (author && gift && gift.length <= 120) {
        add({ type: 'gift', author, gift, quantity, gift_image: giftImage, text: `mengirim ${gift} × ${quantity}` }, el);
      }
    }
    return out.sort((a, b) => a._top - b._top || a._order - b._order).slice(-120);
  }).catch(() => []);
  if (options.collect) return result;
  for (const item of result) addComment(room, item);
  return result;
}

async function bootstrapBacklog(room, page) {
  const maxPasses = Math.max(2, parseInt(process.env.TIKTOK_COMMENT_BACKLOG_PASSES, 10) || 6);
  let previousSignature = '';
  const batches = [];
  for (let pass = 0; pass < maxPasses && !room.stopRequested; pass += 1) {
    const batch = await scrapeComments(room, page, { collect: true });
    if (batch.length) batches.push(batch);
    const state = await page.evaluate(() => {
      const chat = document.querySelector('[data-e2e="live-chat-container"]') ||
        document.querySelector('[data-e2e="public-screen-live-chat-slot"]');
      if (!chat) return { found: false, moved: false, signature: '' };
      const nodes = [chat, ...chat.querySelectorAll('*')];
      const candidates = nodes.filter(el => {
        const style = getComputedStyle(el);
        return el.scrollHeight > el.clientHeight + 4 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll');
      });
      const row = chat.querySelector('[data-index], [data-e2e="chat-message"]');
      const el = candidates
        .filter(node => row && node.contains(row))
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
      if (!el) return { found: false, moved: false, signature: '' };
      const before = el.scrollTop;
      const delta = Math.max(240, el.clientHeight * 0.8);
      el.scrollTop = Math.max(0, el.scrollTop - delta);
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -delta, bubbles: true }));
      if (typeof el.scrollBy === 'function') el.scrollBy({ top: -delta, behavior: 'auto' });
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      const signature = [...chat.querySelectorAll('[data-e2e="chat-message"], [data-index]')]
        .map(node => (node.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80).join('\n');
      return { found: true, moved: before !== el.scrollTop, atTop: el.scrollTop <= 2, signature };
    }).catch(() => ({ found: false, moved: false, signature: '' }));
    const box = await page.locator('[data-e2e="live-chat-container"]').boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await page.mouse.wheel(0, -Math.max(300, Math.floor(box.height * 0.8))).catch(() => {});
    }
    await sleep(1200);
    const unchanged = state.signature === previousSignature;
    previousSignature = state.signature;
    if (pass >= 1 && !state.found) break;
    if (pass >= 1 && state.atTop && !state.moved && unchanged) break;
  }
  const history = [];
  const historySeen = new Set();
  for (const batch of batches.reverse()) {
    for (const item of batch) {
      const key = `${item.type}\u0000${item.author}\u0000${item.text}`;
      if (!historySeen.has(key)) {
        historySeen.add(key);
        const { _order, _top, ...cleanItem } = item;
        history.push(cleanItem);
      }
    }
  }
  for (const item of history) addComment(room, item);
  await page.evaluate(() => {
    const chat = document.querySelector('[data-e2e="live-chat-container"]') || document.querySelector('[data-e2e="public-screen-live-chat-slot"]');
    if (!chat) return;
    const nodes = [chat, ...chat.querySelectorAll('*')];
    const el = nodes.filter(node => node.scrollHeight > node.clientHeight + 4)
      .sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth))[0];
    if (el) el.scrollTop = el.scrollHeight;
  }).catch(() => {});
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
    await bootstrapBacklog(room, page);
    if (room.stopRequested) return;
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
