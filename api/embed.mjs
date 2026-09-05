const ALLOWED_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const RESERVED_PROFILE_PATHS = new Set([
  'accounts', 'about', 'developer', 'explore', 'directory', 'legal', 'privacy', 'terms'
]);

function normalizeTarget(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('url が必要です。');

  let candidate = input;
  if (/^@[A-Za-z0-9._]+$/.test(candidate)) {
    candidate = `https://www.instagram.com/${candidate.slice(1)}/`;
  } else if (/^[A-Za-z0-9._]+$/.test(candidate)) {
    candidate = `https://www.instagram.com/${candidate}/`;
  } else if (/^(www\.)?instagram\.com\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const url = new URL(candidate);
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('instagram.com のURLだけ指定できます。');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) throw new Error('プロフィール名または投稿URLを指定してください。');

  let type = 'profile';
  if (parts[0] === 'p' && parts[1]) type = 'post';
  else if (parts[0] === 'reel' && parts[1]) type = 'reel';
  else if (parts.length === 1 && !RESERVED_PROFILE_PATHS.has(parts[0].toLowerCase())) type = 'profile';
  else throw new Error('対応形式はプロフィール /p/ /reel/ の公開URLです。');

  url.protocol = 'https:';
  url.hostname = 'www.instagram.com';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';

  return { url: url.toString(), type };
}

function stripScripts(html) {
  return String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GETのみ対応しています。' });
    return;
  }

  let target;
  try {
    target = normalizeTarget(req.query?.url);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const endpoint = new URL('https://graph.facebook.com/v25.0/instagram_oembed');
  endpoint.searchParams.set('url', target.url);
  endpoint.searchParams.set('omitscript', 'true');
  endpoint.searchParams.set('maxwidth', '540');

  try {
    const upstream = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'InstagramGettingPrototype/1.0'
      },
      signal: AbortSignal.timeout(10000)
    });

    const text = await upstream.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }

    if (!upstream.ok) {
      const metaMessage = payload?.error?.message || payload?.message;
      res.status(upstream.status).json({
        error: metaMessage || `Meta oEmbed が HTTP ${upstream.status} を返しました。`,
        upstreamStatus: upstream.status,
        type: target.type,
        target: target.url
      });
      return;
    }

    const html = stripScripts(payload.html);
    if (!html) {
      res.status(502).json({
        error: 'Meta oEmbedの応答に表示用HTMLがありませんでした。',
        upstreamStatus: upstream.status,
        type: target.type,
        target: target.url
      });
      return;
    }

    res.status(200).json({
      ok: true,
      type: target.type,
      target: target.url,
      upstreamStatus: upstream.status,
      providerName: payload.provider_name || 'Instagram',
      authorName: payload.author_name || null,
      authorUrl: payload.author_url || null,
      title: payload.title || null,
      html
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Meta oEmbedへの接続が10秒でタイムアウトしました。' : `Meta oEmbedへの接続に失敗しました: ${error.message}`,
      type: target.type,
      target: target.url
    });
  }
}
