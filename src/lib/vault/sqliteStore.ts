/**
 * The browser VaultStore: a thin RPC proxy over the sqlite worker
 * (sqlite-worker.ts owns all SQL and the persistence tiers).
 *
 * ONE TAB AT A TIME, and not by choice. The OPFS sync-access-handle API
 * that the sqlite SAH-pool VFS needs exists only in dedicated workers, and
 * a SharedWorker can neither use it nor start a dedicated worker to do so
 * (Chrome does not define `Worker` in that scope). So the database cannot
 * be shared between tabs by any arrangement of workers, and a second tab
 * has to be handed the vault rather than given a copy of it — see the
 * hand-off in store.ts, which is what `VAULT_BUSY` below drives.
 */
/*
 * The `?sharedworker` / `?worker` suffixes are the bundler's own way of
 * asking for a worker constructor. They are used instead of
 * `new SharedWorker(new URL(…))` because the URL form is not served as a
 * module in dev, and the shared worker then fails to fetch on every load.
 */
import SqliteWorker from './sqlite-worker?worker';
import type { FileRow, FileWrite, VaultStore } from './types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface Reply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** What a locked-out boot throws, so the app can tell it from a real fault. */
export const VAULT_BUSY = 'notey-vault-busy';

export function sqliteStore(): VaultStore {
  let port: MessagePort | Worker | null = null;
  let terminate: (() => void) | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let backend = 'sqlite (starting)';
  /**
   * Set when the worker has said hello. Before that, an error event means
   * the script did not load and the fallback is right; after it, an error
   * event is just something the worker logged — sqlite's OPFS pool throws
   * a few DOMExceptions on its way to a working database — and tearing the
   * connection down over one would be a bug, not a recovery.
   */
  let greeted = false;

  const call = <T>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!port) return Promise.reject(new Error('vault worker not started'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port!.postMessage({ id, op, args });
    });
  };

  const onReply = (event: MessageEvent<Reply>): void => {
    const { id, ok, result, error } = event.data;
    if (id < 0) {
      greeted = true; // the ready / client-id beacons
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error ?? 'vault op failed'));
  };

  const failAll = (message: string): void => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new Error(message));
    }
  };

  return {
    get backend() {
      return backend;
    },

    async init() {
      if (port) return;
      const worker = new SqliteWorker();
      worker.onmessage = onReply;
      worker.onerror = (event) => {
        if (!greeted) failAll('vault worker error: ' + event.message);
      };
      port = worker;
      terminate = () => worker.terminate();

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('vault worker took too long to start')), 30_000)
      );
      let started: { backend: string };
      try {
        started = await Promise.race([call<{ backend: string }>('init'), timeout]);
      } catch (err) {
        terminate();
        port = null;
        terminate = null;
        greeted = false;
        // The one failure the app can do something about.
        if (String(err).includes('already open in another tab')) throw new Error(VAULT_BUSY);
        throw err;
      }
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

    /**
     * Let go of the database so another tab can have it. The worker closes
     * the connection, which releases the OPFS handles.
     */
    async close() {
      if (!port) return;
      await call('close').catch(() => {});
      terminate?.();
      port = null;
      terminate = null;
      greeted = false;
    },
  };
}
