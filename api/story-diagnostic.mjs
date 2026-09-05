const WEB_APP_ID = '936619743392459';
const DEFAULT_ASBD_ID = '198387';
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

function normalizeUsername(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('username が必要です。');

  let username = input;
  if (username.startsWith('@')) username = username.slice(1);

  if (/^https?:\/\//i.test(username) || /^(?:www\.)?instagram\.com\//i.test(username)) {
    const candidate = /^https?:\/\//i.test(username) ? username : `https://${username}`;
    const url = new URL(candidate);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())) {
      throw new Error('instagram.com の公開プロフィールだけ指定できます。');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) throw new Error('Story診断はプロフィールURLだけ指定できます。');
    username = parts[0];
  }

  if (!USERNAME_RE.test(username)) {
    throw new Error('有効なInstagramユーザー名を指定してください。');
  }
  return username;
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || '';
  return String(value || '');
}

function safeMessage(payload) {
  const value = payload?.message || payload?.error_message || payload?.error_type || payload?.status;
  return typeof value === 'string' ? value.slice(0, 240) : null;
}

function buildCookie() {
  const sessionid = String(process.env.INSTAGRAM_SESSIONID || '').trim();
  const csrftoken = String(process.env.INSTAGRAM_CSRFTOKEN || '').trim();
  const dsUserId = String(process.env.INSTAGRAM_DS_USER_ID || '').trim();
  const rur = String(process.env.INSTAGRAM_RUR || '').trim();

  const parts = [];
  if (sessionid) parts.push(`sessionid=${sessionid}`);
  if (csrftoken) parts.push(`csrftoken=${csrftoken}`);
  if (dsUserId) parts.push(`ds_user_id=${dsUserId}`);
  if (rur) parts.push(`rur=${rur}`);
  return { cookie: parts.join('; '), sessionid, csrftoken, dsUserId };
}

function makeHeaders(username, auth) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1',
    'X-IG-App-ID': WEB_APP_ID,
    'X-ASBD-ID': String(process.env.INSTAGRAM_ASBD_ID || DEFAULT_ASBD_ID),
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
    Cookie: auth.cookie
  };
  if (auth.csrftoken) headers['X-CSRFToken'] = auth.csrftoken;
  return headers;
}

async function fetchJson(name, url, headers, attempts) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(10000)
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = null;
    }

    attempts.push({
      name,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      finalHost: (() => {
        try { return new URL(response.url).hostname; } catch { return null; }
      })(),
      contentType: response.headers.get('content-type') || null,
      bodyLength: text.length,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 30) : [],
      upstreamMessage: safeMessage(payload)
    });

    return { response, payload, text };
  } catch (error) {
    attempts.push({
      name,
      status: 'ERROR',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error?.message || String(error)
    });
    return { response: null, payload: null, text: '' };
  }
}

function extractUser(payload) {
  const candidates = [
    payload?.data?.user,
    payload?.user,
    payload?.items?.[0]?.user,
    payload?.items?.[0]?.owner
  ].filter(Boolean);

  for (const user of candidates) {
    const id = user?.id ?? user?.pk ?? user?.pk_id;
    if (id != null) {
      return {
        id: String(id),
        username: user.username || null,
        fullName: user.full_name || null,
        isPrivate: Boolean(user.is_private),
        isVerified: Boolean(user.is_verified),
        profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
        latestReelMedia: Number(user.latest_reel_media || 0) || null
      };
    }
  }
  return null;
}

async function resolveUser(username, headers, attempts) {
  const encoded = encodeURIComponent(username);
  const candidates = [
    ['profile_www', `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encoded}`],
    ['profile_i', `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encoded}`],
    ['feed_username_www', `https://www.instagram.com/api/v1/feed/user/${encoded}/username/?count=1`],
    ['feed_username_i', `https://i.instagram.com/api/v1/feed/user/${encoded}/username/?count=1`]
  ];

  for (const [name, url] of candidates) {
    const result = await fetchJson(name, url, headers, attempts);
    if (!result.response?.ok || !result.payload) continue;
    const user = extractUser(result.payload);
    if (user?.id) return { user, source: name };
  }
  return null;
}

