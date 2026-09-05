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
    .replace(/\\\//g, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function decodeEscapedLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u002f/gi, '/')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function buildDecodedVariants(html) {
  const variants = [];
  let current = String(html || '');
  for (let level = 0; level < 4; level += 1) {
    if (!variants.includes(current)) variants.push(current);
    current = decodeEscapedLayer(current);
  }
  return variants;
}

function extractBalanced(text, startIndex, open = '[', close = ']') {
  let depth = 0;
  let quote = '';
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { inString = false; quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quote = char; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function dedupeMediaObjects(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.shortcode || item.id || JSON.stringify(item).slice(0, 120));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function parseGraphqlMediaFromHtml(html) {
  const variants = buildDecodedVariants(html);
  let arrayOccurrences = 0;
  let bestItems = [];
  let parseMethod = null;
  let decodedLevel = null;
  const parseErrors = [];

  for (let level = 0; level < variants.length; level += 1) {
    const input = variants[level];
    const marker = /["']graphql_media["']\s*:\s*\[/gi;
    let match;
    while ((match = marker.exec(input))) {
      arrayOccurrences += 1;
      const start = input.indexOf('[', match.index);
      if (start < 0) continue;
      const rawArray = extractBalanced(input, start, '[', ']');
      if (!rawArray) continue;
      try {
        const parsed = JSON.parse(rawArray);
        if (Array.isArray(parsed)) {
          const objects = parsed
            .map((entry) => entry?.shortcode_media || entry?.node || entry)
            .filter((entry) => entry && typeof entry === 'object');
          if (objects.length > bestItems.length) {
            bestItems = objects;
            parseMethod = 'graphql_media_array';
            decodedLevel = level;
          }
        }
      } catch (error) {
        if (parseErrors.length < 5) parseErrors.push(`array@level${level}: ${error.message}`);
      }
    }
  }

  if (!bestItems.length) {
    for (let level = 0; level < variants.length; level += 1) {
      const input = variants[level];
      const marker = /["']shortcode_media["']\s*:\s*\{/gi;
      const objects = [];
      let match;
      while ((match = marker.exec(input))) {
        const start = input.indexOf('{', match.index);
        if (start < 0) continue;
        const rawObject = extractBalanced(input, start, '{', '}');
        if (!rawObject) continue;
        try {
          objects.push(JSON.parse(rawObject));
        } catch (error) {
          if (parseErrors.length < 5) parseErrors.push(`object@level${level}: ${error.message}`);
        }
      }
      const deduped = dedupeMediaObjects(objects);
      if (deduped.length > bestItems.length) {
        bestItems = deduped;
        parseMethod = 'shortcode_media_objects';
        decodedLevel = level;
      }
    }
  }

  return {
    items: dedupeMediaObjects(bestItems),
    parseMethod,
    decodedLevel,
    arrayOccurrences,
    parseErrors
  };
}

function firstCaption(media) {
  if (typeof media?.caption === 'string') return media.caption;
  const edgeText = media?.edge_media_to_caption?.edges?.[0]?.node?.text;
  if (typeof edgeText === 'string') return edgeText;
  return null;
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return { raw: null, iso: null };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { raw: value, iso: null };
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return { raw: numeric, iso: Number.isNaN(date.getTime()) ? null : date.toISOString() };
}

function childSummary(node) {
  const child = node?.node || node || {};
  const timestamp = normalizeTimestamp(child.taken_at_timestamp ?? child.taken_at);
  return {
    id: child.id || null,
    shortcode: child.shortcode || null,
    typename: child.__typename || null,
    isVideo: Boolean(child.is_video),
    displayUrl: child.display_url || child.thumbnail_src || null,
    videoUrl: child.video_url || null,
    dimensions: child.dimensions || null,
    timestamp: timestamp.raw,
    timestampIso: timestamp.iso
  };
}

function mediaSummary(media, index) {
  const timestamp = normalizeTimestamp(media.taken_at_timestamp ?? media.taken_at);
  const sidecarEdges = media?.edge_sidecar_to_children?.edges || [];
  const children = sidecarEdges.slice(0, 20).map(childSummary);
  const isVideo = Boolean(media.is_video);
  const shortcode = media.shortcode || null;
  const typename = media.__typename || null;
  const mediaType = typename === 'GraphSidecar'
    ? 'carousel'
    : (isVideo || typename === 'GraphVideo' ? 'video' : 'image');
  const caption = firstCaption(media);

  return {
    index: index + 1,
    id: media.id || null,
    shortcode,
    typename,
    mediaType,
    isVideo,
    dimensions: media.dimensions || null,
    displayUrl: media.display_url || media.thumbnail_src || null,
    videoUrl: media.video_url || null,
    caption,
    accessibilityCaption: media.accessibility_caption || null,
    timestamp: timestamp.raw,
    timestampIso: timestamp.iso,
    productType: media.product_type || media.productType || null,
    ownerUsername: media?.owner?.username || null,
    childCount: children.length,
    children,
    urlCandidates: shortcode ? {
      post: `https://www.instagram.com/p/${shortcode}/`,
      reel: isVideo ? `https://www.instagram.com/reel/${shortcode}/` : null
    } : null,
    availability: {
      displayUrl: Boolean(media.display_url || media.thumbnail_src),
      videoUrl: Boolean(media.video_url),
      caption: Boolean(caption),
      timestamp: timestamp.raw != null,
      children: children.length > 0
    }
  };
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
  const values = [];
  for (const input of buildDecodedVariants(html)) {
    const patterns = [
      /["']shortcode["']\s*:\s*["']([A-Za-z0-9_-]{5,})["']/gi,
      /["']shortcode["']\s*=\s*["']([A-Za-z0-9_-]{5,})["']/gi,
      /\/(?:p|reel)\/([A-Za-z0-9._-]{5,})\/?/gi
    ];
    for (const pattern of patterns) {
      for (const match of input.matchAll(pattern)) values.push(match[1]);
    }
  }
  return unique(values).slice(0, 50);
}

function extractMediaIds(html) {
  const values = [];
  for (const input of buildDecodedVariants(html)) {
    for (const match of input.matchAll(/["'](?:media_id|mediaId|id)["']\s*:\s*["']?(\d{6,})["']?/gi)) {
      values.push(match[1]);
    }
  }
  return unique(values).slice(0, 80);
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
    'graphql_media',
    'edge_owner_to_timeline_media',
    'timeline_media',
    'edge_media_to_caption',
    'taken_at_timestamp',
    'video_url',
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

function classify({ structuredMedia, postLinks, shortcodes, keywordHits }) {
  if (structuredMedia.length) {
    const withCaption = structuredMedia.filter((item) => item.availability.caption).length;
    const withTimestamp = structuredMedia.filter((item) => item.availability.timestamp).length;
    return {
      code: 'FRAME_HTML_GRAPHQL_MEDIA_PARSED',
      title: `graphql_mediaを${structuredMedia.length}件構造化できました`,
      explanation: `iframe初期HTML内の埋め込みデータを投稿オブジェクトへ変換できました。caption ${withCaption}/${structuredMedia.length}、timestamp ${withTimestamp}/${structuredMedia.length}。`
    };
  }
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
      explanation: '個別投稿URLそのものはありませんが、GraphQLやtimeline media関連の文字列を検出しました。'
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
    const parsedGraphql = parseGraphqlMediaFromHtml(html);
    const structuredMedia = parsedGraphql.items.slice(0, 25).map(mediaSummary);
    const postLinks = extractPostLinks(html);
    const shortcodes = unique([
      ...structuredMedia.map((item) => item.shortcode),
      ...extractShortcodes(html)
    ]).slice(0, 50);
    const mediaIds = unique([
      ...structuredMedia.map((item) => item.id),
      ...extractMediaIds(html)
    ]).slice(0, 80);
    const scriptSrcs = extractScriptSrcs(html);
    const keywordHits = findKeywordHits(html);
    const signals = pageSignals(html);
    const classification = classify({ structuredMedia, postLinks, shortcodes, keywordHits });
    const snippets = makeSnippets(html, [...postLinks, ...shortcodes, 'graphql_media', ...keywordHits]);

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
      graphqlMedia: {
        count: structuredMedia.length,
        parseMethod: parsedGraphql.parseMethod,
        decodedLevel: parsedGraphql.decodedLevel,
        arrayOccurrences: parsedGraphql.arrayOccurrences,
        parseErrors: parsedGraphql.parseErrors,
        items: structuredMedia
      },
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
