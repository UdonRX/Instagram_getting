const targetInput = document.querySelector('#diagTarget');
const startButton = document.querySelector('#startDiagnostic');
const copyButton = document.querySelector('#copyDiagnostic');
const messageEl = document.querySelector('#diagMessage');
const embedEl = document.querySelector('#diagnosticEmbed');
const activeTargetEl = document.querySelector('#activeTarget');
const conclusionEl = document.querySelector('#diagnosticConclusion');
const explanationEl = document.querySelector('#diagnosticExplanation');
const rawLogEl = document.querySelector('#rawDiagnosticLog');
const oembedDetailEl = document.querySelector('#oembedDetail');
const iframeDetailEl = document.querySelector('#iframeDetail');
const resourceDetailEl = document.querySelector('#resourceDetail');
const messageDetailEl = document.querySelector('#messageDetail');
const metricOembedLinks = document.querySelector('#metricOembedLinks');
const metricIframes = document.querySelector('#metricIframes');
const metricResources = document.querySelector('#metricResources');
const metricMessages = document.querySelector('#metricMessages');

const INSTAGRAM_HOST_RE = /(^|\.)instagram\.com$/i;
const META_HOST_RE = /(^|\.)(facebook\.com|fbcdn\.net|cdninstagram\.com)$/i;
const POST_LINK_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+\/?/gi;

let runId = 0;
let instagramScriptPromise = null;
let latestReport = null;
let activeCapture = null;

