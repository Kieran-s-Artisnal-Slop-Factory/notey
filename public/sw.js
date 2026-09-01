/*
 * notey service worker — full offline support.
 *
 * Ported from useful's worker, which encodes a fixed bug in nearly every
 * line (ignoreVary, activate-blocking, backtick imports, prefix-scoped
 * purge, non-Response rejection). Structure:
 *  - Install: cache only the app SHELL (pages + icons + typeface). Fast,
 *    small, never competing with the booting app for the host's rate limit.
 *  - Activate: purge old caches, claim clients, then crawl the
 *    fingerprinted _astro/ asset graph in the BACKGROUND — one file at a
 *    time, with a delay between each and a hard cap — so pages never
 *    visited still work offline.
 *  - Navigations (HTML): network-first (with retry); offline serves the
 *    cached copy (or the cached home page).
 *  - Assets: stale-while-revalidate; a miss goes to the network with retry.
 */

// Bump this on any meaningful change to this file: `activate` only purges
// caches whose name differs.
const CACHE_NAME = 'notey-cache-v1';

// Everything under this prefix belongs to this app. Cache Storage is keyed
// by ORIGIN, not by service-worker scope; scoping deletion to the prefix
// keeps a co-hosted app's caches out of our purge.
const CACHE_PREFIX = 'notey-cache-';

// The worker is registered from `${base}/sw.js`, so its scope IS the Astro
// base ('/' at the root, '/notey/' on GitHub Pages).
const BASE = new URL(self.registration.scope).pathname; // always ends with '/'
const ASSET_PREFIX = BASE + '_astro/';
// A build asset is ONE path segment with an extension. Minified code is
// full of strings that look like relative paths but are not files in this
// build (Excalidraw alone contributes hundreds); anything with a slash
// after the prefix, or no extension, is not ours.
const ASSET_FILE = /^[^/]+\.[A-Za-z0-9]+$/;
const SHELL = ['', 'settings/', 'favicon.svg', 'favicon-maskable.svg', 'manifest.webmanifest'].map(
  (p) => BASE + p
);

// Stable vendored files fetched by name at run time (the _astro/ crawl can
// never discover them): the KaTeX faces, the Excalidraw canvas faces, and
// notey's own Courier Prime. Their bucket sits deliberately OUTSIDE
// CACHE_PREFIX so a CACHE_NAME bump never re-downloads unchanged fonts.
// Mirrored by FONT_CACHE in src/lib/math/fonts.ts.
const FONT_CACHE = 'notey-fonts-v1';
const FONT_PREFIXES = [BASE + 'math/', BASE + 'excalidraw/', BASE + 'fonts/'];
// The typeface is part of the first paint, so it precaches at install
// (into its own bucket) instead of waiting to be fetched once.
const FONT_SHELL = [
  'fonts/fonts.css',
  'fonts/CourierPrime-Regular.woff2',
  'fonts/CourierPrime-Bold.woff2',
  'fonts/CourierPrime-RegularItalic.woff2',
  'fonts/CourierPrime-BoldItalic.woff2',
].map((p) => BASE + p);

// Servers often send `Vary: Origin`, and module import() requests carry an
// Origin header while our install-time fetches don't — without ignoreVary
// the cache would refuse to serve cached chunks to module loads.
const MATCH_OPTS = { ignoreVary: true };

// Navigations also ignore query strings: /?note=<x> is cached as /.
const NAV_OPTS = { ignoreVary: true, ignoreSearch: true };

// Background-warm pacing: gap between fetches and a ceiling on how many
// the crawl will pull, so a large bundle can't hammer the host.
const WARM_DELAY_MS = 120;
const WARM_MAX_ASSETS = 600;

// The crawl never follows wasm/data payloads (sqlite-wasm's engine is
// referenced from its chunk); they cache on first use like any asset.
const CRAWL_SKIP = /\.(wasm|data)$/;

/** Transient failures worth retrying (throttles and gateway hiccups). */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with exponential backoff on 429/5xx and network errors. Returns the
 * final Response even if it is still an error status (callers decide);
 * throws only when every attempt threw.
 */
async function fetchWithRetry(request) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    try {
      const response = await fetch(request);
      if (!RETRY_STATUS.has(response.status) || attempt === RETRY_ATTEMPTS - 1) return response;
      lastError = new Error('HTTP ' + response.status);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Offline navigation fallback: exact page → trailing-slash page → home. */
async function cachedNavigation(request, url) {
  const cache = await caches.open(CACHE_NAME);
  const withSlash = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  return (
    (await cache.match(request, NAV_OPTS)) ??
    (await cache.match(withSlash, NAV_OPTS)) ??
    (await cache.match(BASE, NAV_OPTS))
  );
}

/** Install-time: the app shell and the typeface. Small and bounded. */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    SHELL.map(async (url) => {
      try {
        const response = await fetchWithRetry(url);
        if (response.ok) await cache.put(url, response.clone());
      } catch {
        // Offline during install — the fetch handler fills this in later.
      }
    })
  );
  const fonts = await caches.open(FONT_CACHE);
  await Promise.all(
    FONT_SHELL.map(async (url) => {
      try {
        if (await fonts.match(url, MATCH_OPTS)) return;
        const response = await fetchWithRetry(url);
        if (response.ok) await fonts.put(url, response.clone());
      } catch {
        // Same story.
      }
    })
  );
}

/**
 * Crawl the cached HTML/JS/CSS for fingerprinted _astro/ assets (including
 * dynamically imported chunks) and cache them, slowly, after activation.
 * Never awaited by anything the app is waiting on.
 */
