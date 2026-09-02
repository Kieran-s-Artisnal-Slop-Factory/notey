# notey

Notes on paper, in a browser. A local-first note-taking PWA that opens on a
blank 8 × 11 sheet and keeps every control behind one keystroke — no sidebar,
no toolbar, no account, no server, no network. The same app builds as a
desktop program that writes plain `.md` files to a folder you own.

## What's in it

- **A page, and Ctrl+K.** notey opens unfiled: a title and a sheet. The
  command palette creates notes and notebooks, browses them, searches, shows
  a note's links, exports, prints and deletes. Browsing keeps you in the
  palette; only landing on a page closes it. A closed book in the corner
  opens the same thing with the mouse.
- **Notebooks and the Pile.** A notebook is a folder; the Pile is everything
  loose. Notes are Markdown files with YAML frontmatter — tags, aliases,
  dates, and any field of your own — shown on the right of the header, above
  the red rule.
- **A real editor**, ported from [useful](../useful): rich WYSIWYG, raw
  Markdown and rendered Preview over one string; footnotes with a dialog
  (Alt+0); mermaid diagrams with a template workbench; Excalidraw drawings
  saved as re-editable PNGs; pasted images; KaTeX maths.
- **`[[Wiki links]]`** resolved by title, with computed backlinks, automatic
  aliases on rename, and a one-press offer to rewrite the links that still
  point at the old name.
- **Search** over titles, aliases, tags, paths and bodies, with `tag:` and
  `book:` filters and a snippet of the matching line.
- **Exports**: Markdown with images inlined, one self-contained HTML file,
  print to PDF, a zip of many notes at once, and a zip of the whole vault —
  folders, files and images — that imports straight back in.
- **A desk you choose.** The paper (eight of them, light and dark), the
  desk under it (plain, or wood and leather textures generated in CSS rather
  than downloaded) and the accent colour are three independent settings — a
  dark desk can hold a light page.
- **As many tabs as you like.** One tab holds the database and serves the
  others; a note has one writer at a time, and a tab that opens a note
  another tab is writing reads it until that tab moves on.
- **Offline**, installable, and durable — a service worker that precaches the
  shell and crawls the rest in the background.

## Storage

The browser build keeps the vault in **sqlite-wasm** (OPFS), laid out as a
pseudo-filesystem — schema v1, two tables:

- `files` — one row per directory, note or asset. `path` is the primary key
  and the identity of everything; `content` is markdown for notes and base64
  for assets; `mime`, `bytes` and `mtime` complete it.
- `meta` — a small key/value side table for vault-level state.

There is no notes table and no tags table on purpose: a note is a file and
its tags are in its frontmatter, which is what lets the desktop build use a
real directory with the same code above the seam. Preferences are per device
in `localStorage` and never in the vault.

The desktop build writes the same tree as real files under
`Documents/Notey`.

## Quickstart

```bash
npm install
npm run dev        # http://localhost:4321
```

## Build & deploy

```bash
npm run build      # static site into dist/
```

Any static host will do. Under a sub-path, pass the base — CI publishes with
`astro build --base "/notey"`, which is authoritative for what is deployed.

## The desktop app

```bash
npm run tauri:dev      # the app against the dev server
npm run tauri:build    # an installer (needs Rust)
```

## Offline & installability

Install it from the browser's address bar. After the first visit everything
works offline, including pages you have not opened — the service worker
crawls the asset graph in the background. Diagrams and the drawing canvas
arrive the first time you use them.

## Backups

**The only copy of your notes is the browser they were made in** (or, on the
desktop, the folder on your disk). Clearing site data deletes them. Settings
has **Export everything** — one zip of the vault as folders and plain `.md`
files, which **Import a zip** reads back into any browser — and a button to
ask for persistent storage.

## Documentation

[docs/](docs/) has two trees: [dev/](docs/dev/) for how it is built and what
must not break, [user/](docs/user/) for how to use it and what will surprise
you. [docs/dev/plans/](docs/dev/plans/) records intent at a point in time and
is not maintained against the code — except
[far-fetched.md](docs/dev/plans/far-fetched.md), which holds the ideas that
were taken seriously and not built, with the reasoning that produced each no.

## Versioning & releases

`VERSION` holds the semver string and `package.json` is kept in step by hand.
A schema change needing a migration is at least a minor bump. To release:

1. Update `VERSION`, `package.json`, and the `CHANGELOG.md` heading.
2. Run both suites: `npm run test:unit` and `npm test`.
3. `git add VERSION CHANGELOG.md && git commit -m "Release $(cat VERSION)"`

## Architecture notes

Pages are thin Astro wrappers that mount one Svelte 5 root with
`client:only="svelte"`. Everything storage-shaped goes through the
`VaultStore` seam in `src/lib/vault/`, which has three implementations —
sqlite-wasm in a worker, the Tauri filesystem, and an in-memory store whose
test file *is* the contract's specification. `src/lib/notebook/` is pure note
logic ported from useful with tests attached; `src/lib/markdown.ts` is the one
sanctioned render path (marked + DOMPurify + Prism).

## Evolving the schema

The schema lives in two places that must change together: the `MIGRATIONS`
array in `src/lib/vault/sqlite-worker.ts` (append-only — `user_version` is its
length, and an entry describes the schema at that version forever) and the
types in `src/lib/vault/types.ts`. The Storage section above is the third
copy, for humans.
