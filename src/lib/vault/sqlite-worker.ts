/**
 * The browser vault: sqlite-wasm in a dedicated worker.
 *
 * Why a worker: the OPFS sync-access-handle API only exists in workers, and
 * keeping sqlite off the main thread keeps typing latency flat. Why the
 * `opfs-sahpool` VFS and not the default `opfs` one: the default needs
 * COOP/COEP headers (SharedArrayBuffer) that GitHub Pages will not send;
 * the SAH-pool VFS works without them.
 *
 * Persistence tiers, best available wins:
 *   1. `opfs`   — opfs-sahpool database, durable.
 *   2. `snapshot` — OPFS unavailable (old Safari, some private windows):
 *      an in-memory database, serialized into IndexedDB after every write
 *      (debounced) and reloaded at boot. Slower and byte-for-byte, but the
 *      notes survive a reload.
 *   3. `memory` — nothing persists (IndexedDB also refused); Settings says
 *      so loudly.
 *
 * The worker owns ALL SQL. The main thread talks a tiny RPC (`VaultStore`
 * methods by name); rows cross the boundary as plain objects.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

interface Req {
  id: number;
  op: string;
  args: Record<string, unknown>;
}

/**
 * A connected tab. As a SharedWorker every tab talks to the SAME database
 * over its own port, which is what lets two tabs be open at once: the OPFS
 * handles are held once, here, instead of being fought over.
 */
interface Client {
  id: number;
  post(message: unknown): void;
}

type Db = {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: 'object';
    returnValue?: 'resultRows';
  }): unknown[];
  selectValue(sql: string, bind?: unknown[]): unknown;
  transaction(fn: () => void): void;
  close(): void;
  pointer?: number;
};

let db: Db | null = null;
let backend: 'opfs' | 'snapshot' | 'memory' = 'memory';
let sqlite3Api: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;

/* ── schema ─────────────────────────────────────────────────────────── */
/* Appended, never edited: user_version = MIGRATIONS.length. Each entry
   describes the schema at that version forever. */
