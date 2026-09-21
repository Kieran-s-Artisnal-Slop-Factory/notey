/*
 * notey service worker — full offline support.
 *
 * Ported from useful's worker, which encodes a fixed bug in nearly every
 * line (ignoreVary, activate-blocking, non-Response rejection). Structure:
 *  - Install: cache the app SHELL (pages + icons + typeface) and nothing
 *    else, so the worker installs in a moment and never competes with the
 *    booting app.
 *  - Activate: purge old caches, claim clients, then download EVERYTHING
 *    the build emitted — every lazy chunk, the sqlite engine, every font —
 *    from `precache.json`, flat out, in the background. One visit is all
 *    it takes; after that the network is optional, including for pages and
 *    features never opened.
 *  - Navigations (HTML): network-first (with retry); offline serves the
 *    cached copy (or the cached home page).
 *  - Assets: stale-while-revalidate; a miss goes to the network with retry.
 *
 * `precache.json` is written by tools/astro-precache.mjs at build time. The
 * worker used to CRAWL instead — cache the shell, regex `_astro/…` out of
 * it, follow what it found — because Astro emits no manifest. A regex over
 * minified code is a guess, and a chunk it guessed wrong about was simply
 * missing the first time someone opened that feature offline. The build
 * knows the file list exactly, so it writes it down.
 */

// Only meaningful for the purge below: the worker keeps ONE app cache, and
// a precache run deletes whatever the current build no longer lists (see
// `prune`), so a stale entry cannot survive a deployment either way.
const CACHE_NAME = 'notey-cache-v3';

// Everything under this prefix belongs to this app. Cache Storage is keyed
// by ORIGIN, not by service-worker scope; scoping deletion to the prefix
// keeps a co-hosted app's caches out of our purge.
const CACHE_PREFIX = 'notey-cache-';

// The worker is registered from `${base}/sw.js`, so its scope IS the Astro
// base ('/' at the root, '/notey/' on GitHub Pages).
const BASE = new URL(self.registration.scope).pathname; // always ends with '/'

// The build's own list of everything it serves. Relative paths, so this
// same file works wherever the app is mounted.
const MANIFEST_URL = BASE + 'precache.json';

// The worker's own note of what the last complete run cached, and what the
// build BEFORE that one cached (see `prune`). A cache key only — nothing is
// ever fetched from here.
const STATE_URL = BASE + '__notey-precache-state';

// One page: settings live inside the command palette, not on a route.
const SHELL = ['', 'favicon.svg', 'favicon-maskable.svg', 'manifest.webmanifest'].map(
  (p) => BASE + p
);

// Stable vendored files fetched by name at run time: the KaTeX faces
// MathLive draws with, the Excalidraw canvas faces, and notey's own Courier
// Prime. Their bucket sits deliberately OUTSIDE CACHE_PREFIX so a
// CACHE_NAME bump never re-downloads unchanged fonts. Only the worker
// reads it: the page asks the worker (see src/lib/offline.ts) rather than
// opening caches of its own.
const FONT_CACHE = 'notey-fonts-v1';
const FONT_PREFIXES = [BASE + 'math/', BASE + 'excalidraw/', BASE + 'fonts/'];
const isFontAsset = (path) => FONT_PREFIXES.some((prefix) => path.startsWith(prefix));

// The typeface is part of the first paint, so it precaches at install
// (into its own bucket) instead of waiting for the full run.
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

// How many precache fetches are in flight at once. There is deliberately no
// delay between them and no ceiling on how many run: the whole point is that
// the first visit pays for every later one. Six keeps a browser's connection
// pool busy without burying the host.
const PRECACHE_CONCURRENCY = 6;

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
 * The build's file list, as absolute paths.
 *
 * Read past the HTTP cache (`reload`), or a deployment could stay invisible
 * for as long as the previous manifest is fresh. The copy kept in the cache
 * is the fallback for an offline status check — never for a download, which
 * needs the network anyway.
 */
async function loadManifest() {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetchWithRetry(new Request(MANIFEST_URL, { cache: 'reload' }));
    if (response.ok) {
      await cache.put(MANIFEST_URL, response.clone());
      return readManifest(await response.json());
    }
  } catch {
    // Offline. Fall through to whatever the last run wrote down.
  }
  const cached = await cache.match(MANIFEST_URL, MATCH_OPTS);
  return readManifest(cached ? await cached.json() : null);
}

/** `{ built, urls }` — which build this is, and every file in it. */
function readManifest(manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return {
    built: String(manifest?.built ?? ''),
    urls: files.filter((f) => typeof f === 'string').map((f) => BASE + f),
  };
}

