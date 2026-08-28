/**
 * Util bersama untuk provider scraping.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** fetch dengan UA browser + timeout (ms). */
async function fetchWithUA(url, { timeout = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Cari objek-objek (rekursif) di dalam struktur JSON yang cocok dengan predikat.
 * Dipakai untuk mengekstrak data dari JSON scrape yang bentuknya bisa berubah.
 */
function deepFindAll(node, predicate, acc = [], depth = 0) {
  if (depth > 30 || node === null || typeof node !== 'object') return acc;
  try {
    if (predicate(node)) acc.push(node);
  } catch (_) { /* abaikan */ }
  for (const key of Object.keys(node)) {
    deepFindAll(node[key], predicate, acc, depth + 1);
  }
  return acc;
}

/** Ambil satu objek pertama yang cocok. */
function deepFind(node, predicate) {
  const all = deepFindAll(node, predicate);
  return all.length > 0 ? all[0] : null;
}

/** Ekstrak angka dari teks "11,569 watching", "1.2K", "1,2rb", "3 jt", "568 menonton" dst. */
function parseCount(text) {
  if (typeof text === 'number') return Math.round(text);
  if (typeof text !== 'string') return undefined;
  // Buang kata satuan agar tidak tertukar dengan suffix (mis. 'm' pada 'menonton')
  let t = text.replace(/\b(menonton|watching|views?|penonton|orang|live)\b/gi, ' ').trim();
  const m = t.match(/([\d.,]+)\s*(rb|jt|[KkMmBb])?(?![a-zA-Z0-9])/);
  if (!m) return undefined;
  // Normalisasi pemisah: 1.169 / 1,169 = ribuan; 1,2 / 1.2 (1-2 digit) = desimal
  let numStr = m[1]
    .replace(/(\d)[.,](\d{3})(?!\d)/g, '$1$2')
    .replace(/,/g, '.');
  const n = parseFloat(numStr);
  if (Number.isNaN(n)) return undefined;
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k' || suffix === 'rb') return Math.round(n * 1e3);
  if (suffix === 'm' || suffix === 'jt') return Math.round(n * 1e6);
  if (suffix === 'b') return Math.round(n * 1e9);
  return Math.round(n);
}

module.exports = { UA, fetchWithUA, deepFind, deepFindAll, parseCount };
