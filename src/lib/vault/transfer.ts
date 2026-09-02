/**
 * The whole vault, out to a zip and back.
 *
 * The export is not a database dump: it is the vault as it would look on
 * disk — `Work/Plan.md` at `Work/Plan.md`, its images beside it in
 * `Work/.assets/`, empty notebooks as empty folders. So the same archive
 * is a backup, the way to carry notes to another browser, and something
 * you can simply unzip and read in any editor. It is exactly what the
 * Tauri build already keeps in `Documents/Notey`.
 *
 * Import NEVER destroys anything. A note that is already there with the
 * same words is left alone; one that clashes is filed alongside under a
 * free name, because two copies is a nuisance and a lost draft is not.
 * That makes importing the same archive twice a no-op rather than a
 * duplicate, and importing a stale backup safe.
 *
 * Pure apart from the store it is handed: unit-tested against memoryStore.
 */
import { zipBytes, zipEntries } from '../zip';
import { ASSET_DIR } from '../notebook/assets';
import { decodeBytes, encodeBytes } from '../encode/base64';
import { isAssetPath, nameOf, normalizePath, parentOf, stemOf, uniqueNotePath } from './model';
import type { FileRow, VaultStore } from './types';

export interface VaultExport {
  bytes: Uint8Array;
  notes: number;
  assets: number;
  folders: number;
}

