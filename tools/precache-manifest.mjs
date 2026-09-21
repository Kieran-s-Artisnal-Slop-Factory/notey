/**
 * Every path a build serves, spelled the way the service worker asks for it.
 *
 * Astro emits no precache manifest, and the worker used to compensate by
 * CRAWLING: cache the shell, read it back, regex out `_astro/…` references,
 * follow those, repeat. That works right up until it doesn't — a chunk
 * referenced only from a string the regex does not match is a file that is
 * missing the first time someone opens that feature offline, and there is no
 * way to tell from the outside that it happened.
 *
 * The build knows the answer exactly. This module turns a list of emitted
 * files into the list of URL paths to fetch, and `astro-precache.mjs` writes
 * it to `precache.json` beside them.
 *
 * Paths are RELATIVE (no leading slash) so the same manifest works at the
 * domain root and under a sub-path: the worker prefixes its own scope.
 */

/** Where the manifest is written, and the one file that never lists itself. */
export const PRECACHE_FILE = 'precache.json';

/**
 * Never precached:
 *  - `sw.js` — the worker's own script. The browser refetches it on its own
 *    schedule to find updates; a cached copy of it could only get in the way.
 *  - the manifest — always read fresh, or a new build is invisible.
 */
const SKIP_FILES = new Set(['sw.js', PRECACHE_FILE]);

/** Source maps are for a debugger that is not running offline. */
const SKIP_EXT = /\.map$/;

/**
 * A directory index is served at its directory: `index.html` at `` (the base
 * itself) and `notes/index.html` at `notes/`. That is also the key the worker
 * stores navigations under, so the precached page and a later visit to it are
 * the same entry rather than two copies.
 */
function toUrlPath(file) {
  if (file === 'index.html') return '';
  return file.endsWith('/index.html') ? file.slice(0, -'index.html'.length) : file;
}

/**
 * @param {readonly string[]} files build-relative POSIX paths
 * @returns {string[]} URL paths to precache, sorted, without duplicates
 */
export function manifestPaths(files) {
  const paths = new Set();
  for (const file of files) {
    const clean = file.replace(/^\.?\//, '');
    if (!clean || SKIP_FILES.has(clean) || SKIP_EXT.test(clean)) continue;
    // Dot-files are host plumbing (`.nojekyll` and friends), never content.
    if (clean.split('/').some((part) => part.startsWith('.'))) continue;
    paths.add(toUrlPath(clean));
  }
  return [...paths].sort();
}
