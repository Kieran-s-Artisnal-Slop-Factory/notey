// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

import precache from './tools/astro-precache.mjs';

// https://astro.build/config
export default defineConfig({
  // Serving under a sub-path (e.g. GitHub Pages at https://you.github.io/notey/)?
  // The CI workflow passes --base "/notey"; every in-app link, the service
  // worker, and the manifest resolve through it (src/lib/paths.ts). Leave it
  // off here so local dev serves at the root.
  // `precache()` writes dist/precache.json — the list the service worker
  // downloads in full during install, so everything works offline after one
  // visit. See docs/dev/service-worker-and-offline.md.
  integrations: [svelte(), precache()],
  vite: {
    // sqlite-wasm locates its .wasm relative to its own module URL; Vite's
    // dev-time pre-bundling rewrites that path to a .vite/deps URL that
    // 404s. Serve the package as-is in dev; the build handles it fine.
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
    // Milkdown Crepe (the rich editor) renders its feature UIs with Vue's
    // runtime. Vue's esm-bundler build reads these flags; leaving them
    // undefined logs a warning and keeps the Options API code paths alive.
    define: {
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
    }
  }
});
