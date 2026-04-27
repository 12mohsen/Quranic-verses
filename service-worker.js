/* Quran PWA Service Worker */
const VERSION = 'v1.0.1';
const STATIC_CACHE    = `quran-static-${VERSION}`;
const RUNTIME_CACHE   = `quran-runtime-${VERSION}`;
const AUDIO_CACHE     = `quran-audio-${VERSION}`;
// User-initiated downloads — STABLE name (preserved across SW updates)
const DOWNLOADS_CACHE = 'quran-downloads-v1';

// Files to precache on install (app shell + local data)
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './quran-simple.sql',
  './Quran .txt',
  // CDN assets (best-effort; failures are ignored individually)
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap'
];

// ---------- INSTALL ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Cache each url individually so one failing URL won't break install
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const req = new Request(url, { cache: 'reload' });
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(url, res);
        }
      } catch (e) { /* ignore */ }
    }));
    // Do NOT auto-skipWaiting: let the page prompt the user
  })());
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (![STATIC_CACHE, RUNTIME_CACHE, AUDIO_CACHE, DOWNLOADS_CACHE].includes(k)) {
        return caches.delete(k);
      }
    }));
    await self.clients.claim();
  })());
});

// ---------- MESSAGE (for update flow) ----------
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigation requests -> serve index.html offline
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }

  // Audio (mp3) -> check user downloads first, then on-demand cache, then network
  if (/\.(mp3|ogg|m4a|aac|wav)(\?|$)/i.test(url.pathname)) {
    event.respondWith(audioStrategy(req));
    return;
  }

  // Known API endpoints -> network-first (fresh data when online, cached when offline)
  if (
    url.hostname === 'api.alquran.cloud' ||
    url.hostname === 'www.mp3quran.net' ||
    url.hostname === 'mp3quran.net'
  ) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // Google Fonts / Font Awesome / other CDN assets -> stale-while-revalidate
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'cdnjs.cloudflare.com'
  ) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // Same-origin assets -> cache-first, fall back to network
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Default: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

// ---------- STRATEGIES ----------
async function audioStrategy(req) {
  // 1) Look in user-downloads cache (preserved across versions)
  const dlCache = await caches.open(DOWNLOADS_CACHE);
  const downloaded = await dlCache.match(req, { ignoreSearch: true, ignoreVary: true });
  if (downloaded) return downloaded;
  // 2) Look in transient audio cache
  const audioCache = await caches.open(AUDIO_CACHE);
  const cached = await audioCache.match(req, { ignoreSearch: true, ignoreVary: true });
  if (cached) return cached;
  // 3) Network — and cache opportunistically (range requests skipped)
  try {
    const res = await fetch(req);
    const isRange = req.headers.has('range');
    if (!isRange && res && (res.status === 200 || res.type === 'opaque')) {
      audioCache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // last resort — try downloads with looser match
    const fallback = await dlCache.match(req.url, { ignoreSearch: true });
    if (fallback) return fallback;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const fallback = await cache.match(req, { ignoreSearch: true });
    if (fallback) return fallback;
    throw err;
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

async function networkFirstPage(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(STATIC_CACHE);
    cache.put('./index.html', res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cache = await caches.open(STATIC_CACHE);
    return (await cache.match('./index.html')) ||
           (await cache.match('index.html')) ||
           Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);
  return cached || (await fetchPromise) || Response.error();
}
