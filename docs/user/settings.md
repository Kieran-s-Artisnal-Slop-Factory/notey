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
- **Only one tab can write at a time.** Open notey twice and the second tab
  says so and offers to take the vault; the first then goes read-only until
  you hand it back. Your browser will not let two tabs share one database,
  so this is a hand-off rather than a lock.
