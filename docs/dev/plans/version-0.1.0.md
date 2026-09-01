# notey — Version 0.1.0 wish list

The raw feature list, as asked for. The reviewed, ordered version with the
technology chosen is [version-0.1.0-phased.md](version-0.1.0-phased.md);
where the two disagree, that file is the later thought.

## The app

- [ ] A note-taking PWA that feels like writing on paper inside a notebook
  - [ ] Sidebar of **notebooks** (folders) holding the files and folders you specify
  - [ ] A **pile** — a general section for loose, individual notes
  - [ ] Minimal design: me and the page, with easy switching to other pages
  - [ ] Frontmatter above the red line on the right, title on the left
    (index-card layout, per the design inspiration)

## The editor — everything the useful notebook can do

- [ ] Rich (WYSIWYG) / Source / Preview faces over one markdown string
- [ ] Wiki links `[[Title]]` with backlinks, aliases on rename, create-on-click
- [ ] Footnotes (Alt+0, dialog, gutter markers, completions, issue warnings)
- [ ] Mermaid diagrams (templates, autocomplete, live preview workbench)
- [ ] Excalidraw drawings (PNG with the scene embedded, re-editable)
- [ ] Maths (`$…$`, `$$…$$`, `math` fences) with KaTeX
- [ ] Images by paste/drop
- [ ] Bulk operations: select many, export zip, tag, move, delete

## Organization & search

- [ ] Tag support (frontmatter tags, editable in the header)
- [ ] Fulltext search + filtering (titles, tags, bodies; `tag:` filter)

## Storage

- [ ] PWA build: everything persists to sqlite-wasm acting as a pseudo-filesystem
- [ ] Tauri build: a real desktop app persisting to plain `.md` files on disk

## Small things

- [ ] Preference to open to a blank document with no file yet
- [ ] Export to HTML (self-contained single file), Markdown, and print/PDF
- [ ] Repo modelled after useful: docs, VERSION, CHANGELOG, plans, CI
