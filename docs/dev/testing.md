# Testing

Two suites. Vitest covers the pure modules next to the code; Playwright
drives the real app against a **production build**, because the service
worker only exists there and a suite that never loads it tests a path no user
runs.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## File map

| Path | Role |
| --- | --- |
| [vitest.config.ts](../../vitest.config.ts) | `include: ['src/**/*.test.ts']` |
| [playwright.config.ts](../../playwright.config.ts) | Production build on port 4340, `retries: 0`, 8 workers |
| [tests/local/helpers/app.ts](../../tests/local/helpers/app.ts) | The `app` fixture: fresh context, the hook, console-error teardown |
| [tests/local/notey.spec.ts](../../tests/local/notey.spec.ts) | Every browser case |
| [src/lib/testMode.ts](../../src/lib/testMode.ts) | The gate — the hook chunk is only fetched when the flag is set |
| [src/lib/testHook.ts](../../src/lib/testHook.ts) | `window.__notey`: raw vault reads and writes |
| [src/lib/vault/store.ts](../../src/lib/vault/store.ts) | The tab hand-off the two-tab case drives |
| [tools/preview-server.mjs](../../tools/preview-server.mjs) | A dependency-free static server over `dist/` |

## Commands

```bash
npm run test:unit   # vitest run
npm test            # playwright test (builds first)
```

## The unit suite — 303 cases in 18 files

| File | Cases | Covers |
| --- | --- | --- |
| `notebook/footnotes.test.ts` | 95 | The offset-preserving footnote model: find, insert, rename, remove, markers, `restoreDefinitions`, code masking |
| `markdown.test.ts` | 24 | The render pipeline: wiki links, footnote numbering, maths rules (`$5 and $10` stays prose), mermaid fences, sanitisation |
| `notebook/wiki.test.ts` | 22 | Link parsing with offsets, escaping, unicode, alias resolution, rewriting, backlinks |
| `notebook/export.test.ts` | 16 | H1 prepending, asset inlining, the self-contained HTML document, hostile titles, `externalReferences` |
| `encode/base64.test.ts` | 16 | RFC 4648 vectors, UTF-8, URL-safe alphabet, data URLs |
| `vault/frontmatter.test.ts` | 15 | Round-trips, key order, broken YAML left as body, junk tolerance, date strings |
| `notebook/assets.test.ts` | 14 | Ref parsing, the 2 MB cap and its message, `uniqueAssetName` and the `.excalidraw.png` compound suffix |
| `vault/fmFields.test.ts` | 15 | The three frontmatter field shapes: which editor a value needs, untouched round-trips, list splitting, YAML that will not parse |
| `vault/model.test.ts` | 12 | Path algebra, `sanitizeTitle`, unique paths, asset refs, `toNote` round-trips, tree building |
| `notebook/bulk.test.ts` | 12 | Flattening, subtree ids, move targets, reparenting, tag add/remove, export filenames |
| `fuzzy.test.ts` | 10 | Subsequence matching and the scoring floor |
| `notebook/mermaid.test.ts` | 8 | Templates, `diagramKindOf`, completions |
| `notebook/model.test.ts` | 8 | Note normalisation, trees, cycles, `parseTags` |
| `vault/search.test.ts` | 8 | Query grammar, ranking, snippets, `tag:` and `book:` |
| `zip.test.ts` | 7 | CRC-32, round-trips, non-ASCII names, corruption refusal |
| `math/fonts.test.ts` | 5 | The vendored KaTeX asset list against `PROVENANCE.txt` |
| `vault/memoryStore.test.ts` | 5 | **The `VaultStore` contract**: implicit parents, subtree rename, clash refusal, subtree delete, meta |
| `notebook/drawing.test.ts` | 5 | The `.excalidraw.png` convention and the vendored font list |

## The browser suite — 41 cases

The fixture gives every test a **fresh browser context** (fresh OPFS, fresh
worker), installs `localStorage['notey-test-mode'] = '1'` with an init script
before the first navigation, and **fails the test at teardown if anything
logged a console error**. `app.ready()` waits for `window.__notey` and for
Astro to have hydrated every island; `openApp()` additionally waits for the
vault to open and the editor to mount, because a click that lands before the
editor finishes mounting is swallowed by the mount.

| Group | What it pins |
| --- | --- |
| the page | Opens blank and unfiled and writes nothing; no sidebar exists; the sheet keeps an 8 × 11 shape; the backend really is sqlite over OPFS |
| the palette | The book opens and closes it; browsing notebooks stays open while opening a note leaves; creating a notebook stays put; Escape walks back a level then closes; search finds by title, body and `tag:` |
| vault | A note survives a full reload; the file on disk is markdown with a frontmatter block |
| linking | A missing link is listed, creates the note under its own name, and then backlinks; a rename pushes an alias, offers the rewrite with a count, and moves the file; `?note=` opens a note and offers Create for one that does not exist — without creating it |
| organizing | Moving a note moves the file; deleting a notebook moves its notes up; bulk tag then delete touches only ticked rows; bulk move lands them in the notebook |
| editor | Alt+0 cites at the cursor and files the definition; a mermaid fence renders; maths render while `$5 and $10` stays prose; the face is remembered across a reload |
| exports | The HTML file is self-contained (no script, no link, no external URL beyond XML namespaces, fonts embedded); Markdown carries the title as an H1; a bulk export is one zip with both files |
| the page, in use | A click on blank paper puts the caret at the end of the writing; a breadcrumb opens the palette on that notebook |
| frontmatter | Aliases are a field a rename fills in; a field can be a value, a list or YAML; a hand-written nested map survives an unrelated edit |
| two tabs | A second tab is offered the vault rather than an error, and taking it puts the first one read-only |
| preferences | The blank page keeps what you type without writing to the vault, and filing lands it in the Pile; "reopen the last note" works; the paper can be a legal pad and the rule can go; the grain re-scales; Settings names the backend |

## Pitfalls the suite encodes

- **Wait for the app's own statement, not a duration.** `newNote()` waits for
  the title field to read `Untitled` — the field is one element every
  document binds into, so filling it early renames the *previous* note.
- **The body's debounce chain is long** (Milkdown 200 + editor 150 + app
  1500), so assertions on saved content use `expect.poll` rather than a
  fixed wait; `typeInCanvas`'s 900 ms only settles the editor, not the file.
- **The title is committed by blurring**, not by typing, so `setTitle`
  fills and blurs — a test that only fills is testing the uncommitted state
  on purpose.
- **`retries: 0`.** A flaky data test is an untrustworthy data test; use
  `expect.poll`, not retries.
- **Reuse of the preview server.** `reuseExistingServer` is on locally, so a
  server left running from an earlier run will serve a **stale build**. Kill
  it before re-running after a source change, or the fix under test will not
  be in the bundle.

## Known limits and decisions

- **No oracle and no trust gate.** useful diffs the whole database before and
  after an action to catch collateral writes, and has a reporter that fails
  the run if the self-sabotage cases did not run. notey asserts specific rows
  instead. Worth porting when the schema grows.
- **CI does not run either suite** — see
  [build-and-tooling.md](build-and-tooling.md). They are a local release
  gate.
- **The desktop build is untested end to end.** `memoryStore.test.ts` pins
  the contract `tauriStore` implements, and nothing exercises the real
  filesystem path.
