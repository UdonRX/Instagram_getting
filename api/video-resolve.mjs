const ALLOWED_KINDS = new Set(['auto', 'post', 'reel']);

function validateShortcode(raw) {
  const shortcode = String(raw || '').trim();
  if (!/^[A-Za-z0-9_-]{5,64}$/.test(shortcode)) {
    throw new Error('有効なInstagram shortcodeが必要です。');
  }
  return shortcode;
}

function decodeEscapedLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"');
}

function buildVariants(html) {
  const variants = [];
  let current = String(html || '');
  for (let level = 0; level < 5; level += 1) {
    if (!variants.includes(current)) variants.push(current);
    current = decodeEscapedLayer(current);
  }
  return variants;
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function cleanUrl(value) {
  return decodeEscapedLayer(String(value || ''))
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=');
}

function extractVideoUrls(html) {
  const urls = [];
  for (const input of buildVariants(html)) {
    const patterns = [
      /["']video_url["']\s*:\s*["']([^"']+)["']/gi,
      /["']videoUrl["']\s*:\s*["']([^"']+)["']/gi,
      /<meta\b[^>]*(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]*>/gi
    ];
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) {
        const url = cleanUrl(match[1]);
        if (/^https:\/\//i.test(url) && /(?:\.mp4(?:\?|$)|video|fbcdn|cdninstagram|scontent)/i.test(url)) urls.push(url);
      }
    }
  }
  return unique(urls).slice(0, 20);
}

function extractPoster(html) {
  for (const input of buildVariants(html)) {
    for (const pattern of [
      /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /["']display_url["']\s*:\s*["']([^"']+)["']/i
    ]) {
      const match = input.match(pattern);
      if (match?.[1]) return cleanUrl(match[1]);
    }
  }
  return null;
}

function makeCandidates(shortcode, kind) {
  const reel = `https://www.instagram.com/reel/${shortcode}/embed/`;
  const post = `https://www.instagram.com/p/${shortcode}/embed/`;
  if (kind === 'reel') return [reel, post];
  if (kind === 'post') return [post, reel];
  return [reel, post];
}

async function fetchEmbed(url) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1'
    },
    signal: AbortSignal.timeout(10000)
  });
  const html = await response.text();
  return { response, html };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GETのみ対応しています。' });
    return;
  }

  let shortcode;
  let kind;
  try {
    shortcode = validateShortcode(req.query?.shortcode);
    kind = String(req.query?.kind || 'auto').toLowerCase();
    if (!ALLOWED_KINDS.has(kind)) throw new Error('kindは auto / post / reel のいずれかです。');
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const attempts = [];
  try {
    for (const candidateUrl of makeCandidates(shortcode, kind)) {
      try {
        const { response, html } = await fetchEmbed(candidateUrl);
        const videoUrls = extractVideoUrls(html);
        const posterUrl = extractPoster(html);
        attempts.push({
          url: candidateUrl,
          status: response.status,
          finalUrl: response.url,
          htmlLength: html.length,
          videoUrlCount: videoUrls.length,
          posterAvailable: Boolean(posterUrl)
        });
        if (response.ok && videoUrls.length) {
          res.status(200).json({
            ok: true,
            shortcode,
            kind,
            source: 'individual_embed_html',
            sourceUrl: candidateUrl,
            finalUrl: response.url,
            videoUrl: videoUrls[0],
            videoUrlCandidates: videoUrls,
            posterUrl,
            attempts
          });
          return;
        }
      } catch (error) {
        attempts.push({ url: candidateUrl, status: 'ERROR', error: error.message });
      }
    }

    res.status(404).json({
      ok: false,
      shortcode,
      kind,
      error: '個別投稿Embed HTMLからvideo_urlを取得できませんでした。',
      attempts
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      ok: false,
      shortcode,
      kind,
      error: timedOut ? '動画URL解決が10秒でタイムアウトしました。' : error.message,
      attempts
    });
  }
}
