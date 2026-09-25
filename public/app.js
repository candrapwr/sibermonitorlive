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
    players: new Map(),
    assetV: null,          // versi CSS/JS saat load — untuk deteksi perubahan otomatis
    jsReloadPending: false,
    jsToastShown: false
};

const hlsMap = new Map();   // key → instance hls.js (HLS) aktif
const flvMap = new Map();   // key → instance mpegts.js (FLV) aktif
const commentsState = {
    streamId: null,
    eventSource: null,
    items: [],
    seen: new Set()
};
const tiktokDetailState = {
    streamId: null,
    requestId: 0
};

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

function setCommentsStatus(text, kind = 'connecting') {
    const el = $('commentsStatus');
    if (!el) return;
    el.className = `comments-status ${kind}`;
    el.innerHTML = `<span class="status-dot"></span><span>${esc(text)}</span>`;
}

function stopCommentsStream() {
    if (commentsState.eventSource) {
        commentsState.eventSource.close();
        commentsState.eventSource = null;
    }
    commentsState.streamId = null;
}

function clearCommentsView() {
    commentsState.items = [];
    commentsState.seen.clear();
    const list = $('commentsList');
    if (list) list.innerHTML = '<div class="comments-empty"><div>💬</div><p>Menunggu komentar baru…</p></div>';
    if ($('commentsCount')) $('commentsCount').textContent = '0 komentar';
}

function appendComments(items) {
    const list = $('commentsList');
    if (!list) return;
    const wasBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const empty = list.querySelector('.comments-empty');
    if (empty) empty.remove();
    for (const item of items || []) {
        if (!item || !item.id || commentsState.seen.has(item.id)) continue;
        commentsState.seen.add(item.id);
        commentsState.items.push(item);
        const row = document.createElement('div');
        row.className = item.type === 'gift' ? 'comment-row comment-gift' : 'comment-row';
        const label = item.type === 'gift' ? '🎁 ' : '';
        const initial = esc(String(item.author || '?').charAt(0).toUpperCase());
        const avatar = item.type === 'gift' ? '🎁' : initial;
        const avatarHtml = item.avatar_url && item.type !== 'gift'
            ? `<div class="comment-avatar comment-avatar-image"><img src="${esc(imgProxy(item.avatar_url, initial))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span>${initial}</span></div>`
            : `<div class="comment-avatar">${avatar}</div>`;
        const levelHtml = Number.isInteger(item.level)
            ? `<span class="comment-level" title="Level ${item.level}">${item.level_badge_url ? `<img src="${esc(imgProxy(item.level_badge_url, `Lv.${item.level}`))}" alt="" loading="lazy">` : ''}<span>Lv.${item.level}</span></span>`
            : '';
        const badgesHtml = (item.badges || []).map(badge => {
            const image = badge.image_url ? `<img src="${esc(imgProxy(badge.image_url, badge.label || 'badge'))}" alt="" loading="lazy">` : '';
            return `<span class="comment-badge" title="${esc(badge.label || badge.type || 'Badge')}">${image}${badge.label ? `<span>${esc(badge.label)}</span>` : ''}</span>`;
        }).join('');
        row.innerHTML = `${avatarHtml}
            <div class="comment-body"><div class="comment-author-line"><div class="comment-author">${label}${esc(item.author || 'Anonim')}</div>${levelHtml}${badgesHtml}</div><div class="comment-text">${esc(item.text || '')}</div></div>`;
        list.appendChild(row);
    }
    while (list.children.length > 250) list.firstElementChild.remove();
    if ($('commentsCount')) $('commentsCount').textContent = `${commentsState.items.length} komentar`;
    if (wasBottom) list.scrollTop = list.scrollHeight;
}

function closeCommentsModal() {
    stopCommentsStream();
    const modal = $('commentsModal');
    if (modal) modal.classList.remove('active');
}

function openCommentsModal(id) {
    if (!state.user) return;
    const stream = state.streams.find(s => s.id === id);
    if (!stream) return;
    if (stream.platform !== 'tiktok' || !stream.is_live) {
        showToast('ℹ️', 'Komentar hanya tersedia saat TikTok sedang LIVE', true);
        return;
    }
    openCommentsStream(stream, `/api/streams/${id}/comments`, id);
}

function openCommentsFromSearch(idx) {
    if (!state.user) return;
    const stream = state.searchResults?.[idx];
    if (!stream || stream.platform !== 'tiktok' || !stream.is_live) {
        showToast('ℹ️', 'Komentar hanya tersedia saat TikTok sedang LIVE', true);
        return;
    }
    const sourceKey = String(stream.source_key || '').replace(/^@/, '');
    openCommentsStream(
        stream,
        `/api/search/tiktok-comments?source_key=${encodeURIComponent(sourceKey)}`,
        `search:${sourceKey.toLowerCase()}`
    );
}

function openCommentsStream(stream, endpoint, streamKey) {
    stopCommentsStream();
    commentsState.streamId = streamKey;
    commentsState.items = [];
    commentsState.seen.clear();
    $('commentsModalTitle').textContent = `💬 ${stream.handle || stream.display_name || 'TikTok LIVE'}`;
    $('commentsModalSubtitle').textContent = stream.title || 'Komentar realtime';
    clearCommentsView();
    $('commentsModal').classList.add('active');
    setCommentsStatus('Menghubungkan ke LIVE…', 'connecting');

    const es = new EventSource(endpoint);
    commentsState.eventSource = es;
    es.addEventListener('snapshot', e => {
        const data = JSON.parse(e.data);
        appendComments(data.comments || []);
        if (data.status === 'needs_verification') {
            setCommentsStatus('Perlu verifikasi browser', 'warning');
        } else if (data.status === 'connecting') {
            setCommentsStatus('Memuat riwayat komentar…', 'connecting');
        } else {
            setCommentsStatus('Terhubung', 'connected');
        }
    });
    es.addEventListener('status', e => {
        const data = JSON.parse(e.data);
        const labels = { connecting: 'Membuka browser komentar…', connected: 'Komentar realtime aktif', needs_verification: 'CAPTCHA perlu diselesaikan di browser server', error: data.error || 'Koneksi komentar gagal', stopped: 'Koneksi dihentikan' };
        const kind = data.status === 'connected' ? 'connected' : data.status === 'needs_verification' ? 'warning' : data.status === 'error' ? 'error' : 'connecting';
        setCommentsStatus(labels[data.status] || data.status, kind);
    });
    const appendLiveEvent = e => {
        appendComments([JSON.parse(e.data)]);
        setCommentsStatus('Komentar realtime aktif', 'connected');
    };
    es.addEventListener('comment', appendLiveEvent);
    es.addEventListener('gift', appendLiveEvent);
    es.onerror = () => {
        if (commentsState.eventSource !== es) return;
        setCommentsStatus('Koneksi komentar terputus', 'error');
    };
}

