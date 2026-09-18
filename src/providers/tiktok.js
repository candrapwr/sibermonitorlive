/**
 * Provider TikTok Live — tanpa API resmi.
 *
 * Pengecekan status per username memakai endpoint HTTP ringan
 * `/api-live/user/room/`. Endpoint ini mengembalikan status akun, metadata
 * room, dan kadang URL playback tanpa perlu membuka Chromium.
 *
 * Playwright tetap dipakai khusus untuk pencarian keyword TikTok karena
 * halaman `/search/live` dapat meminta login dan membutuhkan browser untuk
 * menangkap response internalnya.
 *
 * Temuan penting (diverifikasi langsung):
 * - Pada endpoint ini `user.status=2` berarti LIVE dan `user.status=4`
 *   berarti OFFLINE.
 * - LIVE private dapat terdeteksi dari status=2 meski liveRoom tidak memberi
 *   URL playback; status tetap LIVE, hanya player yang tidak tersedia.
 * - Pencarian keyword (/search/live) tetap membutuhkan browser/session — jika
 *   terkena login wall, otomatis fallback ke daftar LIVE trending (discover).
 *   Login opsional via `npm run login`.
 */
const { withContext } = require('../browser');
const { fetchWithUA, deepFind, deepFindAll, parseCount } = require('./util');

const GOTO_TIMEOUT = 45000;
const WAIT_ROOM_MS = 15000;
const LIVE_API_TIMEOUT = 15000;
const LIVE_API_AID = 1988;
const LIVE_API_SOURCE_TYPE = 54;
const PLAYBACK_QUALITY_ORDER = ['origin', 'hd', 'sd', 'ld', 'ao'];

/* ------------------------------------------------------------------ */
/* Helper ekstraksi                                                    */
/* ------------------------------------------------------------------ */

/** Cari URL gambar pertama di dalam objek sembarang. */
function extractUrl(obj) {
  // Endpoint /api-live/user/room/ membalas avatar/cover sebagai STRING polos
  // (bukan objek url_list seperti payload webcast) — terima keduanya.
  if (typeof obj === 'string') return obj.startsWith('http') ? obj : undefined;
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of ['urls', 'url_list', 'urlList']) {
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
const COVER_HINTS = ['coverUrl', 'cover', 'squareCoverImg', 'blurred_cover'];

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

/** Parse JSON yang kadang dikirim TikTok sebagai string JSON bersarang. */
function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return null;

  try { return JSON.parse(value); } catch (_) { /* coba bentuk escaped */ }
  try {
    return JSON.parse(value.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  } catch (_) { /* bukan JSON yang bisa dipakai */ }
  return null;
}

/** Ambil URL playback terbaik dari format stream_data API ringan TikTok. */
function extractApiPlayback(liveRoom) {
  const sources = [
    liveRoom?.streamData?.pull_data?.stream_data,
    liveRoom?.hevcStreamData?.pull_data?.stream_data,
    liveRoom?.stream_data?.pull_data?.stream_data,
    liveRoom?.hevc_stream_data?.pull_data?.stream_data
  ];
  let hls;
  let flv;

  for (const raw of sources) {
    const parsed = parseMaybeJson(raw);
    const qualities = parsed?.data || {};
    for (const quality of PLAYBACK_QUALITY_ORDER) {
      const main = qualities?.[quality]?.main;
      if (!main) continue;
      if (!hls && typeof main.hls === 'string' && /^https?:\/\//.test(main.hls)) hls = main.hls;
      if (!flv && typeof main.flv === 'string' && /^https?:\/\//.test(main.flv)) flv = main.flv;
      if (hls && flv) return { playback_url: hls, playback_flv_url: flv };
    }
  }
  return { playback_url: hls, playback_flv_url: flv };
}

/** Ambil data status live dari endpoint HTTP tanpa membuka browser. */
async function fetchLiveApi(username) {
  const url = `https://www.tiktok.com/api-live/user/room/?aid=${LIVE_API_AID}`
    + `&uniqueId=${encodeURIComponent(username)}&sourceType=${LIVE_API_SOURCE_TYPE}`;
  const res = await fetchWithUA(url, {
    timeout: LIVE_API_TIMEOUT,
    headers: {
      Referer: 'https://www.tiktok.com/',
      Accept: 'application/json, text/plain, */*'
    }
  });
  if (!res.ok) throw new Error(`TikTok live API HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (_) {
    throw new Error('Respons TikTok live API bukan JSON yang valid');
  }
}

function isLiveStatus(value) {
  return String(value) === '2';
}

function toStartedAt(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return undefined;
  const n = Number(value);
  return n < 1e12 ? n * 1000 : n;
}

/** Normalisasi response /api-live/user/room/ menjadi info standar aplikasi. */
function normalizeLiveApi(payload, fallbackUsername) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Struktur response TikTok live API tidak dikenali');
  }
  if (payload.data == null && /user[_ ]not[_ ]found|not found/i.test(String(payload.message || ''))) {
    return offlineInfo(fallbackUsername);
  }
  if (!payload.data || typeof payload.data !== 'object') {
    throw new Error('Struktur response TikTok live API tidak dikenali');
  }

  const user = payload.data.user;
  if (!user || typeof user !== 'object') return offlineInfo(fallbackUsername);

  const liveRoom = payload.data.liveRoom || payload.data.live_room || null;
  const status = user.status ?? user.liveStatus ?? user.live_status;
  const liveStatus = liveRoom?.status ?? liveRoom?.status2;
  const isLive = isLiveStatus(status) || isLiveStatus(liveStatus);
  const handle = String(user.uniqueId || user.unique_id || user.displayId || fallbackUsername).toLowerCase();
  const playback = isLive ? extractApiPlayback(liveRoom) : {};
  const viewers = liveRoom?.liveRoomStats?.userCount
    ?? liveRoom?.live_room_stats?.user_count
    ?? liveRoom?.userCount
    ?? 0;

  return {
    platform: 'tiktok',
    source_key: handle,
    url: `https://www.tiktok.com/@${handle}/live`,
    room_id: String(user.roomId || liveRoom?.roomId || liveRoom?.room_id || ''),
    title: liveRoom?.title || undefined,
    is_live: isLive,
    viewers: isLive ? (parseCount(viewers) || 0) : 0,
    display_name: user.nickname || handle,
    handle: '@' + handle,
    avatar_url: extractBestImage(user, AVATAR_HINTS),
    cover_url: extractBestImage(liveRoom, COVER_HINTS),
    started_at: toStartedAt(liveRoom?.startTime ?? liveRoom?.start_time),
    ...playback,
    // true berarti akun sedang live tetapi TikTok tidak memberikan URL
    // playback; ini lazim pada live private/tertutup.
    private_live: isLive && !playback.playback_url && !playback.playback_flv_url
  };
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
  // Status polling sengaja tidak melalui withContext/Chromium. Selain lebih
  // ringan, endpoint ini bisa membedakan live private: user.status tetap 2
  // walaupun liveRoom tidak menyediakan URL playback.
  const normalizedUsername = String(username).replace(/^@/, '').toLowerCase();
  const payload = await fetchLiveApi(normalizedUsername);
  return normalizeLiveApi(payload, normalizedUsername);
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
