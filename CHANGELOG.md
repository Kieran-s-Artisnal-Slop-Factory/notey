# 0.1.0 (unreleased)

## Features

* Initial release: a note-taking PWA that feels like writing on paper. It
  opens on a blank, unfiled 8 x 11 sheet — a title and a page, nothing else.
  Each note is a Markdown file with YAML frontmatter shown above the red rule
  (title on the left, frontmatter on the right), filed into notebooks
  (folders) or left in the Pile.
* **Eight papers.** Card (cream stock), Lamplight, Plain (white, black
  ink), a yellow Legal pad with blue rules and a red margin, Blueprint (blue
  on white) and Cyanotype (white on blue) with a drafting grid, Black with
  white ink, and Green bar — continuous-feed printer paper with pale green
  bands three lines tall, a hairline every row and tractor-feed holes down
  both edges that show the desk through. The red rule under the header can
  be switched off.
* **Frontmatter is real YAML, and is edited as such.** A field can hold a
  value, a list, or a nested map: one button cycles its shape, lists edit
  comma-separated like tags, and maps edit as YAML. A value nobody touched
  round-trips byte for byte, so a hand-written file keeps its numbers, its
  nesting and its key order. Aliases are now one of these fields rather than
  a line of prose, so they can be edited and removed like anything else.
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
* **Many tabs, one writer per note.** Tabs queue on a Web Lock for the
  vault; the holder opens the sqlite worker (OPFS sync-access handles exist
  only in dedicated workers) and serves the other tabs over a
  BroadcastChannel, and when it closes the next tab takes over and the
  others re-drive what was in flight. Each open note is a second Web Lock:
  a note another tab is writing opens read-only, follows that tab's saves,
  and becomes writable when it moves on — only in a visible tab, so a
  forgotten background tab never takes a note off the one in front of you.
  The blank page is locked the same way, with a per-tab sheet for a tab that
  cannot have the shared one; bulk actions leave notes open elsewhere alone.
  iOS suspends background tabs, so there it is one tab at a time.

* **The whole vault exports to a zip, and imports back.** Settings has
  **Export everything** — your notebooks as folders and your notes as plain
  `.md` files with their images, exactly as the vault holds them — and
  **Import a zip** to read one back, into this browser or another. Importing
  only ever adds: a note already there word for word is left alone, one that
  clashes is filed alongside under a free name, and running the same archive
  twice does nothing the second time.

* **The database dumps to a `.sqlite` file, and one can be loaded back.**
  In a browser, Settings also has **Export .sqlite** and **Replace from
  .sqlite**: the real database, which opens in any SQLite browser so you can
  read the rows notey actually stored. Loading one replaces the whole vault
  (it asks first) and every open tab reloads — it is for seeing someone
  else's notes as they see them, where the zip is for merging.

* **Drag a `.md` file onto the page and it becomes a note.** From your
  desktop, an email, anywhere; it opens straight away, and while you drag,
  the page says where it will land — the notebook you are in, or the Pile.
  A name already taken is filed alongside rather than written over, and a
  file you already have, unchanged, just opens the one you have.
* **The desktop app asks where to keep your notes, and can be pointed
  anywhere.** A first launch says plainly where the files are about to go
  and offers a folder picker; Settings can move it later. `notey plan.md`
  opens that file **and saves back to it**, `notey ~/projects` works in that
  folder, and `notey new.md` starts a file that is not there yet — because
  pointing notey at a file simply mounts the folder it sits in, so links,
  images and search work there with no separate "external file" mode.
  `Ctrl+K → Edit existing file` does the same with a picker, and appears
  only on the desktop, where writing back to a real file is possible.

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
* **The command palette's book was washed out on light desks.** It sits on
  a chip of paper now, so it is legible on oak, birch and cream too.
* **The leather grain was the size of stucco.** The textures are tiles, so
  the grain is scaled with `background-size` — 40% by default, with a
  setting for fine, medium or coarse.
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
* **A failed pool init could have deleted the vault.** sqlite-wasm's OPFS
  pool removes its whole directory when installing the VFS fails, and
  during a hand-over between tabs it fails whenever the old worker's file
  handles are still held. The worker now probes every pool file with a
  sync-access handle first and reports "busy" without installing anything,
  so the tab retries instead of the pool wiping itself.

* **The drawing canvas no longer types into the note behind it.** Opening a
  drawing from the ✏ on an existing image left the caret in the note, so
  Excalidraw's tool shortcuts — `5` for the arrow, `r` for the rectangle —
  picked the tool *and* typed the character into what you were writing.
  Focus now moves into the canvas as the dialog opens, and back to where it
  was when it closes.
* **Escape belongs to the drawing canvas.** It used to close the dialog,
  which took the key away from Excalidraw — where Escape finishes a
  multi-point line, drops a selection, or leaves a tool — and threw the
  drawing away in the process. The dialog closes with Cancel or ×.

## Other

* Repo structure modelled after useful: docs trees (dev/user), versioned
  plans with checkpoints, VERSION + CHANGELOG discipline, GitHub Pages CI.
* **The tan leather desk is retuned.** It now renders as #a6430a (measured
  #a74309 in Chromium); the base gradient is far darker than that because
  the pebble grain sits on top with overlay, and the ink on it is cream.
* Clicking anywhere on the blank page puts the caret at the end of the
  writing, the way a real page has no "outside the text".
* Breadcrumbs are links: each one opens the palette on that notebook.
