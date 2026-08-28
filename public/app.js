/**
 * SiberMonitorLive — frontend logic.
 * Auth: login cookie-session. Role admin = akses penuh (cari/tambah/kategori/user).
 * Role viewer = hanya melihat list Saved per kategori (tanpa pencarian).
 */
'use strict';

const state = {
    user: null,             // { id, username, role }
    categories: [],
    streams: [],            // stream yang terlihat oleh user ini (dari DB)
    view: 'saved',          // saved | high | live | search | cat-all | cat-<id>
    searchPlatform: 'tiktok',
    searchResults: null,
    searchQuery: '',
    searching: false,
    searchPage: 1,
    searchHasMore: false,
    loadingMore: false,
    players: new Map()
};

const hlsMap = new Map();   // key → instance hls.js (HLS) aktif
const flvMap = new Map();   // key → instance mpegts.js (FLV) aktif

const isAdmin = () => state.user?.role === 'admin';

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatCount(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
    return String(n);
}

function formatDuration(startedAt) {
    if (!startedAt) return '';
    let s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const h = Math.floor(s / 3600);
    s %= 3600;
    const m = Math.floor(s / 60);
    s %= 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function timeAgo(ts) {
    if (!ts) return '—';
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return `${d}s lalu`;
    if (d < 3600) return `${Math.floor(d / 60)}m lalu`;
    if (d < 86400) return `${Math.floor(d / 3600)}j lalu`;
    return `${Math.floor(d / 86400)}h lalu`;
}

let toastTimeout;
function showToast(icon, message, isError = false) {
    $('toastIcon').textContent = icon;
    $('toastMessage').textContent = message;
    const t = $('toast');
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(path, opts = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* body kosong */ }
    if (!res.ok) {
        if (res.status === 401) { showLogin(); throw new Error('Belum login'); }
        throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
}

const PLATFORM_META = {
    tiktok: { icon: '🎵', name: 'TikTok' },
    youtube: { icon: '▶', name: 'YouTube' }
};

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function showLogin() {
    $('loginOverlay').style.display = 'flex';
    $('loginError').textContent = '';
    setTimeout(() => $('loginUser').focus(), 100);
}

function hideLogin() {
    $('loginOverlay').style.display = 'none';
}

async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* abaikan */ }
    state.user = null;
    stopAllPlayers();
    state.streams = [];
    state.categories = [];
    render();
    showLogin();
}

async function submitLogin(e) {
    e.preventDefault();
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Memeriksa…';
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPass').value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login gagal');
        state.user = data;
        hideLogin();
        applyRole();
        await Promise.all([loadStreams(), loadCategories()]);
        renderFilterBar(); // pastikan chip kategori termuat setelah login
        render();
        showToast('👋', `Selamat datang, ${data.username} (${data.role})`);
    } catch (err) {
        $('loginError').textContent = err.message;
    } finally {
        btn.disabled = false;
        btn.textContent = '🔐 Masuk';
    }
}

/** Terapkan role ke UI (sembunyikan elemen admin) + view default. */
function applyRole() {
    document.body.classList.toggle('is-admin', isAdmin());
    $('userBadge').textContent = `👤 ${state.user.username} (${isAdmin() ? 'admin' : 'viewer'})`;
    state.view = isAdmin() ? 'saved' : 'cat-all';
    renderFilterBar();
}

/* ------------------------------------------------------------------ */
/* Users panel (admin)                                                 */
/* ------------------------------------------------------------------ */

async function openUsersPanel() {
    $('usersModal').classList.add('active');
    await refreshUsersList();
}

function closeUsersPanel() {
    $('usersModal').classList.remove('active');
}

async function refreshUsersList() {
    try {
        const users = await api('/api/users');
        $('usersList').innerHTML = users.map(u => {
            const nCat = (u.category_ids || []).length;
            const catInfo = u.role === 'viewer'
                ? `<span class="val">${nCat} kategori</span>` : '';
            const buttons = u.id !== state.user.id
                ? `${u.role === 'viewer' ? `<button class="mini-btn" onclick="openUserCats(${u.id})" title="Tetapkan kategori yang bisa dilihat">🗂</button>` : ''}
                   <button class="mini-btn" onclick="removeUser(${u.id})" title="Hapus user">🗑</button>`
                : '';
            return `
            <div class="list-row">
                <span>${esc(u.username)} <span class="role-tag ${u.role}">${u.role}</span></span>
                <span>${catInfo}</span>
                ${buttons}
            </div>`;
        }).join('');
    } catch (err) {
        $('usersList').innerHTML = `<div class="list-row">${esc(err.message)}</div>`;
    }
}

/** Modal tetapkan kategori yang boleh dilihat seorang viewer. */
async function openUserCats(userId) {
    let users = [];
    try { users = await api('/api/users'); } catch (_) { /* abaikan */ }
    const u = users.find(x => x.id === userId);
    if (!u) return;
    const assigned = new Set(u.category_ids || []);
    // Tutup panel user dulu — dua modal aktif bersamaan saling menutupi (z-index)
    catModalReopenUsers = true;
    $('usersModal').classList.remove('active');
    $('catModalTitle').textContent = `🗂 Kategori untuk ${u.username}`;
    $('catModalBody').innerHTML = `
        ${state.categories.map(c => `
            <label class="list-row" style="cursor:pointer;">
                <span>🏷 ${esc(c.name)}</span>
                <input type="checkbox" value="${c.id}" ${assigned.has(c.id) ? 'checked' : ''}>
            </label>`).join('') || '<div class="form-hint">Belum ada kategori — buat dulu lewat ➕ di bar filter.</div>'}
        <div class="modal-actions">
            <button class="btn" onclick="closeCatModal()">Batal</button>
            <button class="btn btn-primary" onclick="saveUserCats(${userId})">💾 Simpan</button>
        </div>
        <div class="form-hint" style="margin-top:8px;">Centang kategori yang BOLEH dilihat user ini.
        Tanpa centang, user tidak melihat stream apa pun.</div>`;
    $('catModal').classList.add('active');
}

