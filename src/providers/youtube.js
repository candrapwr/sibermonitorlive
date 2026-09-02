/**
 * Provider YouTube — tanpa API key, via HTTP biasa.
 *
 * - Pencarian live: halaman hasil pencarian dengan filter live (sp=EgJAAQAB),
 *   data diambil dari blob ytInitialData di HTML.
 * - Status video: halaman watch (ytInitialData) + oEmbed sebagai fallback
 *   judul/author/thumbnail.
 * - URL channel (@handle): diarahkan ke /live lalu dicari canonical videoId
 *   dari stream yang sedang berjalan (jika ada).
 */
const { fetchWithUA, deepFindAll, parseCount } = require('./util');

const LIVE_FILTER_SP = 'EgJAAQAB'; // Search filter: Live (type)
// Fokus region Indonesia: gl (geolocation) memprioritaskan konten lokal,
// hl (host language) memakai Bahasa Indonesia.
const REGION_PARAMS = 'gl=ID&hl=id';

/* ------------------------------------------------------------------ */
/* Parsing halaman                                                     */
/* ------------------------------------------------------------------ */

/** Ekstrak JSON (ytInitialData / ytInitialPlayerResponse) dari HTML YouTube. */
function extractYtJson(html, marker) {
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const braceStart = html.indexOf('{', idx);
    if (braceStart === -1) break;
    // brace-counting untuk menemukan akhir JSON yang seimbang
    let depth = 0, inStr = false, esc = false;
    for (let i = braceStart; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(braceStart, i + 1));
          } catch (_) { /* coba kemunculan marker berikutnya */ }
          break;
        }
      }
    }
    idx = html.indexOf(marker, idx + 1);
  }
  return null;
}

const extractYtInitialData = (html) => extractYtJson(html, 'ytInitialData');

/** Ambil teks dari struktur richText runs (ytInitialData). */
function runsText(runs) {
  if (!Array.isArray(runs)) return undefined;
  return runs.map(r => r.text || '').join('').trim() || undefined;
}

/** Konversi hasil videoRenderer menjadi item standar aplikasi. */
function normalizeVideoRenderer(vr) {
  // Badge live bisa di badges[] ATAU di thumbnailOverlays (time status LIVE)
  const isLive = (vr.badges || []).some(b =>
      b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW' ||
      b?.metadataBadgeRenderer?.label === 'LIVE'
    ) ||
    (vr.thumbnailOverlays || []).some(o =>
      o?.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE_NOW' ||
      o?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText === 'LIVE'
    );
  const title = runsText(vr.title?.runs) || vr.title?.simpleText;
  const channel = runsText(vr.ownerText?.runs) ||
    runsText(vr.longBylineText?.runs) ||
    runsText(vr.shortBylineText?.runs);
  // "11,569 watching" = penonton live; "1.2M views" = VOD (bukan live) → 0
  const viewText = vr.viewCountText?.simpleText || runsText(vr.viewCountText?.runs) || '';
  const viewers = isLive && /watching/i.test(viewText) ? (parseCount(viewText) || 0) : 0;
  const thumb = (vr.thumbnail?.thumbnails || []).slice(-1)[0]?.url;
  const videoId = vr.videoId;
  return {
    platform: 'youtube',
    source_key: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    display_name: channel,
    handle: channel,
    avatar_url: undefined,
    cover_url: thumb,
    is_live: isLive,
    viewers,
    started_at: undefined
  };
}

/* ------------------------------------------------------------------ */
/* API publik provider                                                 */
/* ------------------------------------------------------------------ */

/** Deteksi platform & source_key dari sebuah URL YouTube. */
function parseUrl(url) {
  let m = url.match(/(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/live\/|youtube\.com\/shorts\/)([\w-]{11})/);
  if (m) return { type: 'video', key: m[1] };
  m = url.match(/youtube\.com\/(@[\w.-]+)/);
  if (m) return { type: 'channel', key: m[1] };
  if (/^[\w-]{11}$/.test(url.trim())) return { type: 'video', key: url.trim() };
  return null;
}

/** Cari live stream berdasarkan keyword (region Indonesia).
 *  page=1 → halaman pertama; page>1 → lanjut via continuation internal YouTube
 *  (context diambil dari halaman itu sendiri — tanpa API key). */
async function searchLive(query, limit = 20, page = 1) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${LIVE_FILTER_SP}&${REGION_PARAMS}`;
  const res = await fetchWithUA(url);
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const html = await res.text();
  const data = extractYtJson(html, 'ytInitialData');
  if (!data) throw new Error('Gagal mengekstrak ytInitialData dari halaman pencarian YouTube');

  let renderers = deepFindAll(data, n => n.videoId && n.thumbnail && n.title, [], 0);

  // Muat halaman lanjutan bila diminta (via API internal continuation).
  // Setiap halaman berisi HANYA item baru dari continuation tersebut.
  if (page > 1) {
    const apiKey = extractYtcfg(html, 'INNERTUBE_API_KEY');
    const context = extractYtcfg(html, 'INNERTUBE_CONTEXT');
    const contItem = deepFindAll(data, n => n.continuationItemRenderer)[0];
    let token = contItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (!apiKey || !context || !token) {
      return []; // tidak ada continuation — halaman berikutnya tidak tersedia
    }
    let fetched = 1;
    while (fetched < page && token) {
      const cRes = await fetchWithUA(
        `https://www.youtube.com/youtubei/v1/search?key=${apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context, continuation: token })
        }
      );
      if (!cRes.ok) break;
      const cData = await cRes.json();
      renderers = deepFindAll(cData, n => n.videoId && n.thumbnail && n.title); // replace: hanya halaman ini
      const nextCont = deepFindAll(cData, n => n.continuationItemRenderer)[0];
      token = nextCont?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      fetched++;
    }
  }

  const seen = new Set();
  const items = [];
  for (const vr of renderers) {
    if (seen.has(vr.videoId)) continue;
    seen.add(vr.videoId);
    items.push(normalizeVideoRenderer(vr));
  }
  // Hasil live didahulukan, lalu jumlah penonton terbanyak
  items.sort((a, b) => (b.is_live - a.is_live) || (b.viewers - a.viewers));
  return items.slice(0, limit);
}

