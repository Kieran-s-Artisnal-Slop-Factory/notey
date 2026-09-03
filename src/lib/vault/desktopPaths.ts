/**
 * Where the desktop vault lives, as pure path arithmetic.
 *
 * The browser vault has no location — it is a database — but the desktop
 * one IS a folder, and which folder is a question with three answers:
 * what notey was launched with, what you chose last time, and the default
 * under Documents. This module holds the rules that pick between them and
 * nothing else, so they can be tested without a desktop.
 *
 * Paths here are OS paths (`C:\Users\me\notes`, `/home/me/notes`), not the
 * vault's own forward-slash relative ones. Both separators are understood
 * because Windows writes `\` and everything else — including Tauri's own
 * fs plugin, and any path a person pastes — writes `/`.
 */

/** Everything before the last separator: `C:\a\b.md` → `C:\a`. */
export function dirOf(path: string): string {
  const at = lastSep(trimTrailing(path));
  if (at < 0) return '';
  // A root (`/` or `C:\`) keeps its separator; nothing else does.
  const head = trimTrailing(path).slice(0, at);
  return head === '' ? path.slice(0, 1) : /^[A-Za-z]:$/.test(head) ? head + '/' : head;
}

/** Everything after the last separator: `C:\a\b.md` → `b.md`. */
export function baseOf(path: string): string {
  const clean = trimTrailing(path);
  const at = lastSep(clean);
  return at < 0 ? clean : clean.slice(at + 1);
}

function lastSep(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** Drop trailing separators, but never turn a root into nothing. */
function trimTrailing(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}

/** An OS path with forward slashes, which every platform's fs takes. */
export function toSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** `root` + a vault-relative path, for the fs plugin. */
export function underRoot(root: string, path: string): string {
  const base = toSlashes(root);
  return path === '' ? base : `${base}/${path}`;
}

export interface LaunchTarget {
  /** The folder to mount as the vault. */
  root: string;
  /** A vault-relative note to open, when notey was pointed at one file. */
  open: string | null;
}

/**
 * What `notey <path>` should do.
 *
 * A folder becomes the vault. A FILE mounts the folder it sits in and
 * opens it — which is the whole trick behind "act like an editor": once
 * its folder is the vault, every ordinary save writes back to exactly
 * where the file came from, and its neighbours are notes too, so links
 * and images work without a second code path.
 */
export function launchTarget(path: string, isDirectory: boolean): LaunchTarget {
  const clean = toSlashes(path);
  if (isDirectory) return { root: clean, open: null };
  return { root: toSlashes(dirOf(clean)), open: baseOf(clean) };
}

/**
 * Is this an argument to open, or something the shell added? Flags are
 * not paths, and neither is the `--` a launcher may pass along.
 */
export function isPathArg(arg: string | null | undefined): arg is string {
  return typeof arg === 'string' && arg.trim() !== '' && !arg.startsWith('-');
}

/** A short label for a folder: the last segment, or the whole path if short. */
export function rootLabel(root: string): string {
  const clean = toSlashes(root);
  return baseOf(clean) || clean;
}
