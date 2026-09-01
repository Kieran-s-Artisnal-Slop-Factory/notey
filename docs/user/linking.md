# Linking notes

Write a note's title in double brackets and it becomes a link. notey tells you
who links back, and keeps old links working when you rename things.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Writing a link

`[[Title]]` links to the note with that title, matched without caring about
case or extra spaces. `[[Title|what to show]]` shows different words.

A link to a note that does not exist yet is drawn differently — dashed, in the
stamp red. Click it in Preview, or open **Ctrl+K → Links to and from this
note** and pick it, and the note is created on the spot, **under that name**,
beside the note you were writing in.

## Seeing what points where

**Ctrl+K → Links to and from this note** lists both directions: the notes that
link here (with a count when one links more than once), and every title this
note links to, marking the ones that are not notes yet. Pick any of them to go
there.

Both are read from the notes themselves each time, so they are never stale.

## Renaming

Rename a note and old links keep working: the old title is kept as an alias,
listed under the title as *Also answers to: …*.

If other notes still link by the old name, the page says so — *2 notes still
link to "Old title"* — with one button, **Update them to "New title"**, that
rewrites those links. Nothing is rewritten unless you press it, and nothing
breaks if you never do.

## Links from outside

A link of the form `…/?note=Some%20Title` opens notey with that note. If no
note has that title, notey says so and offers **Create it** — it never creates
a note just because you arrived.

## Gotchas

- **Links point at titles, not paths.** Moving a note between notebooks, or
  renaming a notebook, never breaks a link.
- **Two notes with the same title are ambiguous.** A link finds one of them —
  whichever comes first in the vault.
- **A link inside a code block is not a link.** Fenced and inline code are
  skipped, so `[[example]]` in a snippet stays a snippet.
- **Aliases accumulate.** Rename three times and the note answers to all three
  old titles. They are in the frontmatter, so you can prune them by hand.
- **The rewrite is one action, not a setting.** It rewrites the links that
  exist when you press it; links written afterwards with the old name resolve
  through the alias anyway.
