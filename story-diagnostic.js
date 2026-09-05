(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const usernameInput = $('storyUsername');
  const keyInput = $('storyKey');
  const runButton = $('runStoryDiagnostic');
  const copyButton = $('copyStoryDiagnostic');
  const status = $('storyStatus');
  const list = $('storyList');
  const raw = $('storyRawLog');
  const userId = $('storyUserId');
  const active = $('storyActive');
  const count = $('storyCount');
  const source = $('storySource');

  let latestPayload = null;

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.className = `story-status ${kind}`.trim();
  }

  function resetSummary() {
    userId.textContent = '—';
    active.textContent = '—';
    count.textContent = '—';
    source.textContent = '—';
    list.innerHTML = '<p>診断中です…</p>';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '不明';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(date);
  }

  function renderStories(stories) {
    if (!Array.isArray(stories) || stories.length === 0) {
      list.innerHTML = '<p>現在有効なStoryは0件でした。API通信自体が成功していれば、これは正常結果です。</p>';
      return;
    }

    list.innerHTML = stories.map((story) => {
      const media = story.type === 'video' && story.videoUrl
        ? `<video controls playsinline preload="metadata" poster="${escapeHtml(story.imageUrl || '')}" src="${escapeHtml(story.videoUrl)}"></video>`
        : story.imageUrl
          ? `<img loading="lazy" src="${escapeHtml(story.imageUrl)}" alt="Instagram Story ${story.index + 1}" />`
          : '<p style="padding:20px">表示可能なCDN URLがありません。</p>';

      return `
        <article class="story-card">
          <div class="story-media">${media}</div>
          <div class="story-meta">
            <strong>#${story.index + 1} ${escapeHtml(story.type)}</strong>
            <p>投稿: ${escapeHtml(formatDate(story.takenAt))}<br>期限: ${escapeHtml(formatDate(story.expiringAt))}</p>
            <code>${escapeHtml(story.id || 'IDなし')}</code>
          </div>
        </article>`;
    }).join('');
  }

  async function run() {
    const username = usernameInput.value.trim();
    const key = keyInput.value;

    if (!username) {
      setStatus('公開Instagramユーザー名を入力してください。', 'error');
      return;
    }
    if (!key) {
      setStatus('Story診断キーを入力してください。', 'error');
      return;
    }

    runButton.disabled = true;
    copyButton.disabled = true;
    latestPayload = null;
    resetSummary();
    raw.textContent = '通信中…';
    setStatus('Instagramセッションを使ってユーザーIDとStory一覧を確認中…');

    try {
      const response = await fetch(`/api/story-diagnostic?username=${encodeURIComponent(username)}`, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'X-Story-Diagnostic-Key': key
        }
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { ok: false, error: `JSONではない応答: ${text.slice(0, 300)}` };
      }

      latestPayload = payload;
      raw.textContent = JSON.stringify(payload, null, 2);
      copyButton.disabled = false;

      if (!response.ok || !payload.ok) {
        setStatus(payload.error || `HTTP ${response.status}`, 'error');
        list.innerHTML = '<p>Story一覧を表示できませんでした。下の通信診断ログで失敗段階を確認してください。</p>';
        return;
      }

      userId.textContent = payload.user?.id || '—';
      active.textContent = payload.activeStory ? 'あり' : 'なし';
      count.textContent = String(payload.storyCount ?? 0);
      source.textContent = payload.storySource || '—';
      renderStories(payload.stories);

      const resolveSource = payload.userResolveSource || '不明';
      setStatus(`取得成功。ID解決=${resolveSource} / Story取得=${payload.storySource} / ${payload.storyCount}件`, 'ok');
    } catch (error) {
      setStatus(`通信エラー: ${error.message}`, 'error');
      raw.textContent = String(error?.stack || error);
      list.innerHTML = '<p>APIへ接続できませんでした。</p>';
    } finally {
      runButton.disabled = false;
    }
  }

  async function copyJson() {
    if (!latestPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(latestPayload, null, 2));
      setStatus('診断JSONをコピーしました。', 'ok');
    } catch {
      setStatus('コピーできませんでした。ログ欄を長押ししてコピーしてください。', 'error');
    }
  }

  runButton.addEventListener('click', run);
  copyButton.addEventListener('click', copyJson);
  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });
  keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });
})();
