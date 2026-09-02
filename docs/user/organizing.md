# Organizing

Notebooks, the Pile, tags and search — all of it through Ctrl+K.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Notebooks

**Ctrl+K → New notebook…**, type a name, press Enter. A notebook is a folder,
and it can hold folders of its own: open it from **View notebooks** and use
**+ New folder inside**.

Inside a notebook you also get **+ New note here**, **Rename this notebook…**
and **Delete this notebook**.

## The Pile

Everything not in a notebook. **View the Pile** lists it; **+ New note in the
Pile** adds one. It is flat on purpose — the Pile is where a thought goes when
deciding where it belongs would cost more than writing it down.

## Moving a note

Open it and change **inside** in the frontmatter block, on the right of the
page header. The file moves, and any images it uses move with it. Several at
once: tick them in a list view and press **Move**.

## Tags, aliases and your own fields

**Tags** and **aliases** are fields in the page header, comma-separated, and
they are stored in the note's frontmatter so they travel with the file.

**+ field** adds one of your own. Each field has a small button that changes
what it can hold:

- a **single value** — a name, a number, a date;
- a **list** — commas separate the items, like tags;
- **YAML** — for anything with structure, like a map of settings.

Frontmatter is ordinary YAML, so a field you wrote by hand in another editor
opens here as whatever it already was, and one you do not touch is written
back exactly as you left it.

## Searching

Press **Ctrl+K** and type. It searches titles, aliases, tags, paths and the
text of every note, and shows a snippet of the line it found. Two filters:

- `tag:baking` — only notes carrying that tag.
- `book:Recipes` — only notes in that notebook. `book:pile` means loose notes.

They combine with words and with each other: `tag:baking book:Recipes dough`.

Title matches rank above tag and alias matches, which rank above matches in
the body.

## Doing several at once

In **View the Pile** or inside a notebook, tick the box beside any row (or
press Ctrl+Space on the highlighted one). A bar appears:

- **.md zip** / **.html zip** — one archive, one file per note.
- **Tag** — type tags, then Enter to add them, Shift+Enter to remove them.
- **Move** — pick a destination, or the Pile.
- **Delete** — asks first.
- **Clear** — untick everything.

What happened is reported underneath, and stays there after the action.

## Gotchas

- **Deleting a notebook never deletes notes.** Everything inside moves up a
  level, images included. Only the folder goes.
- **Deleting a note is final** and takes its images with it. There is no
  trash.
- **Renaming a notebook does not break links.** Links point at note titles,
  not paths, so moving and renaming folders is free.
- **Two notes can have the same title in different notebooks.** notey allows
  it, but a `[[link]]` to that title will find only one of them.
- **A bulk action is a series of small writes.** If it is interrupted, some
  notes are done and some are not; the receipt line says how many landed.
- **Notes open in another tab are left alone.** Tag, Move and Delete skip a
  note another tab is writing, and the receipt says so: *N left alone: open
  in another tab*. The same goes for the link rewrite after a rename.
  Renaming or deleting a notebook refuses outright while a note inside it is
  open in another tab — close it there first. A note you are only reading
  in this tab cannot be deleted from here either.
- **Search is substring, not stemmed.** "bake" will not find "baking". Tags
  are the tool for reliable recall.
- **The tick boxes only appear in list views** — the Pile and inside a
  notebook — not in the search results at the root.
- **A YAML field that does not parse is not saved over the old one.** The
  block says which field it was, and the previous value stays until the YAML
  is valid again.
- **Breadcrumbs are links.** The notebook names above a note's title open
  the palette on that notebook.
