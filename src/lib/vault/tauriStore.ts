/**
 * The desktop vault: real files in a folder you choose, via Tauri's fs
 * plugin. Notes are plain `.md` files anyone can open in any editor;
 * assets are real binaries in `.assets/` folders; the vault IS the disk.
 *
 * The folder is passed in rather than fixed, because on the desktop it is
 * a question with three answers — a launch argument, the folder you chose,
 * or `Documents/Notey` — and desktop.ts is what answers it. That is also
 * what lets `notey ~/notes/plan.md` write back to `~/notes`: the vault is
 * simply mounted there for the session.
 *
 * Same semantics as memoryStore.test.ts specifies: implicit parents,
 * subtree rename/remove, clash refusal. Files that are not notes, dirs or
 * assets (a stray .txt, someone's .git) are left alone and never listed —
 * but they DO ride along on a folder rename and DO go down with a folder
 * remove, because those act on the real directory.
 *
 * Meta lives in `.notey.json` at the vault root — one small JSON map, so
 * the vault stays self-describing on disk.
 */
import type { FileRow, FileWrite, VaultStore } from './types';
import { decodeBytes, encodeBytes } from '../encode/base64';
import { underRoot } from './desktopPaths';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const META_FILE = '.notey.json';

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

type FsModule = typeof import('@tauri-apps/plugin-fs');

export function tauriStore(root: string): VaultStore {
  let fs: FsModule | null = null;

  /** A vault path as a real one. Absolute, so no `baseDir` is involved. */
  const abs = (path: string): string => underRoot(root, path);
  const opts = () => ({});

  const needFs = (): FsModule => {
    if (!fs) throw new Error('vault not initialized');
    return fs;
  };

  const statMtime = async (path: string): Promise<string> => {
    try {
      const info = await needFs().stat(abs(path), opts());
      const m = info.mtime ? new Date(info.mtime) : new Date();
      return m.toISOString();
    } catch {
      return new Date().toISOString();
    }
  };

  const walk = async (rel: string, out: FileRow[]): Promise<void> => {
    const f = needFs();
    const entries = await f.readDir(abs(rel), opts());
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        out.push({ path, kind: 'dir', content: null, mime: null, bytes: null, mtime: '' });
        await walk(path, out);
      } else if (entry.name.toLowerCase().endsWith('.md') && !path.includes('/.assets/')) {
        const [content, mtime] = await Promise.all([f.readTextFile(abs(path), opts()), statMtime(path)]);
        out.push({ path, kind: 'note', content, mime: null, bytes: null, mtime });
      } else if (path.includes('/.assets/') || path.startsWith('.assets/')) {
        const info = await f.stat(abs(path), opts()).catch(() => null);
        out.push({
          path,
          kind: 'asset',
          content: null,
          mime: mimeOf(path),
          bytes: info ? Number(info.size) : null,
          mtime: info?.mtime ? new Date(info.mtime).toISOString() : '',
        });
      }
      // Anything else on disk is not notey's business — skipped, untouched.
    }
  };

  const readMeta = async (): Promise<Record<string, string>> => {
    try {
      const text = await needFs().readTextFile(abs(META_FILE), opts());
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };

  const store: VaultStore = {
    backend: `files (${root})`,

    async init() {
      fs = await import('@tauri-apps/plugin-fs');
      // The folder may not exist yet — a freshly chosen one, or the
      // default on a first run.
      if (!(await fs.exists(abs('')))) {
        await fs.mkdir(abs(''), { recursive: true });
      }
    },

    async loadAll() {
      const out: FileRow[] = [];
      await walk('', out);
      return out.sort((a, b) => (a.path < b.path ? -1 : 1));
    },

    async read(path) {
      const f = needFs();
      if (!(await f.exists(abs(path), opts()))) return null;
      const info = await f.stat(abs(path), opts());
      const mtime = info.mtime ? new Date(info.mtime).toISOString() : new Date().toISOString();
      if (info.isDirectory) return { path, kind: 'dir', content: null, mime: null, bytes: null, mtime };
      if (path.toLowerCase().endsWith('.md') && !path.includes('/.assets/')) {
        const content = await f.readTextFile(abs(path), opts());
        return { path, kind: 'note', content, mime: null, bytes: null, mtime };
      }
      const bytes = await f.readFile(abs(path), opts());
      return {
        path,
        kind: 'asset',
        content: encodeBytes(bytes),
        mime: mimeOf(path),
        bytes: bytes.byteLength,
        mtime,
      };
    },

    async list(prefix) {
      const f = needFs();
      if (!(await f.exists(abs(prefix), opts()))) return [];
      const out: FileRow[] = [];
      out.push({ path: prefix, kind: 'dir', content: null, mime: null, bytes: null, mtime: '' });
      await walk(prefix, out);
      // list() promises asset content — fill it in (a note's .assets only,
      // so the read set stays small).
      for (const row of out) {
        if (row.kind === 'asset') {
          const bytes = await f.readFile(abs(row.path), opts()).catch(() => null);
          if (bytes) row.content = encodeBytes(bytes);
        }
      }
      return out;
    },

    async write(file: FileWrite) {
      const f = needFs();
      const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      if (parent && !(await f.exists(abs(parent), opts()))) {
        await f.mkdir(abs(parent), { ...opts(), recursive: true });
      }
      if (file.kind === 'dir') {
        await f.mkdir(abs(file.path), { ...opts(), recursive: true });
      } else if (file.kind === 'asset') {
        await f.writeFile(abs(file.path), decodeBytes(file.content ?? ''), opts());
      } else {
        await f.writeTextFile(abs(file.path), file.content ?? '', opts());
      }
      return {
        path: file.path,
        kind: file.kind,
        content: file.content ?? null,
        mime: file.mime ?? null,
        bytes: file.bytes ?? null,
        mtime: new Date().toISOString(),
      };
    },

    async create(file) {
      if (await needFs().exists(abs(file.path), opts())) {
        throw new Error(`create target exists: ${file.path}`);
      }
      return store.write(file);
    },

    async mkdir(path) {
      await needFs().mkdir(abs(path), { ...opts(), recursive: true });
    },

    async rename(from, to) {
      const f = needFs();
      if (await f.exists(abs(to), opts())) throw new Error(`rename target exists: ${to}`);
      const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
      if (parent && !(await f.exists(abs(parent), opts()))) {
        await f.mkdir(abs(parent), { ...opts(), recursive: true });
      }
      await f.rename(abs(from), abs(to));
    },

    async remove(path) {
      const f = needFs();
      if (!(await f.exists(abs(path), opts()))) return;
      await f.remove(abs(path), { ...opts(), recursive: true });
    },

    async getMeta(key) {
      return (await readMeta())[key] ?? null;
    },

    async setMeta(key, value) {
      const meta = await readMeta();
      meta[key] = value;
      await needFs().writeTextFile(abs(META_FILE), JSON.stringify(meta, null, 2), opts());
    },
  };
  return store;
}
