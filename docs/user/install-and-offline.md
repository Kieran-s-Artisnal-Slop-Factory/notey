# Installing, and working offline

notey is a web app that installs like a real one and works with the network
unplugged.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Installing it

Open notey in Chrome, Edge or another Chromium browser and use the install
button in the address bar (or *Install app* in the menu). Safari on iOS and
iPadOS: *Share* → *Add to Home Screen*.

Installed, it opens in its own window with no browser chrome — and, on iOS,
installing is also what makes the browser far less likely to throw your notes
away. See the gotchas.

## What works offline

Everything, including the parts you have not used yet. Notes are stored in
your browser, not on a server, so there is nothing to be disconnected from.

The first visit downloads **the whole app**: the editor, the formula editor,
the diagram engine, the drawing canvas, the database engine and every font.
It carries on in the background while you use the app. Once it has finished,
every page and every feature works on a plane — even ones you have never
opened.

**Settings → Your vault** says whether it has finished: *Ready to work
offline — all … files are here.* If you are about to lose the network and it
has not, **Download the rest now** fetches whatever is left while you wait.

## The one-time download

It is about 15 MB, most of it the diagram engine, and it happens once —
expect a noticeable wait on a slow connection, the first time only. After an
update, only what changed is fetched. The typeface, the maths fonts and the
drawing fonts are all served by notey itself; nothing is fetched from Google
or a CDN, ever.

## Keeping your notes

Your notes are in this browser's storage. That is real storage — a SQLite
database — but browsers are allowed to clear it when space runs short.

In **Settings → Your vault**, *Ask for persistent storage* asks the browser
to exempt notey from that. Chrome usually grants it to installed apps
silently. It also shows how much space you are using and how much you are
allowed.

## Gotchas

- **iOS evicts site data after about seven days of not opening the app** —
  unless you have added it to your Home Screen. If notey lives in Safari as a
  tab, treat it as temporary and export anything you care about.
- **Clearing site data deletes your notes.** "Clear browsing data" includes
  them. Nothing is uploaded anywhere, so nothing comes back.
- **A private window keeps nothing.** notey will run, and Settings will say
  which storage tier it got, but the vault goes when the window closes.
- **Many tabs, one database.** Only one tab can hold the database, so the
  others read and write through it — Settings says *via another tab* in
  those. Close the holder and another tab picks the database up on its own,
  after a short pause. If a note is open in two tabs, only one of them
  writes it; see [getting-started.md](getting-started.md).
- **On iOS it is one tab at a time.** Safari suspends the tab you are not
  looking at, and a tab that depends on a suspended one waits until it
  wakes.
- **Different browsers are different vaults.** Chrome and Firefox on the same
  machine do not share notes.
- **The desktop app is the durable answer.** Real `.md` files in a folder you
  can back up — see [desktop-app.md](desktop-app.md).
