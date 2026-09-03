/**
 * Where the desktop vault is, and how it gets pointed somewhere else.
 *
 * The browser vault is a database with no location. The desktop vault is a
 * FOLDER, and which folder has three answers, in this order:
 *
 *  1. what notey was launched with — `notey ~/notes/plan.md`, or the path
 *     the shell hands over when you open a `.md` with notey;
 *  2. the folder you chose, remembered from last time;
 *  3. `Documents/Notey`, the one it makes for you.
 *
 * Pointing at a FILE mounts the folder that file sits in. That is what
 * makes notey act like an editor rather than a vault browser: the file's
 * own folder becomes the vault, so an ordinary save writes back exactly
 * where the file came from, and the neighbours are notes too — links,
 * images and search all work with no second code path for "external"
 * files. A launch argument is deliberately NOT remembered; opening one
 * file should not move the vault you chose.
 *
 * Every Tauri import here is dynamic so the web bundle carries none of it.
 * The path arithmetic lives in desktopPaths.ts, where it is tested.
 */
import { isPathArg, launchTarget, toSlashes, type LaunchTarget } from './desktopPaths';
import { loadPrefs, savePrefs } from '../prefs';

export type { LaunchTarget };

/** The folder notey makes when nobody has chosen one. */
const DEFAULT_FOLDER = 'Notey';

let resolved: LaunchTarget | null = null;
/** The launch file, handed to the app once and then forgotten. */
let pending: string | null = null;

/** The folder chosen last time, or null if nobody ever has. */
export function savedRoot(): string | null {
  const root = loadPrefs().vaultRoot;
  return root === null || root.trim() === '' ? null : root;
}

/** True until a folder has been chosen — what the welcome asks about. */
export function isFirstRun(): boolean {
  return savedRoot() === null;
}

/** `Documents/Notey`, made if it is not there. */
export async function defaultRoot(): Promise<string> {
  const { documentDir } = await import('@tauri-apps/api/path');
  return toSlashes(await documentDir()) + '/' + DEFAULT_FOLDER;
}

/**
 * Let the fs plugin touch this folder. The capability can only name paths
 * known when the app was built, so anywhere else has to be permitted at
 * run time (see src-tauri/src/lib.rs).
 */
export async function allowFolder(root: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('allow_folder', { path: toSlashes(root) });
}

async function kindOf(path: string): Promise<'dir' | 'file' | 'missing'> {
  try {
    const { stat } = await import('@tauri-apps/plugin-fs');
    const info = await stat(path);
    return info.isDirectory ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/**
 * Where this launch's vault is, and what to open in it. Resolved once:
 * every caller (the store, the app) sees the same answer.
 */
export async function resolveDesktopVault(): Promise<LaunchTarget> {
  if (resolved) return resolved;
  resolved = await decide();
  pending = resolved.open;
  await allowFolder(resolved.root).catch(() => {
    // Refused: init will fail with something the user can act on, which
    // is better than a silent read of an empty folder.
  });
  return resolved;
}

async function decide(): Promise<LaunchTarget> {
  const arg = await launchArg();
  if (isPathArg(arg)) {
    const kind = await kindOf(arg);
    if (kind !== 'missing') return launchTarget(arg, kind === 'dir');
    // `notey todo.md` for a file that is not there yet is a reasonable
    // way to start one, so long as the folder it would live in exists.
    const wanted = launchTarget(arg, false);
    if ((await kindOf(wanted.root)) === 'dir') return wanted;
  }
  return { root: savedRoot() ?? (await defaultRoot()), open: null };
}

async function launchArg(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('opened_with');
  } catch {
    return null;
  }
}

/** The note a launch argument asked for — once. */
export function takePendingOpen(): string | null {
  const open = pending;
  pending = null;
  return open;
}

/** Ask for a folder, and remember it as the vault from now on. */
export async function chooseVaultFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Where should notey keep your notes?' });
  if (typeof picked !== 'string') return null;
  const root = toSlashes(picked);
  await allowFolder(root);
  savePrefs({ vaultRoot: root });
  return root;
}

/**
 * Ask for a `.md` file to edit in place. Its folder becomes the vault for
 * this session only — the folder you chose is still yours, and is back
 * next launch.
 */
export async function chooseVaultFile(): Promise<LaunchTarget | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    directory: false,
    multiple: false,
    title: 'Edit an existing file',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mkd'] }],
  });
  if (typeof picked !== 'string') return null;
  const target = launchTarget(picked, false);
  await allowFolder(target.root);
  return target;
}

/** Remember a folder as the vault without opening a picker (the welcome). */
export async function useFolder(root: string): Promise<void> {
  const clean = toSlashes(root);
  await allowFolder(clean);
  savePrefs({ vaultRoot: clean });
}
