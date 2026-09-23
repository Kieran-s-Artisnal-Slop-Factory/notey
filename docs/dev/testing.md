# Testing

Two suites. Vitest covers the pure modules next to the code; Playwright
drives the real app against a **production build**, because the service
worker only exists there and a suite that never loads it tests a path no user
runs.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## File map

| Path | Role |
| --- | --- |
| [vitest.config.ts](../../vitest.config.ts) | `include: ['src/**/*.test.ts', 'tools/**/*.test.mjs']` |
| [playwright.config.ts](../../playwright.config.ts) | Production build on port 4340, `retries: 0`, 8 workers |
| [tests/local/helpers/app.ts](../../tests/local/helpers/app.ts) | The `app` fixture: fresh context, the hook, console-error teardown, `newTab()` |
| [tests/local/notey.spec.ts](../../tests/local/notey.spec.ts) | Every browser case |
| [src/lib/testMode.ts](../../src/lib/testMode.ts) | The gate — the hook chunk is only fetched when the flag is set |
| [src/lib/testHook.ts](../../src/lib/testHook.ts) | `window.__notey`: raw vault reads and writes |
| [src/lib/vault/fakePlatform.ts](../../src/lib/vault/fakePlatform.ts) | `FakeLocks` and `FakeBus`: Web Locks and BroadcastChannel in one node process, tab deaths included |
| [src/lib/vault/tabs.test.ts](../../src/lib/vault/tabs.test.ts) | The owner/follower protocol under those fakes |
| [src/lib/vault/noteLocks.test.ts](../../src/lib/vault/noteLocks.test.ts) | One writer per note, under the same fakes |
| [tools/preview-server.mjs](../../tools/preview-server.mjs) | A dependency-free static server over `dist/` |

## Commands

```bash
npm run test:unit   # vitest run
npm test            # playwright test (builds first)
```

## The unit suite — 417 cases in 26 files