const globalObserved = {
  resources: [],
  fetches: [],
  xhr: [],
  messages: [],
  iframes: []
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeProfileInput(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Instagramユーザー名を入力してください。');

  let candidate = input;
  if (/^@[A-Za-z0-9._]+$/.test(candidate)) candidate = `https://www.instagram.com/${candidate.slice(1)}/`;
  else if (/^[A-Za-z0-9._]+$/.test(candidate)) candidate = `https://www.instagram.com/${candidate}/`;
  else if (/^(www\.)?instagram\.com\//i.test(candidate)) candidate = `https://${candidate}`;

  const url = new URL(candidate);
  if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) {
    throw new Error('instagram.com のプロフィールだけ指定できます。');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || ['p', 'reel', 'stories', 'explore', 'accounts'].includes(parts[0].toLowerCase())) {
    throw new Error('この診断はプロフィールURLだけが対象です。');
  }
  url.protocol = 'https:';
  url.hostname = 'www.instagram.com';
  url.search = '';
  url.hash = '';
  url.pathname = `/${parts[0]}/`;
  return url.toString();
}

function safeUrl(value) {
  try {
    const url = new URL(String(value), location.href);
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function isInterestingUrl(value) {
  try {
    const url = new URL(String(value), location.href);
    return INSTAGRAM_HOST_RE.test(url.hostname) || META_HOST_RE.test(url.hostname) || url.pathname.startsWith('/api/embed');
  } catch {
    return false;
  }
}

function extractPostLinks(value) {
  const matches = String(value || '').match(POST_LINK_RE) || [];
  return [...new Set(matches.map((item) => item.replace(/\?.*$/, '')))].slice(0, 50);
}

function summarizeMessageData(data) {
  if (data == null) return null;
  if (typeof data === 'string') return data.slice(0, 3000);
  try {
    return JSON.parse(JSON.stringify(data, (_key, value) => {
      if (typeof value === 'string' && value.length > 1500) return `${value.slice(0, 1500)}…`;
      return value;
    }));
  } catch {
    return String(data).slice(0, 3000);
  }
}

function logObserved(kind, payload) {
  const entry = { at: nowIso(), kind, ...payload };
  if (globalObserved[kind]) globalObserved[kind].push(entry);
  if (activeCapture) activeCapture.events.push(entry);
  return entry;
}

function installObservers() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = args[0];
    const url = safeUrl(typeof request === 'string' ? request : request?.url);
    const method = args[1]?.method || request?.method || 'GET';
    const started = performance.now();
    try {
      const response = await originalFetch(...args);
      if (isInterestingUrl(url)) {
        logObserved('fetches', {
          url,
          method,
          status: response.status,
          durationMs: Math.round(performance.now() - started)
        });
      }
      return response;
    } catch (error) {
      if (isInterestingUrl(url)) {
        logObserved('fetches', {
          url,
          method,
          status: 'ERROR',
          error: error.message,
          durationMs: Math.round(performance.now() - started)
        });
      }
      throw error;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__igDiag = { method, url: safeUrl(url), started: 0 };
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this.__igDiag) {
      this.__igDiag.started = performance.now();
      this.addEventListener('loadend', () => {
        if (isInterestingUrl(this.__igDiag.url)) {
          logObserved('xhr', {
            url: this.__igDiag.url,
            method: this.__igDiag.method,
            status: this.status,
            durationMs: Math.round(performance.now() - this.__igDiag.started)
          });
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };

  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!isInterestingUrl(entry.name)) continue;
          logObserved('resources', {
            url: entry.name,
            initiatorType: entry.initiatorType,
            durationMs: Math.round(entry.duration),
            transferSize: Number(entry.transferSize || 0)
          });
        }
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Safari versions without buffered resource observer are handled by final snapshot.
    }
  }

  window.addEventListener('message', (event) => {
    let hostname = '';
    try { hostname = new URL(event.origin).hostname; } catch {}
    if (!INSTAGRAM_HOST_RE.test(hostname) && !META_HOST_RE.test(hostname)) return;
    const data = summarizeMessageData(event.data);
    logObserved('messages', {
      origin: event.origin,
      data,
      discoveredPostLinks: extractPostLinks(typeof data === 'string' ? data : JSON.stringify(data || {}))
    });
  });
}

function setStep(name, state, text) {
  const step = document.querySelector(`[data-step="${name}"]`);
  if (!step) return;
  step.dataset.state = state;
  step.querySelector('small').textContent = text;
}

function resetUi() {
  messageEl.textContent = '';
  embedEl.innerHTML = '<div class="loading">Meta公式oEmbedを取得中…</div>';
  oembedDetailEl.textContent = '取得中…';
  iframeDetailEl.textContent = '待機中…';
  resourceDetailEl.textContent = '待機中…';
  messageDetailEl.textContent = '待機中…';
  rawLogEl.textContent = '収集中…';
  conclusionEl.textContent = '診断中…';
  explanationEl.textContent = 'Profile Embedを描画し、約10秒間通信を観測しています。';
  metricOembedLinks.textContent = '—';
  metricIframes.textContent = '—';
  metricResources.textContent = '—';
  metricMessages.textContent = '—';
  copyButton.disabled = true;
  setStep('oembed', 'running', '取得中');
  setStep('iframe', '', '待機');
  setStep('network', '', '待機');
  setStep('conclusion', '', '待機');
}

async function ensureInstagramScript() {
  if (window.instgrm?.Embeds) return;
  if (instagramScriptPromise) return instagramScriptPromise;
  instagramScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.instagram.com/embed.js';
    script.async = true;
    script.defer = true;
    script.dataset.instagramEmbed = 'true';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Instagram embed.js の読み込みに失敗しました。'));
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
  if (!response.ok) throw new Error(data?.error || `oEmbed HTTP ${response.status}`);
  return data;
}

function startIframeObserver(capture) {
  const seen = new Set();
  const inspect = () => {
    for (const iframe of embedEl.querySelectorAll('iframe')) {
      const src = iframe.getAttribute('src') || iframe.src || '(srcなし)';
      if (seen.has(src)) continue;
      seen.add(src);
      const entry = logObserved('iframes', {
        src,
        title: iframe.getAttribute('title') || null,
        width: iframe.getAttribute('width') || null,
        height: iframe.getAttribute('height') || null
      });
      capture.iframes.push(entry);
      iframe.addEventListener('load', () => {
        logObserved('iframes', { src, event: 'load' });
      }, { once: true });
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(embedEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  inspect();
  return () => {
    inspect();
    observer.disconnect();
  };
}

function snapshotResources(startedAtPerf) {
  const items = performance.getEntriesByType('resource')
    .filter((entry) => entry.startTime >= startedAtPerf - 50 && isInterestingUrl(entry.name))
    .map((entry) => ({
      at: nowIso(),
      kind: 'resources',
      url: entry.name,
      initiatorType: entry.initiatorType,
      durationMs: Math.round(entry.duration),
      transferSize: Number(entry.transferSize || 0)
    }));
  return items;
}

function formatList(items, formatter) {
  if (!items.length) return '<p class="diag-none">該当データなし</p>';
  return `<ol class="diag-list">${items.map((item) => `<li>${formatter(item)}</li>`).join('')}</ol>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function analyze(report) {
  const htmlLinks = report.oembed.htmlPostLinks;
  const messageLinks = [...new Set(report.messages.flatMap((item) => item.discoveredPostLinks || []))];
  const resourceLinks = [...new Set(report.resources.flatMap((item) => extractPostLinks(item.url)))];
  const iframeLinks = [...new Set(report.iframes.flatMap((item) => extractPostLinks(item.src)))];

  if (htmlLinks.length) {
    return {
      code: 'OEMBED_CONTAINS_POSTS',
      title: '個別投稿URLはoEmbed初期レスポンスに含まれています',
      explanation: `Profile oEmbed HTML内で ${htmlLinks.length} 件の /p/ または /reel/ URLを確認。次はこのURLを個別oEmbedへ渡せるか試せます。`,
      candidateLinks: htmlLinks
    };
  }
  if (messageLinks.length) {
    return {
      code: 'POSTMESSAGE_CONTAINS_POSTS',
      title: '個別投稿URLはiframeのpostMessage経由で観測できました',
      explanation: `Instagram iframeから親ページへ送られたmessage内で ${messageLinks.length} 件の個別投稿URLを確認。messageの用途と安定性を追加確認する価値があります。`,
      candidateLinks: messageLinks
    };
  }
  if (resourceLinks.length || iframeLinks.length) {
    const links = [...new Set([...resourceLinks, ...iframeLinks])];
    return {
      code: 'RESOURCE_CONTAINS_POSTS',
      title: '個別投稿URLはブラウザから観測可能なResource/iframe URLに現れました',
      explanation: `${links.length} 件の個別投稿URLを観測。どのリクエストが6投稿一覧を供給しているか、ログからさらに絞り込めます。`,
      candidateLinks: links
    };
  }
  if (report.iframes.length) {
    return {
      code: 'CROSS_ORIGIN_IFRAME_INTERNAL',
      title: '6投稿の生成元はInstagramのクロスオリジンiframe内部にある可能性が高い',
      explanation: 'oEmbed初期HTML、親ページのfetch/XHR/Resource、postMessageのいずれにも個別 /p/ /reel/ URLは現れませんでした。一方でInstagram iframeは生成されています。通常のページJavaScriptからiframe内部のサブリクエストはSame-Origin制約で完全には観測できないため、正確な内部エンドポイント特定にはブラウザレベルのNetworkトレースが必要です。',
      candidateLinks: []
    };
  }
  return {
    code: 'NO_IFRAME',
    title: 'Profile Embedのiframe生成まで確認できませんでした',
    explanation: 'embed.jsの読み込み失敗、描画待ち不足、Instagram側の一時エラーなどが考えられます。再診断してください。',
    candidateLinks: []
  };
}

function renderReport(report) {
  const result = analyze(report);
  report.analysis = result;
  latestReport = report;

  conclusionEl.textContent = result.title;
  explanationEl.textContent = result.explanation;
  metricOembedLinks.textContent = `${report.oembed.htmlPostLinks.length}件`;
  metricIframes.textContent = `${report.iframes.length}件`;
  metricResources.textContent = `${report.resources.length}件`;
  metricMessages.textContent = `${report.messages.length}件`;

  oembedDetailEl.innerHTML = `
    <dl class="diag-kv">
      <div><dt>HTTP</dt><dd>${escapeHtml(report.oembed.status)}</dd></div>
      <div><dt>payload keys</dt><dd>${escapeHtml(report.oembed.payloadKeys.join(', ') || '不明')}</dd></div>
      <div><dt>HTML length</dt><dd>${report.oembed.htmlLength}</dd></div>
      <div><dt>個別投稿URL</dt><dd>${report.oembed.htmlPostLinks.length}</dd></div>
    </dl>
    ${formatList(report.oembed.htmlPostLinks, (item) => `<code>${escapeHtml(item)}</code>`)}
  `;

  iframeDetailEl.innerHTML = formatList(report.iframes, (item) => `
    <div><strong>${escapeHtml(item.event || 'iframe生成')}</strong></div>
    <code>${escapeHtml(item.src)}</code>
  `);

  resourceDetailEl.innerHTML = formatList(report.resources, (item) => `
    <div><strong>${escapeHtml(item.kind || item.initiatorType || 'resource')}</strong> ${escapeHtml(item.status ?? '')}</div>
    <code>${escapeHtml(item.url)}</code>
    <small>${escapeHtml(item.initiatorType || item.method || '')} ${item.durationMs != null ? `${item.durationMs}ms` : ''}</small>
  `);

  messageDetailEl.innerHTML = formatList(report.messages, (item) => `
    <div><strong>${escapeHtml(item.origin)}</strong></div>
    <pre>${escapeHtml(typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2))}</pre>
  `);

  rawLogEl.textContent = JSON.stringify(report, null, 2);
  copyButton.disabled = false;
  setStep('conclusion', 'done', result.code);
}

async function runDiagnostic() {
  const currentRun = ++runId;
  resetUi();
  startButton.disabled = true;

  let profileUrl;
  try {
    profileUrl = normalizeProfileInput(targetInput.value);
  } catch (error) {
    messageEl.textContent = error.message;
    startButton.disabled = false;
    setStep('oembed', 'error', '入力エラー');
    return;
  }

  localStorage.setItem('instagram-getting-diag-last-target', targetInput.value.trim());
  activeTargetEl.textContent = profileUrl;

  const capture = {
    id: currentRun,
    target: profileUrl,
    startedAt: nowIso(),
    startedAtPerf: performance.now(),
    events: [],
    iframes: []
  };
  activeCapture = capture;
  const stopIframeObserver = startIframeObserver(capture);

  try {
    const oembed = await fetchEmbed(profileUrl);
    if (currentRun !== runId) return;
    const htmlPostLinks = extractPostLinks(oembed.html);
    capture.oembed = {
      status: oembed.upstreamStatus,
      payloadKeys: oembed.debug?.payloadKeys || [],
      htmlLength: oembed.debug?.htmlLength ?? oembed.html.length,
      htmlPostLinks: oembed.debug?.postLinksInHtml || htmlPostLinks,
      authorName: oembed.authorName || null,
      target: oembed.target
    };
    setStep('oembed', 'done', `OK ${oembed.upstreamStatus}`);

    embedEl.innerHTML = oembed.html;
    setStep('iframe', 'running', '生成待ち');
    setStep('network', 'running', '観測中');

    await ensureInstagramScript();
    if (window.instgrm?.Embeds?.process) window.instgrm.Embeds.process();

    await new Promise((resolve) => setTimeout(resolve, 10000));
    if (currentRun !== runId) return;

    stopIframeObserver();
    const snapshot = snapshotResources(capture.startedAtPerf);
    const resources = dedupeBy([
      ...capture.events.filter((item) => ['resources', 'fetches', 'xhr'].includes(item.kind)),
      ...snapshot
    ], (item) => `${item.kind}|${item.url}|${item.status || ''}|${item.initiatorType || ''}`);
    const messages = capture.events.filter((item) => item.kind === 'messages');
    const iframes = dedupeBy(capture.events.filter((item) => item.kind === 'iframes'), (item) => `${item.src}|${item.event || 'create'}`);

    const report = {
      runId: currentRun,
      target: profileUrl,
      startedAt: capture.startedAt,
      finishedAt: nowIso(),
      userAgent: navigator.userAgent,
      oembed: capture.oembed,
      iframes,
      resources,
      messages
    };

    setStep('iframe', 'done', `${iframes.length}件`);
    setStep('network', 'done', `${resources.length}件`);
    renderReport(report);
  } catch (error) {
    messageEl.textContent = error.message;
    conclusionEl.textContent = '診断に失敗しました';
    explanationEl.textContent = error.message;
    rawLogEl.textContent = JSON.stringify({ error: error.message, target: profileUrl, at: nowIso() }, null, 2);
    setStep('conclusion', 'error', '失敗');
  } finally {
    if (currentRun === runId) {
      activeCapture = null;
      startButton.disabled = false;
    }
  }
}

startButton.addEventListener('click', runDiagnostic);
targetInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runDiagnostic();
});
copyButton.addEventListener('click', async () => {
  if (!latestReport) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(latestReport, null, 2));
    messageEl.textContent = '診断ログをコピーしました。';
  } catch {
    messageEl.textContent = 'コピーできませんでした。生ログを長押ししてコピーしてください。';
  }
});

const lastTarget = localStorage.getItem('instagram-getting-diag-last-target');
if (lastTarget) targetInput.value = lastTarget;
installObservers();
