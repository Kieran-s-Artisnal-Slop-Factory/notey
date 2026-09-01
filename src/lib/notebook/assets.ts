/**
 * Where the notebook editor puts the bytes for pasted images.
 *
 * The editor never talks to storage — it talks to an `AssetStore` (the
 * contract is useful's, verbatim). Markdown keeps a plain RELATIVE ref,
 * `.assets/<filename>`, which is what a Markdown export writes out and what
 * a real `.md` file on disk carries under Tauri; the store maps that ref to
 * a `data:` URL the browser can display, and back to a Blob when the bytes
 * are needed again. The vault-backed implementation lives in
 * `../vault/assetStore.ts`; this file is the pure contract and helpers.
 *
 * Two design facts:
 *
 *  - `resolve()` is SYNCHRONOUS in the contract (Crepe calls it while
 *    rendering an image node), but the bytes live in async storage. So a
 *    note's store is PRIMED once — every asset of the note loaded into a
 *    Map — and `resolve()` answers from that cache, returning undefined for
 *    anything it has not seen. Prime before mounting the editor.
 *  - Every asset is capped at `MAX_ASSET_BYTES`. The browser vault is one
 *    sqlite file and the HTML export inlines every image as base64 (which
 *    inflates by a third); a few dozen uncapped screenshots is the first
 *    thing in this app able to fail either on memory.
 */
import { decodeBytes, encodeBytes } from '../encode/base64';

export interface AssetStore {
  /**
   * Store `blob` under a name derived from `filename` and return the src to
   * write into the markdown. Implementations may rename to avoid collisions.
   */
  save(blob: Blob, filename: string): Promise<string>;
  /**
   * Replace the bytes behind an existing src, keeping the src itself valid —
   * this is what lets an edited drawing update every reference to it at
   * once. Optional: without it, editing a drawing inserts a new one.
   */
  replace?(src: string, blob: Blob): Promise<void>;
  /** The bytes behind a src, for reopening a drawing. */
  load?(src: string): Promise<Blob | null>;
  /**
   * The filename a src was saved under, or undefined when the src IS the
   * name (a path) or the store has not seen it. The name is what says
   * whether an image is a re-editable drawing (`*.excalidraw.png`).
   * Synchronous, like `resolve`.
   */
  nameOf?(src: string): string | undefined;
  /**
   * A displayable URL for a stored src, or undefined to use the src as
   * written (already a URL the browser can fetch).
   */
  resolve?(src: string): string | undefined;
}

/**
 * The directory a note's assets live in, relative to the note's folder:
 * `![alt](.assets/<filename>)`. A relative ref keeps exported and on-disk
 * `.md` files working in any other Markdown tool.
 */
export const ASSET_DIR = '.assets';
export const ASSET_PREFIX = ASSET_DIR + '/';

/** True when `src` points into the note's asset directory rather than the web. */
export function isAssetRef(src: string): boolean {
  return src.startsWith(ASSET_PREFIX) && src.length > ASSET_PREFIX.length;
}

/** The filename behind an `.assets/` ref, or null for anything else. */
export function assetNameOf(src: string): string | null {
  if (!isAssetRef(src)) return null;
  // Tolerate a query/fragment the editor may have appended.
  const name = src.slice(ASSET_PREFIX.length).split(/[?#]/)[0]!.trim();
  // A ref never reaches deeper than the asset directory itself.
  if (name.length === 0 || name.includes('/') || name.includes('\\')) return null;
  return name;
}

/** Per-asset cap, in decoded bytes. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** A paste the cap refuses. The message is shown to the user as-is. */
export class AssetTooLarge extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit = MAX_ASSET_BYTES) {
    super(`${formatMb(bytes)} MB is over the ${formatMb(limit)} MB limit for one image`);
    this.name = 'AssetTooLarge';
    this.bytes = bytes;
    this.limit = limit;
  }
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  // Whole numbers stay whole ("2 MB"); anything else gets one decimal so a
  // 2.04 MB paste does not read as "2 MB is over the 2 MB limit".
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/* ── base64 ─────────────────────────────────────────────────────────── */

/** The blob's bytes as base64 — no `data:` prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return encodeBytes(new Uint8Array(await blob.arrayBuffer()));
}

/** The inverse: base64 (no prefix) back to a Blob of the given type. */
export function base64ToBlob(b64: string, mime: string): Blob {
  return new Blob([decodeBytes(b64)], { type: mime });
}

/** A `data:` URL for stored bytes. */
export function dataUrlOf(row: { mime: string; data: string }): string {
  return `data:${row.mime || 'application/octet-stream'};base64,${row.data}`;
}

/** Total decoded bytes across rows — what Settings shows as a note's size. */
export function assetBytesOf(rows: readonly { bytes: number }[]): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.bytes) ? row.bytes : 0), 0);
}

/**
 * Pick a filename for a new asset that no sibling already uses. Keeps the
 * extension, sanitizes the stem the same way exports do, and suffixes `-2`,
 * `-3`… on a clash (case-insensitive, like the disks the Tauri build writes
 * to). `taken` is compared lowercased and is NOT mutated.
 */
export function uniqueAssetName(filename: string, taken: ReadonlySet<string>): string {
  // `.excalidraw.png` is a COMPOUND extension — the suffix is how a drawing
  // is recognized as re-editable, so a clash suffix must land before it
  // (`drawing-2.excalidraw.png`), never inside it.
  const lowerName = filename.toLowerCase();
  const compound = lowerName.endsWith('.excalidraw.png') ? '.excalidraw.png'.length : 0;
  const dot = compound > 0 ? filename.length - compound : filename.lastIndexOf('.');
  const rawStem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  const stem =
    rawStem
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 80) || 'image';
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let candidate = stem + ext;
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}
