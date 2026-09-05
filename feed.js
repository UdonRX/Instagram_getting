const STORAGE_KEY = 'instagram-getting-feed-accounts-v1';
const STORY_API_LIMIT = 12;
const targetEl = document.querySelector('#feedTarget');
const addEl = document.querySelector('#feedAdd');
const refreshEl = document.querySelector('#feedRefresh');
const messageEl = document.querySelector('#feedMessage');
const statsEl = document.querySelector('#feedStats');
const accountsEl = document.querySelector('#accountPanel');
const filtersEl = document.querySelector('#feedFilters');
const statusEl = document.querySelector('#feedStatus');
const listEl = document.querySelector('#feedList');
const storyTrayEl = document.querySelector('#storyTray');
const storyTrayStatusEl = document.querySelector('#storyTrayStatus');
const storyKeyEl = document.querySelector('#storyKey');
const storyRefreshEl = document.querySelector('#storyRefresh');
const storyViewerEl = document.querySelector('#storyViewer');
const storyProgressEl = document.querySelector('#storyProgress');
const storyViewerAvatarEl = document.querySelector('#storyViewerAvatar');
const storyViewerUsernameEl = document.querySelector('#storyViewerUsername');
const storyViewerTimeEl = document.querySelector('#storyViewerTime');
const storyViewerMediaEl = document.querySelector('#storyViewerMedia');
const storyViewerCloseEl = document.querySelector('#storyViewerClose');
const storyPrevEl = document.querySelector('#storyPrev');
const storyNextEl = document.querySelector('#storyNext');
const storyOpenInstagramEl = document.querySelector('#storyOpenInstagram');

let accounts = loadAccounts();
let accountStates = new Map();
let feedItems = [];
let activeFilter = 'all';
let refreshSeq = 0;
let storyRefreshSeq = 0;
let storyAccounts = new Map();
let storyLastPayload = null;
let viewerState = { activeAccounts: [], accountIndex: 0, storyIndex: 0, timer: null, video: null };
let viewerRenderSeq = 0;

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

