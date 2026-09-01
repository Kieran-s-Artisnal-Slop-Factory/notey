/**
 * The browser VaultStore: a thin RPC proxy over the sqlite worker
 * (sqlite-worker.ts owns all SQL and the persistence tiers). One in-flight
 * map, monotonically increasing ids, and a boot timeout so a worker that
 * fails to load reads as an error instead of a hang.
 */
import type { FileRow, FileWrite, VaultStore } from './types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function sqliteStore(): VaultStore {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let backend = 'sqlite (starting)';

  const call = <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!worker) return Promise.reject(new Error('vault worker not started'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker!.postMessage({ id, op, args });
    });
  };

  return {
    get backend() {
      return backend;
    },

    async init() {
      if (worker) return;
      worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
        const { id, ok, result, error } = event.data;
        if (id === -1) return; // module-evaluated beacon
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (ok) entry.resolve(result);
        else entry.reject(new Error(error ?? 'vault op failed'));
      };
      worker.onerror = (event) => {
        // A worker that cannot load fails every waiting call, not silence.
        for (const [id, entry] of pending) {
          pending.delete(id);
          entry.reject(new Error('vault worker error: ' + event.message));
        }
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('vault worker took too long to start')), 30_000)
      );
      const started = await Promise.race([call<{ backend: string }>('init'), timeout]);
      backend =
        started.backend === 'opfs'
          ? 'sqlite (OPFS)'
          : started.backend === 'snapshot'
            ? 'sqlite (snapshot — no OPFS in this browser)'
            : 'sqlite (memory only — nothing persists!)';
    },

    loadAll: () => call<FileRow[]>('loadAll'),
    read: (path) => call<FileRow | null>('read', { path }),
    list: (prefix) => call<FileRow[]>('list', { prefix }),
    write: (file: FileWrite) => call<FileRow>('write', { ...file }),
    mkdir: (path) => call<void>('mkdir', { path }),
    rename: (from, to) => call<void>('rename', { from, to }),
    remove: (path) => call<void>('remove', { path }),
    getMeta: (key) => call<string | null>('getMeta', { key }),
    setMeta: (key, value) => call<void>('setMeta', { key, value }),
    usage: () => call<{ bytes: number } | null>('usage'),

    async close() {
      if (!worker) return;
      await call('close').catch(() => {});
      worker.terminate();
      worker = null;
    },
  };
}
