const WEB_APP_ID = '936619743392459';
const DEFAULT_ASBD_ID = '198387';
const MAX_ACCOUNTS = 12;
const EMBED_CONCURRENCY = 3;
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '');
}

function normalizeUsername(raw) {
  let username = String(raw || '').trim();
  if (username.startsWith('@')) username = username.slice(1);
  if (!USERNAME_RE.test(username)) throw new Error(`無効なInstagramユーザー名: ${raw}`);
  return username.toLowerCase();
}

function parseUsernames(raw) {
  const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const unique = [];
  for (const value of values) {
    if (!String(value || '').trim()) continue;
    const username = normalizeUsername(value);
    if (!unique.includes(username)) unique.push(username);
  }
  if (!unique.length) throw new Error('usernames が必要です。');
  if (unique.length > MAX_ACCOUNTS) throw new Error(`Story試作は1回最大${MAX_ACCOUNTS}アカウントです。`);
  return unique;
}

function authConfig() {
  const sessionid = String(process.env.INSTAGRAM_SESSIONID || '').trim();
  const csrftoken = String(process.env.INSTAGRAM_CSRFTOKEN || '').trim();
  const dsUserId = String(process.env.INSTAGRAM_DS_USER_ID || '').trim();
  const rur = String(process.env.INSTAGRAM_RUR || '').trim();
  const cookies = [];
  if (sessionid) cookies.push(`sessionid=${sessionid}`);
  if (csrftoken) cookies.push(`csrftoken=${csrftoken}`);
  if (dsUserId) cookies.push(`ds_user_id=${dsUserId}`);
  if (rur) cookies.push(`rur=${rur}`);
  return { sessionid, csrftoken, dsUserId, cookie: cookies.join('; ') };
}

function storyHeaders(auth) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
    'User-Agent': UA,
    'X-IG-App-ID': WEB_APP_ID,
    'X-ASBD-ID': String(process.env.INSTAGRAM_ASBD_ID || DEFAULT_ASBD_ID),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.instagram.com/',
    Cookie: auth.cookie
  };
  if (auth.csrftoken) headers['X-CSRFToken'] = auth.csrftoken;
  return headers;
}

function decodeLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function decodedVariants(html) {
  const out = [];
  let current = String(html || '');
  for (let level = 0; level < 5; level += 1) {
    if (!out.includes(current)) out.push(current);
    current = decodeLayer(current);
  }
  return out;
}