function storyFaceHtml(username, state) {
  const pic = state?.profile?.profilePicUrl;
  return pic ? `<img src="${escapeHtml(pic)}" alt="@${escapeHtml(username)}">` : escapeHtml(initials(username));
}
function renderStoryTray() {
  storyTrayEl.innerHTML = '';
  if (!accounts.length) {
    storyTrayEl.innerHTML = '<span class="story-tray-status">アカウントを登録するとここにStoryが並びます。</span>';
    storyTrayStatusEl.textContent = 'アカウント未登録';
    return;
  }
  for (const username of accounts) {
    const state = storyAccounts.get(username);
    const kind = !state ? 'idle' : state.status !== 'ok' ? 'error' : state.activeStory ? 'active' : 'inactive';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'story-bubble';
    button.dataset.state = kind;
    button.disabled = kind !== 'active';
    button.title = kind === 'active' ? `@${username} · ${state.storyCount}件` : kind === 'error' ? `${state.error || 'Story取得失敗'}` : `@${username} · Storyなし/未取得`;
    button.innerHTML = `<span class="story-ring"><span class="story-face">${storyFaceHtml(username,state)}</span></span>${kind==='active'?`<span class="story-count-badge">${state.storyCount}</span>`:''}<span class="story-label">${escapeHtml(username)}</span>`;
    if (kind === 'active') button.addEventListener('click', () => openStoryViewer(username));
    storyTrayEl.appendChild(button);
  }
}
async function refreshStories() {
  const key = storyKeyEl.value;
  if (!accounts.length) {
    storyTrayStatusEl.textContent = 'アカウント未登録';
    renderStoryTray();
    return;
  }
  if (!key) {
    storyTrayStatusEl.textContent = '診断キーを入力してね';
    storyKeyEl.focus();
    return;
  }
  const seq = ++storyRefreshSeq;
  const targets = accounts.slice(0, STORY_API_LIMIT);
  storyRefreshEl.disabled = true;
  storyTrayStatusEl.textContent = `${targets.length}件を取得中…`;
  try {
    const response = await fetch(`/api/stories-batch?usernames=${encodeURIComponent(targets.join(','))}&t=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-Story-Diagnostic-Key': key }
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { ok:false, error:`JSONではない応答: ${text.slice(0,200)}` }; }
    if (seq !== storyRefreshSeq) return;
    storyLastPayload = payload;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    for (const item of payload.accounts || []) storyAccounts.set(item.username, item);
    const extra = accounts.length > STORY_API_LIMIT ? ` · 先頭${STORY_API_LIMIT}件` : '';
    const failed = payload.failedAccountCount ? ` · ${payload.failedAccountCount}件失敗` : '';
    storyTrayStatusEl.textContent = `${payload.activeAccountCount}/${payload.accountCount} Storyあり${failed}${extra}`;
    renderStoryTray();
  } catch (error) {
    storyTrayStatusEl.textContent = `Story取得失敗: ${error.message}`;
    console.warn('[Instagram Story batch]', error, storyLastPayload);
  } finally {
    if (seq === storyRefreshSeq) storyRefreshEl.disabled = false;
  }
}

function activeStoryAccounts() {
  return accounts.map((username) => storyAccounts.get(username)).filter((entry) => entry?.status === 'ok' && entry.activeStory && Array.isArray(entry.stories) && entry.stories.length);
}
function clearViewerPlayback() {
  viewerRenderSeq += 1;
  if (viewerState.timer) clearTimeout(viewerState.timer);
  viewerState.timer = null;
  if (viewerState.video) {
    try { viewerState.video.pause(); } catch {}
    viewerState.video = null;
  }
}
function storyDisplayTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.floor(minutes/60)}時間前`;
  return new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
}
function setViewerAvatar(account) {
  const pic = account?.profile?.profilePicUrl;
  storyViewerAvatarEl.innerHTML = pic ? `<img src="${escapeHtml(pic)}" alt="">` : escapeHtml(initials(account?.username));
}
function renderProgress(total, current) {
  storyProgressEl.innerHTML = Array.from({length:total}, (_,index) => `<span class="story-progress-segment"><span class="story-progress-fill" data-index="${index}" style="width:${index<current?'100':'0'}%"></span></span>`).join('');
  return storyProgressEl.querySelector(`.story-progress-fill[data-index="${current}"]`);
}
function currentViewerEntry() {
  const account = viewerState.activeAccounts[viewerState.accountIndex];
  const story = account?.stories?.[viewerState.storyIndex];
  return { account, story };
}
function renderStoryViewer() {
  clearViewerPlayback();
  const renderSeq = viewerRenderSeq;
  const { account, story } = currentViewerEntry();
  if (!account || !story) return closeStoryViewer();

  storyViewerEl.hidden = false;
  storyViewerEl.setAttribute('aria-hidden','false');
  document.body.classList.add('story-viewer-open');
  storyViewerUsernameEl.textContent = `@${account.username}`;
  storyViewerTimeEl.textContent = storyDisplayTime(story.takenAt);
  setViewerAvatar(account);
  const currentFill = renderProgress(account.stories.length, viewerState.storyIndex);
  storyOpenInstagramEl.href = story.id ? `https://www.instagram.com/stories/${encodeURIComponent(account.username)}/${encodeURIComponent(story.id)}/` : profileUrl(account.username);
  storyViewerMediaEl.innerHTML = '';

  if (story.type === 'video' && story.videoUrl) {
    const video = document.createElement('video');
    video.src = story.videoUrl;
    video.poster = story.imageUrl || '';
    video.playsInline = true;
    video.preload = 'auto';
    video.autoplay = true;
    video.muted = false;
    video.addEventListener('timeupdate', () => {
      if (renderSeq !== viewerRenderSeq) return;
      if (!currentFill || !Number.isFinite(video.duration) || video.duration <= 0) return;
      currentFill.style.width = `${Math.min(100, (video.currentTime/video.duration)*100)}%`;
    });
    video.addEventListener('ended', () => { if (renderSeq === viewerRenderSeq) nextStory(); });
    video.addEventListener('error', () => {
      if (renderSeq !== viewerRenderSeq) return;
      storyViewerMediaEl.innerHTML = '<div class="story-viewer-error">動画を読み込めませんでした。Storyを再取得するか、下の「Instagramで開く」を使ってください。</div>';
    }, { once:true });
    storyViewerMediaEl.appendChild(video);
    viewerState.video = video;
    video.play().catch(() => { video.controls = true; });
    return;
  }

  if (story.imageUrl) {
    const image = document.createElement('img');
    image.src = story.imageUrl;
    image.alt = `@${account.username} Story`;
    image.addEventListener('load', () => {
      if (renderSeq !== viewerRenderSeq) return;
      if (currentFill) {
        currentFill.style.transition = 'width 5s linear';
        requestAnimationFrame(() => { currentFill.style.width = '100%'; });
      }
      viewerState.timer = setTimeout(nextStory, 5000);
    }, { once:true });
    image.addEventListener('error', () => {
      if (renderSeq !== viewerRenderSeq) return;
      storyViewerMediaEl.innerHTML = '<div class="story-viewer-error">画像を読み込めませんでした。Storyを再取得するか、下の「Instagramで開く」を使ってください。</div>';
    }, { once:true });
    storyViewerMediaEl.appendChild(image);
    return;
  }

  storyViewerMediaEl.innerHTML = '<div class="story-viewer-error">表示できるStoryメディアURLがありません。</div>';
}
function openStoryViewer(username) {
  const active = activeStoryAccounts();
  const accountIndex = active.findIndex((entry) => entry.username === username);
  if (accountIndex < 0) return;
  viewerState.activeAccounts = active;
  viewerState.accountIndex = accountIndex;
  viewerState.storyIndex = 0;
  renderStoryViewer();
}
function nextStory() {
  const { account } = currentViewerEntry();
  if (!account) return closeStoryViewer();
  if (viewerState.storyIndex + 1 < account.stories.length) {
    viewerState.storyIndex += 1;
  } else if (viewerState.accountIndex + 1 < viewerState.activeAccounts.length) {
    viewerState.accountIndex += 1;
    viewerState.storyIndex = 0;
  } else {
    return closeStoryViewer();
  }
  renderStoryViewer();
}
function prevStory() {
  if (viewerState.storyIndex > 0) {
    viewerState.storyIndex -= 1;
  } else if (viewerState.accountIndex > 0) {
    viewerState.accountIndex -= 1;
    const previousAccount = viewerState.activeAccounts[viewerState.accountIndex];
    viewerState.storyIndex = Math.max(0, previousAccount.stories.length - 1);
  } else {
    viewerState.storyIndex = 0;
  }
  renderStoryViewer();
}
function closeStoryViewer() {
  clearViewerPlayback();
  storyViewerEl.hidden = true;
  storyViewerEl.setAttribute('aria-hidden','true');
  document.body.classList.remove('story-viewer-open');
  storyViewerMediaEl.innerHTML = '';
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
    renderStoryTray();
    refreshFeed();
  } catch (e) { setMessage(e.message); }
}
function removeAccount(username) {
  accounts = accounts.filter((x)=>x!==username);
  saveAccounts();
  accountStates.delete(username);
  storyAccounts.delete(username);
  feedItems=feedItems.filter((x)=>x.account?.username!==username);
  renderAccounts();
  renderFilters();
  renderStoryTray();
  renderFeed();
  refreshFeed();
}

addEl.addEventListener('click', addAccount);
targetEl.addEventListener('keydown',(e)=>{if(e.key==='Enter')addAccount();});
refreshEl.addEventListener('click',refreshFeed);
storyRefreshEl.addEventListener('click',refreshStories);
storyKeyEl.addEventListener('keydown',(e)=>{if(e.key==='Enter')refreshStories();});
storyViewerCloseEl.addEventListener('click',closeStoryViewer);
storyPrevEl.addEventListener('click',prevStory);
storyNextEl.addEventListener('click',nextStory);
storyViewerEl.addEventListener('click',(event)=>{if(event.target===storyViewerEl)closeStoryViewer();});
document.addEventListener('keydown',(event)=>{
  if (storyViewerEl.hidden) return;
  if (event.key === 'Escape') closeStoryViewer();
  else if (event.key === 'ArrowLeft') prevStory();
  else if (event.key === 'ArrowRight') nextStory();
});

renderAccounts();
renderFilters();
renderStoryTray();
renderFeed();
refreshFeed();
