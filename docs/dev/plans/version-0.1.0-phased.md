# notey — Version 0.1.0 plan (phased)

What 0.1.0 builds, split into phases with checkpoints where the full test
suite must pass before proceeding. The feature list comes from
[version-0.1.0.md](version-0.1.0.md), which stays as the raw wish list; this
file is the reviewed version of it — the same features with the technology
chosen, the impossible parts named, and the order they can be built in. Where
the two disagree, this file is the later thought.

Written 2026-08-31 against a fresh Astro 7 starter: no schema yet, no
`CACHE_NAME` yet, `VERSION` and `package.json` both reading `0.1.0`. The
notebook tool is ported from the sibling `useful` repo (v0.4.0, its schema
v16); per-file portability verdicts were taken by reading that source in full
and are recorded inline below.

> **Progress:** all ten phases landed, plus a UI rework taken during Phase 6
> (decision 10) that removed the sidebar built in Phase 4. 288 unit tests and
> 28 Playwright cases are green against the production build.

---

## Standing checklist — applies to EVERY phase

Adapted from useful's version-4-phased.md so a phase can be worked from this
file alone:

1. **If the data model changed:** the sqlite schema (`MIGRATIONS` in
   `src/lib/vault/sqliteStore.ts`, `user_version = MIGRATIONS.length`), the
   TypeScript types in `src/lib/vault/types.ts`, and the README's Storage
   section move in lockstep. Adequate tests: unit tests for the pure logic
   and a Playwright spec proving the UI writes what it claims — no data
   migration may strand an existing vault.
2. **Tests:** pure logic gets Vitest (`src/**/*.test.ts`); anything touching
   UI + storage gets a Playwright spec driving the real UI. Checkpoints run
   both suites (`npm run test:unit` + `npm test`); ordinary phases run the
   unit suite plus the specs they touched.
3. **CHANGELOG.md:** entries under `# 0.1.0 (unreleased)` in `Features` /
   `Bug Fixes` / `Other`. Brief — 2–4 sentences per change.
4. **PWA:** new pages join `SHELL` in `public/sw.js` and `CACHE_NAME` is
   bumped; links are built with `href()` so the GitHub Pages base works.
5. **Usability first:** this is a personal app. Keyboard operability and
   sensible contrast, but usability wins when the two collide.
6. **Docs:** every user-visible feature gets its page under `docs/dev/` and
   `docs/user/` (dev pages carry mermaid diagrams and code references; user
   pages end in Gotchas). Written in Phase 9 rather than per phase, because
   0.1.0 is one large build — the phase notes here are the interim record.
7. **TODO:** keep `docs/dev/plans/TODO` checked off as work lands, so a
   usage-limit interruption leaves a readable trail.

## Decisions taken up front

Settled; the phases below assume them. Each records why, because the reasons
are the part that ages.

1. **Notes are a virtual filesystem, not a table of rows.** Path is the
   primary key (`Notebook/Sub/Note.md`); a notebook is a top-level folder;
   the Pile is the set of root-level files. Chosen because the Tauri build
   must write real `.md` files — path semantics have to be first-class, and
   the browser build simply mirrors them into sqlite.
