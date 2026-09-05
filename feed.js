const STORAGE_KEY = 'instagram-getting-feed-accounts-v1';
const targetEl = document.querySelector('#feedTarget');
const addEl = document.querySelector('#feedAdd');
const refreshEl = document.querySelector('#feedRefresh');
const messageEl = document.querySelector('#feedMessage');
const statsEl = document.querySelector('#feedStats');
const accountsEl = document.querySelector('#accountPanel');
const filtersEl = document.querySelector('#feedFilters');
const statusEl = document.querySelector('#feedStatus');
const listEl = document.querySelector('#feedList');

let accounts = loadAccounts();
let accountStates = new Map();
let feedItems = [];
let activeFilter = 'all';
let refreshSeq = 0;

function loadAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? [...new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))] : [];
  } catch { return []; }
}
function saveAccounts() { localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts)); }
function setMessage(text = '') { messageEl.textContent = text; }
function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function normalizeUsername(value) {
  let input = String(value || '').trim();
  if (!input) throw new Error('Instagramユーザー名を入力してね。');
  if (input.startsWith('@')) input = input.slice(1);
  if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i.test(input)) {
    if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
    const url = new URL(input);
    input = url.pathname.split('/').filter(Boolean)[0] || '';
  }
  if (!/^[A-Za-z0-9._]+$/.test(input)) throw new Error('ユーザー名の形式を確認してね。');
  return input.toLowerCase();
}
function initials(username) { return String(username || '?').slice(0, 2).toUpperCase(); }
function profileUrl(username) { return `https://www.instagram.com/${encodeURIComponent(username)}/`; }