async function readState(cache) {
  try {
    const response = await cache.match(STATE_URL);
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Which of `urls` are not in a cache yet, with the cache each belongs in. */
async function missingFrom(urls, app, fonts) {
  const missing = [];
  for (const url of urls) {
    const cache = isFontAsset(url) ? fonts : app;
    if (!(await cache.match(url, MATCH_OPTS))) missing.push([url, cache]);
  }
  return missing;
}

/**
 * Drop everything neither this build nor the one before it lists.
 *
 * This is what makes the single app cache safe: stale hashed chunks leave on
 * their own, without the version-bump-by-hand step that only works when
 * somebody remembers it.
 *
 * ONE previous build is kept, not zero. A tab opened before an update is
 * still running the old build's code once this worker claims it, and the
 * lazy chunks it has not loaded yet exist nowhere else — the host replaced
 * them. Pruning them at once would break that tab's first diagram or drawing
 * until a reload, offline or not. They go when the build after this one is
 * cached, by which time nothing should still be running them.
 */
async function prune(cache, wanted) {
  for (const request of await cache.keys()) {
    if (!wanted.has(new URL(request.url).pathname)) await cache.delete(request);
  }
}

/**
 * Download the whole build.
 *
 * Returns true when every file is cached — only then is it safe to prune,
 * because a half-finished run says nothing about what the build contains.
 */
async function precacheAll(onProgress) {
  const { built, urls } = await loadManifest();
  if (urls.length === 0) return false; // no manifest: never prune on a guess
  const app = await caches.open(CACHE_NAME);
  const fonts = await caches.open(FONT_CACHE);
  const queue = await missingFrom(urls, app, fonts);
  const total = queue.length;
  let done = 0;
  let failed = 0;
  onProgress?.(done, total);

  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [url, cache] = job;
      try {
        const response = await fetchWithRetry(url);
        if (response.ok) await cache.put(url, response);
        else failed++;
      } catch {
        failed++; // offline, or a file the host will not serve
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PRECACHE_CONCURRENCY, Math.max(total, 1)) }, worker)
  );

  if (failed > 0) return false;
  // The same build run again keeps the generation it already remembered; a
  // new build demotes the one the state describes to "previous".
  const state = await readState(app);
  const previous = !state
    ? []
    : state.built === built
      ? (state.previous ?? [])
      : (state.urls ?? []);
  await app.put(
    STATE_URL,
    new Response(JSON.stringify({ built, urls, previous }), {
      headers: { 'content-type': 'application/json' },
    })
  );
  const wanted = new Set([...urls, ...previous, MANIFEST_URL, STATE_URL]);
  await prune(app, wanted);
  await prune(fonts, wanted);
  return true;
}

// Browsers terminate idle service workers, so a long download is regularly
// cut short. These live for the lifetime of one worker instance: a restarted
// worker runs again, skips everything already cached, and picks up where the
// last run stopped. `activate` fires only once, so fetches re-kick it.
let precachePromise = null;
let precacheDone = false;

function precacheOnce() {
  if (precacheDone) return Promise.resolve();
  if (!precachePromise) {
    precachePromise = precacheAll()
      .then((complete) => {
        precacheDone = complete;
      })
      .catch(() => {})
      .finally(() => {
        precachePromise = null;
      });
  }
  return precachePromise;
}

self.addEventListener('install', (event) => {
  // The shell only. A download of the whole build belongs in `activate`'s
  // background, not in front of the worker taking over: a worker is not
  // "installed" until this settles, and an install the browser kills part
  // way through has to start over.
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
        // Downloaded in the background — NOT inside this waitUntil. A worker
        // is "activating" until its activate promise settles, and the
        // browser holds navigations and worker-script loads to an activating
        // worker: with the download in here, every click on a fresh install
        // waits for the whole build. The fetch handler's own
        // waitUntil(precacheOnce()) keeps the worker alive instead.
        void precacheOnce();
      })
  );
});

/**
 * The offline-copy controls in Settings.
 *
 *   { type: 'notey-offline', action: 'status' }   → how much is missing
 *   { type: 'notey-offline', action: 'download' } → fetch the rest now
 *
 * Only the worker can answer either: the page cannot see the manifest, and
 * the caches it would have to count are the worker's.
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'notey-offline') return;
  const source = event.source;
  const reply = (message) => source?.postMessage?.(message);
  event.waitUntil(
    (async () => {
      try {
        if (data.action === 'status') {
          const { urls } = await loadManifest();
          const missing = await missingFrom(
            urls,
            await caches.open(CACHE_NAME),
            await caches.open(FONT_CACHE)
          );
          reply({
            type: 'notey-offline-status',
            ready: urls.length > 0 && missing.length === 0,
            missing: missing.length,
            total: urls.length,
          });
          // Asking is also a nudge. A run that ended short (a host that ran
          // out of sockets, a worker the browser stopped, a file evicted
          // since) is otherwise resumed only by the next fetch — and a page
          // sitting on Settings makes none, so the answer would say "25 still
          // to download" for ever. The count just taken is proof enough that
          // "done" is out of date, whatever this worker last believed.
          if (urls.length > 0 && missing.length > 0) {
            precacheDone = false;
            await precacheOnce();
          }
          return;
        }
        if (data.action === 'download') {
          const complete = await precacheAll((done, total) =>
            reply({ type: 'notey-offline-progress', done, total })
          );
          precacheDone = complete;
          reply({ type: 'notey-offline-done', complete });
        }
      } catch (err) {
        reply({ type: 'notey-offline-error', error: String(err) });
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Resume an interrupted download. Cheap once it has finished, and the
  // in-flight request keeps the worker alive long enough to make more
  // progress across normal use.
  event.waitUntil(precacheOnce());

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
  if (isFontAsset(url.pathname)) {
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
