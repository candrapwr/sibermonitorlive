#!/usr/bin/env node
/**
 * TikTok Live Checker
 * Cek status live + tampilkan semua stream URL dari satu username.
 * Pakai internal API TikTok: /api-live/user/room/
 *
 * Cara pakai:
 *   node tiktok-live-check.js <username>
 *   node tiktok-live-check.js 7joe_juliana
 */
const https = require('https');

// ---------- Konfigurasi ----------
const AID = 1988;                      // konstan untuk TikTok Web
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SOURCE_TYPE = 54;
// --------------------------------

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'www.tiktok.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.tiktok.com/',
        'Accept': 'application/json, text/plain, */*',
        'Connection': 'keep-alive',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Gagal parse JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Coba parse sebuah string JSON secara progresif (bisa 1x atau 2x stringified)
function tryParse(s) {
  if (!s) return null;
  // 1) parse langsung
  try { return JSON.parse(s); } catch (e) {}
  // 2) mungkin masih double-escaped -> unescape dulu
  try { return JSON.parse(s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')); } catch (e) {}
  // 3) coba method aman: interpret sebagai JSON string lalu parse lagi
  try { return JSON.parse(JSON.parse('"' + s.replace(/"/g, '\\"') + '"')); } catch (e) {}
  return null;
}

// Ekstrak semua URL stream dari object stream_data
function extractStreams(streamDataStr, kinds) {
  const out = [];
  if (!streamDataStr) return out;

  // streamDataStr bisa berupa objek (sudah di-parse JSON) atau string
  let parsed = typeof streamDataStr === 'object' ? streamDataStr : tryParse(streamDataStr);
  if (!parsed) { out.push({ error: 'gagal parse stream_data' }); return out; }

  const data = parsed?.data || {};
  for (const quality of kinds) {
    const q = data[quality];
    if (!q?.main) continue;
    const main = q.main;
    const entry = { kualitas: quality };
    if (main.flv) entry.flv = main.flv;
    if (main.hls) entry.hls = main.hls;
    if (main.cmaf) entry.cmaf = main.cmaf;
    if (main.lls) entry.lls = main.lls;
    // sdk_params berupa string JSON -> ambil codec + resolusi
    const sp = tryParse(main.sdk_params) || {};
    entry.codec = sp.VCodec;
    entry.resolusi = sp.resolution;
    entry.kode = sp.stream_suffix;
    out.push(entry);
  }
  return out;
}

async function main() {
  const username = (process.argv[2] || '').replace(/^@/, '').trim();
  if (!username) {
    console.error('⚠️  Wajib isi username. Contoh:\n   node tiktok-live-check.js 7joe_juliana');
    process.exit(1);
  }

  console.log(`🔍 Cek live TikTok: @${username}\n`);

  let json;
  try {
    json = await get(
      `/api-live/user/room/?aid=${AID}&uniqueId=${encodeURIComponent(username)}&sourceType=${SOURCE_TYPE}`
    );
  } catch (e) {
    console.error('❌ Gagal request:', e.message);
    process.exit(1);
  }

  const user = json.data?.user;
  const liveRoom = json.data?.liveRoom;

  if (!user) {
    console.log(`❌ Akun @${username} tidak ditemukan / tidak ada data.`);
    return;
  }

  // ---------- Status ----------
  const status = user.status;       // 2 = live, 4 = offline (standar web)
  const liveStatus = liveRoom?.status;

  let statusLabel;
  if (status === 2 || liveStatus === 2) {
    statusLabel = '🔴 SEDANG LIVE';
  } else if (status === 4 || liveStatus === 4) {
    statusLabel = '⚪ OFFLINE (tidak live)';
  } else {
    statusLabel = `🟡 Status tidak standar (user=${status}, liveRoom=${liveStatus})`;
  }
  console.log(`📺 Username : @${user.uniqueId}`);
  console.log(`👤 Nickname : ${user.nickname || '-'}`);
  console.log(`🆔 Room ID  : ${user.roomId || '-'}`);
  console.log(`📊 Status   : ${statusLabel}  (user.status=${status})`);
  if (liveRoom) {
    console.log(`👁  Viewer   : ${liveRoom.liveRoomStats?.userCount ?? '-'}`);
    console.log(`🏷  Title    : "${liveRoom.title || '-'}"`);
    console.log(`⏱  Start    : ${liveRoom.startTime ? new Date(liveRoom.startTime * 1000).toLocaleString() : '-'}`);
  }

  // ---------- Stream URLs ----------
  const normalStreams = extractStreams(liveRoom?.streamData?.pull_data?.stream_data, ['origin','ao','hd','sd','ld']);
  const hevcStreams  = extractStreams(liveRoom?.hevcStreamData?.pull_data?.stream_data, ['origin','ao','hd','sd','ld']);

  const anyStream = normalStreams.length || hevcStreams.length;
  if (!anyStream) {
    console.log('\n🎯 Tidak ada stream URL yang tersedia.');
    if (status === 2) {
      console.log('   Kemungkinan live adalah PRIVATE/tertutup utk akun ini, atau data stream disembunyikan.');
    } else {
      console.log('   (Akun offline — data stream biasanya kosong.)');
    }
    return;
  }

  const printGroup = (title, streams) => {
    if (!streams.length) return;
    console.log(`\n${title}`);
    for (const s of streams) {
      const label = [s.kualitas, s.kode, s.resolusi, s.codec].filter(Boolean).join(' · ');
      if (s.error) { console.log(`  ⚠️ ${s.error}`); continue; }
      console.log(`\n  ${label}`);
      if (s.flv) console.log(`    FLV: ${s.flv}`);
      if (s.hls) console.log(`    HLS: ${s.hls}`);
      if (s.cmaf) console.log(`    CMAF: ${s.cmaf}`);
      if (s.lls) console.log(`    LLS: ${s.lls}`);
    }
  };

  printGroup('📶 Stream H264 (web/h264):', normalStreams);
  printGroup('📶 Stream H265/HEVC:', hevcStreams);

  console.log('\n✅ Selesai. (Catatan: URL memiliki masa berlaku `expire`, bisa berubah per request.)');
}

main();