/**
 * Path algebra and the FileRow ⇄ Note conversion.
 *
 * Paths are forward-slash, no leading or trailing slash. The first segment
 * of a note's path is its notebook; a root-level note is in the Pile. All
 * of this is pure and unit-tested; the stores just move rows.
 */
import type { FileRow, FolderEntry, Note } from './types';
import { buildNoteContent, noteFields, parseNoteContent } from './frontmatter';
import { ASSET_DIR } from '../notebook/assets';

/* ── paths ──────────────────────────────────────────────────────────── */

/** Collapse separators and strip the edges: `\a\\b/` → `a/b`. */
export function normalizePath(path: string): string {
  return path
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

/** The parent folder's path, or null at the root. */
export function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/');
  return i === -1 ? null : path.slice(0, i);
}

/** The last path segment. */
export function nameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** The filename without its `.md` — a note's title. */
export function stemOf(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

export function joinPath(folder: string | null, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** True for `.assets` dirs and anything inside one. */
export function isAssetPath(path: string): boolean {
  return path === ASSET_DIR || path.endsWith('/' + ASSET_DIR) || path.includes('/' + ASSET_DIR + '/') || path.startsWith(ASSET_DIR + '/');
}

/**
 * A title as a filename stem. Titles ARE filenames (the Tauri build writes
 * them to a real disk), so the characters no filesystem takes are swapped
 * for `-`; spaces and unicode stay, because files belong to people.
 */
export function sanitizeTitle(title: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex -- strip what no filesystem takes
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[.\s-]+|[-.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  return clean === '' ? 'Untitled' : clean;
}

/** `folder/Title.md`, sanitized. */
export function notePath(folder: string | null, title: string): string {
  return joinPath(folder, sanitizeTitle(title) + '.md');
}

/**
 * A note path no existing path uses (case-insensitive — the disks the Tauri
 * build writes to are). Clashes get ` 2`, ` 3`… on the stem.
 */
export function uniqueNotePath(folder: string | null, title: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  const stem = sanitizeTitle(title);
  let candidate = joinPath(folder, stem + '.md');
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) {
    candidate = joinPath(folder, `${stem} ${n}.md`);
  }
  return candidate;
}

/** Same, for folders. */
export function uniqueFolderPath(parent: string | null, name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  const stem = sanitizeTitle(name);
  let candidate = joinPath(parent, stem);
  for (let n = 2; lower.has(candidate.toLowerCase()); n++) {
    candidate = joinPath(parent, `${stem} ${n}`);
  }
  return candidate;
}

/** Where a note's assets live: `<its folder>/.assets/<name>`. */
export function assetPathFor(noteOrFolderPath: string, name: string, kind: 'note' | 'dir' = 'note'): string {
  const folder = kind === 'note' ? parentOf(noteOrFolderPath) : noteOrFolderPath;
  return joinPath(folder, `${ASSET_DIR}/${name}`);
}

/** Every `.assets/<name>` ref a markdown body carries (deduped, in order). */
export function assetRefsIn(markdown: string): string[] {
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/\.assets\/[A-Za-z0-9._-]+/g)) seen.add(match[0]);
  return [...seen];
}

/* ── FileRow ⇄ Note ─────────────────────────────────────────────────── */

/** Parse a note row. `fm` keeps the raw map so a save round-trips key order. */
export function toNote(row: Pick<FileRow, 'path' | 'content' | 'mtime'>): Note {
  const { data, body } = parseNoteContent(row.content ?? '');
  const fields = noteFields(data);
  return {
    id: row.path,
    title: stemOf(nameOf(row.path)),
    body_md: body,
    aliases: [...fields.aliases],
    tags: [...fields.tags],
    parent_id: parentOf(row.path),
    fm: fields.extra,
    created_at: fields.created ?? row.mtime,
    updated_at: fields.updated ?? row.mtime,
  };
}

/** Serialize a note back to file content, stamping `updated`. */
export function noteContentOf(note: Note, originalData: Record<string, unknown> = {}): string {
  return buildNoteContent(
    {
      tags: note.tags,
      aliases: note.aliases,
      created: note.created_at,
      updated: note.updated_at,
      extra: note.fm,
    },
    note.body_md,
    originalData
  );
}

/** A folder row as a tree entry. */
export function toFolder(path: string): FolderEntry {
  return { id: path, title: nameOf(path), parent_id: parentOf(path) };
}

/**
 * Folders and notes as ONE Note[] for useful's `buildTree` — a folder
 * becomes a Note with an empty body. `kindOf` below tells them apart again.
 */
export function treeEntries(folders: readonly FolderEntry[], notes: readonly Note[]): Note[] {
  const folderNotes: Note[] = folders.map((f) => ({
    id: f.id,
    title: f.title,
    body_md: '',
    aliases: [],
    tags: [],
    parent_id: f.parent_id,
    fm: {},
    created_at: null,
    updated_at: '',
  }));
  return [...folderNotes, ...notes];
}
