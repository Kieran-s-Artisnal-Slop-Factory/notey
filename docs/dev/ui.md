# The page and the palette

notey has no sidebar, no menu bar and no toolbar of its own. It opens on a
blank, unfiled sheet in an 8 × 11 shape, and every command and every
navigation runs through Ctrl+K. The only chrome on the page is a closed book
in the corner, which opens the same palette on the library.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## File map

| Path | Role |
| --- | --- |
| [src/components/NoteyApp.svelte](../../src/components/NoteyApp.svelte) | The page: title, frontmatter, red rule, editor host, and every action the palette calls |
| [src/components/CommandPalette.svelte](../../src/components/CommandPalette.svelte) | The palette: view stack, commands, library views, bulk bar |
| [src/lib/prefs.ts](../../src/lib/prefs.ts) | Startup mode, editor face, theme, and the unfiled scratch |
| [src/layouts/Layout.astro](../../src/layouts/Layout.astro) | The letterhead — a brand that is also the way home |

## The page

```
┌───────────────────────────────────────────────┐ ← .sheet, 8 × 11
│ THE PILE                     CREATED  2026-09 │
│ Bread notes                  UPDATED  2026-09 │ ← title left,
│ Also answers to: Loaf notes  INSIDE   Recipes │   frontmatter right
│                              TAGS     baking  │
│                              + FIELD          │
├═══════════════════════════════════════════════┤ ← the red rule
│ ◇ Diagram  ✏ Draw  ⁋ Footnotes  Edit Src Prev │
│                                               │
│ Sourdough starts with a good starter…         │
└───────────────────────────────────────────────┘
```

The sheet is `--page-width: 51rem` wide with `min-height: calc(width * 11 /
8)` — an 8 × 11 page that is that tall when empty and grows past it rather
than clipping when the writing runs long. Under 56rem of viewport it goes
fluid and the frontmatter block moves below the title.

**The unfiled page shows no frontmatter at all**: there is nothing true to
say about a note that does not exist yet. It is one title input with an
`Untitled` placeholder, the red rule, and the editor telling you to press
Ctrl+K or just start typing.

## The book

A closed book, fixed in the corner. Clicking it opens the palette and the
glyph becomes an open book; clicking it again closes it. Its `z-index` is 90
— above the palette's backdrop at 80 — because a button that opens something
must be able to close it again.

## The palette

```mermaid
stateDiagram-v2
  [*] --> root: Ctrl+K or the book
  root --> notebooks: View notebooks
  notebooks --> notebook: pick one
  notebook --> notebooks: Escape
  root --> pile: View the Pile
  root --> links: Links to and from this note
  root --> newNotebook: New notebook…
  notebook --> newNotebook: New folder inside
  pile --> tag: Tag (with rows ticked)
  pile --> move: Move (with rows ticked)
  tag --> pile: applied
  move --> pile: applied
  notebooks --> root: Escape
  root --> [*]: Escape, or an action that lands you on a page
```

Two rules give the palette its character:

1. **Browsing keeps you in the palette.** "View notebooks" shows the
   notebooks and stays open, because looking around takes several steps.
   Only an action that puts you on a page — open a note, create one, print,
   go to Settings — closes it.
2. **Escape walks back one level**, and closes only from the root. So does
   Backspace on an empty query.

### What the root offers

Always: New note · New notebook… · View notebooks · View the Pile · Blank
page · Settings. Plus the notes themselves — the five most recently updated
when the query is empty, or the search results when it is not.

With an unfiled page that has something on it: **File this note in the
Pile**, and one command per notebook.

With a note open: Links to and from this note · Export as Markdown · Export
as HTML · Print / Save as PDF · Close this note · Delete this note.

### Selecting several

Rows in the Pile and notebook views carry a tick box (or Ctrl+Space on the
highlighted row). Ticking any shows the bulk bar: `.md zip`, `.html zip`,
Tag, Move, Delete, Clear. Tag and Move are their own small views — type the
tags and press Enter to add or Shift+Enter to remove; pick a destination from
a list that excludes the selection and anything inside it. Both return to the
list they came from **through `go()`**, which clears the query, or the tag
text would linger as a filter and hide every row.

The receipt line ("Moved 2 notes.") stays under the list after the action.

## Where the state lives

| State | Owner | Notes |
| --- | --- | --- |
| The vault (notes, folders) | `NoteyApp` | Re-read after every write |
| The open document | `NoteyApp` | `currentPath` / `scratchOpen`, plus `mountPath` for the mounted editor |
| Palette view, query, selection | `CommandPalette` | Discarded when it closes |
| Startup, face, theme, last note | `localStorage` via `prefs.ts` | Per device, never in the vault |
| The unfiled page's text | `localStorage` (`notey-scratch`) | Survives reloads, writes nothing to the vault |

`prefs` and the scratch are read **at script init**, not in `onMount`:
`MarkdownEditor` is created during the first render and takes `mode` and
`value` as initial values only, so reading them later mounts the editor in
the wrong face with an empty document.

## Known limits and decisions

- **The editor is keyed on the open document, not the note path.** A rename
  changes the path, and keying on it rebuilt the editor mid-typing, throwing
  away the undo history and the caret. `mountPath` follows the rename along.
- **Delete still uses `confirm()`.** It is the one blocking, irreversible
  action, and a native dialog cannot be missed. Everything else is a receipt
  line.
- **`prompt()` was removed entirely.** Naming a notebook is an input in the
  palette, where the name will actually land.
- **The palette closes on an action that navigates.** There is no "keep it
  open" setting; if you want to do several things, the browsing views are
  where you stay.
- **No mobile affordance for Ctrl+K yet.** The book is reachable by touch,
  and it opens the same palette; the keyboard shortcut is the desktop path.
