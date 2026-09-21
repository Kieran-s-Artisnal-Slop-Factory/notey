import { describe, expect, it } from 'vitest';
import { manifestPaths } from './precache-manifest.mjs';

describe('the offline manifest', () => {
  it('serves a directory index at its directory', () => {
    // The worker stores a navigation under its pathname, so `/` and
    // `index.html` have to be ONE entry or the precached page is never the
    // one a later visit reads back.
    expect(manifestPaths(['index.html', 'notes/index.html'])).toEqual(['', 'notes/']);
  });

  it('keeps every other file at its own spelling', () => {
    expect(manifestPaths(['_astro/app.Bx1.js', 'math/fonts/KaTeX_Main-Regular.woff2'])).toEqual([
      '_astro/app.Bx1.js',
      'math/fonts/KaTeX_Main-Regular.woff2',
    ]);
  });

  it('leaves out the worker and the manifest itself', () => {
    // A cached copy of either can only hide a new deployment.
    expect(manifestPaths(['sw.js', 'precache.json', 'favicon.svg'])).toEqual(['favicon.svg']);
  });

  it('leaves out source maps and host plumbing', () => {
    expect(manifestPaths(['_astro/app.js.map', '.nojekyll', '.well-known/x', 'a.js'])).toEqual([
      'a.js',
    ]);
  });

  it('sorts, de-duplicates and strips a leading slash', () => {
    expect(manifestPaths(['./b.js', '/a.js', 'a.js'])).toEqual(['a.js', 'b.js']);
  });

  it('is empty for an empty build rather than throwing', () => {
    expect(manifestPaths([])).toEqual([]);
  });
});
