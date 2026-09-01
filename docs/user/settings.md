# Settings

Three things: how notey opens, how it looks, and the truth about where your
notes are. Reach it from **Ctrl+K → Settings**; the NOTEY letterhead takes you
back.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Opening the app

- **Open to a blank page with no file yet** (the default). notey lands on an
  unfiled sheet — a title placeholder and room to write. Nothing is saved to
  your vault until you file it with **Ctrl+K → File this note…**.
- **Reopen the note I had open.** The last note you were in comes back.

Either way, a link of the form `?note=Some title` wins: an explicit link is an
explicit ask.

## Theme

**System**, **Paper** (cream stock, typewriter ink) or **Lamplight** (the same
desk at night). System follows your OS. The choice is applied before the page
paints, so there is no flash of the wrong one.

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
- **The blank page's text is also per device.** It is not in the vault, does
  not appear in search, and is not exported. File it to make it real.
- **"Ask for persistent storage" is a request, not a guarantee.** Some
  browsers grant it silently to installed apps, some ask, some refuse. The
  answer is shown next to the button.
- **The memory-only tier is a warning, not a bug report.** Close the private
  window and the notes are gone; that is what a private window is for.
