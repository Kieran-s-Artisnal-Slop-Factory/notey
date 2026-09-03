# Writing

Three ways of looking at the same note, and a small toolbar for the things
plain text cannot do: footnotes, diagrams, drawings, images and maths.

_Describes the code as of v0.1.0 (unreleased; schema v1) — verify against source when in doubt._

## Three faces

The buttons on the right of the toolbar switch between them. The note is the
same text underneath all three.

- **Edit** is the rich view: headings, lists, tables, code blocks with a
  language picker, images and `$maths$`, all rendered as you type. A
  `mermaid` code block draws itself right there.
- **Source** is the markdown itself, in a code editor. Use it when you want to
  see exactly what will be saved, or when the rich view has tidied something
  you did not want tidied.
- **Preview** shows the note the way it renders everywhere else: links
  resolved, footnotes numbered at the foot, maths typeset, diagrams drawn.

The face you leave the editor in is the one you come back to.

## Footnotes

Press **Alt+0** with the cursor in ordinary text: you get a numbered citation
where the cursor was and a dialog open on its note, ready to write. Press it
on an existing citation and the dialog opens on *that* note.

The **⁋ Footnotes** button (with a count) opens the same dialog for all of
them. Rename a label and every citation renames with it; delete a note and
its citations go too; **+ New footnote** adds one. Nothing changes until you
press **Save footnotes**. Ctrl/Cmd+Enter saves; Escape cancels.

In the rich view the notes themselves stay out of the writing on purpose —
they are not prose. They live at the foot of the markdown (see Source) and in
that dialog. A line under the toolbar warns about a citation with no note, a
note nobody cites, or a label used twice.

## Diagrams

**◇ Diagram** opens the mermaid workbench: eight starter templates
(Flowchart, Sequence, State, Class, ER, Mindmap, Pie, Gantt), an editor that
completes diagram types on the first line and the right keywords below it,
and a live picture that keeps the last good drawing while it tells you what is
wrong with the current text. Ctrl/Cmd+Enter saves, Escape cancels.

In Source, opening it with the cursor inside an existing `mermaid` block edits
that block instead of adding another.

## Drawings

**Escape belongs to the drawing canvas** — it is how you finish a line or
drop a selection there — so the drawing dialog closes with **Cancel** or the
×, not with Escape.

**✏ Draw** opens an Excalidraw canvas — the same hand-drawn shapes, arrows and
text as excalidraw.com, in a dialog. **Insert drawing** saves it as a PNG in
the note, and the picture carries the drawing inside it, so it reopens for
editing: select the image (or put the cursor inside its `![Drawing](…)` in
Source) and press **✏ Draw** again.

A drawing is an ordinary image to everything else — the exports, the 2 MB cap
— and the PNG opens on excalidraw.com too.

## Images

Paste or drop an image into the rich view and it is stored beside the note and
shown in place. Each image may be at most **2 MB**; a bigger one is refused
with a line naming its size and the limit.

## Maths

Write `$…$` for inline maths and `$$…$$` on their own lines (or a `math` code
block) for display maths. A price — `$5 and $10` — is left alone, because
maths may not start or end with a space or be followed by a digit. Preview,
the HTML export and the print all typeset it; the rich view shows it in place
and opens a small editor when you click it.

## Gotchas

- **Switching faces loses undo history.** Edit, Source and Preview each start
  fresh; the text carries over, the undo stack does not.
- **The rich view normalises markdown.** Round-tripping through it can change
  how the source is written, though never what it means. Source is the way to
  keep it exactly as you typed it.
- **Footnote definitions are hidden in the rich view on purpose.** If you type
  a `[^label]: …` line there by hand, it is filed away into the dialog when you
  move off it.
- **Mermaid's error messages are mermaid's.** A diagram that will not parse
  stays as its text with the first line of the message above it.
- **Diagrams and drawings arrive when first used.** The mermaid engine is
  about a megabyte and the drawing canvas rather more; both are then cached
  and work offline.
- **An image over 2 MB is refused, not resized.** Shrink it first.
