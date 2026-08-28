/** Salin aset vendor (hls.js) dari node_modules ke public/vendor agar frontend self-hosted. */
const fs = require('fs');
const path = require('path');

const targets = [
  ['hls.js/dist/hls.min.js', 'hls.min.js'],
  ['mpegts.js/dist/mpegts.js', 'mpegts.js']
];

const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

for (const [src, dest] of targets) {
  const from = path.join(__dirname, '..', 'node_modules', src);
  const to = path.join(vendorDir, dest);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    console.log('[vendor]', dest, 'siap');
  } else if (!fs.existsSync(to)) {
    throw new Error(`Aset vendor hilang: ${src} — jalankan npm install`);
  } else {
    console.log('[vendor]', dest, 'pakai salinan lama (node_modules tidak ada)');
  }
}