function extractBalancedObject(text, startIndex) {
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
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function profileFromObject(object, username) {
  const id = object?.id ?? object?.pk ?? object?.pk_id;
  const objectUsername = String(object?.username ?? object?.user_name ?? '').toLowerCase();
  if (objectUsername !== username || !/^\d{5,30}$/.test(String(id || ''))) return null;
  return {
    id: String(id),
    username,
    fullName: object?.full_name || object?.fullName || null,
    profilePicUrl: object?.profile_pic_url_hd || object?.profile_pic_url || object?.profilePicUrl || null,
    isVerified: typeof object?.is_verified === 'boolean' ? object.is_verified : null,
    isPrivate: typeof object?.is_private === 'boolean' ? object.is_private : null
  };
}

function extractProfile(html, username) {
  const matches = [];
  for (const input of decodedVariants(html)) {
    const marker = /["'](?:owner|user|profile_user|profileUser)["']\s*:\s*\{/gi;
    let match;
    while ((match = marker.exec(input))) {
      const start = input.indexOf('{', match.index);
      const raw = start >= 0 ? extractBalancedObject(input, start) : null;
      if (!raw) continue;
      try {
        const profile = profileFromObject(JSON.parse(raw), username);
        if (profile) matches.push({ ...profile, method: 'named_object_json' });
      } catch {
        const userMatch = raw.match(/["'](?:username|user_name)["']\s*:\s*["']([^"']+)["']/i);
        const idMatch = raw.match(/["'](?:id|pk|pk_id)["']\s*:\s*["']?(\d{5,30})["']?/i);
        if (userMatch?.[1]?.toLowerCase() !== username || !idMatch?.[1]) continue;
        const picMatch = raw.match(/["'](?:profile_pic_url_hd|profile_pic_url|profilePicUrl)["']\s*:\s*["']([^"']+)["']/i);
        matches.push({
          id: idMatch[1], username, fullName: null,
          profilePicUrl: picMatch?.[1] ? decodeLayer(picMatch[1]) : null,
          isVerified: null, isPrivate: null, method: 'named_object_regex'
        });
      }
    }
  }
  const grouped = new Map();
  for (const item of matches) {
    const current = grouped.get(item.id);
    if (!current) grouped.set(item.id, item);
    else if (!current.profilePicUrl && item.profilePicUrl) current.profilePicUrl = item.profilePicUrl;
  }
  const candidates = [...grouped.values()];
  return {
    profile: candidates[0] || null,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 8).map(({ id, method }) => ({ id, method }))
  };
}

async function fetchEmbedProfile(username) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/embed/`;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(10000)
    });
    const html = await response.text();
    const extracted = response.ok ? extractProfile(html, username) : { profile: null, candidateCount: 0, candidates: [] };
    return {
      username,
      responseOk: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      htmlLength: html.length,
      profile: extracted.profile,
      candidateCount: extracted.candidateCount,
      candidates: extracted.candidates,
      error: response.ok && !extracted.profile ? 'Embed HTMLからuser IDを抽出できませんでした。' : (!response.ok ? `Embed HTTP ${response.status}` : null)
    };
  } catch (error) {
    return { username, responseOk: false, status: 'ERROR', durationMs: Date.now() - startedAt, htmlLength: 0, profile: null, candidateCount: 0, candidates: [], error: error?.message || String(error) };
  }
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, runWorker));
  return results;
}

function bestImage(item) {
  const candidates = [
    ...(item?.image_versions2?.candidates || []),
    ...(item?.image_versions?.candidates || [])
  ].filter((entry) => entry?.url);
  candidates.sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)));
  return candidates[0]?.url || null;
}

function bestVideo(item) {
  const candidates = [...(item?.video_versions || [])].filter((entry) => entry?.url);
  candidates.sort((a, b) => (Number(b.width || 0) * Number(b.height || 0)) - (Number(a.width || 0) * Number(a.height || 0)));
  return candidates[0]?.url || null;
}

function unixToIso(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
}

function mapStory(item, index) {
  const imageUrl = bestImage(item);
  const videoUrl = bestVideo(item);
  return {
    index,
    id: String(item?.pk ?? item?.id ?? ''),
    code: item?.code || null,
    type: Number(item?.media_type) === 2 || videoUrl ? 'video' : imageUrl ? 'image' : 'unknown',
    takenAt: unixToIso(item?.taken_at),
    expiringAt: unixToIso(item?.expiring_at),
    width: Number(item?.original_width || item?.image_versions2?.candidates?.[0]?.width || 0) || null,
    height: Number(item?.original_height || item?.image_versions2?.candidates?.[0]?.height || 0) || null,
    imageUrl,
    videoUrl,
    hasAudio: typeof item?.has_audio === 'boolean' ? item.has_audio : null
  };
}

function storyContainer(payload, userId) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.reels && typeof payload.reels === 'object' && !Array.isArray(payload.reels)) {
    return payload.reels[userId] || null;
  }
  if (Array.isArray(payload.reels_media)) {
    return payload.reels_media.find((entry) => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId)) || null;
  }
  if (Array.isArray(payload.reels)) {
    return payload.reels.find((entry) => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId)) || null;
  }
  return null;
}

async function fetchStoriesBatch(userIds, auth) {
  if (!userIds.length) return { response: null, payload: null, skipped: true, durationMs: 0 };
  const endpoint = new URL('https://www.instagram.com/api/v1/feed/reels_media/');
  for (const userId of userIds) endpoint.searchParams.append('reel_ids', userId);
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      redirect: 'follow',
      headers: storyHeaders(auth),
      signal: AbortSignal.timeout(12000)
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = null; }
    return {
      response,
      payload,
      skipped: false,
      durationMs: Date.now() - startedAt,
      bodyLength: text.length,
      contentType: response.headers.get('content-type') || null,
      upstreamMessage: payload?.message || payload?.status || null
    };
  } catch (error) {
    return { response: null, payload: null, skipped: false, durationMs: Date.now() - startedAt, error: error?.message || String(error) };
  }
}

function jsonError(res, status, error, extra = {}) {
  res.status(status).json({ ok: false, error, ...extra });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method !== 'GET') return jsonError(res, 405, 'GETのみ対応しています。');

  const configuredKey = String(process.env.STORY_DIAGNOSTIC_KEY || '');
  if (!configuredKey) return jsonError(res, 503, 'STORY_DIAGNOSTIC_KEY が未設定です。', { setupRequired: true });
  if (headerValue(req.headers?.['x-story-diagnostic-key']) !== configuredKey) return jsonError(res, 401, 'Story診断キーが一致しません。');

  let usernames;
  try { usernames = parseUsernames(req.query?.usernames); }
  catch (error) { return jsonError(res, 400, error.message); }

  const auth = authConfig();
  if (!auth.sessionid) return jsonError(res, 503, 'INSTAGRAM_SESSIONID が未設定です。', { setupRequired: true });

  const startedAt = Date.now();
  const embedResults = await mapLimit(usernames, EMBED_CONCURRENCY, fetchEmbedProfile);
  const resolvedProfiles = embedResults.filter((entry) => entry.profile?.id).map((entry) => entry.profile);
  const storyBatch = await fetchStoriesBatch(resolvedProfiles.map((profile) => profile.id), auth);
  const storyOk = Boolean(storyBatch.response?.ok && storyBatch.payload);

  const accounts = embedResults.map((entry) => {
    if (!entry.profile?.id) {
      return {
        username: entry.username,
        status: 'id_unresolved',
        activeStory: false,
        storyCount: 0,
        stories: [],
        profile: null,
        error: entry.error || 'user IDを取得できませんでした。',
        embed: { status: entry.status, durationMs: entry.durationMs, htmlLength: entry.htmlLength, candidateCount: entry.candidateCount, candidates: entry.candidates }
      };
    }

    if (!storyOk) {
      return {
        username: entry.username,
        status: 'story_error',
        activeStory: false,
        storyCount: 0,
        stories: [],
        profile: entry.profile,
        error: storyBatch.response ? `Story API HTTP ${storyBatch.response.status}` : (storyBatch.error || 'Story APIへ接続できませんでした。'),
        embed: { status: entry.status, durationMs: entry.durationMs, htmlLength: entry.htmlLength, candidateCount: entry.candidateCount, candidates: entry.candidates }
      };
    }

    const container = storyContainer(storyBatch.payload, entry.profile.id);
    const items = Array.isArray(container?.items) ? container.items : [];
    const stories = items.slice(0, 50).map(mapStory);
    return {
      username: entry.username,
      status: 'ok',
      activeStory: stories.length > 0,
      storyCount: stories.length,
      stories,
      profile: entry.profile,
      latestReelMedia: Number(container?.latest_reel_media || 0) || null,
      expiringAt: unixToIso(container?.expiring_at),
      embed: { status: entry.status, durationMs: entry.durationMs, htmlLength: entry.htmlLength, candidateCount: entry.candidateCount, candidates: entry.candidates }
    };
  });

  const activeCount = accounts.filter((account) => account.activeStory).length;
  const failedCount = accounts.filter((account) => account.status !== 'ok').length;
  return res.status(200).json({
    ok: true,
    diagnostic: 'instagram_story_multi_probe_v1',
    checkedAt: new Date().toISOString(),
    maxAccounts: MAX_ACCOUNTS,
    accountCount: accounts.length,
    activeAccountCount: activeCount,
    failedAccountCount: failedCount,
    storyApiExecuted: resolvedProfiles.length > 0,
    storyApiCallCount: resolvedProfiles.length > 0 ? 1 : 0,
    storyApi: {
      status: storyBatch.response?.status ?? (storyBatch.skipped ? 'SKIPPED' : 'ERROR'),
      ok: storyOk,
      durationMs: storyBatch.durationMs,
      bodyLength: storyBatch.bodyLength || 0,
      contentType: storyBatch.contentType || null,
      upstreamMessage: storyBatch.upstreamMessage || null,
      error: storyBatch.error || null
    },
    durationMs: Date.now() - startedAt,
    accounts,
    authConfigured: {
      sessionid: true,
      csrftoken: Boolean(auth.csrftoken),
      dsUserId: Boolean(auth.dsUserId)
    },
    notes: [
      '各アカウントのuser IDは公開 /username/embed/ HTMLから取得します。',
      '解決できたuser IDは1回の reels_media リクエストへまとめています。',
      'Story CDN URLは長期保存しません。'
    ]
  });
}
