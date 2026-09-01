# Far-fetched

Ideas taken seriously and **not built**, with the reasoning that produced
each "no" and what would have to change for the answer to be different — so
a rejected idea gets re-opened on new evidence rather than re-argued from
scratch. This file is maintained; the other plans record intent at a point
in time.

## FTS5 fulltext search (0.1.0)

**Asked for:** fulltext search over the vault, and sqlite-wasm is right
there with FTS5 compiled in.

**Not built, because the whole vault is already in memory.** Wiki links and
backlinks need every note body loaded (`resolveNote`/`backlinks` scan the
live array), so search gets the same array for free — `src/lib/vault/search.ts`
is a linear scan with scoring and snippets, and a personal vault is
megabytes at most: the scan is unmeasurable next to a keystroke. FTS5 would
add index-maintenance triggers, a second source of truth to drift, and a
worker round-trip per keystroke — for no observable speedup at this scale,
and the Tauri build (no persistent sqlite) would need a parallel in-memory
index anyway.

**What would flip it:** vaults that no longer fit comfortably in memory
(say tens of thousands of notes / hundreds of MB), or a search feature that
needs ranking sqlite does better (BM25 phrase queries). The seam is ready —
search takes `Note[]`, and a store-backed implementation could replace it
behind the same `searchNotes` signature.

## A second WYSIWYG face without Milkdown's normalisation

**Asked for (implicitly):** the Source face exists because markdown that
goes through Crepe comes back slightly normalised.

**Not built.** useful measured this trade before notey did: remark-stringify
normalisation is the price of a real WYSIWYG over markdown, and the Source
face is the escape hatch. Writing a custom ProseMirror serializer that
preserves byte-exact markdown is a project bigger than the rest of the app.

**What would flip it:** Milkdown shipping a lossless round-trip mode.
