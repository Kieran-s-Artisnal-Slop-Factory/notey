/**
 * An in-memory VaultStore — the unit-test double and the semantics
 * reference. Every behavior here (implicit parent dirs, subtree rename,
 * clash refusal, subtree remove) is what the sqlite worker and the Tauri
 * store must also do; memoryStore.test.ts is the contract's spec.
 */
import type { FileRow, FileWrite, VaultStore } from './types';

export function memoryStore(seed: readonly FileWrite[] = []): VaultStore {
  const rows = new Map<string, FileRow>();
  const meta = new Map<string, string>();
  let clock = 0;
  const nowIso = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();

  const ensureParents = (path: string, at: string): void => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!rows.has(dir)) {
        rows.set(dir, { path: dir, kind: 'dir', content: null, mime: null, bytes: null, mtime: at });
      }
    }
  };

  const store: VaultStore = {
    backend: 'memory',

    async init() {
      for (const file of seed) await store.write(file);
    },

    async loadAll() {
      return [...rows.values()]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((row) => (row.kind === 'asset' ? { ...row, content: null } : { ...row }));
    },

    async read(path) {
      const row = rows.get(path);
      return row ? { ...row } : null;
    },

    async list(prefix) {
      return [...rows.values()]
        .filter((row) => row.path === prefix || row.path.startsWith(prefix + '/'))
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((row) => ({ ...row }));
    },

    async write(file) {
      const at = nowIso();
      ensureParents(file.path, at);
      const row: FileRow = {
        path: file.path,
        kind: file.kind,
        content: file.content ?? null,
        mime: file.mime ?? null,
        bytes: file.bytes ?? null,
        mtime: at,
      };
      rows.set(file.path, row);
      return { ...row };
    },

    async mkdir(path) {
      ensureParents(path + '/x', nowIso());
    },

    async rename(from, to) {
      for (const path of rows.keys()) {
        if (path === to || path.startsWith(to + '/')) throw new Error(`rename target exists: ${to}`);
      }
      const at = nowIso();
      ensureParents(to, at);
      const moves: [string, FileRow][] = [];
      for (const [path, row] of rows) {
        if (path === from || path.startsWith(from + '/')) {
          moves.push([path, row]);
        }
      }
      for (const [path, row] of moves) {
        rows.delete(path);
        const next = to + path.slice(from.length);
        rows.set(next, { ...row, path: next, mtime: at });
      }
    },

    async remove(path) {
      for (const key of [...rows.keys()]) {
        if (key === path || key.startsWith(path + '/')) rows.delete(key);
      }
    },

    async getMeta(key) {
      return meta.get(key) ?? null;
    },

    async setMeta(key, value) {
      meta.set(key, value);
    },

    async usage() {
      let bytes = 0;
      for (const row of rows.values()) bytes += row.content?.length ?? 0;
      return { bytes };
    },
  };
  return store;
}