function closeTikTokDetailModal() {
    tiktokDetailState.streamId = null;
    tiktokDetailState.requestId += 1;
    const modal = $('tiktokDetailModal');
    if (modal) modal.classList.remove('active');
}

function detailNum(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? formatCount(n) : esc(String(value));
}

function detailDate(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return typeof value === 'string' && value.trim() ? esc(value) : '—';
    }
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toLocaleString('id-ID');
}

/** Normalisasi semua durasi di modal detail menjadi HH:MM:SS. */
function detailDuration(value, defaultUnit = 'seconds') {
    if (value === null || value === undefined || value === '') return '—';

    let seconds = null;
    if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value))) {
        const n = Number(String(value).replace(',', '.'));
        seconds = defaultUnit === 'minutes' ? n * 60 : n;
    } else {
        const text = String(value).trim();
        const clock = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
        if (clock) {
            seconds = clock[3]
                ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
                : Number(clock[1]) * 60 + Number(clock[2]);
        } else {
            const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|jam|minutes?|mins?|menit|seconds?|secs?|detik|h|m|s)\b/gi)];
            if (matches.length) {
                seconds = matches.reduce((total, match) => {
                    const amount = Number(match[1].replace(',', '.'));
                    const unit = match[2].toLowerCase();
                    if (/^(?:h|hour|hours|hr|hrs|jam)$/.test(unit)) return total + amount * 3600;
                    if (/^(?:m|minute|minutes|min|mins|menit)$/.test(unit)) return total + amount * 60;
                    return total + amount;
                }, 0);
            }
        }
    }

    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return [hours, minutes, secs].map(part => String(part).padStart(2, '0')).join(':');
}

function detailHttpUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url : '';
}

function detailImage(url, hint, className = '') {
    const source = detailHttpUrl(url);
    if (!source) return '';
    return `<img class="${className}" src="${esc(imgProxy(source, hint || '?'))}" alt="" loading="lazy" onerror="this.remove()">`;
}

function detailLink(label, url) {
    const source = detailHttpUrl(url);
    return source
        ? `<a class="detail-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
        : '';
}

function detailStat(value, label) {
    return `<div class="detail-stat"><div class="detail-stat-value">${value}</div><div class="detail-stat-label">${esc(label)}</div></div>`;
}

function detailKv(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="detail-kv"><span>${esc(label)}</span><b>${value}</b></div>`;
}

function detailChip(text, tone = '') {
    if (text === null || text === undefined || text === '') return '';
    return `<span class="detail-chip ${tone}">${esc(String(text))}</span>`;
}

function renderDetailBattle(battle) {
    if (!battle?.players?.length) return '';
    const battleDuration = detailDuration(battle.duration_s);
    return `<section class="detail-card">
        <h3>⚔ PK / Battle</h3>
        <div class="detail-battle">${battle.players.map((player, index) => `
            <div class="detail-battle-player">
                ${detailImage(player.avatar, player.nickname, 'detail-battle-avatar')}
                <div class="detail-battle-score">${detailNum(player.score)}</div>
                <div class="detail-battle-name">${esc(player.nickname || '—')}</div>
                ${player.league ? `<div class="detail-muted">Liga ${esc(player.league)}</div>` : ''}
                ${player.top_armies?.length ? `<div class="detail-muted">Top: ${player.top_armies.map(a => `${esc(a.name || '—')} (${detailNum(a.score)})`).join(' · ')}</div>` : ''}
            </div>${index === 0 && battle.players.length > 1 ? '<div class="detail-battle-vs">VS</div>' : ''}`).join('')}</div>
        ${battleDuration !== '—' ? `<div class="detail-muted detail-centered">Durasi ${battleDuration}</div>` : ''}
        ${battle.bubble_text ? `<div class="detail-muted detail-centered">${esc(battle.bubble_text)}</div>` : ''}
    </section>`;
}

