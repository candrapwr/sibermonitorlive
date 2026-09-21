/**
 * Poller background — refresh berkala seluruh stream yang dimonitor.
 *
 * - TikTok dieksekusi sekuensial lewat antrean browser (lihat browser.js),
 *   ditambah jeda antar-cek agar tidak memancing rate-limit.
 * - State lama dipertahankan jika sebuah cek gagal (last_error diisi).
 */
const db = require('./db');
const tiktok = require('./providers/tiktok');
const youtube = require('./providers/youtube');

const INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SEC, 10) || 60) * 1000;
const TIKTOK_GAP_MS = 2500;   // jeda antar cek TikTok
const YOUTUBE_GAP_MS = 400;   // jeda antar cek YouTube

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Anti flip-flop: stream LIVE yang dilaporkan offline baru diyakini setelah
// 2x bukti BERTURUT-TURUT. Verdict offline pertama ditahan (status & playback
// URL lama dipertahankan) — satu cek gagal parse tidak bisa mematikan stream.
const offlineStreak = new Map(); // stream id → jumlah cek offline berturut-turut

// Verdict "LIVE private" tidak bisa dipercaya dari respons sembarang:
// selain room yang memang private, TikTok juga menyajikan respons TANPA
// URL playback secara INTERMITEN ketika endpoint-nya sedang dibatasi
// (403/throttle) atau sesi kurang dipercaya — room publik pun tampak
// "private". Sekali masuk DB, verdict ini ikut menghapus URL playback lama
// (lihat db.updateStreamState). Karena itu:
//  1. Vonis private hanya ditulis setelah 2x konfirmasi jalur browser
//     BERTURUT-TURUT yang juga tidak menemukan URL (privateStreak >= 2).
//  2. Konfirmasi browser berfungsi ganda: kalau URL DITEMUKAN, stream
//     langsung dipulihkan publik dengan URL segar (streak reset).
//  3. Konfirmasi dibatasi paling sekali tiap jendela waktu agar tidak
//     menambah tekanan request ke endpoint yang mudah dibatasi.
const PRIVATE_CONFIRM_MS = (parseInt(process.env.PRIVATE_CONFIRM_SEC, 10) || 180) * 1000;
const privateConfirmedAt = new Map(); // stream id → waktu konfirmasi browser terakhir
const privateStreak = new Map();      // stream id → jumlah konfirmasi no-URL berturut-turut

/** Biarkan field private/playback tetap memakai nilai DB (undefined =
 *  "jangan diubah" pada updateStreamState) — dipakai saat jalur HTTP
 *  sendirian tidak cukup bukti untuk membalik verdict. */
function keepDbVerdict(info) {
  info.private_live = undefined;
  info.playback_url = undefined;
  info.playback_flv_url = undefined;
  info.playback_candidates = undefined;
  info.started_at = undefined;
}

/** Cek satu stream via provider yang sesuai → info terbaru.
 *  opts.via = 'browser' → TikTok dicek lewat Chromium (dipakai 🔄 manual). */
async function fetchStreamInfo(stream, opts = {}) {
  if (stream.platform === 'tiktok') return tiktok.getStreamInfo(stream.source_key, opts);
  if (stream.platform === 'youtube') return youtube.getStreamInfo(stream.source_key);
  throw new Error(`Platform tidak dikenal: ${stream.platform}`);
}

/**
 * Refresh satu stream (dipakai poller & endpoint POST /refresh).
 * Mengembalikan state stream terbaru dari DB.
 */
