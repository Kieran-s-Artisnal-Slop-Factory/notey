# 0.1.0 (unreleased)

## Features

* Initial release: a note-taking PWA that feels like writing on paper. It
  opens on a blank, unfiled 8 x 11 sheet — a title and a page, nothing else.
  Each note is a Markdown file with YAML frontmatter shown above the red rule
  (title on the left, frontmatter on the right), filed into notebooks
  (folders) or left in the Pile.
* **Choose the paper, the desk and the pen separately.** The page can be
  light while the desk is dark. Desks come as Plain, Wood (mahogany, oak,
  birch) or Leather (black, rich brown, tan, cream), and the textures are
  generated in CSS from SVG turbulence rather than shipped as images — no
  downloads, any size, and the command palette keeps a solid background so
  it stays legible over all of them. Eight accent colours dress the buttons,
  links and focus rings.
* **Everything runs through Ctrl+K**, settings included — they are a view
  inside the palette rather than a page you navigate away to.
  There is no sidebar and no toolbar: the palette creates notes and
  notebooks, browses the notebooks, the Pile and a note's links, exports,
  prints and deletes, with commands and notes under their own headings.
  Browsing views stay open while you look around; only landing on a page
  closes it. The one piece of chrome is a closed book in the corner that
  opens the same palette.
* The full **useful notebook editor**, ported: WYSIWYG / Source / Preview
  faces over one markdown string, `[[wiki links]]` with backlinks and rename
  aliases, footnotes (Alt+0, dialog, gutter markers), mermaid diagrams with a
  template workbench, Excalidraw drawings saved as re-editable PNGs, pasted
  images, and KaTeX maths.
* **Tags, fulltext search and filtering** — frontmatter tags editable in the
  page header, and a Ctrl+K search covering titles, aliases, tags, paths and
  bodies, with `tag:` and `book:` filters and a snippet of the matching line.
* **Two persistence backends behind one seam**: the browser build stores the
  vault in sqlite-wasm (OPFS) as a pseudo-filesystem, schema v1; the Tauri
  desktop build writes plain `.md` files to `Documents/Notey`.
* **Exports**: Markdown with images inlined, a self-contained single-file
  HTML export, and print-to-PDF.
* **Opens blank by default.** The unfiled page keeps what you type across
  reloads without writing anything to the vault, and one Ctrl+K command files
  it into the Pile or any notebook. Settings can switch it to reopening the
  last note instead.

## Bug Fixes

Found while building 0.1.0. The first three are in code ported from
**useful**, so they are worth carrying back upstream.

* **Alt+0 never opened the footnote dialog for a real keypress.** The
  shortcut was an `onkeydown` on the editor element, and the editors consume
  Alt-combinations before they reach it — a synthetic event still arrived,
  which is what made it look like it worked. It is now claimed on the
  capture phase of the editor root, before either editor sees the key.
* **The footnote dialog closed on the keystroke that opened it.** Its window
  listener is registered while that same Alt+0 is still being dispatched, so
  the dialog was saving and closing itself before it painted. It now ignores
  keys until a task boundary after mount.
* **Renaming a note tore the editor down and rebuilt it.** The editor was
  keyed on the note's path, which a rename changes, so editing a title threw
  away the undo history and the caret mid-typing. It is now keyed on the open
  document, and a rename simply moves the mounted editor's path along.
* **The command palette kept a filter after a bulk action.** Tagging or moving
  a selection left the tag text in the search box, hiding every row in the
  list it returned to.
* **The book could not close the palette it had opened** — the palette's
  backdrop covered it. It now sits above the backdrop.
* **A link to a note that did not exist yet created it as "Untitled"** when
  followed from the palette's Links view, leaving the link that made it still
  dangling. It now takes the link's own name.
* **A long note spilled off the bottom of the page onto the desk.** The sheet
  was given its 8 x 11 shape with `aspect-ratio`, which fixes the height, so
  the writing overflowed instead of growing it. It is a minimum now.
* **Typos were saved, and remembered.** The title is a filename, so writing
  it on every keystroke renamed the file that often — and every intermediate
  spelling became an alias the note answered to forever. The title now
  commits when you leave the field or press Enter (Escape puts the saved one
  back), and the typing debounce elsewhere went from 400 ms to 1.5 s.
* **Naming a brand-new note left it answering to "Untitled".** A note that
  has never been given a name is being named for the first time, not
  renamed, so no alias is kept — otherwise every note started life with
  `Untitled` in its alias list and cluttered every link lookup.

## Other

* Repo structure modelled after useful: docs trees (dev/user), versioned
  plans with checkpoints, VERSION + CHANGELOG discipline, GitHub Pages CI.