function renderDetailStreams(streams, room) {
    const rows = Array.isArray(streams) ? streams : [];
    if (!rows.length && !room?.backup_flv && !room?.backup_hls) return '';
    return `<section class="detail-card">
        <h3>📺 Kualitas Stream</h3>
        ${rows.length ? `<div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>Kualitas</th><th>Resolusi</th><th>Codec</th><th>Bitrate</th><th>URL</th></tr></thead><tbody>
            ${rows.map(item => `<tr><td>${esc(item.name || '—')}</td><td>${esc(item.resolution || '—')}</td><td>${esc(item.codec || '—')}</td><td>${esc(item.bitrate || '—')}</td><td>${detailLink('FLV', item.flv)} ${detailLink('HLS', item.hls)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
        ${(room?.backup_flv || room?.backup_hls) ? `<div class="detail-kv detail-stream-backup"><span>Cadangan</span><b>${detailLink('FLV backup', room.backup_flv)} ${detailLink('HLS backup', room.backup_hls)}</b></div>` : ''}
    </section>`;
}

function historyDuration(row) {
    const start = Number(row?.start_time);
    const end = Number(row?.end_time);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        const timestampUnit = Math.max(Math.abs(start), Math.abs(end)) >= 1e12 ? 1000 : 1;
        return detailDuration((end - start) / timestampUnit);
    }
    return detailDuration(row?.duration_min, 'minutes');
}

function renderTikTokLiveHistory(liveHistory) {
    if (!liveHistory || typeof liveHistory !== 'object') return '';
    const rows = Array.isArray(liveHistory.history) ? liveHistory.history : [];
    if (!rows.length && liveHistory.total === undefined) return '';

    return `<section class="detail-card detail-history-card">
        <h3>🕘 Riwayat LIVE${liveHistory.total !== undefined ? ` <span class="detail-muted">— ${detailNum(liveHistory.total)} sesi</span>` : ''}</h3>
        <div class="detail-stats detail-history-stats">
            ${detailStat(detailNum(liveHistory.total ?? rows.length), 'Total sesi')}
            ${detailStat(detailNum(liveHistory.fans_club_count), 'Fans club')}
        </div>
        ${rows.length ? `<div class="detail-history-list">
            ${rows.map((row, index) => `<article class="detail-history-item">
                <div class="detail-history-item-head">
                    <span class="detail-history-index">#${index + 1}</span>
                    <div class="detail-history-heading">
                        <div class="detail-history-title">${esc(row.title || 'Tanpa judul')}</div>
                        ${row.room_id ? `<div class="detail-history-room">Room ${esc(row.room_id)}</div>` : ''}
                    </div>
                    <span class="detail-history-duration">⏱ ${historyDuration(row)}</span>
                </div>
                <div class="detail-history-meta">
                    <div><span>Mulai</span><b>${detailDate(row.start_time)}</b></div>
                    <div><span>Selesai</span><b>${detailDate(row.end_time)}</b></div>
                    <div><span>Likes</span><b>❤️ ${detailNum(row.likes)}</b></div>
                </div>
            </article>`).join('')}
        </div>` : '<div class="detail-muted">Belum ada riwayat LIVE.</div>'}
    </section>`;
}

function renderTikTokLoginDetail(data, stream) {
    const login = data.login_data || {};
    const loginRoom = login.extra?.room || {};
    const anchor = login.extra?.anchor || {};
    const ranks = login.ranks || {};
    const name = anchor.nickname || stream.display_name || stream.handle || data.username || 'TikTok LIVE';
    const topViewers = Array.isArray(ranks.top_viewers) ? ranks.top_viewers : [];
    const resolutions = Array.isArray(login.resolutions) ? login.resolutions : [];
    const loginDuration = detailDuration(loginRoom.duration_min, 'minutes');
    const liveHistoryData = login.live_history;
    const liveHistory = renderTikTokLiveHistory(liveHistoryData);
    const loginChips = [
        anchor.zodiac ? `Zodiac ${anchor.zodiac}` : '',
        anchor.account_since ? `Akun sejak ${new Date(Number(anchor.account_since) * 1000).toLocaleDateString('id-ID')}` : '',
        loginRoom.product_num ? `🛒 ${detailNum(loginRoom.product_num)} produk` : '',
        loginRoom.is_pk ? '⚔ PK aktif' : '',
        loginRoom.business_live ? 'Business live' : '',
        loginRoom.composition?.my_follow !== null && loginRoom.composition?.my_follow !== undefined ? `Follower ${loginRoom.composition.my_follow}%` : '',
        ranks.host_rank ? `💰 Host ${ranks.host_rank.rank > 0 ? `#${ranks.host_rank.rank} nasional` : ''} — ${ranks.host_rank.desc || detailNum(ranks.host_rank.score)} koin` : ''
    ].filter(Boolean);

    return `<div class="tiktok-detail-content">
        <div class="tiktok-detail-hero">
            <div class="tiktok-detail-profile">
                ${detailImage(anchor.avatar || stream.avatar_url, name, 'tiktok-detail-avatar')}
                <div>
                    <div class="tiktok-detail-badges"><span class="detail-status live">LIVE</span><span class="detail-session active">Session Aktif</span>${loginDuration !== '—' ? `<span class="detail-session detail-duration">⏱ ${loginDuration}</span>` : ''}</div>
                    <h2>${esc(name)}</h2>
                    <div class="detail-handle">@${esc(String(data.username || stream.source_key || '').replace(/^@/, ''))}</div>
                    ${anchor.bio ? `<div class="detail-bio">${esc(anchor.bio)}</div>` : ''}
                </div>
            </div>
        </div>

        <section class="detail-card detail-card-first detail-login-card">
            <div class="detail-stats">
                ${detailStat(detailNum(loginRoom.likes), 'Likes sesi ini')}
                ${detailStat(detailNum(loginRoom.viewers), 'Penonton')}
                ${detailStat(detailNum(loginRoom.total_enter), 'Total masuk')}
                ${detailStat(detailNum(loginRoom.shares), 'Share')}
                ${detailStat(detailNum(anchor.followers), 'Followers anchor')}
                ${detailStat(detailNum(anchor.video_likes_total), 'Like video total')}
            </div>
            ${loginChips.length ? `<div class="detail-chips">${loginChips.map(chip => detailChip(chip, 'gold')).join('')}</div>` : ''}
            <div class="detail-kv-grid">
                ${detailKv('Komentar', detailNum(loginRoom.comments))}
                ${detailKv('Fan ticket', detailNum(loginRoom.fan_ticket))}
                ${detailKv('Fans club', detailNum(liveHistoryData?.fans_club_count))}
                ${detailKv('Room ID', `<span class="detail-mono">${esc(login.room_id || '—')}</span>`)}
                ${detailKv('Battle score', loginRoom.battle_scores?.length ? esc(JSON.stringify(loginRoom.battle_scores)) : '—')}
            </div>
            ${resolutions.length ? `<div class="detail-kv"><span>Kualitas</span><b>${resolutions.map(item => detailChip(item, 'gold')).join(' ')}</b></div>` : ''}
            <div class="detail-stream-links">${detailLink('Buka FLV', login.flv)} ${detailLink('Buka HLS', login.hls)}</div>
        </section>

        ${topViewers.length ? `<section class="detail-card"><h3>❤️ Top Fan Room${ranks.viewers_total ? ` <span class="detail-muted">— ${detailNum(ranks.viewers_total)} penonton</span>` : ''}</h3><div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>#</th><th>Nama</th><th>Kontribusi</th><th>Level</th></tr></thead><tbody>${topViewers.map(viewer => `<tr><td>${esc(viewer.rank ?? '—')}</td><td>${esc(viewer.nickname || '—')}</td><td>${esc(viewer.desc || detailNum(viewer.score))}</td><td>${viewer.level ? `Lv${esc(viewer.level)}` : '—'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}

        ${liveHistory}

        <details class="detail-raw"><summary>📄 Data lengkap service login</summary><pre>${esc(JSON.stringify(login, null, 2))}</pre></details>
    </div>`;
}

function renderTikTokDetail(data, stream) {
    if (data.mode === 'login' && data.logged_in && data.login_data?.ok) {
        return renderTikTokLoginDetail(data, stream);
    }

    const profile = data.profile || {};
    const room = data.room || {};
    const extras = data.extras || {};
    const login = data.login_data;
    const loginRoom = login?.extra?.room || {};
    const anchor = login?.extra?.anchor || {};
    const ranks = login?.ranks || {};
    const isLogin = data.mode === 'login' && data.logged_in && login?.ok;
    const guestDuration = detailDuration(room.duration);
    const liveHistoryData = data.live_history || login?.live_history;
    const name = profile.nickname || stream.display_name || stream.handle || data.username || 'TikTok LIVE';
    const statusText = data.is_live ? 'LIVE' : 'OFFLINE';
    const statusClass = data.is_live ? 'live' : 'offline';
    const chips = [
        ...(data.tags || []),
        ...(data.geofencing || []).map(value => `geo: ${value}`),
        room.multi_stream ? 'multi-stream tersedia' : '',
        room.orientation !== null && room.orientation !== undefined ? `Landscape flag ${room.orientation}` : '',
        extras.commerce ? 'TikTok Shop aktif' : '',
        extras.questions ? `${extras.questions} pertanyaan` : '',
        extras.stickers ? `${extras.stickers} stiker interaksi` : ''
    ].filter(Boolean);
    const products = Array.isArray(data.products) ? data.products : [];
    const snapshot = data.snapshot || room.cover;
    const loginNote = data.login_note || 'Sesi TikTok login tidak aktif.';

    let html = `<div class="tiktok-detail-content">
        <div class="tiktok-detail-hero">
            <div class="tiktok-detail-profile">
                ${detailImage(profile.avatar || stream.avatar_url, name, 'tiktok-detail-avatar')}
                <div>
                    <div class="tiktok-detail-badges"><span class="detail-status ${statusClass}">${statusText}</span><span class="detail-session ${isLogin ? 'active' : 'guest'}">${isLogin ? 'Session Aktif' : 'Mode guest'}</span>${guestDuration !== '—' ? `<span class="detail-session detail-duration">⏱ ${guestDuration}</span>` : ''}</div>
                    <h2>${esc(name)}</h2>
                    <div class="detail-handle">@${esc(profile.username || String(data.username || stream.source_key || '').replace(/^@/, ''))}</div>
                    ${profile.bio ? `<div class="detail-bio">${esc(profile.bio)}</div>` : ''}
                </div>
            </div>
        </div>

        <section class="detail-card detail-card-first">
            <h3>📊 Ringkasan Guest</h3>
            <div class="detail-stats">
                ${detailStat(detailNum(room.viewers), 'Penonton')}
                ${detailStat(detailNum(room.likes), 'Likes')}
                ${detailStat(detailNum(room.total_enter), 'Total masuk')}
                ${detailStat(detailNum(profile.followers), 'Followers')}
                ${detailStat(detailNum(profile.following), 'Mengikuti')}
                ${detailStat(detailNum(room.shares), 'Share')}
            </div>
            <div class="detail-kv-grid">
                ${detailKv('Room ID', `<span class="detail-mono">${esc(room.room_id || '—')}</span>`)}
                ${detailKv('UID', `<span class="detail-mono">${esc(profile.uid || '—')}</span>`)}
                ${detailKv('Mulai live', esc(detailDate(room.started_at)))}
                ${detailKv('Check alive', data.check_alive === null || data.check_alive === undefined ? '—' : (data.check_alive ? '✓ aktif' : '✗ tidak aktif'))}
                ${detailKv('Link-mic', profile.link_mic_stats === null || profile.link_mic_stats === undefined ? '—' : esc(String(profile.link_mic_stats)))}
            </div>
        </section>

        <section class="detail-card">
            <h3>🏠 Room & Metadata</h3>
            ${snapshot ? `<div class="detail-images">${detailImage(snapshot, name, 'detail-room-image')}${room.cover && room.cover !== snapshot ? detailImage(room.cover, name, 'detail-room-image') : ''}</div>` : ''}
            ${chips.length ? `<div class="detail-chips">${chips.map(chip => detailChip(chip, data.tags?.includes(chip) ? 'pink' : '')).join('')}</div>` : ''}
            <div class="detail-kv-grid">
                ${detailKv('Status room', room.status === 2 ? '<span class="detail-live-text">LIVE</span>' : esc(room.status ?? '—'))}
                ${detailKv('Aweme type', extras.aweme_type === null || extras.aweme_type === undefined ? '—' : esc(String(extras.aweme_type)))}
                ${detailKv('Group ID', extras.group_id ? `<span class="detail-mono">${esc(extras.group_id)}</span>` : '—')}
                ${detailKv('Posisi search', extras.position === null || extras.position === undefined ? '—' : `#${Number(extras.position) + 1}`)}
                ${detailKv('Deteksi wajah', room.face ? `x=${esc(room.face[0])}, y=${esc(room.face[1])}` : '—')}
            </div>
        </section>`;

    if (products.length) {
        html += `<section class="detail-card"><h3>🛒 Produk di Live (${products.length})</h3><ol class="detail-product-list">${products.map(product => `<li>${esc(product)}</li>`).join('')}</ol></section>`;
    }

    html += renderDetailBattle(data.battle);
    html += renderDetailStreams(data.streams, room);
    html += renderTikTokLiveHistory(liveHistoryData);

    if (isLogin) {
        const loginDuration = detailDuration(loginRoom.duration_min, 'minutes');
        const loginChips = [
            anchor.zodiac ? `Zodiac ${anchor.zodiac}` : '',
            anchor.account_since ? `Akun sejak ${new Date(Number(anchor.account_since) * 1000).toLocaleDateString('id-ID')}` : '',
            loginRoom.product_num ? `🛒 ${detailNum(loginRoom.product_num)} produk` : '',
            loginRoom.is_pk ? '⚔ PK aktif' : '',
            loginRoom.business_live ? 'Business live' : '',
            loginRoom.composition?.my_follow !== null && loginRoom.composition?.my_follow !== undefined ? `Follower ${loginRoom.composition.my_follow}%` : '',
            ranks.host_rank ? `💰 Host ${ranks.host_rank.rank > 0 ? `#${ranks.host_rank.rank} nasional` : ''} — ${ranks.host_rank.desc || detailNum(ranks.host_rank.score)} koin` : ''
        ].filter(Boolean);
        const topViewers = Array.isArray(ranks.top_viewers) ? ranks.top_viewers : [];

        html += `<section class="detail-card detail-login-card">
            <div class="detail-stats">
                ${detailStat(detailNum(loginRoom.likes), 'Likes sesi ini')}
                ${detailStat(detailNum(loginRoom.viewers), 'Penonton')}
                ${detailStat(detailNum(loginRoom.total_enter), 'Total masuk')}
                ${detailStat(detailNum(loginRoom.shares), 'Share')}
                ${detailStat(detailNum(anchor.followers), 'Followers anchor')}
                ${detailStat(detailNum(anchor.video_likes_total), 'Like video total')}
            </div>
            ${loginChips.length ? `<div class="detail-chips">${loginChips.map(chip => detailChip(chip, 'gold')).join('')}</div>` : ''}
            <div class="detail-kv-grid">
                ${detailKv('Komentar', detailNum(loginRoom.comments))}
                ${detailKv('Fan ticket', detailNum(loginRoom.fan_ticket))}
                ${detailKv('Fans club', detailNum(liveHistoryData?.fans_club_count))}
                ${detailKv('Room ID login', `<span class="detail-mono">${esc(login.room_id || room.room_id || '—')}</span>`)}
            </div>
            <div class="detail-stream-links">${detailLink('Buka FLV', login.flv)} ${detailLink('Buka HLS', login.hls)}</div>
        </section>`;

        if (topViewers.length) {
            html += `<section class="detail-card"><h3>❤️ Top Fan Room${ranks.viewers_total ? ` <span class="detail-muted">— ${detailNum(ranks.viewers_total)} penonton</span>` : ''}</h3><div class="detail-table-wrap"><table class="detail-table"><thead><tr><th>#</th><th>Nama</th><th>Kontribusi</th><th>Level</th></tr></thead><tbody>${topViewers.map(viewer => `<tr><td>${esc(viewer.rank ?? '—')}</td><td>${esc(viewer.nickname || '—')}</td><td>${esc(viewer.desc || detailNum(viewer.score))}</td><td>${viewer.level ? `Lv${esc(viewer.level)}` : '—'}</td></tr>`).join('')}</tbody></table></div></section>`;
        }
    } else {
        html += `<section class="detail-card detail-guest-note"><h3>🔓 Detail Login Session</h3><p>${esc(loginNote)}</p><small>Data guest tetap tersedia. Detail room, fan club, rank, dan top fan memerlukan sesi TikTok login pada service Python.</small></section>`;
    }

    html += `<details class="detail-raw"><summary>📄 Data lengkap service</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details></div>`;
    return html;
}

