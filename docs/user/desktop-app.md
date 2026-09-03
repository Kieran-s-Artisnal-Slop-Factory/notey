# The desktop app

The same notey, with your notes as real Markdown files in a folder you own.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Where your notes are

Wherever you say. The first time you open the desktop app it tells you where
it is about to put them — `Documents/Notey` unless you say otherwise — and
offers to put them somewhere else. You can move it later under **Settings →
Your vault → Change folder…**, and notes already written stay where they are.

Notebooks are folders, notes are `.md` files, and a note's images sit in a
`.assets` folder beside it:

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

### Opening one file, from anywhere

The desktop app is also a plain Markdown editor:

```bash
notey ~/projects/readme.md    # open that file, and save back to it
notey ~/projects              # work in that folder for now
notey ~/projects/new.md       # start a file that is not there yet
```

`Ctrl+K → Edit existing file` does the same thing with a file picker. (You
will not find that command in the browser: a web page cannot write back to a
file on your disk.)

In every case notey **works in that folder** — your edits land in the file
you named, not in your notes folder. The folder's other `.md` files become
notes too, so `[[links]]`, search and images work normally while you are
there. It is for the session only: your own notes folder is back next time
you launch, and Settings still names it.

## Dropping a file in

Drag a `.md` file onto the page — from your desktop, a mail attachment,
anywhere — and it becomes a note and opens. This works in the browser too.

It lands in the notebook you are in, or the Pile if you are not in one, and
the hint that appears while you drag says which. A name already taken is
filed alongside as `Name 2` rather than written over, and dropping a file you
already have, unchanged, does nothing.

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
  editing it elsewhere. Worth remembering when you point notey at a project
  folder you are also working in.
- **Moving your notes folder does not move the notes.** Choosing a new
  folder points notey at it; what you already wrote stays in the old one.
  Use **Export everything** and **Import a zip** in Settings to carry them.
- **Opening a file from elsewhere shows you that folder, not your notes.**
  That is the point — but it does mean the palette lists that folder's files
  until you launch notey again.
- **Files notey does not understand are left alone** — a stray `.txt`, a
  `.git` folder — and it will not show them. But they *do* move when you
  rename the folder they are in, and they *do* go with it if you delete that
  notebook.
- **The title is the filename.** Renaming a note in notey renames the file;
  renaming the file outside notey renames the note.
- **No service worker and no install prompt** — it is already an app.
- **Exports go to your browser-style download folder**, not through a native
  save dialog. That is a rough edge of this version.
