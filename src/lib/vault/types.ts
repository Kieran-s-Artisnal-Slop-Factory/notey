/**
 * The vault: notey's data model.
 *
 * A vault is a virtual filesystem of Markdown notes. Paths use forward
 * slashes with no leading slash; a top-level folder is a NOTEBOOK, a
 * root-level `.md` file sits in the PILE, and a note's pasted images live
 * beside it in `<its folder>/.assets/`. The browser build mirrors this tree
 * into one sqlite-wasm database (a pseudo-filesystem); the Tauri build IS a
 * real filesystem under `Documents/Notey`. Everything above the storage
 * seam (`VaultStore`) is shared.
 *
 * Invariants:
 *  - A note's id IS its path, and its title IS its filename stem. Renaming
 *    the title renames the file; the old title is pushed into frontmatter
 *    `aliases` so `[[Old title]]` keeps resolving.
 *  - `body_md` NEVER contains the frontmatter block; `fm` carries every
 *    frontmatter key notey does not own, verbatim, so a hand-written file
 *    round-trips without loss.
 *  - Backlinks are computed from bodies, never stored.
 *  - `parent_id` is the parent folder's path (`null` = the Pile) — the same
 *    field name useful's tree/bulk machinery expects, so those tested
 *    modules port unchanged.
 */

/** What a vault path can point at. */
export type FileKind = 'dir' | 'note' | 'asset';

/** One row of the pseudo-filesystem, as the store returns it. */
export interface FileRow {
  /** Forward-slash path, no leading slash: `Work/Ideas/Big plan.md`. */
  path: string;
  kind: FileKind;
  /**
   * Markdown (with frontmatter) for notes, base64 (no `data:` prefix) for
   * assets, null for dirs. `loadAll()` omits asset content — image bytes
   * are primed per note, not carried by the whole-vault read.
   */
  content: string | null;
  /** Asset mime type; null for notes and dirs. */
  mime: string | null;
  /** Asset decoded size in bytes; null for notes and dirs. */
  bytes: number | null;
  /** Last write, UTC ISO. The note-level `updated` lives in frontmatter. */
  mtime: string;
}

/** A parsed note, shaped so useful's notebook modules work unchanged. */
export interface Note {
  /** The vault path — doubles as the id everywhere. */
  id: string;
  /** The filename stem. `[[Wiki links]]` resolve against this + aliases. */
  title: string;
  /** Markdown without the frontmatter block. */
  body_md: string;
  /** Old titles (from frontmatter), so renamed notes keep their links. */
  aliases: string[];
  /** Frontmatter tags. */
  tags: string[];
  /** Parent folder path, or null for the Pile. */
  parent_id: string | null;
  /** Frontmatter keys notey does not own, preserved verbatim and in order. */
  fm: Record<string, unknown>;
  /** From frontmatter `created`, or the store's mtime the first time. */
  created_at: string | null;
  /** From frontmatter `updated`, falling back to the store's mtime. */
  updated_at: string;
}

/** A folder, shaped like a Note so the shared tree can hold both. */
export interface FolderEntry {
  id: string;
  title: string;
  parent_id: string | null;
}

/** What `write` takes: the store stamps mtime itself. */
export interface FileWrite {
  path: string;
  kind: FileKind;
  content: string | null;
  mime?: string | null;
  bytes?: number | null;
}

/**
 * The storage seam. Implementations: `sqliteStore` (browser: sqlite-wasm in
 * a worker, OPFS-backed), `tauriStore` (desktop: real files via the fs
 * plugin), `memoryStore` (unit tests). All paths are vault-relative; every
 * method that writes creates missing parent dirs implicitly.
 */
export interface VaultStore {
  /** Which backend actually came up — Settings shows this. */
  readonly backend: string;
  /** Open the database / ensure the vault dir exists. Call once. */
  init(): Promise<void>;
  /**
   * The whole tree in one read: every dir and note (notes with content),
   * every asset's metadata (path/mime/bytes, content omitted).
   */
  loadAll(): Promise<FileRow[]>;
  /** One full row, content included, or null. */
  read(path: string): Promise<FileRow | null>;
  /** Every row at or under `prefix`, content INCLUDED (for priming a
   *  note's `.assets/`; keep the prefix narrow). */
  list(prefix: string): Promise<FileRow[]>;
  /** Upsert. Returns the stored row (with the stamped mtime). */
  write(file: FileWrite): Promise<FileRow>;
  /**
   * Like `write`, but REFUSES a path that already exists (atomically, in
   * the sqlite store). New notes are made with this, so two tabs that both
   * picked the same free name cannot overwrite one another: the second
   * one hears "exists" and picks again.
   */
  create(file: FileWrite): Promise<FileRow>;
  /** Create a folder (and its parents). */
  mkdir(path: string): Promise<void>;
  /** Move a file, or a dir and everything under it. Fails if `to` exists. */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file, or a dir and everything under it. */
  remove(path: string): Promise<void>;
  /** Small key/value side-table (schema version, non-preference state). */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Storage usage, when the backend can tell. */
  usage?(): Promise<{ bytes: number } | null>;
  /** Release handles (tests; Tauri window close). */
  close?(): Promise<void>;
}