async function openTikTokDetailModal(id) {
    if (!state.user) return;
    const stream = state.streams.find(item => item.id === id);
    if (!stream || stream.platform !== 'tiktok' || !stream.is_live) {
        showToast('ℹ️', 'Detail hanya tersedia untuk TikTok yang sedang LIVE', true);
        return;
    }
    openTikTokDetailForStream(stream, `/api/streams/${id}/tiktok-detail`, id);
}

async function openTikTokDetailFromSearch(idx) {
    if (!state.user) return;
    const stream = state.searchResults?.[idx];
    if (!stream || stream.platform !== 'tiktok' || !stream.is_live) {
        showToast('ℹ️', 'Detail hanya tersedia untuk TikTok yang sedang LIVE', true);
        return;
    }
    const sourceKey = String(stream.source_key || '').replace(/^@/, '');
    openTikTokDetailForStream(
        stream,
        `/api/search/tiktok-detail?source_key=${encodeURIComponent(sourceKey)}`,
        `search:${sourceKey.toLowerCase()}`
    );
}

async function openTikTokDetailForStream(stream, endpoint, streamKey) {

    const modal = $('tiktokDetailModal');
    const body = $('tiktokDetailBody');
    const requestId = ++tiktokDetailState.requestId;
    tiktokDetailState.streamId = streamKey;
    $('tiktokDetailTitle').textContent = `🔎 ${stream.handle || stream.display_name || 'TikTok LIVE'}`;
    $('tiktokDetailSubtitle').textContent = stream.title || 'Detail room TikTok';
    body.innerHTML = '<div class="detail-loading"><div class="loading-spinner"></div><p>Mengambil detail TikTok…</p><small>Mencoba data login session terlebih dahulu.</small></div>';
    modal.classList.add('active');

    try {
        const data = await api(endpoint);
        if (requestId !== tiktokDetailState.requestId) return;
        $('tiktokDetailSubtitle').textContent = data.mode === 'login'
            ? 'Detail dari sesi login TikTok'
            : 'Detail guest (fallback karena sesi login tidak tersedia)';
        body.innerHTML = renderTikTokDetail(data, stream);
    } catch (err) {
        if (requestId !== tiktokDetailState.requestId) return;
        body.innerHTML = `<div class="detail-error"><div>⚠️</div><h3>Detail TikTok gagal dimuat</h3><p>${esc(err.message)}</p><small>Pastikan service Python aktif dan URL-nya benar di TIKTOK_DETAIL_SERVICE_URL.</small></div>`;
    }
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
    closeCommentsModal();
    closeTikTokDetailModal();
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

/** Bar filter dinamis: admin = filter + kategori; viewer = LIVE + kategori. */
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
    } else {
        chips.push(`<div class="filter-chip ${state.view === 'live' ? 'active' : ''}" data-view="live">🔴 Sedang Live</div>`);
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

/**
 * Huruf fallback aman-URI: alphanumerik pertama dari teks. Emoji/surrogate
 * yang terpotong tidak bisa dilewati encodeURIComponent (URIError: URI
 * malformed) — nama TikTok sering berawalan emoji, jadi saring dulu.
 */
const safeChar = (s) => (String(s || '').match(/[A-Za-z0-9]/) || ['?'])[0];

/**
 * URL gambar aman untuk <img>: CDN TikTok/YouTube menolak akses langsung
 * dari browser ("Access Denied") → dialirkan lewat proxy server sendiri.
 * `hint` = teks fallback (avatar huruf) bila URL CDN kedaluwarsa.
 */
const imgProxy = (u, hint) => (u
    ? '/api/img?u=' + encodeURIComponent(u) + (hint ? '&t=' + safeChar(hint) : '')
    : u);

/**
 * Sumber <img> untuk kartu:
 * - stream tersimpan (monitored): gambar LOKAL di server (/img/:id/:type) —
 *   diperbarui hanya saat simpan / 🔄 refresh manual, tidak pernah otomatis;
 *   ?v= berubah hanya saat file gambar berganti → browser langsung ambil yang baru
 * - hasil pencarian (belum tersimpan): proxy CDN sesuai snapshot
 */
const imgSrc = (item, type, hint, monitored) => (monitored && item.id
    ? `/img/${item.id}/${type}?v=${item.img_v || 0}&t=${safeChar(hint)}`
    : imgProxy(item[type === 'cover' ? 'cover_url' : 'avatar_url'], hint));

function placeholderHtml(item, key) {
    const pmeta = PLATFORM_META[item.platform] || { icon: '❓', name: item.platform };
    const live = !!item.is_live;
    const duration = live ? formatDuration(item.started_at) : '';
    const monitored = String(key).startsWith('s-');
    const name = item.display_name || item.handle || item.source_key || '';
    const cover = item.cover_url || monitored
        ? `<img class="cover-img" src="${esc(imgSrc(item, 'cover', name, monitored))}" alt="" loading="lazy" onerror="this.remove()">`
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
    const privateLive = item.platform === 'tiktok' && live && !!item.private_live;
    const key = monitored ? 's-' + item.id : 'r-' + item._idx;

    const searchSaved = !monitored && isSearchSaved(item);
    const searchTikTokLive = !monitored && Number.isInteger(item._idx) && item.platform === 'tiktok' && live;
    const detailAction = monitored && item.platform === 'tiktok' && live
        ? `<button class="icon-btn detail-btn" onclick="openTikTokDetailModal(${item.id})" title="Buka detail TikTok" aria-label="Buka detail TikTok">🔎</button>`
        : searchTikTokLive
            ? `<button class="icon-btn detail-btn" onclick="openTikTokDetailFromSearch(${item._idx})" title="Buka detail TikTok" aria-label="Buka detail TikTok">🔎</button>`
            : '';
    const commentAction = monitored && item.platform === 'tiktok' && live
        ? `<button class="icon-btn comment-btn" onclick="openCommentsModal(${item.id})" title="Buka komentar LIVE" aria-label="Buka komentar LIVE">💬</button>`
        : searchTikTokLive
            ? `<button class="icon-btn comment-btn" onclick="openCommentsFromSearch(${item._idx})" title="Buka komentar LIVE" aria-label="Buka komentar LIVE">💬</button>`
            : '';
    const actions = monitored
        ? (isAdmin()
            ? `
        <button class="icon-btn" onclick="refreshStreamNow(${item.id})" title="Cek ulang status sekarang">🔄</button>
        <button class="icon-btn" onclick="openCatAssign(${item.id})" title="Set kategori">🗂</button>
        <button class="icon-btn ${item.priority === 'high' ? 'flagged' : ''}"
                onclick="togglePriority(${item.id})" title="Toggle High Priority">${item.priority === 'high' ? '🚩' : '🏳'}</button>
        <button class="save-btn icon-btn ${item.saved ? 'saved' : ''}" onclick="toggleSave(${item.id})"
                title="${item.saved ? 'Hapus dari Saved' : 'Simpan ke Saved'}">${item.saved ? '📌' : '🔖'}</button>
        <button class="icon-btn" onclick="deleteStream(${item.id})" title="Hapus dari monitoring">🗑</button>
        ${detailAction}
        ${commentAction}`
            : `${detailAction}${commentAction}`)
        : (isAdmin()
            ? `${detailAction}${commentAction}<button class="save-btn icon-btn ${searchSaved ? 'saved' : ''}"
                onclick="${searchSaved ? `showToast('ℹ️', 'Stream ini sudah ada di Saved')` : `saveFromSearch(${item._idx})`}" 
                title="${searchSaved ? 'Sudah tersimpan di Saved' : 'Simpan ke Saved lalu pilih kategori'}"
                aria-label="${searchSaved ? 'Sudah tersimpan di Saved' : 'Simpan ke Saved'}">${searchSaved ? '📌' : '🔖'}</button>`
            : `${detailAction}${commentAction}`);

    const tags = [
        `<span class="tag">${pmeta.icon} ${pmeta.name}</span>`,
        item.category_name ? `<span class="tag label-tag">🏷 ${esc(item.category_name)}</span>` : '',
        item.label ? `<span class="tag label-tag">🗒 ${esc(item.label)}</span>` : '',
        isAdmin() && item.priority === 'high' ? '<span class="tag label-tag">🚩 High Priority</span>' : '',
        monitored && item.last_error ? `<span class="tag error-tag" title="${esc(item.last_error)}">⚠ cek gagal</span>` : ''
    ].filter(Boolean).join('');

    const avatar = item.avatar_url || monitored
        ? `<div class="avatar"><img src="${esc(imgSrc(item, 'avatar', name, monitored))}" alt="" loading="lazy"
              onerror="this.outerHTML='${initial}'"></div>`
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
                    ? `<div class="live-badge" title="${privateLive ? 'LIVE private — playback tidak tersedia' : 'LIVE'}"><div class="live-dot"></div>${privateLive ? '🔒 ' : ''}LIVE</div>`
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
    if (state.players.size === 0) {
        render();
        maybeAutoReload(); // versi app.js baru menunggu → aman reload sekarang
    }
}

/** Paksa cek ulang satu stream (admin) — untuk koreksi status manual. */
async function refreshStreamNow(id) {
    const btns = document.querySelectorAll(`#card-s-${id} .icon-btn[onclick^="refreshStreamNow"]`);
    btns.forEach(b => { b.textContent = '⏳'; b.disabled = true; });
    try {
        await api(`/api/streams/${id}/refresh`, { method: 'POST' });
        await loadStreams();
        render();
        const s = state.streams.find(x => x.id === id);
        showToast(s && s.is_live ? '🔴' : '⚪',
            s ? `${s.handle || s.source_key}: ${s.is_live ? 'LIVE' : 'offline'}` : 'Cek selesai');
    } catch (err) {
        showToast('❌', err.message, true);
        btns.forEach(b => { b.textContent = '🔄'; b.disabled = false; });
    }
}

function stopAllPlayers() {
    if (state.players.size === 0) return;
    for (const key of Array.from(state.players.keys())) destroyPlayerMedia(key);
    state.players.clear();
    render();
}

/**
 * Rantai kandidat playback untuk failover: setiap entri {flv, hls, label}.
 * Sumber: kolom playback_candidates (semua kualitas dari room) + URL utama
 * sebagai cadangan terakhir. Player mencoba berurutan saat satu URL mati.
 */
function buildCandidates(item) {
    const list = [];
    const seen = new Set();
    const push = (flv, hls, label) => {
        if (!flv && !hls) return;
        const k = flv || hls;
        if (seen.has(k)) return;
        seen.add(k);
        list.push({ flv, hls, label });
    };
    if (item.playback_candidates) {
        const arr = typeof item.playback_candidates === 'string'
            ? (() => { try { return JSON.parse(item.playback_candidates); } catch (_) { return null; } })()
            : item.playback_candidates;
        if (Array.isArray(arr)) arr.forEach(c => push(c.flv, c.hls, c.label));
    }
    push(item.playback_flv_url, item.playback_url, 'utama');
    return list;
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
        let kandidat = buildCandidates(item);
        if (!kandidat.length) {
            const monitored = state.streams.find(s =>
                s.platform === 'tiktok' && s.source_key === item.source_key && (s.playback_url || s.playback_flv_url));
            if (monitored) kandidat = buildCandidates(monitored);
        }
        if (kandidat.length) {
            state.players.set(key, {
                key, platform: 'tiktok', url: item.url,
                streamId: typeof item.id === 'number' ? item.id : null,
                candidates: kandidat, candIdx: 0, refreshedOnce: false
            });
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
            <small>mengambil status dan URL playback via HTTP ringan</small>
        </div>`;
    try {
        const info = await api('/api/resolve', { method: 'POST', body: JSON.stringify({ url: item.url }) });
        if (!info.is_live) throw new Error('Stream sudah selesai / offline');
        if (!info.playback_url && !info.playback_flv_url) {
            throw new Error('LIVE, tetapi URL playback tidak tersedia — kemungkinan live private');
        }
        item.playback_url = info.playback_url;
        item.playback_flv_url = info.playback_flv_url;
        if (!state.players.has(key) && document.getElementById('vc-' + key)) {
            state.players.set(key, {
                key,
                platform: 'tiktok',
                url: item.url,
                streamId: typeof item.id === 'number' ? item.id : null,
                candidates: buildCandidates(info),
                candIdx: 0,
                refreshedOnce: false
            });
            attachPlayer(state.players.get(key));
        }
    } catch (err) {
        if (document.getElementById('vc-' + key) && !state.players.has(key)) {
            container.innerHTML = placeholderHtml(item, key);
        }
        showToast('❌', 'Tidak bisa memutar: ' + err.message, true);
    }
}

/** Pindah ke kandidat berikutnya; bila habis → segarkan URL sekali lalu ulangi. */
async function failoverNext(p) {
    p.candIdx++;
    if (p.candidates && p.candIdx < p.candidates.length) {
        attachPlayer(p);
        return;
    }
    // Semua kandidat mati → ambil daftar URL baru dari server satu kali
    // (room mungkin restart / URL berganti) lalu coba lagi dari awal.
    if (!p.refreshedOnce) {
        p.refreshedOnce = true;
        try {
            if (isAdmin() && p.streamId) {
                await api(`/api/streams/${p.streamId}/refresh`, { method: 'POST' });
            }
            await loadStreams();
            const item = findItemByKey(p.key);
            const fresh = item ? buildCandidates(item) : [];
            if (fresh.length) {
                p.candidates = fresh;
                p.candIdx = 0;
                attachPlayer(p);
                return;
            }
        } catch (_) { /* biarkan jatuh ke fallback */ }
    }
    // Benar-benar habis
    const container = document.getElementById('vc-' + p.key);
    if (container) {
        destroyPlayerMedia(p.key);
        const div = document.createElement('div');
        div.className = 'player-fallback';
        div.innerHTML = `
            <div style="font-size:26px">📺</div>
            <div>Semua sumber stream gagal (${(p.candidates || []).length} kandidat dicoba).</div>
            <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"
               style="color:#00f2ea;font-size:13px;">Buka stream aslinya →</a>`;
        const closeBtn = container.querySelector('.player-close');
        container.innerHTML = '';
        if (closeBtn) container.appendChild(closeBtn);
        container.insertBefore(div, closeBtn);
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

    // Kandidat aktif (failover): kompatibel juga dengan player lama yang
    // hanya menyimpan hlsUrl/flvUrl tunggal.
    const cand = (p.candidates && p.candidates[p.candIdx]) || { flv: p.flvUrl, hls: p.hlsUrl, label: 'utama' };

    // ---- Jalur 1: FLV via mpegts.js (UTAMA — URL m3u8 TikTok sering 404;
    //      FLV lebih segar dan CORS CDN-nya terbuka) ----
    if (cand.flv && window.mpegts && window.mpegts.getFeatureList().mseLivePlayback) {
        const player = window.mpegts.createPlayer(
            { type: 'flv', url: cand.flv, isLive: true, cors: true },
            { enableStashBuffer: false, stashInitialSize: 128, liveBufferLatencyChasing: true }
        );
        flvMap.set(p.key, player);
        player.attachMediaElement(video);
        player.on(window.mpegts.Events.VIDEO_READY, tryPlay);
        player.on(window.mpegts.Events.ERROR, () => failoverNext(p));
        try { player.load(); } catch (e) {
            failoverNext(p);
            return;
        }
        tryPlay();
        return;
    }

    // ---- Jalur 2: HLS via hls.js (kandidat tanpa FLV / fallback) ----
    if (cand.hls && window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ liveDurationInfinity: true, enableWorker: true });
        hlsMap.set(p.key, hls);

        let recoverCount = 0;
        const MAX_RECOVER = 3;
        const recover = (data) => {
            if (recoverCount >= MAX_RECOVER) {
                failoverNext(p); // pulihkan beberapa kali tetap mati → ganti kandidat
                return;
            }
            recoverCount++;
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad();
            } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            } else {
                failoverNext(p);
            }
        };
        hls.on(window.Hls.Events.FRAG_BUFFERED, () => { recoverCount = 0; });

        hls.loadSource(cand.hls);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, tryPlay);
        hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data && data.fatal) recover(data);
        });
        tryPlay();
        return;
    }

    // ---- Jalur 3: HLS native (engine tanpa MSE, mis. iOS Safari lama) ----
    if (cand.hls && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = cand.hls;
        video.addEventListener('loadedmetadata', tryPlay, { once: true });
        video.addEventListener('error', () => failoverNext(p), { once: true });
        tryPlay();
        return;
    }

    // Kandidat ini tak bisa diputar di engine → lanjut kandidat berikutnya
    failoverNext(p);
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

    // Jangan menyimpan ulang item yang sudah ada di monitoring/Saved.
    if (isSearchSaved(item)) {
        showToast('ℹ️', 'Stream ini sudah ada di Saved');
        return;
    }

    // Selalu lewati dialog pilihan kategori. Jika belum ada kategori,
    // dialog tetap menyediakan pilihan "Tanpa Kategori (Saved)".
    openCatPick(idx);
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
        </div>
        ${state.categories.length === 0
            ? '<div class="form-hint" style="margin-top:10px;">Belum ada kategori. Stream akan disimpan ke Saved tanpa kategori.</div>'
            : ''}`;
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
    $('tiktokDetailModal').addEventListener('click', function (e) {
        if (e.target === this) closeTikTokDetailModal();
    });
    $('commentsModal').addEventListener('click', function (e) {
        if (e.target === this) closeCommentsModal();
    });
}

/* ------------------- Update aset otomatis ------------------- */

/**
 * Cek versi CSS/JS di server (diambil dari mtime file, tanpa restart).
 * - CSS berubah → <link> di-hot-swap langsung: tampilan baru diterapkan
 *   SEKETIKA tanpa reload (player yang sedang jalan tidak terganggu).
 * - JS berubah → reload otomatis, tapi ditunda sampai tidak ada player
 *   aktif supaya playback tidak diputus.
 */
async function checkAssetsVersion() {
    try {
        const v = await api('/api/assets-version');
        if (!state.assetV) { state.assetV = v; return; }

        if (v.css !== state.assetV.css) {
            state.assetV.css = v.css;
            const link = document.querySelector('link[href*="style.css"]');
            if (link) link.href = `style.css?v=${v.css}`;
            showToast('🎨', 'Tampilan diperbarui otomatis');
        }
        if (v.js !== state.assetV.js) {
            state.assetV.js = v.js;
            state.jsReloadPending = true;
            state.jsToastShown = false;
            maybeAutoReload();
        }
    } catch (_) { /* offline / 401 — coba lagi di interval berikutnya */ }
}

function maybeAutoReload() {
    if (!state.jsReloadPending) return;
    if (state.players.size === 0) {
        location.reload();
    } else if (!state.jsToastShown) {
        state.jsToastShown = true;
        showToast('🔄', 'Versi app baru — otomatis termuat setelah semua player ditutup');
    }
}

async function init() {
    bindEvents();

    // Auto-refresh data + durasi live
    setInterval(loadStreams, 25000);
    setInterval(() => {
        if (['saved', 'high', 'live', 'cat-all'].includes(state.view) || state.view.startsWith('cat-')) render();
    }, 10000);
    // Deteksi perubahan CSS/JS di server → terapkan otomatis
    checkAssetsVersion(); // baseline langsung, jangan tunggu interval pertama
    setInterval(checkAssetsVersion, 15000);
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
