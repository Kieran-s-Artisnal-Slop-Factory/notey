# Getting started

notey opens on a blank page. There is no sidebar, no menu bar and nothing to
click through first — a title, a red rule, and room to write. Everything else
is behind one keystroke.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Write first, file later

The page you land on is **unfiled**: it is not a note yet and nothing has been
saved to your vault. Type. It keeps what you write across reloads, in this
browser, and waits for you to decide it is worth keeping.

When it is, press **Ctrl+K** and choose **File this note in the Pile** — or in
any notebook you have made. If you gave it a title, that becomes the
filename; if you did not, the first heading or the first line does.

## Ctrl+K

One keystroke, everything:

- **New note** — a blank note in the Pile, ready to be named.
- **New notebook…** — type a name, press Enter.
- **View notebooks** / **View the Pile** — browse. These *stay open* while
  you look around; only opening a note puts you back on the page.
- **Blank page** — back to an unfiled sheet.
- Start typing anything else and it searches your notes as you go.

With a note open you also get **Links to and from this note**, the three
exports, **Close** and **Delete**.

**Escape** goes back one level, and closes the palette from the top.

## The book

The one thing on screen besides the page is a closed book in the top-right
corner. Click it and it opens — same palette, same everything, for when your
hands are on the mouse.

## The page

The title sits on the left, above the red rule. On the right, once a note is
filed, is its frontmatter: when it was created and last updated, which
notebook it is **inside**, its **tags**, and any other field you add with
**+ field**. Below the rule, the writing — with a small toolbar for diagrams,
drawings and footnotes, and the three ways of looking at a note: **Edit**,
**Source** and **Preview**.

A note saves itself a moment after you stop typing. A small stamp in the
corner says `Saved`.

## More than one tab

Open notey in as many tabs as you like; they all see the same vault, and a
change in one shows up in the others a moment later. One rule: **a note has
one writer at a time**. Open a note that another tab is writing and you get
it read-only — the stamp says `Open in another tab`, the title and
frontmatter are greyed out, the body is shown rendered, and it follows the
other tab's saves as they land. When that tab moves on — to another note, to
the blank page, or closes — the note becomes writable here, provided this
tab is the one you are looking at. A tab you left in the background waits
until you come back to it, so it never takes a note from the one in front of
you.

The blank page has one writer too. A second tab that cannot have it writes on
a fresh sheet of its own, which lasts as long as that tab — and stays that
tab's sheet, even after the first tab moves on, until you file it or clear
it.

## Notebooks and the Pile

- A **notebook** is a folder. Notes go in it, and folders can go in notebooks.
- The **Pile** is everything not in a notebook — loose notes, deliberately
  flat.

Nothing is sorted for you and nothing has to be filed. A note in the Pile is
as findable as one in a notebook, because search and `[[links]]` do not care
where a note lives.

## Light and lamplight

notey follows your system by default. Settings has **Card** (cream stock,
ink) and **Lamplight** (the same page at night) if you want to pin one — and
six more papers, listed in [settings.md](settings.md).

## Where your notes live

**In this browser.** They are a real SQLite database in the browser's own
storage, laid out like a filesystem. Nothing is uploaded, there is no account,
and there is no server.

If you would rather have plain files on your disk, that is what the
[desktop app](desktop-app.md) is.

## Gotchas

- **The blank page is not a note.** It lives in this browser's local storage
  until you file it. Clearing site data loses it, and it does not appear in
  search or in the Pile.
- **Clearing site data deletes everything.** Notes live in this browser only.
  Export what matters, and consider Settings → *Ask for persistent storage*.
- **A note you are only reading cannot be deleted from that tab.** Close
  it in the tab that is writing it first. If the other tab deletes it while
  you are reading, the page says so, and your next keystroke there files it
  again.
- **On iOS it is one tab at a time.** Safari suspends background tabs, and a
  second tab waits on the suspended one until it wakes.
- **Click anywhere on the page to start writing.** A click on blank paper
  puts the caret at the end of what is there.
- **Deleting a note asks first, and is final.** There is no trash.
- **The first visit downloads the editor** — it is a real rich-text editor
  with maths inside, so it is not small. After that it works offline.