| File | Cases | Covers |
| --- | --- | --- |
| `notebook/footnotes.test.ts` | 95 | The offset-preserving footnote model: find, insert, rename, remove, markers, `restoreDefinitions`, code masking |
| `markdown.test.ts` | 30 | The render pipeline: wiki links, footnote numbering, maths rules (`$5 and $10` stays prose), mermaid fences, sanitisation |
| `notebook/wiki.test.ts` | 22 | Link parsing with offsets, escaping, unicode, alias resolution, rewriting, backlinks |
| `notebook/shortcuts.test.ts` | 24 | **The editor's keys**: matching on the physical code rather than the character macOS produces under Option, the numeric keypad, extra modifiers not counting, a bind needing Ctrl/Alt/Cmd, which tool a press opens, refusing a key another tool or the palette has, and reading a stored set that has gone stale |
| `notebook/mathText.test.ts` | 22 | **Maths in source text**: finding the formula the cursor is in (inline, `$$` on one line or several, ` ```math `), prices never paired across a line, `looksLikeMath` telling money from maths, `unescapeDollars` repairing prose and leaving code alone, writing a formula back |
| `notebook/export.test.ts` | 16 | H1 prepending, asset inlining, the self-contained HTML document, hostile titles, `externalReferences` |
| `encode/base64.test.ts` | 16 | RFC 4648 vectors, UTF-8, URL-safe alphabet, data URLs |
| `vault/frontmatter.test.ts` | 15 | Round-trips, key order, broken YAML left as body, junk tolerance, date strings |
| `notebook/assets.test.ts` | 14 | Ref parsing, the 2 MB cap and its message, `uniqueAssetName` and the `.excalidraw.png` compound suffix |
| `vault/fmFields.test.ts` | 15 | The three frontmatter field shapes: which editor a value needs, untouched round-trips, list splitting, YAML that will not parse |
| `vault/transfer.test.ts` | 19 | **Notes in and out**: the vault as folders and images on disk, an empty notebook surviving, a round trip into an empty vault, a second import changing nothing, a clash filed alongside, an image whose name is taken left alone, `..` refused, notes another tab holds skipped, a non-zip rejected before anything is written — and the same never-overwrite rule for a dropped file, including a clash within one drop |
| `vault/model.test.ts` | 12 | Path algebra, `sanitizeTitle`, unique paths, asset refs, `toNote` round-trips, tree building |
| `notebook/bulk.test.ts` | 12 | Flattening, subtree ids, move targets, reparenting, tag add/remove, export filenames |
| `vault/tabs.test.ts` | 21 | **The owner/follower vault**: election, two tabs booting at once, a third tab learning the owner without waiting, failover with in-flight writes landing exactly once (the store counts its own calls), `rename` then `write` staying in order across a crash, a rename or a `create` the dead owner already did not being redone while one it did not is re-driven, a tab promoted while its own re-drive is parked finishing it, check reads lost to a second owner change being re-checked rather than hanging, silence and boot timeouts, a request with no owner at all still failing rather than waiting forever, an owner busy with other tabs not being mistaken for a dead one, one tab's open failure not sinking the next, shutdown handing on straight away, database errors coming back as errors |
| `fuzzy.test.ts` | 10 | Subsequence matching and the scoring floor |
| `vault/desktopPaths.test.ts` | 10 | **Where the desktop vault is**: splitting Windows and POSIX paths, drives and roots, and the rule that pointing notey at a FILE mounts the folder it sits in |
| `vault/noteLocks.test.ts` | 9 | **One writer per note**: free at once, wait then promotion, stop waiting on moving on, promotion when the holder closes, release before the answer, reopen straight after release is held, different notes never wait on each other, no lock manager, `notesHeldElsewhere` |
| `notebook/mermaid.test.ts` | 8 | Templates, `diagramKindOf`, completions |
| `notebook/model.test.ts` | 8 | Note normalisation, trees, cycles, `parseTags` |
| `vault/search.test.ts` | 8 | Query grammar, ranking, snippets, `tag:` and `book:` |
| `zip.test.ts` | 7 | CRC-32, round-trips, non-ASCII names, corruption refusal |
| `tools/precache-manifest.test.mjs` | 6 | **What the offline cache downloads**: a directory index keyed by its directory, the worker and the manifest left out, source maps and dot-files left out |
| `math/fonts.test.ts` | 4 | The vendored MathLive stylesheets and faces against `PROVENANCE.txt`; the layout sheet declares no faces of its own |
| `offline.test.ts` | 3 | The Settings line for the offline copy: ready, missing, not yet known |
| `vault/memoryStore.test.ts` | 6 | **The `VaultStore` contract**: implicit parents, `loadAll` omitting asset bytes, `create` refusing what `write` accepts, subtree rename and clash refusal, subtree delete, meta |
| `notebook/drawing.test.ts` | 5 | The `.excalidraw.png` convention and the vendored font list |

## The browser suite — 74 cases

The fixture gives every test a **fresh browser context** (fresh OPFS, fresh
worker), installs `localStorage['notey-test-mode'] = '1'` with an init script
before the first navigation, and **fails the test at teardown if anything
logged a console error**. `app.ready()` waits for `window.__notey` and for
Astro to have hydrated every island; `openApp()` additionally waits for the
vault to open and the editor to mount, because a click that lands before the
editor finishes mounting is swallowed by the mount.

`app.newTab()` opens a second page **in the same context** — the same
profile, so the same OPFS, the same Web Locks table and the same
BroadcastChannel — wired like the first (console watched, hook reachable,
its errors fail the test too). Web Locks, BroadcastChannel and OPFS are all
scoped to a browser context, which is what lets the 8 parallel workers run
their own vaults without interfering while a second page in one context
genuinely shares them.

| Group | What it pins |
| --- | --- |
| the page | Opens blank and unfiled and writes nothing; no sidebar exists; the sheet keeps an 8 × 11 shape and grows past it for a long note; the backend really is sqlite over OPFS |
| the palette | The book opens and closes it; commands and notes sit under their own headings; browsing notebooks stays open while opening a note leaves; creating a notebook stays put; Escape walks back a level then closes; search finds by title, body and `tag:` from the root |
| naming | The title commits on blur, not per keystroke; naming a new note for the first time leaves no alias |
| vault | A note survives a full reload; the file on disk is markdown with a frontmatter block |
| linking | A missing link is listed, creates the note under its own name, and then backlinks; a rename pushes an alias, offers the rewrite with a count, and moves the file; `?note=` opens a note and offers Create for one that does not exist — without creating it |
| organizing | Moving a note moves the file; deleting a notebook moves its notes up; deleting the note you have open leaves the blank page behind; bulk tag then delete touches only ticked rows; bulk move lands them in the notebook |
| editor | Every tool opens from its key without typing into the note, from the palette, and from its button, which wears the key; the four insert commands are absent in Preview; a citation lands after a selected sentence rather than replacing it; Alt+0 cites at the cursor and files the definition; a mermaid fence renders; maths render through MathLive in Preview and in the canvas while `$5 and $10` stays prose in both; typing "pi" in the formula editor gives π and saves `$\pi$`; double-clicking a formula edits that one in place instead of appending another; in Source view the button opens on the `$$` block the cursor is in; a `$` typed in the canvas is saved without a backslash; the face is remembered across a reload; the drawing canvas takes the keyboard so its tool shortcuts do not type into the note, and Escape stays the canvas's; a drag out of the canvas does not dismiss it |
| offline | One visit downloads the whole build — several hundred files, none missing, all in Cache Storage — and Settings, opened with three files gone missing, fetches them again and
keeps its line current until it says it is ready; after an update the previous build's files stay for tabs still running it, and the build before that is pruned |
| exports | The HTML file is self-contained (no script, no link, no external URL beyond XML namespaces, MathLive markup, fonts embedded); Markdown carries the title as an H1; a bulk export is one zip with both files |
| the page, in use | A click on blank paper puts the caret at the end of the writing; a breadcrumb opens the palette on that notebook |
| dropping a file | A dropped `.md` becomes a note and opens, keeping the frontmatter it arrived with; dropping while another note is open loses nothing from it; a name already taken is filed alongside; a file dropped while in a notebook lands in that notebook; something that is not markdown is refused out loud; and the browser build offers no "Edit existing file", which only the desktop can do |
| frontmatter | Aliases are a field a rename fills in; a field can be a value, a list or YAML; a hand-written nested map survives an unrelated edit |
| two tabs | Two tabs booting at once settle into exactly one owner and one follower; two tabs write two different notes and both persist, and the first lists the second's note without a reload; the same note in a second tab is read-only, follows the writer's saves, and is promoted when the writer moves on; closing one tab with a write still travelling hands the database on and the write lands anyway; the survivor keeps the vault across a reload; the blank page is one page, so a second tab gets a sheet of its own that stays its own after the first tab goes, while the shared sheet is left untouched. No case assumes which tab is the owner |
| preferences | A tool's key can be rebound and works at once, on the button and in the note, while a key another tool has is refused without firing that tool; the blank page keeps what you type without writing to the vault, and filing lands it in the Pile; "reopen the last note" works; the paper can be a legal pad and the rule can go; green bar paper prints its bands and tractor-feed holes; the grain re-scales; Settings names the backend; the paper, the desk and the pen are chosen separately; the vault exports to a real download and imports back into a **separate browser profile**, and an import over a note that differs files it alongside; the database dumps to a `.sqlite` whose first 16 bytes really are the SQLite header and which replaces a separate profile's vault, while a file that is not a database is refused without changing anything |

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
- **Two-tab assertions wait longer.** A follower's write is a round trip
  through the owner and a failover has a retry ladder behind it, so the
  two-tabs group gives `Saved` and the read-only markers 15 s, and the
  scratch reload 30 s. `page.close()` on the first tab is the failover
  case; the test does not know which role that tab had, and must not.
- **The unit tab tests never touch a browser.** `FakeBus` delivers to every
  *other* endpoint only, like the real BroadcastChannel, so a test that
  expects a tab to hear itself is wrong, not the fake; `settle()` runs the
  queued deliveries.
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
