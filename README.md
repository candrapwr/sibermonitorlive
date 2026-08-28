# 📡 SiberMonitorLive

**Portal monitoring live stream TikTok & YouTube — multi-user, real-time, dan self-hosted.**

Dirancang untuk pemantauan banyak live stream sekaligus: status LIVE/OFFLINE, jumlah penonton, player inline multi-video, pengelompokan kategori, hingga kontrol akses per-user. Semua data & sesi tersimpan lokal di server Anda sendiri.

---

## ✨ Apakah SiberMonitorLive cocok untuk anda?

Cocok banget kalau Anda butuh:

- 🔎 **Monitoring banyak live sekaligus** dalam satu dashboard (wall of streams)
- 👥 **Multi-user dengan kontrol akses** — admin mengelola, viewer hanya melihat yang ditugaskan
- 🗂 **Pengelompokan per kategori** (mis. "Politik", "Olahraga", "Daerah") dan penugasan kategori per user
- ▶ **Player inline** — putar langsung di kartu, beberapa video bersamaan
- 🔒 **Self-hosted** — data, sesi, dan database tidak keluar dari server Anda
- 🧩 **Ringan** — tanpa Docker wajib, cukup Node.js + SQLite

### 🎯 Fitur unggulan

| | Fitur |
|---|---|
| 🔐 | Login multi-user + admin master via env, password scrypt-hash, session cookie 7 hari |
| 👁 | Role **viewer** — hanya melihat kategori yang ditugaskan admin (tanpa pencarian/tombol aksi) |
| 🗂 | Kategori: buat/hapus/assign stream, chip filter, penugasan per user via panel 👥 |
| ➕ | Add stream by URL (TikTok `@user/live` · YouTube `watch?v=…` / `youtu.be` / `@channel`) |
| ▶ | Player inline multi-simultanan (embed YouTube + engine HLS & FLV self-hosted) dengan auto-recovery |
| 🔎 | Pencarian live per platform, fokus region Indonesia, pagination "Muat Lebih Banyak" |
| 🚩 | High Priority & filter Sedang Live |
| 📊 | Analytics ringkas: total viewers, status per platform, kendala terakhir |
| ⏱ | Auto-refresh berkala + riwayat snapshot viewers per stream |
| 🧹 | Self-healing: bersihkan proses browser basi saat start, checkpoint database otomatis |

---

## 🚀 Mulai cepat

Prasyarat: **Node.js ≥ 20** dan Chromium Playwright.

```bash
# 1. Clone & install
git clone https://github.com/candrapwr/sibermonitor-live.git
cd sibermonitor-live
npm install

# 2. Download browser engine (sekali saja, ±170MB)
npx playwright install chromium

# 3. Jalankan (ganti password admin!)
ADMIN_USER=admin ADMIN_PASS=passwordAnda npm start
```

Buka **http://localhost:3000** → login dengan `ADMIN_USER`/`ADMIN_PASS` → selesai.

### ⚙️ Variabel environment

Lihat `.env.example`. Ringkasan:

| Env | Default | Fungsi |
|---|---|---|
| `ADMIN_USER` | `admin` | Username admin master |
| `ADMIN_PASS` | `admin123` ⚠️ | Password admin master — **wajib diganti**, disinkronkan tiap start |
| `PORT` | `3000` | Port HTTP |
| `POLL_INTERVAL_SEC` | `60` | Interval refresh semua stream |
| `HEADLESS` | `true` | `false` = browser engine terlihat (debug) |
| `DATA_DIR` | `./data` | Lokasi database & profil browser |

---

## 🔐 Login, Role & Kategori

**Admin (super admin)**
- Diatur via env, bisa membuat user lain lewat tombol 👥 (role: admin/viewer)
- Akses penuh: pencarian, add/hapus stream, kategori, kelola user

**Viewer (user biasa)**
- Hanya melihat stream Saved buatan admin **dalam kategori yang ditugaskan** kepadanya
- Tanpa tombol pencarian / add / aksi kartu — ditegakkan di UI *dan* API
- Tanpa penugasan kategori → tidak melihat apa pun

**Alur kerja kategori**
1. Admin buat kategori: tombol **➕** di bar filter (buka modal kelola: buat/hapus)
2. Assign stream ke kategori: tombol **🗂** di kartu, atau pilih langsung di modal Add Stream
3. Tetapkan kategori per viewer: panel **👥** → tombol **🗂** pada baris user → centang → simpan
4. Viewer login → hanya chip kategorinya yang muncul

---

## 🔄 Memindahkan Sesi Login (laptop → server)

