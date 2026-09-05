const ALLOWED_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const RESERVED_PROFILE_PATHS = new Set([
  'accounts', 'about', 'developer', 'explore', 'directory', 'legal', 'privacy', 'terms',
  'p', 'reel', 'stories'
]);

function normalizeProfile(raw) {
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
    throw new Error('instagram.com のプロフィールだけ指定できます。');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const username = parts[0] || '';
  if (parts.length !== 1 || RESERVED_PROFILE_PATHS.has(username.toLowerCase())) {
    throw new Error('iframe HTML内部診断は公開プロフィールURLだけ対応しています。');
  }

  return {
    username,
    profileUrl: `https://www.instagram.com/${username}/`,
    iframeUrl: `https://www.instagram.com/${username}/embed/`
  };
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function normalizeEmbeddedText(html) {
  return String(html || '')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function extractPostLinks(html) {
  const input = normalizeEmbeddedText(html);
  const values = [];

  for (const match of input.matchAll(/https:\/\/(?:www\.)?instagram\.com\/(p|reel)\/([A-Za-z0-9._-]+)\/?/gi)) {
    values.push(`https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`);
  }
  for (const match of input.matchAll(/(?:^|["'\s=(])\/(p|reel)\/([A-Za-z0-9._-]+)\/?/gi)) {
    values.push(`https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/`);
  }

  return unique(values).slice(0, 50);
}

function extractShortcodes(html) {
  const input = normalizeEmbeddedText(html);
  const values = [];
  const patterns = [
    /["']shortcode["']\s*:\s*["']([A-Za-z0-9_-]{5,})["']/gi,
    /["']shortcode["']\s*=\s*["']([A-Za-z0-9_-]{5,})["']/gi,
    /\/(?:p|reel)\/([A-Za-z0-9._-]{5,})\/?/gi
  ];
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) values.push(match[1]);
  }
  return unique(values).slice(0, 50);
}

function extractMediaIds(html) {
  const input = normalizeEmbeddedText(html);
  const values = [];
  for (const match of input.matchAll(/["'](?:media_id|mediaId)["']\s*:\s*["']?(\d{6,})["']?/gi)) {
    values.push(match[1]);
  }
  return unique(values).slice(0, 50);
}

function extractScriptSrcs(html) {
  const values = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    values.push(match[1]);
  }
  return unique(values).slice(0, 80);
}

function countMatches(html, regex) {
  return Array.from(String(html || '').matchAll(regex)).length;
}

function findKeywordHits(html) {
  const input = String(html || '');
  const keywords = [
    'shortcode_media',
    'edge_owner_to_timeline_media',
    'timeline_media',
    'additionalDataLoaded',
    'graphql',
    'xdt_api__v1__feed__user_timeline_graphql_connection',
    'PolarisProfilePostsTabContentQuery',
    'PolarisProfileReelsTabContentQuery'
  ];
  return keywords.filter((keyword) => input.includes(keyword));
}

function pageSignals(html) {
  const input = String(html || '').toLowerCase();
  return {
    loginWall: input.includes('log in') && input.includes('instagram'),
    challenge: input.includes('challenge_required') || input.includes('/challenge/'),
    rateLimited: input.includes('please wait a few minutes') || input.includes('too many requests'),
    unavailable: input.includes("sorry, this page isn't available")
  };
}

function makeSnippets(html, needles) {
  const input = normalizeEmbeddedText(html);
  const snippets = [];
  for (const needle of unique(needles).slice(0, 8)) {
    const variants = [needle, needle.replace('https://www.instagram.com', '')];
    let index = -1;
    for (const variant of variants) {
      index = input.indexOf(variant);
      if (index >= 0) break;
    }
    if (index < 0) continue;
    snippets.push(input.slice(Math.max(0, index - 180), Math.min(input.length, index + 320)));
  }
  return unique(snippets).slice(0, 6);
}

function classify({ postLinks, shortcodes, keywordHits }) {
  if (postLinks.length) {
    return {
      code: 'FRAME_HTML_CONTAINS_POST_LINKS',
      title: 'iframe初期HTMLに個別投稿URLがあります',
      explanation: `/p/ または /reel/ のURLを ${postLinks.length} 件検出しました。個別oEmbedへ渡せる可能性があります。`
    };
  }
  if (shortcodes.length) {
    return {
      code: 'FRAME_HTML_CONTAINS_SHORTCODES',
      title: 'iframe初期HTMLにshortcode候補があります',
      explanation: `投稿shortcode候補を ${shortcodes.length} 件検出しました。URLへ復元できるか次段階で確認できます。`
    };
  }
  if (keywordHits.length) {
    return {
      code: 'FRAME_HTML_HAS_DATA_HINTS',
      title: 'iframe初期HTMLに投稿取得処理の手掛かりがあります',
      explanation: '個別投稿URLそのものはありませんが、GraphQLやtimeline media関連の文字列を検出しました。iframe内JavaScriptの追加通信で投稿を取得している可能性があります。'
    };
  }
  return {
    code: 'FRAME_HTML_NO_MEDIA_DATA',
    title: 'iframe初期HTMLに明確な投稿データは見つかりませんでした',
    explanation: '最新6投稿はiframe内JavaScriptが追加通信で取得している可能性が高くなります。'
  };
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
    target = normalizeProfile(req.query?.url);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  try {
    const upstream = await fetch(target.iframeUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1'
      },
      signal: AbortSignal.timeout(10000)
    });

    const html = await upstream.text();
    const postLinks = extractPostLinks(html);
    const shortcodes = extractShortcodes(html);
    const mediaIds = extractMediaIds(html);
    const scriptSrcs = extractScriptSrcs(html);
    const keywordHits = findKeywordHits(html);
    const signals = pageSignals(html);
    const classification = classify({ postLinks, shortcodes, keywordHits });
    const snippets = makeSnippets(html, [...postLinks, ...shortcodes, ...keywordHits]);

    res.status(upstream.ok ? 200 : upstream.status).json({
      ok: upstream.ok,
      status: upstream.status,
      target: target.profileUrl,
      iframeUrl: target.iframeUrl,
      finalUrl: upstream.url,
      contentType: upstream.headers.get('content-type') || null,
      htmlLength: html.length,
      scriptSrcs,
      inlineScriptCount: countMatches(html, /<script\b(?![^>]*\bsrc=)[^>]*>/gi),
      jsonScriptCount: countMatches(html, /<script\b[^>]*\btype=["']application\/(?:ld\+)?json["'][^>]*>/gi),
      discoveredPostLinks: postLinks,
      shortcodeCandidates: shortcodes,
      mediaIdCandidates: mediaIds,
      keywordHits,
      pageSignals: signals,
      snippets,
      classification
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'Instagram iframe HTMLへの接続が10秒でタイムアウトしました。'
        : `Instagram iframe HTMLへの接続に失敗しました: ${error.message}`,
      target: target.profileUrl,
      iframeUrl: target.iframeUrl
    });
  }
}
