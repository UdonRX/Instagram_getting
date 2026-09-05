const instagramVideoResolverCache = new Map();
const observedVideoFallbacks = new WeakSet();

function extractInstagramShortcode(url) {
  try {
    const parsed = new URL(url, location.href);
    const match = parsed.pathname.match(/^\/(?:p|reel)\/([A-Za-z0-9_-]{5,64})\/?/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function resolveInstagramVideo(shortcode) {
  if (!shortcode) return Promise.reject(new Error('shortcodeがありません。'));
  if (instagramVideoResolverCache.has(shortcode)) return instagramVideoResolverCache.get(shortcode);

  const promise = fetch(`/api/video-resolve?shortcode=${encodeURIComponent(shortcode)}&kind=auto&t=${Date.now()}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.videoUrl) {
      throw new Error(data.error || `動画URL解決 HTTP ${response.status}`);
    }
    return data;
  }).catch((error) => {
    instagramVideoResolverCache.delete(shortcode);
    throw error;
  });

  instagramVideoResolverCache.set(shortcode, promise);
  return promise;
}

function isStandaloneVideoFallback(anchor) {
  const card = anchor.closest('.ig-card');
  const type = card?.querySelector('.ig-type')?.textContent?.trim()?.toLowerCase();
  return type === 'video';
}

function pauseOtherInstagramVideos(activeVideo) {
  document.querySelectorAll('.ig-card video').forEach((video) => {
    if (video !== activeVideo && !video.paused) video.pause();
  });
}

function makeResolvedVideo(anchor, data, shortcode) {
  const img = anchor.querySelector('img');
  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = data.videoUrl;
  video.poster = data.posterUrl || img?.src || '';
  video.dataset.instagramShortcode = shortcode;
  video.dataset.videoResolverSource = data.source || 'individual_embed_html';
  video.addEventListener('play', () => pauseOtherInstagramVideos(video));
  video.addEventListener('error', () => {
    const fallback = document.createElement('a');
    fallback.className = 'video-fallback video-fallback-error';
    fallback.href = anchor.href;
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.innerHTML = `${img ? img.outerHTML : ''}<span class="play-mark">再生不可 ↗</span>`;
    video.replaceWith(fallback);
  }, { once: true });
  return video;
}

async function activateInternalVideo(anchor) {
  if (anchor.dataset.videoResolving === '1') return;
  const shortcode = extractInstagramShortcode(anchor.href);
  if (!shortcode) return;

  anchor.dataset.videoResolving = '1';
  const mark = anchor.querySelector('.play-mark');
  const previousLabel = mark?.textContent || '▶';
  if (mark) mark.textContent = '取得中…';

  try {
    const data = await resolveInstagramVideo(shortcode);
    const video = makeResolvedVideo(anchor, data, shortcode);
    anchor.replaceWith(video);
    try { await video.play(); } catch { /* Safari may require one more tap; controls stay visible. */ }
  } catch (error) {
    anchor.dataset.videoResolving = '0';
    anchor.dataset.videoResolveError = error.message;
    if (mark) mark.textContent = 'Instagram ↗';
    anchor.dataset.videoResolverFailed = '1';
    console.warn('[Instagram video resolver]', shortcode, error);
  } finally {
    if (anchor.isConnected && mark && !anchor.dataset.videoResolverFailed) mark.textContent = previousLabel;
  }
}

document.addEventListener('click', (event) => {
  const anchor = event.target.closest('a.video-fallback');
  if (!anchor || !isStandaloneVideoFallback(anchor)) return;
  if (anchor.dataset.videoResolverFailed === '1') return;

  const shortcode = extractInstagramShortcode(anchor.href);
  if (!shortcode) return;
  event.preventDefault();
  activateInternalVideo(anchor);
}, true);

const prefetchObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const anchor = entry.target;
        prefetchObserver.unobserve(anchor);
        const shortcode = extractInstagramShortcode(anchor.href);
        if (shortcode) resolveInstagramVideo(shortcode).catch(() => {});
      }
    }, { rootMargin: '700px 0px' })
  : null;

function observeVideoFallbacks() {
  document.querySelectorAll('a.video-fallback').forEach((anchor) => {
    if (observedVideoFallbacks.has(anchor) || !isStandaloneVideoFallback(anchor)) return;
    observedVideoFallbacks.add(anchor);
    const shortcode = extractInstagramShortcode(anchor.href);
    if (!shortcode) return;
    if (prefetchObserver) prefetchObserver.observe(anchor);
    else resolveInstagramVideo(shortcode).catch(() => {});
  });
}

const videoMutationObserver = new MutationObserver(observeVideoFallbacks);
videoMutationObserver.observe(document.documentElement, { childList: true, subtree: true });
observeVideoFallbacks();
