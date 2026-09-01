# Documentation

Two audiences, two trees. [`dev/`](dev/) explains how the app is built and
what must not break; [`user/`](user/) explains how to use it and what will
surprise you. Both describe the code as it is — when a page and the source
disagree, the source is right and the page is a bug.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## For maintainers — [`dev/`](dev/)

Start with [architecture.md](dev/architecture.md): the stack, the runtime
picture, the directory map, and the invariants everything else assumes.

| Page | Covers |
| --- | --- |
| [architecture.md](dev/architecture.md) | The mental model: stack, runtime flow, directory map, non-negotiable invariants |
| [data-layer.md](dev/data-layer.md) | The vault — the `VaultStore` seam, the three backends, schema v1, frontmatter round-trips, what writes and when |
| [ui.md](dev/ui.md) | The page and the command palette: no sidebar, the book, the palette's view stack |
| [editor.md](dev/editor.md) | The three faces, footnotes, diagrams, drawings, images, maths, and the change plumbing |
| [search-and-links.md](dev/search-and-links.md) | Wiki links, aliases, backlinks, the rename offer, search grammar and scoring |
| [export.md](dev/export.md) | Markdown, the self-contained HTML file, print, and the bulk zip |
| [design-system.md](dev/design-system.md) | The paper tokens, light/lamplight mechanics, utility classes, the red rule |
| [service-worker-and-offline.md](dev/service-worker-and-offline.md) | Precache vs runtime cache vs the background crawl, cache versioning |
| [tauri.md](dev/tauri.md) | The desktop build: real `.md` files, the fs capability, what differs |
| [testing.md](dev/testing.md) | The two suites, the test hook, per-spec coverage |
| [build-and-tooling.md](dev/build-and-tooling.md) | Commands, the `tools/*.mjs` generators, vendoring, deployment, the release recipe |

## For users — [`user/`](user/)

Every page ends in **Gotchas** — the surprising behaviour and the data-safety
facts. [Getting started](user/getting-started.md) first if you have never
opened the app.

| Page | Covers |
| --- | --- |
| [getting-started.md](user/getting-started.md) | What notey is, the page, the book, Ctrl+K, where your notes live |
| [writing.md](user/writing.md) | The three faces, footnotes, diagrams, drawings, images, maths |
| [organizing.md](user/organizing.md) | Notebooks, the Pile, moving notes, tags, search, doing several at once |
| [linking.md](user/linking.md) | `[[Links]]`, backlinks, renaming, links from elsewhere |
| [exporting.md](user/exporting.md) | Markdown, one-file HTML, print to PDF, bulk zip |
| [install-and-offline.md](user/install-and-offline.md) | Installing it, what works offline, the one-time downloads |
| [desktop-app.md](user/desktop-app.md) | The Tauri build: your notes as real files on disk |
| [settings.md](user/settings.md) | Startup, theme, and what the storage card is telling you |

## Plans

[`dev/plans/`](dev/plans/) holds the planning documents rather than
descriptions of the code: [version-0.1.0.md](dev/plans/version-0.1.0.md) is
the raw wish list and
[version-0.1.0-phased.md](dev/plans/version-0.1.0-phased.md) the reviewed,
phased version of it, and [TODO](dev/plans/TODO) is the running work list.
They record intent at a point in time and are not maintained against the
code.

One file there is different: [far-fetched.md](dev/plans/far-fetched.md) is
maintained. It holds the things that were asked for, taken seriously and
**not built**, with the reasoning that produced each "no" and what would have
to change for the answer to be different.

## Keeping these honest

A change is not finished while its documentation describes the old behaviour
— new features get a page in each tree, changed features edit the existing
pages, and schema changes update [data-layer.md](dev/data-layer.md) along
with the README's Storage section.
