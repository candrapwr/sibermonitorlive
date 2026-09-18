import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const SID = readFileSync('/tmp/adm.txt','utf8').split('\n').find(l=>l.includes('sid')).split('\t').pop();
const b = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
const ctx = await b.newContext();
await ctx.addCookies([{ name: 'sid', value: SID, url: 'http://localhost:3000' }]);
const p = await ctx.newPage();
const net = [];
p.on('request', r => { const u = r.url(); if (/\.flv|\.m3u8/.test(u)) net.push(u.split('?')[0].slice(-55)); });
await p.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#card-s-18 .play-icon', { timeout: 15000 });
await p.click('#card-s-18 .play-icon');   // metro_tv (live)
await p.waitForTimeout(9000);
const t = await p.evaluate(() => {
  const v = document.querySelector('#vc-s-18 video');
  return v ? { time: v.currentTime, paused: v.paused, ready: v.readyState } : null;
});
console.log('request stream:', [...new Set(net)] || '(tidak ada)');
console.log('video:', t ? `currentTime=${t.time.toFixed(1)}s paused=${t.paused} readyState=${t.ready}` : 'TIDAK ADA');
console.log(t && t.time > 0 ? '→ PLAYBACK JALAN ✓' : '→ tidak berjalan ✗');
await b.close();