function selectBestImage(item) {
  const candidates = [
    ...(item?.image_versions2?.candidates || []),
    ...(item?.image_versions?.candidates || []),
    ...(item?.carousel_media?.[0]?.image_versions2?.candidates || [])
  ].filter((entry) => entry?.url);

  candidates.sort((a, b) => {
    const aa = Number(a.width || 0) * Number(a.height || 0);
    const bb = Number(b.width || 0) * Number(b.height || 0);
    return bb - aa;
  });
  return candidates[0]?.url || null;
}

function selectBestVideo(item) {
  const candidates = [
    ...(item?.video_versions || []),
    ...(item?.carousel_media?.[0]?.video_versions || [])
  ].filter((entry) => entry?.url);

  candidates.sort((a, b) => {
    const aa = Number(a.width || 0) * Number(a.height || 0);
    const bb = Number(b.width || 0) * Number(b.height || 0);
    return bb - aa;
  });
  return candidates[0]?.url || null;
}

function inferStoryType(item) {
  if (Number(item?.media_type) === 2 || (item?.video_versions || []).length) return 'video';
  if (Number(item?.media_type) === 1 || item?.image_versions2) return 'image';
  return 'unknown';
}

function unixToIso(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function mapStory(item, index) {
  const videoUrl = selectBestVideo(item);
  const imageUrl = selectBestImage(item);
  const type = inferStoryType(item);
  return {
    index,
    id: String(item?.pk ?? item?.id ?? ''),
    code: item?.code || null,
    type,
    takenAt: unixToIso(item?.taken_at),
    expiringAt: unixToIso(item?.expiring_at),
    width: Number(item?.original_width || item?.image_versions2?.candidates?.[0]?.width || 0) || null,
    height: Number(item?.original_height || item?.image_versions2?.candidates?.[0]?.height || 0) || null,
    imageUrl,
    videoUrl,
    hasAudio: typeof item?.has_audio === 'boolean' ? item.has_audio : null,
    itemKeys: Object.keys(item || {}).sort().slice(0, 80)
  };
}

function findStoryContainer(payload, userId) {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.reels && typeof payload.reels === 'object' && !Array.isArray(payload.reels)) {
    const direct = payload.reels[userId];
    if (direct) return direct;
    const first = Object.values(payload.reels).find((value) => value && typeof value === 'object');
    if (first) return first;
  }

  if (Array.isArray(payload.reels_media)) {
    return payload.reels_media.find((entry) => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId))
      || payload.reels_media[0]
      || null;
  }

  if (Array.isArray(payload.reels)) {
    return payload.reels.find((entry) => String(entry?.id ?? entry?.user?.pk ?? '') === String(userId))
      || payload.reels[0]
      || null;
  }

  return null;
}

async function fetchStories(username, userId, headers, attempts) {
  const encodedId = encodeURIComponent(userId);
  const candidates = [
    ['stories_www_reel_ids', `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodedId}`],
    ['stories_i_reel_ids', `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodedId}`],
    ['stories_www_user_ids', `https://www.instagram.com/api/v1/feed/reels_media/?user_ids=${encodedId}`],
    ['stories_i_user_ids', `https://i.instagram.com/api/v1/feed/reels_media/?user_ids=${encodedId}`]
  ];

  let firstSuccessfulEmpty = null;

  for (const [name, url] of candidates) {
    const result = await fetchJson(name, url, headers, attempts);
    if (!result.response?.ok || !result.payload) continue;

    const container = findStoryContainer(result.payload, userId);
    if (container) {
      const items = Array.isArray(container.items) ? container.items : [];
      return {
        source: name,
        items,
        containerKeys: Object.keys(container).sort().slice(0, 80),
        payloadKeys: Object.keys(result.payload).sort().slice(0, 80)
      };
    }

    const payloadKeys = Object.keys(result.payload || {});
    const looksValidButEmpty =
      result.payload?.status === 'ok'
      || payloadKeys.includes('reels')
      || payloadKeys.includes('reels_media');

    if (looksValidButEmpty && !firstSuccessfulEmpty) {
      firstSuccessfulEmpty = {
        source: name,
        items: [],
        containerKeys: [],
        payloadKeys: payloadKeys.sort().slice(0, 80)
      };
    }
  }

  return firstSuccessfulEmpty;
}

