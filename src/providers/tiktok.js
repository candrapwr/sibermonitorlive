/**
 * Provider TikTok Live — tanpa API resmi, via Playwright (Chromium headless).
 *
 * Kenapa browser: halaman live TikTok dirender via JS dan request datanya
 * bersignature (msToken/X-Bogus), sehingga HTTP biasa hanya mendapat shell
 * kosong (sudah diverifikasi). Browser asli menjalankan JS TikTok sehingga
 * signature dibuat otomatis.
 *
 * Temuan penting (diverifikasi langsung):
 * - Room info live ada di response XHR `webcast/room/enter/` (JSON besar,
 *   field snake_case: title, status, user_count, like_count, start_time,
 *   owner.display_id, owner.avatar_*, cover.url_list). status=2 = LIVE.
 * - Halaman /@user/live & discover /live bisa diakses TANPA login.
 * - Pencarian keyword (/search/live) DIBUTUHKAN login — jika terkena login
 *   wall, otomatis fallback ke daftar LIVE trending (discover) + filter
 *   keyword pada nama. Login opsional via `npm run login`.
 * - Response /webcast/feed/ berisi kamar user LAIN — sengaja TIDAK
 *   dipakai untuk status user agar tidak salah attribusi.
 */
const { withContext } = require('../browser');
const { deepFind, deepFindAll, parseCount } = require('./util');

const GOTO_TIMEOUT = 45000;
const WAIT_ROOM_MS = 15000;

/* ------------------------------------------------------------------ */
/* Helper ekstraksi                                                    */
/* ------------------------------------------------------------------ */

/** Cari URL gambar pertama di dalam objek sembarang. */
function extractUrl(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of ['urls', 'url_list']) {
    if (Array.isArray(obj[key])) {
      const found = obj[key].find(u => typeof u === 'string' && u.startsWith('http'));
      if (found) return found;
    }
  }
  if (typeof obj.url === 'string' && obj.url.startsWith('http')) return obj.url;
  return undefined;
}

/** Cari URL gambar terbaik di objek user/room (prioritas resolusi besar). */
function extractBestImage(container, hints) {
  if (!container || typeof container !== 'object') return undefined;
  for (const h of hints) {
    const u = extractUrl(container[h]);
    if (u) return u;
  }
  return undefined;
}

const AVATAR_HINTS = ['avatar_large', 'avatarLarge', 'avatar_medium', 'avatarMedium', 'avatar_thumb', 'avatarThumb'];
const COVER_HINTS = ['cover', 'coverUrl', 'blurred_cover'];

/** Ambil URL FLV pertama dari map flv_pull_url (fallback bila room tanpa HLS). */
function extractFlvUrl(room) {
  const flv = room.stream_url?.flv_pull_url;
  if (flv && typeof flv === 'object') {
    for (const v of Object.values(flv)) {
      if (typeof v === 'string' && v.startsWith('http')) return v;
    }
  }
  return undefined;
}

/** Handle user: uniqueId (camel) / display_id (snake) / unique_id. */
function userHandle(owner) {
  return owner?.uniqueId || owner?.display_id || owner?.unique_id || '';
}

/** Predikat objek "user" TikTok (camel maupun snake case). */
function isUserObject(n) {
  return typeof n.nickname === 'string' &&
    (typeof n.uniqueId === 'string' || typeof n.display_id === 'string' || typeof n.unique_id === 'string');
}

/** Predikat objek "ruang live". */
function isRoomObject(n) {
  return (n.userCount != null || n.user_count != null) &&
    (n.status != null || n.status2 != null) &&
    (typeof n.title === 'string' || n.id != null || n.room_id != null);
}