function normalizeMediaNode(node, fallbackType = 'image') {
  if (!node) return null;
  const isVideo = Boolean(node.isVideo || node.is_video || node.videoUrl || node.video_url);
  return {
    kind: isVideo ? 'video' : fallbackType,
    url: node.displayUrl || node.display_url || null,
    posterUrl: node.displayUrl || node.display_url || null,
    videoUrl: node.videoUrl || node.video_url || null,
    dimensions: node.dimensions || null
  };
}
function normalizeFeedItems(username, data) {
  if (Array.isArray(data.feedItems)) return data.feedItems;
  const rawItems = Array.isArray(data.graphqlMedia?.items) ? data.graphqlMedia.items : [];
  return rawItems.map((raw) => {
    const shortcode = raw.shortcode || null;
    const permalink = raw.urlCandidates?.post || (shortcode ? `https://www.instagram.com/p/${shortcode}/` : profileUrl(username));
    let media = [];
    if (raw.mediaType === 'carousel' && Array.isArray(raw.children) && raw.children.length) {
      media = raw.children.map((child) => normalizeMediaNode(child)).filter(Boolean);
    }
    if (!media.length) {
      const main = normalizeMediaNode(raw, raw.mediaType === 'video' ? 'video' : 'image');
      if (main) media = [main];
    }
    return {
      contractVersion: 1,
      source: 'instagram',
      sourceType: 'personal_profile_embed_graphql_media',
      id: `instagram:${username}:${shortcode || raw.id || raw.index}`,
      externalId: raw.id || null,
      shortcode,
      account: { username, profileUrl: profileUrl(username) },
      text: raw.caption || '',
      timestamp: raw.timestamp || null,
      timestampIso: raw.timestampIso || null,
      mediaType: raw.mediaType || 'image',
      media,
      posterUrl: raw.displayUrl || null,
      permalink,
      reelPermalink: raw.urlCandidates?.reel || null,
      diagnostics: {
        typename: raw.typename || null,
        extraction: data.graphqlMedia?.parseMethod || 'graphql_media',
        videoDirectAvailable: Boolean(raw.videoUrl),
        childCount: raw.childCount || 0
      }
    };
  });
}
async function fetchAccount(username) {
  const url = `/api/embed-frame?url=${encodeURIComponent(profileUrl(username))}&t=${Date.now()}`;
  const started = performance.now();
  const response = await fetch(url, { headers:{Accept:'application/json'}, cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  const items = normalizeFeedItems(username, data);
  return { username, items, ms:Math.round(performance.now()-started), diagnostics:{ status:data.status, graphqlCount:data.graphqlMedia?.count || 0, contractVersion:1 } };
}

function renderAccounts() {
  accountsEl.innerHTML = '';
  for (const username of accounts) {
    const state = accountStates.get(username) || { state:'idle', text:'待機' };
    const el = document.createElement('div');
    el.className = 'account-chip';
    el.dataset.state = state.state;
    el.innerHTML = `<div><strong>@${escapeHtml(username)}</strong><small>${escapeHtml(state.text)}</small></div><button type="button" aria-label="${escapeHtml(username)}を削除">×</button>`;
    el.querySelector('button').addEventListener('click', () => removeAccount(username));
    accountsEl.appendChild(el);
  }
}
function renderFilters() {
  const available = ['all', ...accounts];
  if (!available.includes(activeFilter)) activeFilter = 'all';
  filtersEl.innerHTML = '';
  for (const value of available) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-chip';
    b.dataset.filter = value;
    b.setAttribute('aria-pressed', String(activeFilter === value));
    b.textContent = value === 'all' ? 'すべて' : `@${value}`;
    b.addEventListener('click', () => { activeFilter = value; renderFilters(); renderFeed(); });
    filtersEl.appendChild(b);
  }
}
function formatTime(item) {
  const ms = item.timestamp ? Number(item.timestamp) * 1000 : Date.parse(item.timestampIso || '');
  if (!Number.isFinite(ms)) return '時刻不明';
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'たった今';
  if (abs < 3_600_000) return `${Math.max(1, Math.floor(abs/60_000))}分前`;
  if (abs < 86_400_000) return `${Math.max(1, Math.floor(abs/3_600_000))}時間前`;
  if (abs < 604_800_000) return `${Math.max(1, Math.floor(abs/86_400_000))}日前`;
  return new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
}
function absoluteTime(item) {
  const ms = item.timestamp ? Number(item.timestamp) * 1000 : Date.parse(item.timestampIso || '');
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)) : '';
}
function mediaHtml(media, item, index, total) {
  const poster = media.posterUrl || media.url || item.posterUrl || '';
  const videoUrl = media.videoUrl || '';
  const count = total > 1 ? `<span class="media-count">${index+1}/${total}</span>` : '';
  if (media.kind === 'video' && videoUrl) {
    return `<div class="media-slide">${count}<video controls playsinline preload="metadata" poster="${escapeHtml(poster)}" src="${escapeHtml(videoUrl)}"></video></div>`;
  }
  if (media.kind === 'video') {
    return `<div class="media-slide">${count}<a class="video-fallback" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" decoding="async" src="${escapeHtml(poster)}" alt="動画サムネイル"><span class="play-mark">▶</span></a></div>`;
  }
  return `<div class="media-slide">${count}<img loading="lazy" decoding="async" src="${escapeHtml(poster)}" alt="Instagram投稿画像"></div>`;
}
function cardHtml(item) {
  const media = Array.isArray(item.media) && item.media.length ? item.media : (item.posterUrl ? [{kind:'image',url:item.posterUrl,posterUrl:item.posterUrl}] : []);
  const mediaBlock = media.length ? `<div class="ig-media"><div class="media-strip">${media.map((m,i)=>mediaHtml(m,item,i,media.length)).join('')}</div></div>` : '';
  const caption = item.text || '';
  const shouldCollapse = caption.length > 150 || caption.split('\n').length > 4;
  return `<article class="ig-card" data-source-id="${escapeHtml(item.id)}">
    <header class="ig-head"><div class="ig-user"><div class="ig-avatar">${escapeHtml(initials(item.account?.username))}</div><div class="ig-user-text"><strong>@${escapeHtml(item.account?.username || '')}</strong><span>Instagram · ${escapeHtml(formatTime(item))}</span></div></div><a class="ig-open" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener noreferrer">Instagram ↗</a></header>
    ${mediaBlock}
    <div class="ig-body">${caption ? `<p class="ig-caption${shouldCollapse?' collapsed':''}">${escapeHtml(caption)}</p>${shouldCollapse?'<button class="caption-toggle" type="button">続きを読む</button>':''}` : ''}<div class="ig-meta"><span title="${escapeHtml(absoluteTime(item))}">${escapeHtml(formatTime(item))}</span><span class="ig-type">${escapeHtml(item.mediaType || 'post')}</span></div></div>
  </article>`;
}
function renderFeed() {
  const visible = feedItems.filter((item) => activeFilter === 'all' || item.account?.username === activeFilter);
  statsEl.textContent = `${accounts.length}アカウント / ${feedItems.length}投稿`;
  if (!accounts.length) {
    listEl.innerHTML = '<div class="feed-empty">Instagramアカウントを登録すると、各プロフィールの最新6件を独自カードで表示するよ。</div>';
    return;
  }
  if (!visible.length) {
    listEl.innerHTML = '<div class="feed-empty">表示できる投稿がまだありません。再取得してみて。</div>';
    return;
  }
  listEl.innerHTML = visible.map(cardHtml).join('');
  listEl.querySelectorAll('.caption-toggle').forEach((button) => button.addEventListener('click', () => {
    const p = button.previousElementSibling;
    const collapsed = p.classList.toggle('collapsed');
    button.textContent = collapsed ? '続きを読む' : '閉じる';
  }));
}