/** Ambil nilai dari ytcfg.set({...}) pada HTML YouTube (mis. INNERTUBE_API_KEY). */
function extractYtcfg(html, key) {
  let idx = html.indexOf('ytcfg.set(');
  while (idx !== -1) {
    const braceStart = html.indexOf('{', idx);
    if (braceStart === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = braceStart; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) {
      try {
        const cfg = JSON.parse(html.slice(braceStart, end + 1));
        if (cfg[key] !== undefined) return cfg[key];
      } catch (_) { /* coba kemunculan berikutnya */ }
    }
    idx = html.indexOf('ytcfg.set(', idx + 1);
  }
  return undefined;
}

/** oEmbed — fallback metadata video tanpa key. */
async function oEmbed(videoId) {
  try {
    const res = await fetchWithUA(
      `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** Jika channel sedang live, /@handle/live merender watch page stream tsb. */
async function channelLiveVideoId(handle) {
  try {
    const res = await fetchWithUA(`https://www.youtube.com/${handle}/live`);
    if (!res.ok) return null;
    const html = await res.text();
    const canonical = html.match(/<link rel="canonical" href="[^"]*v=([\w-]{11})"/);
    if (canonical) return canonical[1];
    const og = html.match(/property="og:url" content="[^"]*v=([\w-]{11})"/);
    if (og) return og[1];
  } catch (_) { /* abaikan */ }
  return null;
}

/** Ambil info terkini sebuah video (live/offline, viewers, judul, dll). */
async function getStreamInfo(videoId) {
  const res = await fetchWithUA(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
  if (!res.ok) throw new Error(`YouTube watch HTTP ${res.status}`);
  const html = await res.text();
  const data = extractYtJson(html, 'ytInitialData');
  const player = extractYtJson(html, 'ytInitialPlayerResponse');

  let info = {
    platform: 'youtube',
    source_key: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    is_live: false,
    viewers: 0
  };

  // videoDetails (judul/author/thumbnail) ada di ytInitialPlayerResponse
  const details = player?.videoDetails || null;

  if (data) {
    const primary = deepFindAll(data, n => n.videoPrimaryInfoRenderer).map(n => n.videoPrimaryInfoRenderer)[0];
    const vcvr = primary?.viewCount?.videoViewCountRenderer;

    // Flag isLive langsung dari struktur viewCount live
    if (vcvr) {
      const watchText = runsText(vcvr.viewCount?.runs) || vcvr.viewCount?.simpleText || '';
      info.is_live = vcvr.isLive === true || /watching/i.test(watchText);
      if (info.is_live) {
        info.viewers = parseCount(vcvr.originalViewCount) ?? parseCount(watchText) ?? 0;
      }
    }
    if (!info.is_live) {
      // Fallback: badge LIVE di ytInitialData
      info.is_live = deepFindAll(data, n => n.style === 'BADGE_STYLE_TYPE_LIVE_NOW').length > 0;
    }

    info.title = runsText(primary?.title?.runs) || details?.title;
    // Catatan: dateText hanya granular tanggal ("Started streaming on Jul 12, 2025"),
    // terlalu kasar untuk durasi — started_at tidak diisi untuk YouTube.
  }

  info.display_name = details?.author;
  info.handle = details?.author;
  const thumbs = details?.thumbnail?.thumbnails || [];
  if (thumbs.length) info.cover_url = thumbs[thumbs.length - 1].url;

  // Fallback / pelengkap via oEmbed
  if (!info.title || !info.display_name || !info.cover_url) {
    const oe = await oEmbed(videoId);
    if (oe) {
      info.title = info.title || oe.title;
      info.display_name = info.display_name || oe.author_name;
      info.handle = info.handle || oe.author_name;
      info.cover_url = info.cover_url || oe.thumbnail_url;
    }
  }

  if (!info.title) throw new Error('Video YouTube tidak ditemukan atau privat');

  // Struktur halaman tidak dikenali (consent-wall, perubahan markup, dsb.) →
  // jangan diam-diam tandai offline; lempar error agar status lama dipertahankan
  if (!data && !player) {
    throw new Error('Struktur halaman YouTube tidak dikenali — status dipertahankan');
  }
  return info;
}

/**
 * Entry resolve: terima URL apa pun (video/channel/ID) → info stream.
 * Untuk channel, cek stream live-nya dulu; jika tidak live, error informatif.
 */
async function resolve(input) {
  const parsed = parseUrl(String(input).trim());
  if (!parsed) throw new Error('URL/ID YouTube tidak dikenali');
  if (parsed.type === 'video') return getStreamInfo(parsed.key);

  const liveId = await channelLiveVideoId(parsed.key);
  if (liveId) return getStreamInfo(liveId);
  const err = new Error(`Channel ${parsed.key} sedang tidak live — tempel URL video (watch?v=…) atau coba lagi nanti`);
  err.code = 'NOT_LIVE';
  throw err;
}

module.exports = { parseUrl, searchLive, getStreamInfo, resolve, channelLiveVideoId };
