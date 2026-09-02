# Settings

Four things: how notey opens, what the page is made of, what it lies on, and
the truth about where your notes are. Press **Ctrl+K → Settings** — it opens
inside the command palette, so you never leave the page you were writing.
Escape goes back to the commands.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Opening the app

- **Open to a blank page with no file yet** (the default). notey lands on an
  unfiled sheet — a title placeholder and room to write. Nothing is saved to
  your vault until you file it with **Ctrl+K → File this note…**.
- **Reopen the note I had open.** The last note you were in comes back.

Either way, a link of the form `?note=Some title` wins: an explicit link is an
explicit ask.

## The paper

What the page itself is made of. **System** follows your OS; the rest are
chosen outright, and the choice is applied before the page paints so there
is no flash of the wrong one.

- **Card** — cream stock, typewriter ink. The original.
- **Lamplight** — the same page at night.
- **Plain** — white, black ink, nothing warm about it.
- **Legal** — a yellow pad, ruled blue, with a red margin down the left.
- **Blueprint** — dark blue linework on white drafting paper, gridded.
- **Cyanotype** — the same drawing printed the other way round.
- **Black** — white ink on black, like a gel pen.
- **Green bar** — continuous-feed printer paper: bands of pale green three
  lines tall, a hairline every row, and tractor-feed holes down both edges
  that show the desk through.

Under the papers is a switch for **the red rule** under the page header.
Turn it off and the header ends in a plain hairline instead.

## The desk

What the page lies on — chosen separately from the paper, so a dark desk can
hold a light page if that is what you want to look at.

- **Match** follows the paper: a plain light desk under light paper, a plain
  dark one under dark.
- **Plain** — Paper or Lamplight, flat colour, exactly as notey has always
  looked.
- **Wood** — Mahogany, Oak or Birch: grain, growth lines and plank joins.
- **Leather** — Black, Rich brown, Tan or Cream: a pebbled, lit grain.

The textures are drawn by the browser rather than downloaded, so they cost
nothing to load, never blur however large your screen is, and work offline
like everything else.

## The grain

How large the desk's texture is drawn — **Fine**, **Medium** or **Coarse**.
Fine is the default; coarse leather in particular looks more like hide from
a distance and more like stucco up close.

## The pen

Eight accent colours — Ink, Oxblood, Forest, Teal, Aubergine, Rust, Slate,
Moss. It colours buttons, links, `[[wiki links]]`, the focus ring and the
highlighted row in the command palette. The red rule stays red: it is the
stamp, not the pen.

## Your vault, out and back

**Export everything** gives you one zip of the whole vault — notebooks as
folders, notes as plain `.md` files, images beside them — named for the day
you made it. Keep it as a backup, or open it in any other browser with
**Import a zip**.

Importing adds and never overwrites: a note already here word for word is
left alone, and one that clashes is filed alongside under a free name. So
importing an old backup can only ever add to what you have, and importing
the same zip twice does nothing the second time. Notes open in another tab
are left to that tab.

## Your vault

This card tells you which storage notey actually got:

- **sqlite (OPFS)** — the good one. A real database in the browser's own
  filesystem.
- **sqlite (snapshot — no OPFS in this browser)** — your browser lacks the
  filesystem API, so notey keeps the database in memory and saves a copy
  after every change. It works, and it is slower with a large vault.
- **sqlite (memory only — nothing persists!)** — neither was available, which
  usually means a private window. Nothing will survive the tab.
- **files (Documents/Notey)** — you are in the desktop app; your notes are
  real files.

If notey is open in more than one tab, one of them holds the database and
the others go through it, and the card says so: **sqlite (OPFS) — via
another tab**. Nothing is different about your notes in that tab.

**Ask for persistent storage** asks the browser not to evict notey when space
runs short. The line under it is the browser's own estimate of what you are
using and what you are allowed.

## Gotchas

- **Settings are per device, not per vault.** They live in this browser's
  local storage, so they do not travel with an export and are not shared
  between browsers.
- **The command palette never sits on the desk texture.** It always paints
  itself a solid page colour, so it stays readable over the busiest wood.
- **The desk is decoration only.** Nothing about your notes changes with it,
  and a Plain desk is the cheapest to draw if you notice any sluggishness.
- **The blank page's text is also per device.** It is not in the vault, does
  not appear in search, and is not exported. File it to make it real.
- **"Ask for persistent storage" is a request, not a guarantee.** Some
  browsers grant it silently to installed apps, some ask, some refuse. The
  answer is shown next to the button.
- **The memory-only tier is a warning, not a bug report.** Close the private
  window and the notes are gone; that is what a private window is for.
- **Reopen the note I had open does not steal it.** If the note you left
  in is being written in another tab when this one starts, this tab opens
  blank instead. A `?note=` link still opens it, read-only.
- **The blank page in a second tab is a fresh sheet.** Only one tab can
  write the shared blank page. Another tab that opens on it gets a blank
  page of its own that lasts as long as that tab, never touches the shared
  one, and keeps being that tab's sheet while there is writing on it —
  file it or clear it and the tab goes back to sharing.
- **On iOS it is one tab at a time.** Safari suspends a background tab, and
  a tab waiting on a suspended one waits for as long as it is suspended.
