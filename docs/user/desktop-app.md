# The desktop app

The same notey, with your notes as real Markdown files in a folder you own.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Where your notes are

`Documents/Notey`. Notebooks are folders, notes are `.md` files, and a note's
images sit in a `.assets` folder beside it:

```
Documents/Notey/
  Loose thought.md
  .assets/
    diagram.excalidraw.png
  Recipes/
    Bread notes.md
    .assets/
      crumb.png
```

Back that folder up like anything else. Put it in Dropbox, or a git repo, or
on a stick.

## What notey writes into a file

A YAML frontmatter block, then your markdown:

```markdown
---
created: 2026-09-01T10:24:11.000Z
updated: 2026-09-01T11:02:47.000Z
tags:
  - baking
aliases:
  - Loaf notes
---

Sourdough starts with a good starter. See [[Flour guide]].
```

notey owns `created`, `updated`, `tags` and `aliases`. **Any other key you
put in there is kept exactly as you wrote it**, in the same position, and is
shown on the right of the page header where you can edit it.

## Editing files from elsewhere

Go ahead — they are ordinary Markdown. A file written by hand, with no
frontmatter at all, opens fine; notey adds a block the first time it saves.
Read the gotchas first, though.

## Building it yourself

You need Rust installed, then:

```bash
npm install
npm run tauri:build
```

The installer lands in `src-tauri/target`. `npm run tauri:dev` runs it against
the dev server with hot reload.

## Gotchas

- **notey does not watch the folder.** If you edit a note in another editor
  while notey has it open, notey will not notice, and its next save will
  write over your change. Close the note in notey (or reopen the app) before
  editing it elsewhere.
- **The vault path is fixed** at `Documents/Notey` in this version. Choosing a
  folder is a later feature.
- **Files notey does not understand are left alone** — a stray `.txt`, a
  `.git` folder — and it will not show them. But they *do* move when you
  rename the folder they are in, and they *do* go with it if you delete that
  notebook.
- **The title is the filename.** Renaming a note in notey renames the file;
  renaming the file outside notey renames the note.
- **No service worker and no install prompt** — it is already an app.
- **Exports go to your browser-style download folder**, not through a native
  save dialog. That is a rough edge of this version.