2. **Title IS the filename stem.** Renaming the title renames the file; old
   titles are kept in frontmatter `aliases` so `[[Old title]]` still
   resolves (useful's rename/alias behaviour, relocated to frontmatter).
   One source of truth; no drift between a `title:` key and the name on disk.
3. **Frontmatter is YAML, parsed with `yaml`, and preserved.** Known keys:
   `tags`, `aliases`, `created`, `updated`. Unknown keys are kept verbatim
   and shown in the header (above the red line, on the right) — the file
   belongs to the user, not to notey.
4. **sqlite-wasm persists via `opfs-sahpool` in a dedicated worker.** The
   default `opfs` VFS needs COOP/COEP headers that GitHub Pages will not
   send; the SAH-pool VFS works without them. Fallback when OPFS is missing
   entirely: an in-memory database exported/imported to localStorage on a
   debounce (data survives reloads; Settings says which tier you got).
5. **Search is a JS scan over the in-memory model, not FTS5.** The whole
   vault is already in memory (wiki links and backlinks need every body);
   scanning megabytes of text is instant at personal-vault scale. FTS5 can
   be revisited if vaults grow — recorded in far-fetched.md when someone asks.
6. **Assets are relative `.assets/` refs, capped at 2 MB each.** In Tauri
   they are real files next to the note's folder, so exported/synced `.md`
   files keep working in other tools; in the browser they are rows. The cap
   keeps the sqlite vault and HTML exports sane (useful's reasoning, kept).
7. **Design tokens keep useful's NAMES with paper VALUES.** The ported
   editor components consume `--surface-color`, `--color-stamp`, `--space-*`
   etc.; keeping the names makes the 4,800-line editor stack port nearly
   verbatim. Palette from the Tangent card-index inspiration: desk `#e7dec6`,
   paper `#f8f2e0`, ink `#221e16`, stamp red `#a8352c`, link blue `#28439c`.
8. **Tauri vault lives at `$DOCUMENT/Notey` in 0.1.0.** A folder picker is
   post-0.1.0; a fixed, capability-scoped path ships sooner and the fs scope
   stays narrow.
9. **CI deploys without running tests**, mirroring useful ("a red suite
   still deploys"); tests are a local release-gate obligation. Deviating is
   a one-line change later.
10. **No sidebar: the page, a book, and Ctrl+K.** *(Taken during Phase 6,
   replacing the sidebar built in Phase 4.)* notey opens on a blank
   unfiled page — a title and a sheet in an 8 × 11 shape — and every
   other control lives in the command palette, opened with Ctrl+K or by
   the book in the corner (closed on the page, open while the library
   shows). The palette is a stack of views rather than a menu that closes
   on every press: picking *View notebooks* stays open and shows them,
   because browsing takes several steps; only an action that puts you on
   a page (open a note, create one, print) closes it. The reason is the
   brief — "me and the page, with the ability to swap to other pages
   easily" — and a sidebar is permanently-visible furniture that competes
   with the writing for attention and width.

## Open questions

| # | Question | Needed by | Default if unanswered |
| --- | --- | --- | --- |
| 1 | Should the Pile also allow folders (making it just another notebook)? | Phase 4 | No — the Pile is flat by definition; a folder belongs in a notebook. |
| 2 | Dark theme in 0.1.0? | Phase 2 | Yes, cheap via `light-dark()`: darkened desk, dimmed paper ("writing by lamplight"). |
| 3 | Playwright oracle depth (useful has a typed diff oracle + trust gate) | Phase 8 | Port the app fixture + isolated-delta idea over the test hook; skip the sabotage reporter for 0.1.0 and record it in Known limits. |

## Phase overview

| Phase | Goal | New deps | Schema | Notes |
| --- | --- | --- | --- | --- |
| 0 | Repo scaffold: configs, CI, plans, theme, layout | svelte, tauri CLI (all installed up front) | — | **DONE.** Unblocks everything |
| 1 | Port the pure libs + their tests from useful | — | — | **DONE.** Mechanical; unit suite green |
| 2 | Paper design system: theme.css, global.css, Layout | — | — | **DONE.** Token names = useful's |
| 3 | Vault storage: types, frontmatter, fs model, sqlite worker store, memory store, prefs | @sqlite.org/sqlite-wasm, yaml | **v1** `files`, `meta` | **DONE.** Assets are rows in `files` |
| 4 | The page: title left, frontmatter right, red rule, open/edit/autosave | — | — | **DONE.** Its sidebar was later removed |
| 5 | Editor stack port: 3 faces, footnotes, diagrams, drawings, images, math | milkdown, codemirror, mermaid, katex, excalidraw+react | — | **DONE.** Largest phase |
| 6 | Links, tags, search: backlinks, rename/alias offer, fulltext search + `tag:` filter, the Ctrl+K palette, bulk ops | — | — | **DONE.** Plus the palette rework |
| 7 | Export (MD / self-contained HTML / print-PDF) + blank-document preference + settings page | — | — | **DONE.** Blank is the default |
| 8 | PWA: manifest, service worker, vendored math/drawing fonts; Playwright harness + specs | — | — | **DONE.** 28 cases |
| 9 | Tauri build: src-tauri, fs store, packaging; docs; release polish | @tauri-apps/* | — | **DONE.** `cargo check` green; installer not yet cut |

## Phase 0 — Scaffold

**Goal:** a repo that looks like useful's: configs, CI, version bookkeeping,
plans, launch config.

**Scope:**
1. package.json (deps pinned to useful's known-good versions), astro.config
   (svelte + the Vue defines Crepe needs), svelte.config, tsconfig,
   .gitignore, .claude/launch.json, VERSION `0.1.0`, CHANGELOG skeleton.
2. `.github/workflows/astro.yml` — useful's Pages workflow with
   `--base "/notey"`.
3. `tools/preview-server.mjs` copied (SW testing needs a real static server).
4. These plan files + TODO.

**Tests:** none yet. **Docs:** the plans themselves.

## Phase 1 — Pure libs

**Goal:** every COPY-VERBATIM / COPY-WITH-EDITS module from useful in place
with its unit tests green.

**Scope (verdicts from the port survey):**
1. Verbatim + tests: `notebook/footnotes.ts` (95 cases), `notebook/wiki.ts`
   (22), `zip.ts` (7), `fuzzy.ts`, `encode/base64.ts`, `notebook/export.ts`
   (16), `prism.ts`, `exportFile.ts`, `notebook/code-languages.ts`,
   `vendor/excalidraw.ts`, `icons.ts` + `Icon.svelte`, `paths.ts`,
   `db/persistence.ts` (as `lib/persistence.ts`).
2. With edits: `markdown.ts` (wikiLinkHref → `/?note=`), `notebook/mermaid.ts`
   (id prefix `notey-mermaid-`), `notebook/math.ts`, `math/fonts.ts` +
   `notebook/mathFonts.ts` (cache `notey-fonts-v1`), `notebook/drawing.ts`,
   `notebook/model.ts` (keep `parseTags`; tree building moves to the vault's
   path model), `notebook/assets.ts` (keep the interface + pure helpers;
   the store itself is Phase 3).
3. `npm run test:unit` green.

**Tests:** the ported suites themselves. **CHANGELOG:** covered by the 0.1.0
feature bullets.

## Phase 2 — Paper design system

**Goal:** the Tangent-inspired look as tokens + base styles + layout shell.

**Scope:**
1. `theme.css`: useful's token names, paper values (decision 7); `light-dark()`
   with a lamplight dark variant; typewriter type stack (vendored Courier
   Prime with system Courier fallback).
2. `global.css`: reset, utility classes the ported components assume (`.btn`,
   `.stack`, `.row`, `.muted`, prism token colors, print rules, focus rings).
3. `Layout.astro`: FOUC-free theme pin, manifest link, SW register (PROD) /
   unregister (dev), `· notey` titles.

**Tests:** none (visual). **Docs (Phase 9):** design-system.md.

## Phase 3 — Vault storage

**Goal:** the storage seam both builds share, with the sqlite backend working.

**Scope:**
1. `vault/types.ts` — `VaultNote` (path, title, folder, tags, aliases,
   body_md, fm, created/updated), `VaultEntry`, the `VaultStore` interface
   (list/read/write/mkdir/rename/remove + asset ops).
2. `vault/frontmatter.ts` — parse/serialize YAML frontmatter, preserving
   unknown keys and key order where possible. Unit-tested hard.
3. `vault/fsModel.ts` — path algebra: split/join/sanitize, tree building,
   subtree listing, move targets, unique-name resolution. Unit-tested.
4. `vault/sqlite-worker.ts` + `vault/sqliteStore.ts` — worker boots
   sqlite-wasm, installs `opfs-sahpool`, falls back per decision 4; schema
   **v1**: `files(path PK, kind, content, created_at, updated_at)`,
   `assets(path PK, note_path, name, mime, bytes, data)`,
   `meta(key PK, value)`; `MIGRATIONS` array, `user_version` discipline.
5. `vault/memoryStore.ts` — same interface, in-memory (unit tests + dev).
6. `vault/assetStore.ts` — the editor's `AssetStore` over a note's `.assets/`
   (synchronous `resolve` answered from a primed cache, 2 MB cap kept).
7. `prefs.ts` — localStorage preferences: startup mode, editor face, last
   note, theme.

**Data model:** schema v1 (the tables above). **Tests:** unit — frontmatter
round-trips, path algebra, memory-store contract; the sqlite worker is
exercised by Playwright later. 

## Phase 4 — App shell

**Goal:** open the app, see the paper, make notebooks and notes, write, and
have it save.

**Scope:**
1. `NoteyApp.svelte`: vault load into the in-memory model; the page
   itself (there is no sidebar — see decision 10); the book button that
   opens the palette.
2. The page: title input (left) and frontmatter block (right) above the red
   rule; tags field; breadcrumb; autosave chain (editor debounce → 400 ms
   save → flush on pagehide/visibility/switch — useful's invariants:
   page load writes nothing, editor changes carry their mount id, deletes
   never cascade).
3. Plain-textarea editor as a placeholder until Phase 5 lands the real one.

**Tests:** Playwright smoke (create → type → reload → still there) written
against the final harness in Phase 8; until then, manual.

> ### CHECKPOINT A
> `npm run test:unit` green and a hand-run of the dev app: create notebook,
> create note, write, reload, survive.

## Phase 5 — Editor stack

**Goal:** the full useful editor: WYSIWYG/Source/Preview, footnotes,
diagrams, drawings, images, maths.

**Scope:**
1. Port `MarkdownEditor.svelte`, `MarkdownPreview.svelte`, `FootnoteDialog`,
   `DiagramDialog`, `DrawingDialog` (import paths + testids kept; tokens
   already match by name). Keep verbatim the documented tricky parts:
   footnote harvest/restore/unescape repairs, `tidying` flag, `replaceOrInsert`
   focus rule, synchronous `resolve` contract, Excalidraw react-root
   lifecycle with `collaborators: []`.
2. Vendor `public/math/` (KaTeX css + 20 woff2) and `public/excalidraw/fonts/`
   from useful along with their `tools/build-*.mjs` generators + PROVENANCE.
3. Wire the vault `AssetStore`; drawings save as `.excalidraw.png` files.

**New dependencies:** the editor stack (installed Phase 0).
**Tests:** unit suites already ported; Playwright editor specs in Phase 8.

## Phase 6 — Links, tags, search

**Goal:** the knowledge-base half: wiki links resolving across the vault,
backlinks, rename offers, search, filtering, quick switching, bulk ops.

**Scope:**
1. Wiki links resolve by title/alias across all notes; missing-link create
   (in the Pile, or beside the linking note); `?note=` deep links.
2. Links panel: Linked from / Links to, computed fresh each time.
3. Rename → alias push + "N notes still link to … / Update them" offer.
4. Search: fulltext over titles/tags/bodies with result snippets; `tag:foo`
   filter syntax; clicking a tag chip searches it.
5. The **command palette** (Ctrl+K / Ctrl+P, or the book): fuzzy over
   commands and notes, plus the library views — notebooks, one notebook,
   the Pile, this note's links — that keep you in the palette while you
   browse (decision 10).
6. Bulk operations: tick notes in a palette list view → export zip /
   add-remove tags / move / delete (reparent semantics from useful's
   bulk.ts).

> ### CHECKPOINT B
> Unit suite green; manual sweep of linking/search/bulk flows.

## Phase 7 — Export & preferences

**Goal:** notes leave the app; the app opens the way you want.

**Scope:**
1. Export card: Markdown (assets inlined as data URLs), self-contained HTML
   (KaTeX fonts subset, mermaid pre-rendered as SVG, zero external fetches),
   Print/PDF via the print stylesheet + `document.title` trick.
2. Blank-document preference: open to an unfiled scratch buffer; "File this
   note" (or typing a title) materializes it into the Pile.
3. `settings.astro`: startup preference, theme, storage tier/usage readout,
   vault export/import (one JSON envelope; doubles as the browser↔Tauri
   interchange).

## Phase 8 — PWA + test harness

**Goal:** installable, offline, and tested.

**Scope:**
1. `manifest.webmanifest`, icons, `public/sw.js` — useful's worker with
   notey's SHELL (`''`, `settings/`, favicons, manifest), cache prefix
   `notey-cache-`, font bucket `notey-fonts-v1` for `math/` + `excalidraw/`;
   every fixed bug kept byte-for-byte (ignoreVary, activate-blocking crawl,
   backtick imports, prefix-scoped purge).
2. Playwright: `tests/local/helpers/app.ts` fixture (hook `__notey`,
   fresh context per test, console errors fail), `notey.spec.ts` covering:
   zero-write page load, create/edit/reload persistence, wiki link + backlink,
   rename alias offer, search, tag filter, footnote dialog, mermaid render,
   HTML export self-containment, print, bulk tag/move/delete, blank-startup
   preference.

> ### CHECKPOINT C
> `npm run test:unit` + `npm test` green against the production build.

## Phase 9 — Tauri, docs, release

**Goal:** the desktop build, the documentation trees, and a releasable repo.

**Scope:**
1. `src-tauri/`: Tauri v2 app, fs + dialog plugins, capability scoped to
   `$DOCUMENT/Notey`; `vault/tauriStore.ts` (real files; same interface);
   `npm run tauri:build` produces an installer; SW registration skipped
   under Tauri.
2. Docs: `docs/README.md` index; dev/ — architecture, data-layer (vault),
   editor, design-system, service-worker-and-offline, tauri, testing,
   build-and-tooling; user/ — getting-started, writing, organizing, linking,
   exporting, install-and-offline, desktop-app, settings — every user page
   ending in Gotchas, every page carrying the version banner.
3. README.md (useful's section order), CHANGELOG finalized, VERSION check.

**Tests:** full suite green = the release gate.

## Ordering

- **Phase 0 blocks everything**; 1 and 2 are independent of each other.
- **Phase 3 blocks 4**; 4 blocks 5 (the editor mounts into the shell).
- 6 and 7 both need 5; either order works, links-first chosen because
  search wants the final note model.
- 8 needs the app complete; 9 needs 8's green suite.
- Suggested order alone: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.

## Deliberately out of scope for 0.1.0

- **Sync of any kind** — the vault is one browser or one disk. The export
  envelope is the escape hatch.
- **A Tauri vault picker** — fixed `$DOCUMENT/Notey` first (decision 8).
- **FTS5 search** — JS scan is instant at this scale (decision 5).
- **Mobile layout polish** — the page goes fluid under 56rem and the
  palette is reachable, but phone-first ergonomics (no keyboard, no
  Ctrl+K) are a later version.
- **The trust-gate reporter** — useful's sabotage-detecting test reporter is
  deferred; the isolated-delta assertions come without it.