export interface ImportReport {
  /** Notes written under the path they had in the archive. */
  notes: number;
  assets: number;
  folders: number;
  /** Paths that clashed with different content, and where they went. */
  alongside: { from: string; to: string }[];
  /** Already in the vault, word for word — nothing to do. */
  already: number;
  /** In the archive but not brought in, and why. */
  skipped: { name: string; why: string }[];
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A zip timestamp for a row, falling back when the store has no mtime. */
function stampOf(mtime: string, fallback: Date): Date {
  if (!mtime) return fallback;
  const at = new Date(mtime);
  return Number.isNaN(at.getTime()) ? fallback : at;
}

/** Everything in the vault as one stored zip, paths and all. */
export async function exportVault(store: VaultStore, now = new Date()): Promise<VaultExport> {
  const rows = await store.loadAll();
  const entries: { name: string; data: Uint8Array | string; mtime?: Date }[] = [];
  let notes = 0;
  let assets = 0;
  let folders = 0;

  for (const row of rows) {
    const mtime = stampOf(row.mtime, now);
    if (row.kind === 'dir') {
      // A folder entry (trailing slash, no bytes) so an empty notebook
      // survives the round trip.
      entries.push({ name: row.path + '/', data: new Uint8Array(0), mtime });
      folders++;
    } else if (row.kind === 'note') {
      entries.push({ name: row.path, data: row.content ?? '', mtime });
      notes++;
    } else {
      // loadAll leaves asset bytes out — they are read one at a time.
      const full = await store.read(row.path);
      if (!full || full.content === null) continue;
      entries.push({ name: row.path, data: decodeBytes(full.content), mtime });
      assets++;
    }
  }

  return { bytes: zipBytes(entries), notes, assets, folders };
}

/** A default filename for the download: `notey-2026-09-02.zip`. */
export function exportFileName(now = new Date()): string {
  return `notey-${now.toISOString().slice(0, 10)}.zip`;
}

/** The same, for the raw database: `notey-2026-09-02.sqlite`. */
export function dbFileName(now = new Date()): string {
  return `notey-${now.toISOString().slice(0, 10)}.sqlite`;
}

/**
 * A path from an archive, or null if it is not one this vault will take.
 * Foreign zips exist: an entry may be absolute, may climb out with `..`,
 * or may be some file that is not a note at all.
 */
function vaultPath(name: string): string | null {
  const path = normalizePath(name);
  if (path === '') return null;
  if (path.split('/').some((part) => part === '..' || part === '.')) return null;
  return path;
}

/** What a path in the archive means to the vault. */
function kindOf(path: string): 'note' | 'asset' | null {
  if (isAssetPath(path)) return path.endsWith('/' + ASSET_DIR) || path === ASSET_DIR ? null : 'asset';
  return path.toLowerCase().endsWith('.md') ? 'note' : null;
}

export interface ImportOptions {
  /**
   * Paths another tab has open. They belong to that tab while it has them,
   * so an import leaves them alone and says so.
   */
  held?: ReadonlySet<string>;
}

/**
 * Write an archive into the vault, adding but never overwriting. Returns
 * what happened, in enough detail to tell the user.
 */
export async function importVault(
  store: VaultStore,
  archive: Uint8Array,
  options: ImportOptions = {}
): Promise<ImportReport> {
  const held = options.held ?? new Set<string>();
  const entries = zipEntries(archive);
  const report: ImportReport = {
    notes: 0,
    assets: 0,
    folders: 0,
    alongside: [],
    already: 0,
    skipped: [],
  };

  // Everything already in the vault: what a clash is measured against, and
  // what a free name is picked around.
  const existing = new Map<string, FileRow>();
  for (const row of await store.loadAll()) existing.set(row.path, row);
  const taken = new Set(existing.keys());

  for (const entry of entries) {
    const isFolder = entry.name.endsWith('/');
    const path = vaultPath(entry.name);
    if (path === null) {
      report.skipped.push({ name: entry.name, why: 'not a path this vault can hold' });
      continue;
    }

    if (isFolder) {
      if (!taken.has(path)) {
        await store.mkdir(path);
        taken.add(path);
        report.folders++;
      }
      continue;
    }

    const kind = kindOf(path);
    if (kind === null) {
      report.skipped.push({ name: entry.name, why: 'not a note or an image' });
      continue;
    }
    if (held.has(path)) {
      report.skipped.push({ name: entry.name, why: 'open in another tab' });
      continue;
    }

    if (kind === 'asset') {
      // An image's name is the reference a note carries, so it cannot be
      // filed under another one: where the name is taken, what is already
      // in the vault stays.
      if (taken.has(path)) {
        report.already++;
        continue;
      }
      await store.write({
        path,
        kind: 'asset',
        content: encodeBytes(entry.data),
        mime: mimeOf(path),
        bytes: entry.data.length,
      });
      taken.add(path);
      report.assets++;
      continue;
    }

    const content = decoder.decode(entry.data);
    const there = existing.get(path);
    if (there && there.kind === 'note' && (there.content ?? '') === content) {
      report.already++;
      continue;
    }
    if (!taken.has(path)) {
      await store.create({ path, kind: 'note', content });
      taken.add(path);
      report.notes++;
      continue;
    }
    // Taken, and not the same note: keep both.
    const to = uniqueNotePath(parentOf(path), stemOf(nameOf(path)), taken);
    await store.create({ path: to, kind: 'note', content });
    taken.add(to);
    report.notes++;
    report.alongside.push({ from: path, to });
  }

  return report;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** The report as one line for the user. */
export function describeImport(report: ImportReport): string {
  const bits: string[] = [];
  const plural = (n: number, one: string, many = one + 's'): string =>
    `${n} ${n === 1 ? one : many}`;
  if (report.notes > 0) bits.push(plural(report.notes, 'note'));
  if (report.assets > 0) bits.push(plural(report.assets, 'image'));
  if (report.folders > 0) bits.push(plural(report.folders, 'notebook'));
  let out = bits.length > 0 ? `Imported ${bits.join(', ')}.` : 'Nothing new to import.';
  if (report.already > 0) out += ` ${report.already} already here.`;
  if (report.alongside.length > 0) {
    const names = report.alongside.map((a) => stemOf(nameOf(a.to))).join(', ');
    out += ` ${plural(report.alongside.length, 'clash')} filed alongside: ${names}.`;
  }
  const held = report.skipped.filter((s) => s.why === 'open in another tab').length;
  if (held > 0) out += ` ${held} left alone: open in another tab.`;
  const other = report.skipped.length - held;
  if (other > 0) out += ` ${plural(other, 'file')} in the archive ${other === 1 ? 'was' : 'were'} not notes.`;
  return out;
}

/** Encode text the way the export does — for tests and callers building archives. */
export function textBytes(text: string): Uint8Array {
  return encoder.encode(text);
}