Sesi login TikTok (opsional, untuk pencarian keyword TikTok) tersimpan dalam folder **`data/chromium-profile/`** — foldernya bisa dipindah-pindah:

```bash
# 1. Di laptop: login sekali (jendela browser terbuka → login dengan akun Anda)
npm run login

# 2. Kirim folder profilnya ke server
rsync -av data/chromium-profile/ user@server:/path/ke/sibermonitor-live/data/chromium-profile/

# 3. Restart app di server → sesi langsung aktif
pm2 restart sibermonitor-live
```

Catatan:
- Pindahkan **saat app mati** di salah satu sisi (profil tidak boleh dipakai dua proses bersamaan)
- Folder ini juga bisa di-backup — restore = salin balik + start app
- Hapus folder = semua sesi ter-reset (app tetap jalan, hanya pencarian keyword TikTok yang kembali perlu login)

---

## 🚀 Deployment (PM2)

```bash
# Install PM2 (sekali)
npm install -g pm2

# Edit dulu ADMIN_USER/ADMIN_PASS di ecosystem.config.cjs, lalu:
pm2 start ecosystem.config.cjs

# Simpan & aktifkan auto-start saat server reboot
pm2 save
pm2 startup
```

Perintah harian:

| Perintah | Fungsi |
|---|---|
| `pm2 status` | lihat status app |
| `pm2 logs sibermonitor-live` | lihat log (prefix: `[server] [db] [auth] [browser] [poller]`) |
| `pm2 restart sibermonitor-live` | restart (wajib setelah `git pull` / ubah env) |
| `pm2 monit` | monitor CPU/RAM real-time |

⚠️ **`instances: 1` wajib** — antrean browser & database dirancang single-process. Jangan dinaikkan.

---

## 🔌 Referensi API

Semua endpoint (kecuali `login` & `health`) butuh cookie session. **[A]** = khusus admin.

| Endpoint | Metode | Role | Fungsi |
|---|---|---|---|
| `/api/auth/login` · `logout` · `me` | POST/POST/GET | publik | Sesi login |
| `/api/users` | GET/POST/DELETE | [A] | Kelola user |
| `/api/users/:id` | PATCH | [A] | Tetapkan kategori user `{category_ids:[…]}` |
| `/api/categories` | GET/POST/DELETE | semua/[A] | Kategori |
| `/api/streams` | GET | role-aware | Daftar stream (viewer: sesuai penugasan) |
| `/api/streams` | POST | [A] | Tambah by URL → auto-Saved |
| `/api/streams/:id` | PATCH/DELETE | [A] | Ubah metadata / hapus |
| `/api/streams/:id/refresh` | POST | [A] | Paksa cek sekarang |
| `/api/streams/:id/history` | GET | login | Riwayat viewers |
| `/api/resolve` | POST | [A] | Resolve URL → info live |
| `/api/search?platform=&q=&page=` | GET | [A] | Pencarian live |
| `/api/stats` · `/api/health` | GET | login/publik | Statistik & health |

---

## 🧱 Tech stack

| Lapisan | Teknologi |
|---|---|
| Server | Node.js + Express |
| Database | SQLite (better-sqlite3, WAL) |
| Engine monitoring | Playwright Chromium (persistent profile, antrean sekuensial) |
| Player | hls.js + mpegts.js (self-hosted), YouTube embed |
| Frontend | Vanilla JS + CSS (tanpa framework, tema gelap) |

```
server.js                 # Express: API + auth + guard + startup cleanup
src/db.js                 # SQLite: schema, migrasi, CRUD
src/browser.js            # Engine browser: persistent context + kill basi saat start
src/poller.js             # Loop refresh berkala
src/providers/            # Adapter per platform (tiktok, youtube, util)
public/                   # Frontend + vendor player
scripts/                  # login, uji otomatis, salin vendor
data/                     # livemon.db + chromium-profile/ (gitignore)
ecosystem.config.cjs      # Konfigurasi PM2
```

---

## 🧪 Testing

```bash
# pastikan server berjalan, lalu:
node scripts/ui-test.js       # E2E: login, role, kategori
node scripts/search-repro.js  # E2E: pencarian
```

---

## 🤝 Berkontribusi

Pull request & issue sangat welcome. Untuk perubahan frontend, cukup refresh halaman (aset served `no-cache`); untuk perubahan server, restart PM2.

## 📄 Lisensi

MIT © [candrapwr](https://github.com/candrapwr)

## 📬 Kontak

- GitHub: [candrapwr](https://github.com/candrapwr)