async function refreshFeed() {
  const seq = ++refreshSeq;
  setMessage('');
  refreshEl.disabled = true;
  if (!accounts.length) {
    feedItems=[];
    accountStates.clear();
    renderAccounts();
    renderFilters();
    renderFeed();
    statusEl.textContent='';
    refreshEl.disabled=false;
    return;
  }
  statusEl.textContent = `${accounts.length}アカウントを取得中…`;
  for (const username of accounts) accountStates.set(username,{state:'loading',text:'取得中'});
  renderAccounts();
  const results = await Promise.allSettled(accounts.map(fetchAccount));
  if (seq !== refreshSeq) return;
  const merged = [];
  results.forEach((result,index) => {
    const username = accounts[index];
    if (result.status === 'fulfilled') {
      merged.push(...result.value.items);
      accountStates.set(username,{state:'ok',text:`${result.value.items.length}件 · ${result.value.ms}ms`});
    } else {
      accountStates.set(username,{state:'error',text:'取得失敗'});
    }
  });
  const seen = new Set();
  feedItems = merged.filter((item)=>{
    const key=item.id || `${item.account?.username}:${item.shortcode}`;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b)=>(Number(b.timestamp)||0)-(Number(a.timestamp)||0));
  const ok = results.filter((r)=>r.status==='fulfilled').length;
  const ng = results.length-ok;
  statusEl.textContent = `${ok}/${accounts.length}アカウント取得成功 · ${feedItems.length}投稿${ng?` · ${ng}件失敗`:''}`;
  renderAccounts();
  renderFilters();
  renderFeed();
  refreshEl.disabled=false;
}
function addAccount() {
  setMessage('');
  try {
    const username = normalizeUsername(targetEl.value);
    if (accounts.includes(username)) throw new Error('そのアカウントは登録済み。');
    accounts.push(username);
    saveAccounts();
    targetEl.value='';
    renderAccounts();
    renderFilters();
    refreshFeed();
  } catch (e) { setMessage(e.message); }
}
function removeAccount(username) {
  accounts = accounts.filter((x)=>x!==username);
  saveAccounts();
  accountStates.delete(username);
  feedItems=feedItems.filter((x)=>x.account?.username!==username);
  renderAccounts();
  renderFilters();
  renderFeed();
  refreshFeed();
}

addEl.addEventListener('click', addAccount);
targetEl.addEventListener('keydown',(e)=>{if(e.key==='Enter')addAccount();});
refreshEl.addEventListener('click',refreshFeed);
renderAccounts();
renderFilters();
renderFeed();
refreshFeed();