/** Normalisasi payload room (response webcast room/enter|info) → info standar. */
function normalizeRoom(payload, fallbackUsername) {
  if (!payload) return null;
  const room = deepFind(payload, isRoomObject);
  if (room) {
    const owner = (room.owner && isUserObject(room.owner)) ? room.owner
      : (room.user && isUserObject(room.user)) ? room.user
      : (payload.owner && isUserObject(payload.owner)) ? payload.owner
      : (payload.user && isUserObject(payload.user)) ? payload.user
      : null;
    const status = room.status2 ?? room.status;
    const startedMs = room.start_time ? room.start_time * 1000
      : room.startTime ? room.startTime
      : room.create_time ? room.create_time * 1000
      : undefined;
    const likes = room.like_count ?? room.totalLikeCount ?? room.likeCount ?? room.likes;
    const handle = userHandle(owner) || (fallbackUsername || '');
    return {
      platform: 'tiktok',
      source_key: handle.toLowerCase(),
      url: `https://www.tiktok.com/@${handle}/live`,
      room_id: String(room.id_str ?? room.id ?? room.room_id ?? ''),
      title: room.title || undefined,
      is_live: String(status) === '2',
      viewers: parseCount(room.userCount ?? room.user_count ?? 0) || 0,
      display_name: owner?.nickname || undefined,
      handle: handle ? '@' + handle : undefined,
      avatar_url: extractBestImage(owner, AVATAR_HINTS),
      cover_url: extractBestImage(room, COVER_HINTS),
      started_at: startedMs,
      likes: likes != null ? parseCount(likes) : undefined,
      // HLS bertanda tangan dari CDN TikTok — bisa diputar langsung di player (hls.js)
      playback_url: room.stream_url?.hls_pull_url || undefined,
      // Fallback FLV: sebagian room (mis. multi-host) hanya menyediakan FLV
      playback_flv_url: extractFlvUrl(room)
    };
  }
  return null;
}

/** Info minimal saat user offline (tidak ada room payload sama sekali). */
function offlineInfo(username) {
  return {
    platform: 'tiktok',
    source_key: username.toLowerCase(),
    url: `https://www.tiktok.com/@${username}/live`,
    room_id: '',
    title: undefined,
    is_live: false,
    viewers: 0,
    display_name: username,
    handle: '@' + username,
    avatar_url: undefined,
    cover_url: undefined,
    started_at: undefined,
    likes: undefined
  };
}

/** Deteksi username dari URL TikTok. */
function parseUrl(url) {
  const m = String(url).match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (m) return m[1].toLowerCase();
  const m2 = String(url).match(/^@?([\w.]+)$/);
  if (m2) return m2[1].toLowerCase();
  return null;
}

/* ------------------------------------------------------------------ */
/* Info live per username                                              */
/* ------------------------------------------------------------------ */

async function getStreamInfo(username) {
  return withContext(async (ctx) => {
    const page = await ctx.newPage();
    // Hemat bandwidth: blokir media/video, gambar tetap diizinkan
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'media') return route.abort();
      return route.continue();
    });

    const captured = [];
    const pending = [];
    page.on('response', (res) => {
      const url = res.url();
      // HANYA room enter/info milik user target (bukan feed user lain)
      if (/\/webcast\/room\/(enter|info|reflow)/.test(url)) {
        pending.push((async () => {
          try {
            const json = await res.json();
            if (json) captured.push(json);
          } catch (_) { /* bukan JSON — abaikan */ }
        })());
      }
    });

    try {
      await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, {
        waitUntil: 'domcontentloaded',
        timeout: GOTO_TIMEOUT
      });

      const deadline = Date.now() + WAIT_ROOM_MS;
      let info = null;
      while (Date.now() < deadline) {
        await page.waitForTimeout(800);
        await Promise.allSettled(pending);
        for (const payload of captured) {
          const normalized = normalizeRoom(payload, username);
          if (!normalized) continue;
          // Pastikan room ini milik user target (bukan saran lain),
          // kecuali payload berasal dari enter/info milik halaman tsb.
          if (normalized.is_live) { info = normalized; break; }
          if (!info) info = normalized; // simpan offline/offline-ish pertama
        }
        if (info && info.is_live) break;
        await page.waitForTimeout(700);
      }

      // User offline → TikTok redirect ke halaman discover: balas info offline minimal
      return info || offlineInfo(username);
    } finally {
      await Promise.allSettled(pending).catch(() => {});
      await page.close().catch(() => {});
    }
  });
}

