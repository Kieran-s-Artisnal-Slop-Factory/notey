# 0.1.0 (unreleased)

## Features

* Initial release: a note-taking PWA that feels like writing on paper.
  Notebooks (folders) and a Pile of loose notes in the sidebar; each note is a
  Markdown file with YAML frontmatter shown above the red rule (title on the
  left, frontmatter on the right).
* The full **useful notebook editor**, ported: WYSIWYG / Source / Preview
  faces over one markdown string, `[[wiki links]]` with backlinks and rename
  aliases, footnotes (Alt+0, dialog, gutter markers), mermaid diagrams with a
  template workbench, Excalidraw drawings saved as re-editable PNGs, pasted
  images, and KaTeX maths.
* **Tags, fulltext search and filtering** — frontmatter tags editable in the
  header, a search box covering titles, tags and bodies with `tag:` filter
  syntax, and a Ctrl+K quick switcher.
* **Two persistence backends behind one seam**: the browser build stores the
  vault in sqlite-wasm (OPFS) as a pseudo-filesystem, schema v1; the Tauri
  desktop build writes plain `.md` files to `Documents/Notey`.
* **Exports**: Markdown with images inlined, a self-contained single-file
  HTML export, and print-to-PDF.
* **Preference** to open to a blank, unfiled document instead of the last
  note.

## Bug Fixes

* (none yet)

## Other

* Repo structure modelled after useful: docs trees (dev/user), versioned
  plans with checkpoints, VERSION + CHANGELOG discipline, GitHub Pages CI.