async function saveUserCats(userId) {
    const ids = [...document.querySelectorAll('#catModalBody input[type="checkbox"]:checked')]
        .map(cb => parseInt(cb.value, 10));
    try {
        await api(`/api/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ category_ids: ids }) });
        showToast('✅', `Penugasan kategori disimpan (${ids.length} kategori)`);
        closeCatModal(); // otomatis membuka kembali panel user
        await refreshUsersList();
        await loadCategories(); // kategori user login mungkin berubah bila menugaskan diri... (viewer tidak bisa; jaga-jaga)
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

async function createUser() {
    const username = $('newUser').value.trim();
    const password = $('newPass').value;
    const role = $('newRole').value;
    if (!username || !password) { showToast('⚠️', 'Username & password wajib diisi', true); return; }
    try {
        await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
        $('newUser').value = ''; $('newPass').value = '';
        showToast('✅', `User "${username}" dibuat (${role})`);
        await refreshUsersList();
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

async function removeUser(id) {
    const u = (await api('/api/users')).find(x => x.id === id);
    const username = u ? u.username : id;
    if (!confirm(`Hapus user "${username}"?`)) return;
    try {
        await api(`/api/users/${id}`, { method: 'DELETE' });
        showToast('🗑️', `User "${username}" dihapus`);
        await refreshUsersList();
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

/* ------------------------------------------------------------------ */
/* Kategori                                                            */
/* ------------------------------------------------------------------ */

async function loadCategories() {
    try { state.categories = await api('/api/categories'); } catch (_) { state.categories = []; }
}

/** Bar filter dinamis: admin = filter + kategori; viewer = kategori saja. */
function renderFilterBar() {
    const bar = $('filterBar');
    const chips = [];

    if (isAdmin()) {
        chips.push(`<div class="filter-chip ${state.view === 'saved' ? 'active' : ''}" data-view="saved">🔖 Saved <span class="saved-count" id="savedCount">0</span></div>`);
        chips.push(`<div class="filter-chip ${state.view === 'high' ? 'active' : ''}" data-view="high">🚩 High Priority</div>`);
        chips.push(`<div class="filter-chip ${state.view === 'live' ? 'active' : ''}" data-view="live">🔴 Sedang Live</div>`);
        if (state.searchResults) {
            chips.push(`<div class="filter-chip ${state.view === 'search' ? 'active' : ''}" data-view="search">🔎 Hasil Pencarian</div>`);
        }
        chips.push('<div style="width:1px;height:22px;background:#2a2a3e;margin:0 4px;"></div>');
    }

    chips.push(`<div class="filter-chip ${state.view === 'cat-all' ? 'active' : ''}" data-view="cat-all">🗂 Semua Kategori</div>`);
    for (const c of state.categories) {
        chips.push(`<div class="filter-chip ${state.view === 'cat-' + c.id ? 'active' : ''}" data-view="cat-${c.id}">🏷 ${esc(c.name)}</div>`);
    }
    if (isAdmin()) {
        chips.push(`<div class="filter-chip" onclick="openCatManage()" title="Kelola kategori (buat/hapus)">➕</div>`);
    }

    bar.innerHTML = chips.join('');
    bar.querySelectorAll('.filter-chip[data-view]').forEach(chip => {
        chip.addEventListener('click', () => setView(chip.dataset.view));
    });
    updateStatsBar();
}

/** Modal kelola kategori: buat baru + hapus (admin). */
function openCatManage() {
    $('catModalTitle').textContent = '🗂 Kelola Kategori';
    const rows = state.categories.map(c => {
        const n = state.streams.filter(s => s.category_id === c.id).length;
        return `<div class="list-row">
            <span>🏷 ${esc(c.name)} <span class="val">${n} stream</span></span>
            <button class="mini-btn" onclick="deleteCategory(${c.id})" title="Hapus kategori">🗑 Hapus</button>
        </div>`;
    }).join('');
    $('catModalBody').innerHTML = `
        <div class="form-group">
            <label>Kategori baru</label>
            <div style="display:flex;gap:8px;">
                <input type="text" id="newCatName" placeholder="nama kategori" style="flex:1;">
                <button class="btn btn-primary" onclick="createCategoryFromModal()">➕ Buat</button>
            </div>
        </div>
        ${rows || '<div class="form-hint">Belum ada kategori.</div>'}
        <div class="form-hint" style="margin-top:10px;">
            Menghapus kategori <b>tidak</b> menghapus stream — stream di dalamnya hanya menjadi "tanpa kategori".
        </div>`;
    $('catModal').classList.add('active');
}

async function createCategoryFromModal() {
    const name = $('newCatName').value.trim();
    if (!name) { showToast('⚠️', 'Isi nama kategorinya dulu', true); return; }
    try {
        await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
        showToast('✅', `Kategori "${name}" dibuat`);
        await Promise.all([loadCategories(), loadStreams()]);
        renderFilterBar();
        openCatManage(); // refresh isi modal
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

async function deleteCategory(id) {
    const c = state.categories.find(x => x.id === id);
    const name = c ? c.name : id;
    if (!confirm(`Hapus kategori "${name}"?\nStream di dalamnya TIDAK ikut terhapus — hanya menjadi tanpa kategori.`)) return;
    try {
        await api(`/api/categories/${id}`, { method: 'DELETE' });
        showToast('🗑️', `Kategori "${name}" dihapus`);
        if (state.view === 'cat-' + id) state.view = 'cat-all';
        await Promise.all([loadCategories(), loadStreams()]);
        renderFilterBar();
        render();
        openCatManage(); // refresh isi modal
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

let catModalReopenUsers = false; // modal kategori dibuka dari panel user → buka kembali setelah ditutup

function closeCatModal() {
    $('catModal').classList.remove('active');
    // Kembali ke panel user bila modal ini dibuka dari sana
    if (catModalReopenUsers) {
        catModalReopenUsers = false;
        $('usersModal').classList.add('active');
    }
}

/** Modal assign kategori untuk satu stream (admin). */
function openCatAssign(streamId) {
    const s = state.streams.find(x => x.id === streamId);
    if (!s) return;
    $('catModalTitle').textContent = `🗂 Kategori — ${s.handle || s.source_key}`;
    $('catModalBody').innerHTML = `
        <div class="list-row" style="cursor:pointer" onclick="assignCategory(${s.id}, null)">
            <span>— Tanpa kategori —</span>${!s.category_id ? '<span class="role-tag">aktif</span>' : ''}
        </div>
        ${state.categories.map(c => `
            <div class="list-row" style="cursor:pointer" onclick="assignCategory(${s.id}, ${c.id})">
                <span>🏷 ${esc(c.name)}</span>
                ${s.category_id === c.id ? '<span class="role-tag">aktif</span>' : ''}
            </div>
        `).join('')}
        <div class="form-hint" style="margin-top:10px;">Klik kategori untuk menetapkannya. Buat kategori baru lewat tombol ➕ di bar filter.</div>
    `;
    $('catModal').classList.add('active');
}

async function assignCategory(streamId, categoryId) {
    try {
        await api(`/api/streams/${streamId}`, {
            method: 'PATCH',
            body: JSON.stringify({ category_id: categoryId })
        });
        closeCatModal();
        showToast('✅', 'Kategori diperbarui');
        await loadStreams();
    } catch (err) {
        showToast('❌', err.message, true);
    }
}

/* ------------------------------------------------------------------ */
/* Render kartu                                                        */
/* ------------------------------------------------------------------ */

function placeholderHtml(item, key) {
    const pmeta = PLATFORM_META[item.platform] || { icon: '❓', name: item.platform };
    const live = !!item.is_live;
    const duration = live ? formatDuration(item.started_at) : '';
    const cover = item.cover_url
        ? `<img class="cover-img" src="${esc(item.cover_url)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
    return `
        <div class="video-placeholder">
            ${cover}
            <div class="play-icon" onclick="openPlayer('${key}')"
                 title="${live ? 'Putar langsung di player' : 'Stream offline'}">▶</div>
            ${duration ? `<div class="duration-badge">⏱ ${duration}</div>` : ''}
            <div class="viewer-count"><span class="eye-icon">👁</span> ${formatCount(item.viewers)}</div>
            <a class="ext-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer"
               title="Buka di ${pmeta.name}">↗ ${pmeta.name}</a>
        </div>`;
}

function cardHtml(item, monitored) {
    const pmeta = PLATFORM_META[item.platform] || { icon: '❓', name: item.platform };
    const name = item.display_name || item.handle || item.source_key || 'Unknown';
    const initial = esc(String(name).charAt(0).toUpperCase());
    const live = !!item.is_live;
    const key = monitored ? 's-' + item.id : 'r-' + item._idx;

    const actions = monitored
        ? (isAdmin()
            ? `
        <button class="icon-btn" onclick="openCatAssign(${item.id})" title="Set kategori">🗂</button>
        <button class="icon-btn ${item.priority === 'high' ? 'flagged' : ''}"
                onclick="togglePriority(${item.id})" title="Toggle High Priority">${item.priority === 'high' ? '🚩' : '🏳'}</button>
        <button class="save-btn icon-btn ${item.saved ? 'saved' : ''}" onclick="toggleSave(${item.id})"
                title="${item.saved ? 'Hapus dari Saved' : 'Simpan ke Saved'}">${item.saved ? '📌' : '🔖'}</button>
        <button class="icon-btn" onclick="deleteStream(${item.id})" title="Hapus dari monitoring">🗑</button>`
            : '')
        : (isAdmin()
            ? `<button class="save-btn icon-btn ${isSearchSaved(item) ? 'saved' : ''}" onclick="saveFromSearch(${item._idx})"
                title="${isSearchSaved(item) ? 'Sudah tersimpan' : 'Klik untuk masuk list Saved'}">${isSearchSaved(item) ? '📌' : '🔖'}</button>`
            : '');

    const tags = [
        `<span class="tag">${pmeta.icon} ${pmeta.name}</span>`,
        item.category_name ? `<span class="tag label-tag">🏷 ${esc(item.category_name)}</span>` : '',
        item.label ? `<span class="tag label-tag">🗒 ${esc(item.label)}</span>` : '',
        isAdmin() && item.priority === 'high' ? '<span class="tag label-tag">🚩 High Priority</span>' : '',
        monitored && item.last_error ? `<span class="tag error-tag" title="${esc(item.last_error)}">⚠ cek gagal</span>` : ''
    ].filter(Boolean).join('');

    const avatar = item.avatar_url
        ? `<div class="avatar"><img src="${esc(item.avatar_url)}" alt="" onerror="this.remove()"></div>`
        : `<div class="avatar">${initial}</div>`;

    return `
    <div class="stream-card ${live ? 'is-live' : ''}" id="card-${key}">
        <div class="stream-header">
            <div class="streamer-info">
                ${avatar}
                <div>
                    <div class="streamer-name" title="${esc(name)}">${esc(name)}</div>
                    <div class="streamer-handle">${esc(item.handle || '')}</div>
                </div>
            </div>
            <div class="card-actions">
                ${actions}
                ${live
                    ? '<div class="live-badge"><div class="live-dot"></div>LIVE</div>'
                    : '<div class="offline-badge">OFFLINE</div>'}
            </div>
        </div>
        <div class="video-container" id="vc-${key}">${placeholderHtml(item, key)}</div>
        <div class="stream-meta">
            <div class="stream-title" title="${esc(item.title || '')}">${esc(item.title || (live ? 'Sedang live' : 'Tidak ada judul'))}</div>
            <div class="stream-tags">${tags}</div>
            <div class="stream-stats">
                <div class="stat">👁 ${formatCount(item.viewers)}</div>
                <div class="stat">🕒 dicek ${timeAgo(item.last_checked)}</div>
            </div>
        </div>
    </div>`;
}

function emptyStateHtml() {
    return `<div class="empty-state">
        <div class="empty-state-icon">🗂</div>
        <div class="empty-state-text">${isAdmin() ? 'Belum ada stream' : 'Belum ada stream untuk Anda'}</div>
        <div class="empty-state-subtext">${isAdmin()
            ? 'Tambah via <b>+ Add Stream</b> atau cari, lalu kelompokkan dengan kategori'
            : (state.categories.length === 0
                ? 'Admin belum menetapkan kategori apa pun untuk akun Anda'
                : 'Belum ada stream Saved dalam kategori Anda')}</div>
    </div>`;
}

function visibleStreams() {
    let list = state.streams;
    if (state.view === 'saved') list = list.filter(s => s.saved);
    else if (state.view === 'high') list = list.filter(s => s.priority === 'high');
    else if (state.view === 'live') list = list.filter(s => s.is_live);
    else if (state.view === 'cat-all') { /* semua yang terlihat */ }
    else if (state.view.startsWith('cat-')) {
        const catId = parseInt(state.view.slice(4), 10);
        list = list.filter(s => s.category_id === catId);
    }
    return list;
}

function render() {
    if (!state.user) return; // belum login → login overlay
    if (state.players.size > 0) {
        updateStatsBar();
        return;
    }
    const grid = $('streamGrid');

    if (state.view === 'search' && isAdmin()) {
        if (state.searching) {
            grid.innerHTML = `<div class="searching-state">
                <div class="loading-spinner"></div>
                <p>Mencari live ${state.searchPlatform === 'tiktok' ? 'TikTok' : 'YouTube'}: “${esc(state.searchQuery)}”…</p>
                <small>${state.searchPlatform === 'tiktok' ? 'Membuka browser headless TikTok — bisa makan waktu 10–20 detik' : 'Mengambil data YouTube…'}</small>
            </div>`;
            return;
        }
        if (!state.searchResults || state.searchResults.length === 0) {
            grid.innerHTML = `<div class="empty-state">
                <div class="empty-state-icon">🔎</div>
                <div class="empty-state-text">Tidak ada hasil</div>
                <div class="empty-state-subtext">Coba keyword lain atau ganti platform</div>
            </div>`;
            return;
        }
        // Banner permanen bila hasil TikTok = fallback trending (bukan keyword)
        const trendingCount = state.searchResults.filter(i => i.source === 'trending').length;
        const notice = (state.searchPlatform === 'tiktok' && trendingCount > 0)
            ? `<div class="search-notice">⚠️ Hasil di bawah adalah <b>LIVE trending Indonesia</b>, bukan hasil keyword.
               Pencarian <b>keyword TikTok</b> membutuhkan <b>login akun TikTok</b> (berbeda dari login portal ini) —
               jalankan <code>npm run login</code> di server. Pencarian <b>YouTube tidak butuh apa pun</b> — coba tombol ▶ YouTube.</div>`
            : '';
        grid.innerHTML = notice + state.searchResults
            .map((item, i) => { item._idx = i; return cardHtml(item, false); })
            .join('');
        if (state.searchPlatform === 'youtube' && state.searchHasMore) {
            const btn = document.createElement('button');
            btn.className = 'load-more';
            btn.id = 'loadMoreBtn';
            btn.textContent = state.loadingMore ? '⏳ Memuat…' : '⏬ Muat Lebih Banyak';
            btn.disabled = state.loadingMore;
            btn.addEventListener('click', loadMoreSearch);
            grid.appendChild(btn);
        }
        return;
    }

    const list = visibleStreams();
    grid.innerHTML = list.length ? list.map(s => cardHtml(s, true)).join('') : emptyStateHtml();
}

/* ------------------------------------------------------------------ */
/* Player inline MULTI-SIMULTAN                                        */
/* ------------------------------------------------------------------ */

function findItemByKey(key) {
    if (key.startsWith('s-')) {
        const id = parseInt(key.slice(2), 10);
        return state.streams.find(s => s.id === id) || null;
    }
    const idx = parseInt(key.slice(2), 10);
    return (state.searchResults && state.searchResults[idx]) || null;
}

function destroyPlayerMedia(key) {
    const hls = hlsMap.get(key);
    if (hls) {
        try { hls.destroy(); } catch (_) { /* abaikan */ }
        hlsMap.delete(key);
    }
    const flv = flvMap.get(key);
    if (flv) {
        try { flv.pause(); flv.unload(); flv.detachMediaElement(); flv.destroy(); } catch (_) { /* abaikan */ }
        flvMap.delete(key);
    }
}

function closePlayer(key) {
    destroyPlayerMedia(key);
    state.players.delete(key);
    const container = document.getElementById('vc-' + key);
    const item = findItemByKey(key);
    if (container && item) container.innerHTML = placeholderHtml(item, key);
    if (state.players.size === 0) render();
}

function stopAllPlayers() {
    if (state.players.size === 0) return;
    for (const key of Array.from(state.players.keys())) destroyPlayerMedia(key);
    state.players.clear();
    render();
}

function openPlayer(key) {
    const item = findItemByKey(key);
    if (!item) return;
    if (state.players.has(key)) return;

    if (!item.is_live) {
        showToast('ℹ️', 'Stream sedang offline — tidak ada sinyal untuk diputar', true);
        return;
    }

    if (item.platform === 'youtube') {
        state.players.set(key, { key, platform: 'youtube', videoId: item.source_key, url: item.url });
        attachPlayer(state.players.get(key));
        return;
    }

    if (item.platform === 'tiktok') {
        // Prioritas sinyal: HLS (hls.js) → FLV (mpegts.js) → milik stream tersimpan → resolve admin
        let hlsUrl = item.playback_url;
        let flvUrl = item.playback_flv_url;
        if (!hlsUrl && !flvUrl) {
            const monitored = state.streams.find(s =>
                s.platform === 'tiktok' && s.source_key === item.source_key && (s.playback_url || s.playback_flv_url));
            if (monitored) { hlsUrl = monitored.playback_url; flvUrl = monitored.playback_flv_url; }
        }
        if (hlsUrl || flvUrl) {
            state.players.set(key, { key, platform: 'tiktok', hlsUrl, flvUrl, url: item.url });
            attachPlayer(state.players.get(key));
        } else if (isAdmin()) {
            resolveAndPlay(key, item);
        } else {
            window.open(item.url, '_blank', 'noopener');
        }
    }
}

async function resolveAndPlay(key, item) {
    const container = document.getElementById('vc-' + key);
    if (!container) return;
    container.innerHTML = `
        <div class="player-loading">
            <div class="loading-spinner"></div>
            <p>Mengambil sinyal TikTok…</p>
            <small>±10–15 detik (resolve via browser headless)</small>
        </div>`;
    try {
        const info = await api('/api/resolve', { method: 'POST', body: JSON.stringify({ url: item.url }) });
        if (!info.is_live) throw new Error('Stream sudah selesai / offline');
        if (!info.playback_url) throw new Error('URL stream tidak tersedia dari TikTok');
        item.playback_url = info.playback_url;
        if (!state.players.has(key) && document.getElementById('vc-' + key)) {
            state.players.set(key, { key, platform: 'tiktok', hlsUrl: info.playback_url, url: item.url });
            attachPlayer(state.players.get(key));
        }
    } catch (err) {
        if (document.getElementById('vc-' + key) && !state.players.has(key)) {
            container.innerHTML = placeholderHtml(item, key);
        }
        showToast('❌', 'Tidak bisa memutar: ' + err.message, true);
    }
}

function attachPlayer(p) {
    const container = document.getElementById('vc-' + p.key);
    if (!container) { closePlayer(p.key); return; }

    destroyPlayerMedia(p.key);
    container.innerHTML = '';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'player-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Tutup player ini';
    closeBtn.addEventListener('click', () => closePlayer(p.key));
    container.appendChild(closeBtn);

    if (p.platform === 'youtube') {
        const iframe = document.createElement('iframe');
        iframe.className = 'video-player';
        iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(p.videoId)}?autoplay=1&rel=0`;
        iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        container.insertBefore(iframe, closeBtn);
        return;
    }

    const video = document.createElement('video');
    video.className = 'video-player';
    video.controls = true;
    video.playsInline = true;
    container.insertBefore(video, closeBtn);

    const tryPlay = () => {
        video.play().catch(() => {
            video.muted = true;
            video.play().catch(() => { /* biarkan user tekan play manual */ });
        });
    };

    const showFallback = (msg) => {
        destroyPlayerMedia(p.key);
        const div = document.createElement('div');
        div.className = 'player-fallback';
        div.innerHTML = `
            <div style="font-size:26px">📺</div>
            <div>${esc(msg)}</div>
            <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
               style="color:#00f2ea;font-size:13px;">Buka stream aslinya →</a>`;
        container.insertBefore(div, closeBtn);
    };

    // ---- Jalur 1: HLS via hls.js (utama; konsisten di semua engine) ----
    if (p.hlsUrl && window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ liveDurationInfinity: true, enableWorker: true });
        hlsMap.set(p.key, hls);

        let recoverCount = 0;
        const MAX_RECOVER = 5;
        const recover = (data) => {
            if (recoverCount >= MAX_RECOVER) {
                showFallback('Stream TikTok terputus / akses dibatasi (kemungkinan CORS atau rate-limit).');
                return;
            }
            recoverCount++;
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad();
            } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            } else {
                showFallback('Stream TikTok terputus / akses dibatasi (kemungkinan CORS atau rate-limit).');
            }
        };
        hls.on(window.Hls.Events.FRAG_BUFFERED, () => { recoverCount = 0; });

        hls.loadSource(p.hlsUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, tryPlay);
        hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data && data.fatal) recover(data);
        });
        tryPlay();
        return;
    }

    // ---- Jalur 2: HLS native (engine tanpa MSE, mis. iOS Safari lama) ----
    if (p.hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = p.hlsUrl;
        video.addEventListener('loadedmetadata', tryPlay, { once: true });
        video.addEventListener('error', () => showFallback('Gagal memuat stream TikTok (URL kedaluwarsa atau dibatasi).'), { once: true });
        tryPlay();
        return;
    }

    // ---- Jalur 3: FLV via mpegts.js — sebagian room TikTok (mis. multi-host)
    //      hanya menyediakan FLV tanpa HLS; CDN-nya CORS-nya terbuka ----
    if (p.flvUrl && window.mpegts && window.mpegts.getFeatureList().mseLivePlayback) {
        const player = window.mpegts.createPlayer(
            { type: 'flv', url: p.flvUrl, isLive: true, cors: true },
            { enableStashBuffer: false, stashInitialSize: 128, liveBufferLatencyChasing: true }
        );
        flvMap.set(p.key, player);
        player.attachMediaElement(video);
        player.on(window.mpegts.Events.VIDEO_READY, tryPlay);
        player.on(window.mpegts.Events.ERROR, (type, detail) => {
            showFallback(`Stream FLV terputus (${type}: ${detail || 'tidak diketahui'}).`);
        });
        try { player.load(); } catch (e) {
            showFallback('Gagal memuat stream FLV.');
        }
        tryPlay();
        return;
    }

    showFallback(p.flvUrl
        ? 'Browser tidak mendukung pemutaran live FLV.'
        : 'TikTok tidak menyediakan sinyal HLS/FLV untuk stream ini — coba buka aslinya.');
}

/* ------------------------------------------------------------------ */
/* Data & aksi stream                                                  */
/* ------------------------------------------------------------------ */

async function loadStreams() {
    try {
        state.streams = await api('/api/streams');
        for (const key of Array.from(state.players.keys())) {
            if (!findItemByKey(key)) closePlayer(key);
        }
        render();
        updateStatsBar();
        updateAnalytics();
    } catch (err) {
        console.error('loadStreams:', err);
    }
}

function updateStatsBar() {
    const total = state.streams.length;
    const live = state.streams.filter(s => s.is_live).length;
    const viewers = state.streams.reduce((a, s) => a + (s.viewers || 0), 0);

    $('totalStreams').textContent = total;
    $('liveStreams').textContent = live;
    $('totalViewers').textContent = formatCount(viewers);
    if (isAdmin()) {
        $('savedStreams').textContent = state.streams.filter(s => s.saved).length;
        $('highPriority').textContent = state.streams.filter(s => s.priority === 'high').length;
        const sc = $('savedCount');
        if (sc) sc.textContent = state.streams.filter(s => s.saved).length;
    }
}

function updateAnalytics() {
    const byPlatform = {};
    for (const s of state.streams) {
        byPlatform[s.platform] = byPlatform[s.platform] || { total: 0, live: 0, viewers: 0 };
        byPlatform[s.platform].total++;
        if (s.is_live) byPlatform[s.platform].live++;
        byPlatform[s.platform].viewers += s.viewers || 0;
    }
    $('analyticsSummary').innerHTML = `
        <div class="analytics-row"><span>Total dimonitor</span><span class="val">${state.streams.length}</span></div>
        <div class="analytics-row"><span>Sedang live</span><span class="val">${state.streams.filter(s => s.is_live).length}</span></div>
        <div class="analytics-row"><span>Total viewers</span><span class="val">${formatCount(state.streams.reduce((a, s) => a + (s.viewers || 0), 0))}</span></div>`;

    $('analyticsPlatform').innerHTML = Object.entries(byPlatform).map(([p, v]) => {
        const m = PLATFORM_META[p] || { icon: '❓', name: p };
        return `<div class="analytics-row"><span>${m.icon} ${m.name}</span><span class="val">${v.live}/${v.total} live · ${formatCount(v.viewers)} 👁</span></div>`;
    }).join('') || '<div class="analytics-row"><span>Belum ada data</span><span class="val">—</span></div>';

    const errs = state.streams.filter(s => s.last_error);
    $('analyticsErrors').innerHTML = errs.length
        ? errs.map(s => `<div><b>${esc(s.handle || s.source_key)}</b><br>${esc(s.last_error)}</div>`).join('')
        : '<div style="color:#666;font-size:12px;">Tidak ada kendala 🎉</div>';
}

function setView(view) {
    if (state.players.size > 0 && view !== state.view) stopAllPlayers();
    state.view = view;
    renderFilterBar();
    render();
}

async function toggleSave(id) {
    if (!isAdmin()) return;
    const s = state.streams.find(x => x.id === id);
    if (!s) return;
    try {
        await api(`/api/streams/${id}`, { method: 'PATCH', body: JSON.stringify({ saved: !s.saved }) });
        showToast(s.saved ? '🗑️' : '📌', s.saved ? 'Dihapus dari Saved' : 'Masuk ke list Saved');
        await loadStreams();
        renderFilterBar();
    } catch (err) {
        showToast('⚠️', err.message, true);
    }
}

async function togglePriority(id) {
    if (!isAdmin()) return;
    const s = state.streams.find(x => x.id === id);
    if (!s) return;
    try {
        await api(`/api/streams/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ priority: s.priority === 'high' ? 'normal' : 'high' })
        });
        await loadStreams();
    } catch (err) {
        showToast('⚠️', err.message, true);
    }
}

