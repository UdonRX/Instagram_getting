const frameRunButton = document.querySelector('#runFrameDiagnostic');
const frameCopyButton = document.querySelector('#copyFrameDiagnostic');
const frameStatusEl = document.querySelector('#frameDiagStatus');
const frameExplanationEl = document.querySelector('#frameDiagExplanation');
const frameMetricHttp = document.querySelector('#frameMetricHttp');
const frameMetricHtml = document.querySelector('#frameMetricHtml');
const frameMetricLinks = document.querySelector('#frameMetricLinks');
const frameMetricShortcodes = document.querySelector('#frameMetricShortcodes');
const frameSummaryEl = document.querySelector('#frameHtmlSummary');
const frameRawEl = document.querySelector('#rawFrameDiagnosticLog');
const sharedTargetInput = document.querySelector('#diagTarget');

let latestFrameReport = null;

function normalizeFrameProfileInput(value) {
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
    throw new Error('iframe HTML内部診断はプロフィールURLだけが対象です。');
  }
  return `https://www.instagram.com/${parts[0]}/`;
}

function escapeFrameHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function frameList(items, formatter) {
  if (!items?.length) return '<p class="diag-none">該当データなし</p>';
  return `<ol class="diag-list">${items.map((item) => `<li>${formatter(item)}</li>`).join('')}</ol>`;
}

function resetFrameUi() {
  frameStatusEl.textContent = '診断中…';
  frameExplanationEl.textContent = 'Instagramの /username/embed/ HTMLをサーバー側で取得し、その場で解析しています。';
  frameMetricHttp.textContent = '—';
  frameMetricHtml.textContent = '—';
  frameMetricLinks.textContent = '—';
  frameMetricShortcodes.textContent = '—';
  frameSummaryEl.textContent = '取得中…';
  frameRawEl.textContent = '取得中…';
  frameCopyButton.disabled = true;
}

function renderFrameReport(report) {
  latestFrameReport = report;
  const classification = report.classification || {};
  frameStatusEl.textContent = classification.title || (report.ok ? 'iframe HTMLを取得しました' : 'iframe HTML取得に失敗しました');
  frameExplanationEl.textContent = classification.explanation || report.error || '解析結果を確認してください。';
  frameMetricHttp.textContent = report.status ?? '—';
  frameMetricHtml.textContent = report.htmlLength != null ? `${report.htmlLength.toLocaleString()}文字` : '—';
  frameMetricLinks.textContent = `${report.discoveredPostLinks?.length || 0}件`;
  frameMetricShortcodes.textContent = `${report.shortcodeCandidates?.length || 0}件`;

  const signals = report.pageSignals || {};
  frameSummaryEl.innerHTML = `
    <dl class="diag-kv">
      <div><dt>判定コード</dt><dd>${escapeFrameHtml(classification.code || '—')}</dd></div>
      <div><dt>iframe URL</dt><dd>${escapeFrameHtml(report.iframeUrl || '—')}</dd></div>
      <div><dt>最終URL</dt><dd>${escapeFrameHtml(report.finalUrl || '—')}</dd></div>
      <div><dt>Content-Type</dt><dd>${escapeFrameHtml(report.contentType || '—')}</dd></div>
      <div><dt>script src</dt><dd>${report.scriptSrcs?.length || 0}件</dd></div>
      <div><dt>inline script</dt><dd>${report.inlineScriptCount ?? 0}件</dd></div>
      <div><dt>JSON script</dt><dd>${report.jsonScriptCount ?? 0}件</dd></div>
      <div><dt>media ID候補</dt><dd>${report.mediaIdCandidates?.length || 0}件</dd></div>
      <div><dt>keyword hits</dt><dd>${escapeFrameHtml((report.keywordHits || []).join(', ') || 'なし')}</dd></div>
      <div><dt>login wall</dt><dd>${signals.loginWall ? 'YES' : 'NO'}</dd></div>
      <div><dt>challenge</dt><dd>${signals.challenge ? 'YES' : 'NO'}</dd></div>
      <div><dt>rate limited</dt><dd>${signals.rateLimited ? 'YES' : 'NO'}</dd></div>
    </dl>
    <h3>個別投稿URL</h3>
    ${frameList(report.discoveredPostLinks || [], (item) => `<code>${escapeFrameHtml(item)}</code>`)}
    <h3>shortcode候補</h3>
    ${frameList(report.shortcodeCandidates || [], (item) => `<code>${escapeFrameHtml(item)}</code>`)}
    <h3>HTML内スニペット</h3>
    ${frameList(report.snippets || [], (item) => `<pre>${escapeFrameHtml(item)}</pre>`)}
  `;
  frameRawEl.textContent = JSON.stringify(report, null, 2);
  frameCopyButton.disabled = false;
}

async function runFrameDiagnostic() {
  resetFrameUi();
  frameRunButton.disabled = true;

  try {
    const profileUrl = normalizeFrameProfileInput(sharedTargetInput.value);
    const response = await fetch(`/api/embed-frame?url=${encodeURIComponent(profileUrl)}&t=${Date.now()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const report = await response.json().catch(() => ({}));
    if (!response.ok && !report.status) {
      throw new Error(report.error || `iframe HTML診断 HTTP ${response.status}`);
    }
    renderFrameReport(report);
  } catch (error) {
    const report = {
      ok: false,
      status: 'ERROR',
      error: error.message,
      at: new Date().toISOString()
    };
    latestFrameReport = report;
    frameStatusEl.textContent = 'iframe HTML内部診断に失敗しました';
    frameExplanationEl.textContent = error.message;
    frameRawEl.textContent = JSON.stringify(report, null, 2);
    frameCopyButton.disabled = false;
  } finally {
    frameRunButton.disabled = false;
  }
}

frameRunButton.addEventListener('click', runFrameDiagnostic);
frameCopyButton.addEventListener('click', async () => {
  if (!latestFrameReport) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(latestFrameReport, null, 2));
    frameExplanationEl.textContent = 'iframe HTML内部診断ログをコピーしました。';
  } catch {
    frameExplanationEl.textContent = 'コピーできませんでした。生ログを長押ししてコピーしてください。';
  }
});

// 既存の通信診断を実行したときも、同じ入力値でiframe HTML内部診断を並行実行する。
document.querySelector('#startDiagnostic')?.addEventListener('click', () => {
  setTimeout(() => {
    if (sharedTargetInput.value.trim()) runFrameDiagnostic();
  }, 50);
});