async function warmAssetCache({ paced = true, onProgress } = {}) {
  const cache = await caches.open(CACHE_NAME);
  const seen = new Set(SHELL);
  const queue = [...SHELL];
  let fetched = 0;

  while (queue.length > 0 && fetched < WARM_MAX_ASSETS) {
    const url = queue.shift();
    let response = await cache.match(url, MATCH_OPTS);
    if (!response) {
      // Pacing protects the host from a burst while the app is booting. A
      // user who explicitly asked to download everything is waiting for
      // it, so that run goes flat out.
      if (paced) await sleep(WARM_DELAY_MS);
      try {
        response = await fetchWithRetry(url);
      } catch {
        continue; // genuinely offline; the next activation resumes the crawl
      }
      fetched++;
      onProgress?.(fetched, queue.length);
      if (!response.ok) continue; // never cache a non-ok response
      await cache.put(url, response.clone());
    }
    const type = response.headers.get('content-type') || '';
    if (!/html|javascript|css/.test(type)) continue;
    const text = await response.clone().text();
    const enqueue = (path) => {
      if (
        path.startsWith(ASSET_PREFIX) &&
        ASSET_FILE.test(path.slice(ASSET_PREFIX.length)) &&
        !seen.has(path) &&
        !CRAWL_SKIP.test(path)
      ) {
        seen.add(path);
        queue.push(path);
      }
    };
    // Fingerprinted asset references, however the bundle spells them:
    // "/_astro/x.js" (HTML), "/base/_astro/x.js", or bare "_astro/x.js"
    // (Vite's __vite__mapDeps).
    for (const match of text.matchAll(/_astro\/[A-Za-z0-9_.\-]+/g)) {
      enqueue(BASE + match[0]);
    }
    // Relative specifiers — the bundler emits dynamic imports with
    // BACKTICKS, e.g. import(`./chunk.js`), so all three quote styles count.
    const from = new URL(url, self.location.origin);
    for (const match of text.matchAll(/['"`](\.{1,2}\/[A-Za-z0-9_.\-/]+)['"`]/g)) {
      try {
        enqueue(new URL(match[1], from).pathname);
      } catch {
        // not a resolvable path — ignore
      }
    }
  }
}

// Browsers terminate idle service workers, and a paced crawl spends most of
// its time sleeping — so a warm run is regularly cut short. These live for
// the lifetime of one worker instance: a restarted worker re-runs the
// crawl, which skips everything already cached, and picks up where the
// last run stopped. `activate` fires only once, so fetches re-kick it.
let warmPromise = null;
let warmDone = false;

function warmOnce() {
  if (warmDone) return Promise.resolve();
  if (!warmPromise) {
    warmPromise = warmAssetCache()
      .then(() => {
        warmDone = true;
      })
      .catch(() => {})
      .finally(() => {
        warmPromise = null;
      });
  }
  return warmPromise;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
      .then(() => {
        // Warm in the background — NOT inside this waitUntil. A worker is
        // "activating" until its activate promise settles, and the browser
        // holds navigations and worker-script loads to an activating
        // worker: with the crawl in here, every click on a fresh install
        // hangs for as long as the crawl runs. The fetch handler's own
        // waitUntil(warmOnce()) keeps the worker alive instead.
        void warmOnce();
      })
  );
});

/**
 * "Download everything for offline use". The app asks for the crawl
 * because only the worker can see the whole asset graph. Progress goes
 * back as messages.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'notey-warm') return;
  const source = event.source;
  const reply = (message) => source?.postMessage?.(message);
  event.waitUntil(
    (async () => {
      try {
        await warmAssetCache({
          paced: false,
          onProgress: (fetched) => reply({ type: 'notey-warm-progress', fetched }),
        });
        warmDone = true;
        reply({ type: 'notey-warm-done' });
      } catch (err) {
        reply({ type: 'notey-warm-error', error: String(err) });
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Resume an interrupted warm. Cheap once it has finished, and the
  // in-flight request keeps the worker alive long enough to make more
  // progress across normal use.
  event.waitUntil(warmOnce());

  if (request.mode === 'navigate') {
    // Network-first: fresh page when online, cached page offline. The
    // cache key is the bare pathname so /?note=a and /?note=b share one
    // entry.
    event.respondWith(
      (async () => {
        try {
          const response = await fetchWithRetry(request);
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy));
            return response;
          }
          // Server error after retries — a cached page beats an error page.
          return (await cachedNavigation(request, url)) ?? response;
        } catch {
          // Always resolve with a real Response: resolving respondWith
          // with a non-Response makes Chromium report a synthetic 503.
          return (await cachedNavigation(request, url)) ?? Response.error();
        }
      })()
    );
    return;
  }

  // Cache-first with no revalidation: vendored files are replaced by a
  // re-vendor under a new name, never edited in place.
  if (FONT_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONT_CACHE);
        const cached = await cache.match(request, MATCH_OPTS);
        if (cached) return cached;
        const response = await fetchWithRetry(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })()
    );
    return;
  }

  // Stale-while-revalidate for everything else.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, MATCH_OPTS);
      if (cached) {
        // Answer from cache now, refresh in the background.
        event.waitUntil(
          fetchWithRetry(request)
            .then(async (response) => {
              if (response.ok) {
                (await caches.open(CACHE_NAME)).put(request, response.clone());
              }
            })
            .catch(() => {})
        );
        return cached;
      }
      try {
        const response = await fetchWithRetry(request);
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      } catch {
        return Response.error(); // never a non-Response
      }
    })()
  );
});
