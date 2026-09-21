# Build and tooling

Commands, the generators that vendor assets, and how a release is cut.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## File map

| Path | Role |
| --- | --- |
| [package.json](../../package.json) | Scripts and pinned dependencies |
| [astro.config.mjs](../../astro.config.mjs) | Svelte and precache integrations, the Vue flags Crepe needs, the sqlite-wasm dev exclusion |
| [tools/astro-precache.mjs](../../tools/astro-precache.mjs) | Writes `dist/precache.json`, the service worker's download list |
| [.github/workflows/astro.yml](../../.github/workflows/astro.yml) | Build and deploy to GitHub Pages |
| [tools/preview-server.mjs](../../tools/preview-server.mjs) | Static server over `dist/`, used by the Playwright suite |
| [tools/build-courier-prime.mjs](../../tools/build-courier-prime.mjs) | Vendors the typeface |
| [tools/build-math-assets.mjs](../../tools/build-math-assets.mjs) | Vendors MathLive's stylesheets and the KaTeX faces it draws with |
| [tools/build-excalidraw-assets.mjs](../../tools/build-excalidraw-assets.mjs) | Vendors the drawing canvas's faces |
| [.claude/launch.json](../../.claude/launch.json) | Dev and preview server definitions |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server on 4321 |
| `npm run build` | Static build into `dist/` |
| `npm run preview` | Astro's own preview |
| `npm test` | Playwright: builds, serves `dist/` on 4340, runs the browser suite |
| `npm run test:unit` | Vitest over `src/**/*.test.ts` and `tools/**/*.test.mjs` |
| `npm run tauri:dev` | The desktop app against the dev server |
| `npm run tauri:build` | The desktop installer (needs Rust) |

There is no typecheck script and no linter: a type error does not fail the
build. `astro check` is the thing to add when that stops being acceptable.

## Astro config

Four things in there are load-bearing:

- `integrations: [svelte(), precache()]` — static output, no adapter.
- `precache()` hooks `astro:build:done`, walks `dist/` and writes
  `precache.json`: every file the build emitted, which the service worker
  downloads in full on the first visit. See
  [service-worker-and-offline.md](service-worker-and-offline.md).
- `vite.define` sets `__VUE_OPTIONS_API__`, `__VUE_PROD_DEVTOOLS__` and
  `__VUE_PROD_HYDRATION_MISMATCH_DETAILS__` to `'false'`. Milkdown Crepe
  renders its feature UIs with Vue's runtime, which warns and keeps dead code
  paths alive without them.
- `vite.optimizeDeps.exclude: ['@sqlite.org/sqlite-wasm']` — the package
  resolves its `.wasm` relative to its own module URL, and dev pre-bundling
  rewrites that to a `.vite/deps` path that 404s.

`base` is deliberately **not** set here: local dev and the Tauri build serve
from the root, and CI passes `--base "/notey"`, which is authoritative for
what is published.

## Vendored assets

Generators are plain Node ESM, run **by hand**, and their outputs are
**committed**. They never run on install, build or CI.

```bash
node tools/build-courier-prime.mjs      # public/fonts/
node tools/build-math-assets.mjs        # public/math/
node tools/build-excalidraw-assets.mjs  # public/excalidraw/
```

Every vendored directory carries a `PROVENANCE.txt` recording the source, the
licence, and each file's byte count and SHA-256. `math/fonts.test.ts` and
`notebook/drawing.test.ts` check the asset lists against those files, so a
half-finished re-vendor fails the unit suite rather than shipping.

Licences in use: Courier Prime and KaTeX's faces are SIL OFL 1.1; the
Excalidraw faces ship under their own licences recorded in their provenance
file.

## Dependencies

Versions are pinned to `useful`'s known-good set, because the editor stack was
ported from there and Milkdown, ProseMirror, CodeMirror and Excalidraw are all
sensitive to each other's versions. Upgrading one of those means running the
browser suite, not just the unit suite.

## Deployment

Push to `master` or `main`. The workflow installs with `npm ci` on Node 25,
runs `astro build --site "https://kieranwood.ca" --base "/notey"`, and
publishes `dist/` to GitHub Pages.

**CI runs no tests.** That is inherited from useful and is a deliberate
trade — a red suite still deploys — kept because this is a personal app where
the alternative is a slower loop. It is one job away from changing.

The desktop app has no CI: `npm run tauri:build` is run locally, on the
platform being built for.

## Releasing

1. `VERSION` and `package.json`'s `version` say the same thing.
2. `CHANGELOG.md` has the entries under that heading, with the date.
3. Both suites are green: `npm run test:unit` and `npm test`.
4. The docs describe the code as it now is, including the version banner on
   every page and the schema number when it changed.
5. Commit: `git add VERSION CHANGELOG.md && git commit -m "Release $(cat VERSION)"`.

A schema change needing a migration is at least a minor bump.

## Known limits and decisions

- **`package.json` and `VERSION` are kept in step by hand.** Nothing reads
  `VERSION` at runtime; it exists so scripts and humans have one place to
  look.
- **No `postinstall`, no codegen at build time.** Everything generated is
  committed, so a clone builds with `npm ci && npm run build` and nothing
  else.
- **The preview server is ours rather than `astro preview`.** Astro 7's
  preview daemonises itself under a non-TTY stdin, so Playwright sees the
  process exit and aborts the run.
