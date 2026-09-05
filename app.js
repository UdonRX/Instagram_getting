const STORAGE_KEY = 'instagram-getting-targets-v1';

const targetInput = document.querySelector('#target');
const addButton = document.querySelector('#addButton');
const cardsEl = document.querySelector('#cards');
const countLabel = document.querySelector('#countLabel');
const clearButton = document.querySelector('#clearButton');
const refreshAllButton = document.querySelector('#refreshAllButton');
const globalMessage = document.querySelector('#globalMessage');

let targets = loadTargets();
let instagramScriptPromise = null;

function loadTargets() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveTargets() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(targets));
}

function normalizeClientInput(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('ユーザー名かInstagram URLを入力してね。');

  if (/^@[A-Za-z0-9._]+$/.test(input)) {
    return `https://www.instagram.com/${input.slice(1)}/`;
  }

  if (/^[A-Za-z0-9._]+$/.test(input)) {
    return `https://www.instagram.com/${input}/`;
  }

  let urlText = input;
  if (/^(www\.)?instagram\.com\//i.test(urlText)) urlText = `https://${urlText}`;
  const url = new URL(urlText);
  if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) {
    throw new Error('instagram.com のURLだけ登録できるよ。');
  }
  url.protocol = 'https:';
  url.hostname = 'www.instagram.com';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function labelForUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts[0] === 'p') return `投稿 / ${parts[1] || ''}`;
    if (parts[0] === 'reel') return `Reel / ${parts[1] || ''}`;
    return `@${parts[0] || 'profile'}`;
  } catch {
    return url;
  }
}

function typeLabel(type) {
  if (type === 'profile') return 'PROFILE';
  if (type === 'reel') return 'REEL';
  return 'POST';
}

function setMessage(message = '') {
  globalMessage.textContent = message;
}

function ensureInstagramScript() {
  if (window.instgrm?.Embeds) return Promise.resolve();
  if (instagramScriptPromise) return instagramScriptPromise;

  instagramScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-instagram-embed]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://www.instagram.com/embed.js';
    script.async = true;
    script.defer = true;
    script.dataset.instagramEmbed = 'true';
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });

  return instagramScriptPromise;
}

async function fetchEmbed(url) {
  const response = await fetch(`/api/embed?url=${encodeURIComponent(url)}&t=${Date.now()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error || data?.message || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

function renderSkeleton(card) {
  card.querySelector('.embed-wrap').innerHTML = '<div class="loading">Meta公式oEmbedから取得中…</div>';
  card.querySelector('[data-diag="type"]').textContent = '—';
  card.querySelector('[data-diag="status"]').textContent = '取得中';
  card.querySelector('[data-diag="time"]').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

async function hydrateCard(card, target) {
  renderSkeleton(card);
  try {
    const data = await fetchEmbed(target.url);
    const embedWrap = card.querySelector('.embed-wrap');
    embedWrap.innerHTML = data.html;
    card.querySelector('[data-diag="type"]').textContent = typeLabel(data.type);
    card.querySelector('[data-diag="status"]').textContent = `OK ${data.upstreamStatus}`;
    card.querySelector('[data-diag="time"]').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    await ensureInstagramScript();
    if (window.instgrm?.Embeds?.process) window.instgrm.Embeds.process();
  } catch (error) {
    card.querySelector('.embed-wrap').innerHTML = `<div class="embed-error"><p>${escapeHtml(error.message)}<br><small>非公開・Embed無効・Meta側未対応などの可能性あり。</small></p></div>`;
    card.querySelector('[data-diag="status"]').textContent = 'NG';
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function render() {
  countLabel.textContent = `${targets.length}件`;
  clearButton.disabled = targets.length === 0;
  refreshAllButton.disabled = targets.length === 0;
  cardsEl.innerHTML = '';

  if (!targets.length) {
    cardsEl.innerHTML = '<div class="empty">まだ登録なし。<br>@username を入れて、PersonalアカウントのProfile Embedが実際に表示できるか試してみて。</div>';
    return;
  }

  for (const target of targets) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = target.id;
    card.innerHTML = `
      <div class="card-head">
        <div class="card-title">
          <strong>${escapeHtml(labelForUrl(target.url))}</strong>
          <span>${escapeHtml(target.url)}</span>
        </div>
        <div class="card-actions">
          <button type="button" data-action="open">Instagram</button>
          <button type="button" data-action="refresh">再取得</button>
          <button type="button" class="remove" data-action="remove">削除</button>
        </div>
      </div>
      <div class="embed-wrap"></div>
      <div class="diag">
        <div><span>種類</span><strong data-diag="type">—</strong></div>
        <div><span>oEmbed</span><strong data-diag="status">—</strong></div>
        <div><span>更新</span><strong data-diag="time">—</strong></div>
      </div>
    `;

    card.addEventListener('click', async (event) => {
      const action = event.target.closest('button')?.dataset.action;
      if (!action) return;
      if (action === 'open') window.open(target.url, '_blank', 'noopener,noreferrer');
      if (action === 'refresh') hydrateCard(card, target);
      if (action === 'remove') {
        targets = targets.filter((item) => item.id !== target.id);
        saveTargets();
        render();
      }
    });

    cardsEl.appendChild(card);
    hydrateCard(card, target);
  }
}

async function addTarget() {
  setMessage('');
  try {
    const url = normalizeClientInput(targetInput.value);
    if (targets.some((target) => target.url === url)) throw new Error('そのURLはすでに登録済み。');
    targets.unshift({ id: crypto.randomUUID(), url, addedAt: Date.now() });
    saveTargets();
    targetInput.value = '';
    render();
  } catch (error) {
    setMessage(error.message);
  }
}

addButton.addEventListener('click', addTarget);
targetInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addTarget();
});

clearButton.addEventListener('click', () => {
  targets = [];
  saveTargets();
  render();
});

refreshAllButton.addEventListener('click', () => {
  document.querySelectorAll('.card').forEach((card) => {
    const target = targets.find((item) => item.id === card.dataset.id);
    if (target) hydrateCard(card, target);
  });
});

render();