/* ------------------------------------------------------------------ */
/* Pencarian live by keyword                                           */
/* ------------------------------------------------------------------ */

function itemFromRoom(room, owner) {
  const status = room.status2 ?? room.status;
  const handle = userHandle(owner);
  return {
    platform: 'tiktok',
    source_key: handle.toLowerCase(),
    url: `https://www.tiktok.com/@${handle}/live`,
    room_id: String(room.id_str ?? room.id ?? room.room_id ?? ''),
    title: room.title || undefined,
    is_live: String(status) === '2',
    viewers: parseCount(room.userCount ?? room.user_count ?? 0) || 0,
    display_name: owner?.nickname || undefined,
    handle: handle ? '@' + handle : undefined,
    avatar_url: extractBestImage(owner, AVATAR_HINTS),
    cover_url: extractBestImage(room, COVER_HINTS),
    started_at: room.start_time ? room.start_time * 1000 : undefined,
    playback_url: room.stream_url?.hls_pull_url || undefined,
    playback_flv_url: extractFlvUrl(room)
  };
}

/** Deteksi login wall pada halaman pencarian. */
async function isLoginWall(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    return /masuk untuk mencari|log in to search|login to search/i.test(text);
  } catch (_) {
    return false;
  }
}

/** Scrape kartu LIVE dari halaman discover (tanpa login). */
async function scrapeDiscoverCards(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(
      '[data-e2e="discover-list-live-card"], [data-e2e="discover_category-list-live-card"]'
    ));
    const out = [];
    for (const el of cards) {
      const a = el.querySelector('a[href*="/live"]');
      const href = a ? a.getAttribute('href') : '';
      const m = href && href.match(/@([^/?#]+)/);
      if (!m) continue;
      const lines = (el.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
      // Dua varian kartu:
      //  list      : ["LIVE", title, display, "N menonton", ...]
      //  category  : ["LIVE", "1,169", title, display]
      let viewLine = lines.find(l => /menonton|watching/i.test(l));
      if (!viewLine && /^[\d.,]+[KkMm]?$/.test(lines[1] || '')) viewLine = lines[1];
      const contentLines = lines.slice(1).filter(l =>
        l !== viewLine && !/klik untuk menonton|click to watch/i.test(l) && l !== 'D' && l.length > 1
      );
      const img = el.querySelector('img');
      out.push({
        username: m[1].toLowerCase(),
        title: contentLines[0] || undefined,
        display: contentLines[1] || contentLines[0] || undefined,
        viewers: viewLine || undefined,
        cover: img ? (img.src || img.getAttribute('data-src')) : null
      });
    }
    return out;
  }).catch(() => []);
}

/** Pencarian keyword; fallback trending discover jika kena login wall. */
async function searchLive(query, limit = 12) {
  return withContext(async (ctx) => {
    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (route.request().resourceType() === 'media') return route.abort();
      return route.continue();
    });

    const captured = [];
    const pending = [];
    page.on('response', (res) => {
      if (/\/api\/search\//.test(res.url())) {
        pending.push((async () => {
          try {
            const json = await res.json();
            if (json) captured.push(json);
          } catch (_) { /* abaikan */ }
        })());
      }
    });

    try {
      await page.goto(`https://www.tiktok.com/search/live?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout: GOTO_TIMEOUT
      });

      const deadline = Date.now() + WAIT_ROOM_MS;
      const items = new Map(); // key: username

      while (Date.now() < deadline && items.size < limit) {
        await page.waitForTimeout(1000);
        await Promise.allSettled(pending);

        for (const payload of captured) {
          // Sumber hasil pencarian:
          //  1. Objek room langsung di payload (tamu/akun lain)
          //  2. Hasil LOGIN: room ter-encode DUA KALI — string JSON di live_info.raw_data
          const sources = [payload];
          for (const holder of deepFindAll(payload, n => n.live_info && typeof n.live_info.raw_data === 'string')) {
            try { sources.push(JSON.parse(holder.live_info.raw_data)); } catch (_) { /* string rusak */ }
          }
          for (const source of sources) {
            for (const room of deepFindAll(source, isRoomObject)) {
              const owner = (room.owner && isUserObject(room.owner)) ? room.owner
                : (room.user && isUserObject(room.user)) ? room.user
                : deepFind(source, isUserObject);
              const key = String(userHandle(owner) || room.id || '').toLowerCase();
              if (!key || items.has(key)) continue;
              const item = itemFromRoom(room, owner);
              if (item.source_key) items.set(key, item);
            }
          }
        }
        // Login wall → hentikan menunggu
        if (items.size === 0 && await isLoginWall(page)) break;
      }

      if (items.size > 0) {
        return Array.from(items.values()).slice(0, limit);
      }

      // ---- Fallback: trending LIVE discover (tanpa login) ----
      await page.goto('https://www.tiktok.com/live', {
        waitUntil: 'domcontentloaded',
        timeout: GOTO_TIMEOUT
      });
      await page.waitForTimeout(6000);

      // Kumpulkan kartu hingga limit — halaman discover infinite-scroll
      const collected = new Map(); // username → card
      const collect = async () => {
        for (const c of await scrapeDiscoverCards(page)) {
          if (!collected.has(c.username)) collected.set(c.username, c);
        }
      };
      await collect();
      let scrolls = 0;
      // Catatan: daftar discover tamu dibatasi TikTok (±8 kartu, tanpa
      // infinite scroll) — 2 percobaan scroll cukup, jangan buang waktu.
      while (collected.size < limit && scrolls < 2) {
        const before = collected.size;
        await page.evaluate(() => {
          const scroller = [...document.querySelectorAll('*')].find(el =>
            el.scrollHeight > el.clientHeight + 200 &&
            el.clientHeight > 300 &&
            ['auto', 'scroll', 'overlay'].includes(getComputedStyle(el).overflowY)
          );
          if (scroller) scroller.scrollBy(0, 2500);
          else window.scrollBy(0, 2500);
        }).catch(() => {});
        await page.waitForTimeout(2200);
        await collect();
        scrolls++;
        if (collected.size === before) break;
      }

      let cards = Array.from(collected.values());
      // Filter by keyword jika ada yang cocok (nama/handle)
      const q = query.toLowerCase();
      const matched = cards.filter(c =>
        c.username.includes(q) || (c.display || '').toLowerCase().includes(q)
      );
      const source = matched.length > 0 ? matched : cards;
      const itemsOut = source.slice(0, limit).map(c => ({
        platform: 'tiktok',
        source_key: c.username,
        url: `https://www.tiktok.com/@${c.username}/live`,
        title: c.title || 'Sedang LIVE',
        is_live: true,
        viewers: parseCount(c.viewers || '') || 0,
        handle: '@' + c.username,
        display_name: c.display || c.username,
        avatar_url: undefined,
        cover_url: c.cover && c.cover.startsWith('http') ? c.cover : undefined,
        source: 'trending'
      }));

      if (itemsOut.length === 0) {
        const err = new Error('Pencarian live TikTok tidak menghasilkan data. Coba beberapa saat lagi.');
        err.code = 'SEARCH_BLOCKED';
        throw err;
      }
      return itemsOut;
    } finally {
      await Promise.allSettled(pending).catch(() => {});
      await page.close().catch(() => {});
    }
  });
}

module.exports = { parseUrl, getStreamInfo, searchLive };