async function refreshStream(id, opts = {}) {
  const stream = db.getStream(id);
  if (!stream) return null;
  try {
    let info = await fetchStreamInfo(stream, opts);

    // Verdict "live tanpa URL" (kandidat private) butuh konfirmasi browser
    // dan harus terjadi 2x berturut-turut sebelum ditulis ke DB.
    // Jalur manual (opts.manual, tombol 🔄) langsung dipercaya.
    if (!opts.manual && info.is_live && !info.playback_url && !info.playback_flv_url) {
      if (info.private_live) {
        const windowOpen = Date.now() - (privateConfirmedAt.get(id) || 0) >= PRIVATE_CONFIRM_MS;
        let rescued = null;      // browser menemukan URL → publik, pakai datanya
        let confirmedNoUrl = false;
        if (windowOpen) {
          privateConfirmedAt.set(id, Date.now());
          try {
            const confirmed = await fetchStreamInfo(stream, { via: 'browser' });
            const hasUrl = !!(confirmed.playback_url || confirmed.playback_flv_url);
            if (confirmed.is_live && hasUrl) rescued = confirmed;
            else if (confirmed.is_live) confirmedNoUrl = true;
            // browser bilang offline → tidak ada bukti baru
          } catch (e) {
            // Throttle/403 atau Chromium bermasalah → tanpa bukti; pertahankan
            // verdict DB (jangan menulis private dari jalur HTTP saja).
            console.error(`[poller] konfirmasi private #${id} via browser gagal:`, e.message);
          }
        }
        if (rescued) {
          info = rescued;                    // publik + URL playback segar
          privateStreak.set(id, 0);
        } else if (confirmedNoUrl) {
          const streak = (privateStreak.get(id) || 0) + 1;
          privateStreak.set(id, streak);
          if (streak < 2) keepDbVerdict(info); // 1x bukti belum cukup
          // streak >= 2 → dua konfirmasi berturut-turut tanpa URL: private sah
        } else {
          keepDbVerdict(info);                // tanpa bukti baru → pertahankan DB
        }
      }
      // info.is_live tanpa URL dan TANPA flag private_live (payload aneh):
      // perlakukan sama — jangan biarkan field playback kosong menghapus
      // URL lama yang masih berfungsi.
      else keepDbVerdict(info);
    } else if (info.is_live && (info.playback_url || info.playback_flv_url)) {
      privateStreak.set(id, 0); // URL terlihat → stream terbukti publik
    }

    // Transisi live → offline butuh konfirmasi (lihat offlineStreak)
    if (!info.is_live && stream.is_live) {
      const streak = (offlineStreak.get(id) || 0) + 1;
      offlineStreak.set(id, streak);
      if (streak < 2) {
        db.updateStreamState(id, { error: 'Terdeteksi offline 1x — menunggu konfirmasi cek berikutnya' });
        return db.getStream(id);
      }
    }
    if (info.is_live) offlineStreak.delete(id);
    else offlineStreak.delete(id); // offline terkonfirmasi → reset penanda

    db.updateStreamState(id, {
      is_live: !!info.is_live,
      // Jangan paksa boolean (!!): undefined berarti "pertahankan verdict DB"
      // (lihat keepDbVerdict) — !!undefined akan memaksa false dan menghapus
      // status private yang sudah dikonfirmasi browser.
      private_live: info.private_live === undefined ? undefined : !!info.private_live,
      viewers: info.viewers ?? 0,
      title: info.title,
      display_name: info.display_name,
      handle: info.handle,
      avatar_url: info.avatar_url,
      cover_url: info.cover_url,
      started_at: info.started_at,
      playback_url: info.playback_url,
      playback_flv_url: info.playback_flv_url,
      playback_candidates: info.playback_candidates ? JSON.stringify(info.playback_candidates) : undefined,
      error: null
    });
    db.insertSnapshot(id, info.is_live, info.viewers);
  } catch (err) {
    // Jeda backoff global (403): bukan error stream ini — pertahankan state
    // apa adanya tanpa menandai "cek gagal" di semua kartu UI.
    if (err.code === 'TIKTOK_THROTTLED') return db.getStream(id);
    // State lama dipertahankan; catat penyebabnya untuk ditampilkan di UI
    db.updateStreamState(id, { error: err.message });
    console.error(`[poller] gagal cek #${id} ${stream.platform}/${stream.source_key}:`, err.message);
  }
  return db.getStream(id);
}

let running = false;
let timer = null;

async function runCycle() {
  if (running) return;
  running = true;
  try {
    const streams = db.listStreams();
    let lastPlatform = null;
    for (const s of streams) {
      const gap = s.platform === 'tiktok' ? TIKTOK_GAP_MS : YOUTUBE_GAP_MS;
      if (lastPlatform) await sleep(gap + Math.floor(Math.random() * 500));
      await refreshStream(s.id);
      lastPlatform = s.platform;
    }
  } catch (err) {
    console.error('[poller] cycle error:', err.message);
  } finally {
    running = false;
  }
}

function startPoller() {
  // Cek pertama langsung setelah server siap, berikutnya tiap interval
  setTimeout(runCycle, 3000);
  timer = setInterval(runCycle, INTERVAL_MS);
  console.log(`[poller] aktif — refresh tiap ${INTERVAL_MS / 1000}s`);
}

function stopPoller() {
  if (timer) clearInterval(timer);
}

module.exports = { startPoller, stopPoller, refreshStream, runCycle };