function jsonError(res, status, error, extra = {}) {
  res.status(status).json({ ok: false, error, ...extra });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method !== 'GET') {
    jsonError(res, 405, 'GETのみ対応しています。');
    return;
  }

  const configuredKey = String(process.env.STORY_DIAGNOSTIC_KEY || '');
  if (!configuredKey) {
    jsonError(res, 503, 'STORY_DIAGNOSTIC_KEY が未設定です。Vercel Environment Variablesに設定してください。', {
      setupRequired: true
    });
    return;
  }

  const suppliedKey = headerValue(req.headers?.['x-story-diagnostic-key']);
  if (!suppliedKey || suppliedKey !== configuredKey) {
    jsonError(res, 401, 'Story診断キーが一致しません。');
    return;
  }

  let username;
  try {
    username = normalizeUsername(req.query?.username);
  } catch (error) {
    jsonError(res, 400, error.message);
    return;
  }

  const auth = buildCookie();
  if (!auth.sessionid) {
    jsonError(res, 503, 'INSTAGRAM_SESSIONID が未設定です。Vercel Environment Variablesにログイン済みセッションを設定してください。', {
      setupRequired: true,
      authConfigured: {
        sessionid: false,
        csrftoken: Boolean(auth.csrftoken),
        dsUserId: Boolean(auth.dsUserId)
      }
    });
    return;
  }

  const attempts = [];
  const headers = makeHeaders(username, auth);

  const resolved = await resolveUser(username, headers, attempts);
  if (!resolved?.user?.id) {
    jsonError(res, 502, 'InstagramユーザーIDを解決できませんでした。セッション期限切れ・checkpoint・Instagram側の仕様変更を確認してください。', {
      username,
      authConfigured: {
        sessionid: true,
        csrftoken: Boolean(auth.csrftoken),
        dsUserId: Boolean(auth.dsUserId)
      },
      attempts
    });
    return;
  }

  const storyResult = await fetchStories(username, resolved.user.id, headers, attempts);
  if (!storyResult) {
    jsonError(res, 502, 'Storyエンドポイントから有効なJSONを取得できませんでした。', {
      username,
      user: resolved.user,
      userResolveSource: resolved.source,
      attempts
    });
    return;
  }

  const stories = storyResult.items.slice(0, 50).map(mapStory);

  res.status(200).json({
    ok: true,
    diagnostic: 'instagram_story_session_probe_v1',
    checkedAt: new Date().toISOString(),
    username,
    user: resolved.user,
    userResolveSource: resolved.source,
    storySource: storyResult.source,
    activeStory: stories.length > 0,
    storyCount: stories.length,
    stories,
    shape: {
      payloadKeys: storyResult.payloadKeys,
      containerKeys: storyResult.containerKeys
    },
    authConfigured: {
      sessionid: true,
      csrftoken: Boolean(auth.csrftoken),
      dsUserId: Boolean(auth.dsUserId)
    },
    notes: [
      'Story CDN URLは署名付きで失効する可能性があるため長期保存しないでください。',
      'このAPIはInstagram非公開Web/API仕様に依存する診断用で、Instagram側の変更で壊れる可能性があります。',
      'STORY_DIAGNOSTIC_KEYはフロントへ固定埋め込みせず、診断時だけ入力してください。'
    ],
    attempts
  });
}
