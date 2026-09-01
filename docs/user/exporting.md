# Exporting

Three ways out for the note you are reading, and a zip for a pile of them.
All of them are in **Ctrl+K**.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## One note

- **Export as Markdown** gives you the note's own text as a `.md` file named
  after the title, with a `# Title` line added if the note does not already
  open with one, and any images inlined as `data:` URLs so the file stands
  alone.
- **Export as HTML** gives you one `.html` file with everything inside it: a
  stylesheet, your images, the maths typeset with only the maths fonts that
  note actually uses, and diagrams already drawn. It never fetches anything
  and never points at notey or any server. If the note itself links to a web
  page, a line under the page counts those links so you know they are there.
- **Print / Save as PDF** opens your browser's print dialog with the note
  alone on the page — the app around it is hidden, light colours are forced,
  code keeps its background, and tables and figures are kept whole across
  pages. The note's title is offered as the filename; choose *Save as PDF*.

## Many notes

Open **View the Pile** or a notebook, tick the notes you want, and press
**.md zip** or **.html zip**. You get one archive named `notes-YYYY-MM-DD.zip`
with a file per note, named after its title — `Bread notes.md`, and `-2` when
two titles clash.

## Gotchas

- **The exports are the note, not the record.** Frontmatter — tags, aliases,
  dates — is not written into an exported file. Use the vault itself (or the
  desktop app's real `.md` files) when you want that.
- **The HTML file is self-contained; the PDF is not a file notey makes.** PDF
  goes through your browser's own print dialog, so page size, margins and the
  final filename are the browser's to decide.
- **A big note takes a moment to export as HTML.** Its maths and every diagram
  are rendered first so the file needs nothing at the other end.
- **A bulk HTML export renders every note in turn.** Fifty notes with diagrams
  is a slow click, with no progress bar — only the receipt at the end.
- **The zip is uncompressed.** The files inside already carry their images as
  base64, so there is little to squeeze; what matters is that every unzip,
  including your browser's own, opens it.
- **Titles are made filename-safe.** `My note: draft?` becomes
  `My-note-draft.md`.
- **Exporting never changes your notes.**
