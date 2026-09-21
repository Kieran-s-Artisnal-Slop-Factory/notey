/**
 * Astro integration: write `precache.json` next to the build.
 *
 * The service worker downloads everything in it during `install`, so the
 * first visit is the only one that needs a network — every page, every lazy
 * chunk, the sqlite engine, the fonts. Nothing here decides policy; it just
 * reports what the build emitted (see `precache-manifest.mjs` for the rules).
 *
 * `astro:build:done` hands over the output directory and the emitted routes.
 * The directory walk is the source of truth rather than `assets`, because
 * that list omits `public/` files — which is where the fonts, the icons and
 * the vendored maths live.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

import { PRECACHE_FILE, manifestPaths } from './precache-manifest.mjs';

/** Every file under `dir`, as POSIX paths relative to it. */
async function walk(dir, root = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** @returns {import('astro').AstroIntegration} */
export default function precache() {
  return {
    name: 'notey:precache',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        const files = manifestPaths(await walk(out));
        await writeFile(
          join(out, PRECACHE_FILE),
          JSON.stringify({ built: new Date().toISOString(), files }, null, 1),
          'utf8'
        );
        logger.info(`${PRECACHE_FILE}: ${files.length} files for the offline cache`);
      },
    },
  };
}