const MIGRATIONS: string[] = [
  // v1 — the pseudo-filesystem.
  `CREATE TABLE IF NOT EXISTS files (
     path TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('dir','note','asset')),
     content TEXT,
     mime TEXT,
     bytes INTEGER,
     mtime TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

function migrate(d: Db): void {
  const version = Number(d.selectValue('PRAGMA user_version') ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec({ sql: MIGRATIONS[v]! });
    });
    d.exec({ sql: `PRAGMA user_version = ${v + 1}` });
  }
}

/* ── snapshot tier (IndexedDB, raw API — no libraries in the worker) ── */

const SNAP_DB = 'notey-vault-snapshot';
const SNAP_STORE = 'snapshot';
const SNAP_KEY = 'db';
let snapTimer: ReturnType<typeof setTimeout> | undefined;

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SNAP_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SNAP_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<Uint8Array | null> {
  const d = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = d.transaction(SNAP_STORE).objectStore(SNAP_STORE).get(SNAP_KEY);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    d.close();
  }
}

async function idbPut(bytes: Uint8Array): Promise<void> {
  const d = await idbOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(SNAP_STORE, 'readwrite');
      tx.objectStore(SNAP_STORE).put(bytes, SNAP_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

function scheduleSnapshot(): void {
  if (backend !== 'snapshot' || !db || !sqlite3Api) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    try {
      const bytes = (
        sqlite3Api as unknown as {
          capi: { sqlite3_js_db_export(p: number | undefined): Uint8Array };
        }
      ).capi.sqlite3_js_db_export(db!.pointer);
      void idbPut(bytes).catch(() => {});
    } catch {
      // A failed snapshot must never break the write that triggered it.
    }
  }, 400);
}

/* ── boot ───────────────────────────────────────────────────────────── */

async function init(): Promise<{ backend: string }> {
  if (db) return { backend };
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  sqlite3Api = sqlite3;
  const opfsSupported = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  try {
    if (!opfsSupported) throw new Error('no OPFS');
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'notey' });
    db = new pool.OpfsSAHPoolDb('/notey.db') as unknown as Db;
    backend = 'opfs';
  } catch (err) {
    if (opfsSupported) {
      // OPFS exists but the pool would not open — almost always another
      // tab holding the exclusive sync-access handles. Falling back to a
      // DIFFERENT storage tier here would fork the vault in two, so this
      // is a hard stop instead.
      throw new Error(
        'The vault is already open in another tab (' + String(err) + '). Close it and reload.'
      );
    }
    // No OPFS — in-memory database, restored from / mirrored to IndexedDB.
    try {
      const snapshot = await idbGet();
      if (snapshot) {
        const p = sqlite3.wasm.allocFromTypedArray(snapshot);
        const d = new sqlite3.oo1.DB() as unknown as Db;
        const rc = sqlite3.capi.sqlite3_deserialize(
          (d as unknown as { pointer: number }).pointer,
          'main',
          p,
          snapshot.byteLength,
          snapshot.byteLength,
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
        );
        if (rc !== 0) throw new Error('deserialize failed: ' + rc);
        db = d;
      } else {
        db = new sqlite3.oo1.DB() as unknown as Db;
      }
      await idbPut(new Uint8Array(0)).catch(() => {
        throw new Error('IndexedDB refused');
      });
      backend = 'snapshot';
    } catch {
      db = new sqlite3.oo1.DB() as unknown as Db;
      backend = 'memory';
    }
  }
  migrate(db);
  if (backend === 'snapshot') scheduleSnapshot();
  return { backend };
}

/* ── vault ops ──────────────────────────────────────────────────────── */

const nowIso = (): string => new Date().toISOString();

function need(): Db {
  if (!db) throw new Error('vault not initialized');
  return db;
}

function parentDirs(path: string): string[] {
  const parts = path.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'));
  return dirs;
}

function ensureParents(d: Db, path: string, at: string): void {
  for (const dir of parentDirs(path)) {
    d.exec({
      sql: `INSERT INTO files (path, kind, content, mime, bytes, mtime)
            VALUES (?, 'dir', NULL, NULL, NULL, ?)
            ON CONFLICT(path) DO NOTHING`,
      bind: [dir, at],
    });
  }
}

const ops: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
  init: () => init(),

  loadAll: () =>
    need().exec({
      sql: `SELECT path, kind,
                   CASE WHEN kind = 'asset' THEN NULL ELSE content END AS content,
                   mime, bytes, mtime
            FROM files ORDER BY path`,
      rowMode: 'object',
      returnValue: 'resultRows',
    }),

  list: ({ prefix }) =>
    need().exec({
      sql: `SELECT path, kind, content, mime, bytes, mtime FROM files
            WHERE path = ?1 OR path LIKE ?1 || '/%' ORDER BY path`,
      bind: [prefix],
      rowMode: 'object',
      returnValue: 'resultRows',
    }),

  read: ({ path }) => {
    const rows = need().exec({
      sql: `SELECT path, kind, content, mime, bytes, mtime FROM files WHERE path = ?`,
      bind: [path],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    return rows[0] ?? null;
  },

  write: ({ path, kind, content, mime, bytes }) => {
    const d = need();
    const at = nowIso();
    let row: unknown;
    d.transaction(() => {
      ensureParents(d, path as string, at);
      d.exec({
        sql: `INSERT INTO files (path, kind, content, mime, bytes, mtime)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                kind = excluded.kind, content = excluded.content,
                mime = excluded.mime, bytes = excluded.bytes, mtime = excluded.mtime`,
        bind: [path, kind, content ?? null, mime ?? null, bytes ?? null, at],
      });
      row = { path, kind, content: content ?? null, mime: mime ?? null, bytes: bytes ?? null, mtime: at };
    });
    scheduleSnapshot();
    return row;
  },

  mkdir: ({ path }) => {
    const d = need();
    const at = nowIso();
    d.transaction(() => {
      ensureParents(d, path + '/x', at);
    });
    scheduleSnapshot();
    return null;
  },

  rename: ({ from, to }) => {
    const d = need();
    const at = nowIso();
    d.transaction(() => {
      const clash = d.selectValue(`SELECT 1 FROM files WHERE path = ?1 OR path LIKE ?1 || '/%' LIMIT 1`, [
        to,
      ]);
      if (clash) throw new Error(`rename target exists: ${to}`);
      ensureParents(d, to as string, at);
      d.exec({
        sql: `UPDATE files
              SET path = ?2 || substr(path, length(?1) + 1), mtime = ?3
              WHERE path = ?1 OR path LIKE ?1 || '/%'`,
        bind: [from, to, at],
      });
    });
    scheduleSnapshot();
    return null;
  },

  remove: ({ path }) => {
    const d = need();
    d.transaction(() => {
      d.exec({ sql: `DELETE FROM files WHERE path = ?1 OR path LIKE ?1 || '/%'`, bind: [path] });
    });
    scheduleSnapshot();
    return null;
  },

  getMeta: ({ key }) => {
    const v = need().selectValue(`SELECT value FROM meta WHERE key = ?`, [key]);
    return v === undefined ? null : v;
  },

  setMeta: ({ key, value }) => {
    need().exec({
      sql: `INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      bind: [key, value],
    });
    scheduleSnapshot();
    return null;
  },

  usage: () => {
    const d = need();
    const pages = Number(d.selectValue('PRAGMA page_count') ?? 0);
    const size = Number(d.selectValue('PRAGMA page_size') ?? 0);
    return { bytes: pages * size };
  },

  close: () => {
    clearTimeout(snapTimer);
    db?.close();
    db = null;
    return null;
  },
};

let nextClientId = 1;

/** Serve one connected tab. */
function serve(client: Client): void {
  client.post({ id: -2, ok: true, result: { client: client.id } });
  // Tell it the module evaluated (a worker load error otherwise surfaces
  // as a silent init timeout).
  client.post({ id: -1, ok: true, result: 'ready' });
}

async function dispatch(client: Client, data: Req): Promise<void> {
  const { id, op, args } = data;
  try {
    const handler = ops[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    const result = await handler({ ...(args ?? {}), client: client.id });
    client.post({ id, ok: true, result });
  } catch (err) {
    client.post({ id, ok: false, error: String(err) });
  }
}

/*
 * One file, two entry points. As a SharedWorker (every browser but Safari)
 * all tabs share this one database and nobody is locked out; as a plain
 * Worker there is one per tab, and the OPFS pool below refuses the second
 * — which is the old behaviour, kept only as a fallback.
 */
if ('onconnect' in self) {
  (self as unknown as SharedWorkerGlobalScope).onconnect = (event: MessageEvent) => {
    const port = event.ports[0]!;
    const client: Client = { id: nextClientId++, post: (m) => port.postMessage(m) };
    port.onmessage = (message: MessageEvent<Req>) => void dispatch(client, message.data);
    port.start();
    serve(client);
  };
} else {
  const client: Client = {
    id: nextClientId++,
    post: (m) => (self as unknown as Worker).postMessage(m),
  };
  self.onmessage = (event: MessageEvent<Req>) => void dispatch(client, event.data);
  serve(client);
}