async function deleteStream(id) {
    if (!isAdmin()) return;
    const s = state.streams.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`Hapus ${s.handle || s.source_key} dari monitoring?`)) return;
    try {
        await api(`/api/streams/${id}`, { method: 'DELETE' });
        closePlayer('s-' + id);
        showToast('🗑️', 'Stream dihapus dari monitoring');
        await loadStreams();
    } catch (err) {
        showToast('⚠️', err.message, true);
    }
}

/* ------------------------ Add Stream modal (admin) ------------------ */

function detectPlatformFromInput(url) {
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
    if (/^@[\w.]+$/.test(url.trim())) return 'tiktok';
    return null;
}

function addStream() {
    if (!isAdmin()) return;
    $('addStreamModal').classList.add('active');
    $('streamUrlInput').value = '';
    $('streamLabelInput').value = '';
    $('platformDetect').textContent = '—';
    fillCategorySelect();
    setTimeout(() => $('streamUrlInput').focus(), 100);
}

function fillCategorySelect() {
    const sel = $('streamCategoryInput');
    sel.innerHTML = '<option value="">— Tanpa kategori —</option>' +
        state.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

function closeAddStreamModal() {
    $('addStreamModal').classList.remove('active');
}

async function addStreamFromUrl() {
    const url = $('streamUrlInput').value.trim();
    const label = $('streamLabelInput').value.trim();
    const category_id = $('streamCategoryInput').value || null;

    if (!url) {
        showToast('⚠️', 'Masukkan URL live stream terlebih dahulu', true);
        return;
    }

    const btn = $('addStreamBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Mengambil data live…';
    try {
        const { stream, duplicated } = await api('/api/streams', {
            method: 'POST',
            body: JSON.stringify({ url, label, category_id })
        });
        closeAddStreamModal();
        state.view = 'saved';
        renderFilterBar();
        await loadStreams();
        const m = PLATFORM_META[stream.platform];
        showToast('✅', duplicated
            ? `Stream sudah ada — dipastikan tersimpan`
            : `${m.icon} ${m.name} ${stream.handle || stream.source_key} masuk ke Saved${stream.is_live ? ' (SEDANG LIVE 🔴)' : ''}`);
    } catch (err) {
        showToast('❌', err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = '✅ Add Stream';
    }
}

/* --------------------------- Pencarian (admin) ---------------------- */

function isSearchSaved(item) {
    return state.streams.some(s => s.platform === item.platform && s.source_key === item.source_key && s.saved);
}

async function doSearch() {
    if (!isAdmin()) return;
    const q = $('searchInput').value.trim();
    if (!q) {
        showToast('⚠️', 'Ketik keyword pencarian dulu', true);
        return;
    }
    stopAllPlayers();
    state.searchQuery = q;
    state.searching = true;
    state.searchResults = null;
    setView('search'); // PINDAH KE VIEW HASIL PENCARIAN (renderFilterBar + render)

    try {
        const items = await api(`/api/search?platform=${state.searchPlatform}&q=${encodeURIComponent(q)}&page=1`);
        state.searchResults = items;
        state.searchPage = 1;
        state.searchHasMore = state.searchPlatform === 'youtube' && items.length >= 15;
        const trending = items.filter(i => i.source === 'trending');
        if (state.searchPlatform === 'tiktok' && trending.length > 0) {
            showToast('ℹ️', `Keyword TikTok butuh LOGIN AKUN TIKTOK (bukan login portal) via "npm run login" — ditampilkan ${trending.length} LIVE trending. YouTube bisa langsung dicari.`, false);
        }
    } catch (err) {
        state.searchResults = [];
        showToast('❌', err.message, true);
    } finally {
        state.searching = false;
        renderFilterBar(); // chip "Hasil Pencarian" muncul setelah hasil ada
        render();
    }
}

async function loadMoreSearch() {
    if (state.loadingMore || state.searching) return;
    state.loadingMore = true;
    render();
    try {
        const nextPage = state.searchPage + 1;
        const items = await api(`/api/search?platform=${state.searchPlatform}&q=${encodeURIComponent(state.searchQuery)}&page=${nextPage}`);
        if (items.length === 0) {
            state.searchHasMore = false;
            showToast('ℹ️', 'Sudah tidak ada hasil lagi');
        } else {
            const seen = new Set(state.searchResults.map(i => `${i.platform}:${i.source_key}`));
            for (const it of items) {
                const k = `${it.platform}:${it.source_key}`;
                if (!seen.has(k)) { state.searchResults.push(it); seen.add(k); }
            }
            state.searchPage = nextPage;
            state.searchHasMore = items.length >= 15;
        }
    } catch (err) {
        showToast('❌', err.message, true);
    } finally {
        state.loadingMore = false;
        render();
    }
}

async function saveFromSearch(idx) {
    if (!isAdmin()) return;
    const item = state.searchResults && state.searchResults[idx];
    if (!item) return;

    // Ada kategori → pilih dulu lewat modal cepat; belum ada kategori →
    // langsung masuk Saved tanpa kategori (label "Saved" otomatis)
    if (state.categories.length > 0) return openCatPick(idx);
    await saveFromSearchNow(idx, null);
}

/** Modal pilih kategori cepat saat menyimpan dari hasil pencarian. */
function openCatPick(idx) {
    const item = state.searchResults[idx];
    if (!item) return;
    const m = PLATFORM_META[item.platform] || { icon: '❓', name: item.platform };
    $('catPickTitle').textContent = `🔖 ${m.icon} ${item.handle || item.source_key}`;
    $('catPickBody').innerHTML = `
        <div class="form-hint" style="margin:0 0 12px;">Simpan ke kategori:</div>
        <div class="cat-pick-grid">
            ${state.categories.map(c =>
                `<button class="cat-pick-chip" onclick="saveFromSearchNow(${idx}, ${c.id})" title="${esc(c.name)}">🏷 ${esc(c.name)}</button>`
            ).join('')}
            <button class="cat-pick-chip plain" onclick="saveFromSearchNow(${idx}, null)">🔖 Tanpa Kategori (Saved)</button>
        </div>`;
    $('catPickModal').classList.add('active');
}

function closeCatPick() {
    $('catPickModal').classList.remove('active');
}

/** Simpan snapshot dari hasil pencarian (instan) — dengan/tanpa kategori. */
async function saveFromSearchNow(idx, categoryId) {
    if (!isAdmin()) return;
    const item = state.searchResults && state.searchResults[idx];
    if (!item) return;
    const m = PLATFORM_META[item.platform] || { icon: '❓', name: item.platform };
    closeCatPick();

    // Feedback di tombol kartu selama proses (instan — data pencarian dipakai langsung)
    const cardBtns = document.querySelectorAll(`#card-r-${idx} .save-btn`);
    cardBtns.forEach(b => { b.textContent = '⏳'; b.disabled = true; });

    try {
        const { stream, duplicated } = await api('/api/streams', {
            method: 'POST',
            body: JSON.stringify({
                url: item.url,
                ...(categoryId ? { category_id: categoryId } : {}),
                // snapshot dari hasil pencarian → server menyimpan LANGSUNG
                // (instan), detail playback/viewer dilengkapi di background
                info: {
                    platform: item.platform,
                    source_key: item.source_key,
                    url: item.url,
                    is_live: item.is_live,
                    viewers: item.viewers,
                    title: item.title,
                    display_name: item.display_name,
                    handle: item.handle,
                    avatar_url: item.avatar_url,
                    cover_url: item.cover_url,
                    started_at: item.started_at,
                    playback_url: item.playback_url,
                    playback_flv_url: item.playback_flv_url
                }
            })
        });
        const cat = categoryId ? state.categories.find(c => c.id === categoryId) : null;
        showToast(duplicated ? 'ℹ️' : '✅', duplicated
            ? `Sudah ada di list Saved${cat ? ` (🏷 ${cat.name})` : ''}`
            : `${m.icon} ${m.name} ${stream.handle || stream.source_key} masuk ${cat ? `🏷 ${cat.name}` : 'Saved'} (instan)`);
        await loadStreams();
        render();
    } catch (err) {
        showToast('❌', err.message, true);
        cardBtns.forEach(b => { b.textContent = '🔖'; b.disabled = false; });
    }
}

/* ------------------------------ Init -------------------------------- */

function toggleSidebar() {
    $('sidebar').classList.toggle('open');
}

function hideLoadingOverlay() {
    const o = $('loadingOverlay');
    if (!o || o.style.display === 'none') return;
    o.style.opacity = '0';
    setTimeout(() => { o.style.display = 'none'; }, 500);
}

function bindEvents() {
    $('loginForm').addEventListener('submit', submitLogin);

    $('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    document.querySelectorAll('.platform-toggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            state.searchPlatform = btn.dataset.platform;
            document.querySelectorAll('.platform-toggle button').forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    $('streamUrlInput').addEventListener('input', (e) => {
        const p = detectPlatformFromInput(e.target.value);
        $('platformDetect').textContent = p ? PLATFORM_META[p].name : '—';
    });

    $('streamUrlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addStreamFromUrl();
    });

    $('addStreamModal').addEventListener('click', function (e) {
        if (e.target === this) closeAddStreamModal();
    });
    $('catModal').addEventListener('click', function (e) {
        if (e.target === this) closeCatModal();
    });
    $('catPickModal').addEventListener('click', function (e) {
        if (e.target === this) closeCatPick();
    });
    $('usersModal').addEventListener('click', function (e) {
        if (e.target === this) closeUsersPanel();
    });
}

async function init() {
    bindEvents();

    // Auto-refresh data + durasi live
    setInterval(loadStreams, 25000);
    setInterval(() => {
        if (['saved', 'high', 'live', 'cat-all'].includes(state.view) || state.view.startsWith('cat-')) render();
    }, 10000);
}

async function boot() {
    hideLoadingOverlay();
    try {
        state.user = await api('/api/auth/me');
        applyRole();
        await Promise.all([loadStreams(), loadCategories()]);
        renderFilterBar();
        render();
    } catch (_) {
        // belum login → tampilkan halaman login
        render();
        showLogin();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setTimeout(hideLoadingOverlay, 300); init(); boot(); });
} else {
    setTimeout(hideLoadingOverlay, 300);
    init();
    boot();
}
setTimeout(hideLoadingOverlay, 2500);
