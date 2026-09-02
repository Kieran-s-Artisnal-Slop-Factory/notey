/**
 * Many tabs, one database: the owner/follower vault.
 *
 * The browser vault is one sqlite database in OPFS, and the VFS it uses
 * takes exclusive OPFS sync-access handles that exist only in a dedicated
 * worker — so exactly ONE tab can have the database open (see
 * sqliteStore.ts for why no arrangement of workers changes that). Rather
 * than fight over it, tabs elect an owner and everyone else goes through
 * it:
 *
 *  - The OWNER holds the Web Lock `notey:vault-owner` for its lifetime,
 *    opens the sqlite worker, and serves every other tab's requests over a
 *    BroadcastChannel. It also announces every change so every tab's model
 *    stays fresh.
 *  - A FOLLOWER proxies the `VaultStore` interface over that channel:
 *    `{ type: 'req' }` out, `{ type: 'res' }` back, `{ type: 'changed' }`
 *    whenever anyone wrote anything.
 *  - Every tab is queued on the owner lock. When the owner goes, the
 *    browser releases its lock, the next tab in the queue is granted it,
 *    opens the database (retrying while the dead worker's handles are
 *    still being released) and announces itself; followers then re-drive
 *    what was in flight, ONE REQUEST AT A TIME in the order it was issued,
 *    so `rename A→B; write B` can never replay as `write B; rename A→B`.
 *    The owner does not de-duplicate: a re-driven request simply runs
 *    again. That is harmless for everything but `rename` and `create`,
 *    which the dead owner may already have done and which would then fail
 *    as "exists" — so a re-drive looks at the database before sending
 *    either of those (see alreadyDone).
 *
 * A BroadcastChannel never delivers to the object that posted, so nothing
 * here relies on hearing itself: the owner's own changes are handed to its
 * listeners directly, and a promoted tab drains its own queue against the
 * database it just opened.
 *
 * Nothing here decides who may WRITE a note — that is noteLocks.ts, a lock
 * per open note. This layer only makes the database reachable from every
 * tab, so two tabs on two different notes both persist.
 *
 * All platform pieces are injected (`locks`, `bus`, `open`) so the whole
 * protocol runs in node under fakePlatform.ts, tab deaths included.
 */
import type { FileRow, FileWrite, VaultStore } from './types';
import type { ChannelLike, LockManagerLike } from './fakePlatform';

export const OWNER_LOCK = 'notey:vault-owner';
export const VAULT_CHANNEL = 'notey:vault';

export type ChangeOp =
  | 'write'
  | 'create'
  | 'mkdir'
  | 'rename'
  | 'remove'
  | 'setMeta'
  /** The whole vault was replaced from a database file: start again. */
  | 'reload';

/** One thing that changed in the vault, as every tab hears it. */
export interface Change {
  op: ChangeOp;
  /** The path written, made, removed, or renamed FROM; the key for setMeta. */
  path: string;
  /** The rename's target. */
  to?: string;
}

type Op =
  | 'loadAll'
  | 'read'
  | 'list'
  | 'write'
  | 'create'
  | 'mkdir'
  | 'rename'
  | 'remove'
  | 'getMeta'
  | 'setMeta'
  | 'usage'
  | 'exportDb'
  | 'importDb';

const MUTATIONS: ReadonlySet<Op> = new Set<Op>([
  'write',
  'create',
  'mkdir',
  'rename',
  'remove',
  'setMeta',
  'importDb',
]);

type Args = Record<string, unknown>;

type Msg =
  | { type: 'req'; from: string; id: number; op: Op; args: Args }
  | { type: 'res'; to: string; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'owner-ready'; owner: string; backend: string }
  | { type: 'owner-gone'; owner: string }
  | { type: 'who-owns'; from: string }
  | { type: 'changed'; by: string; changes: Change[] };

export type Role = 'starting' | 'owner' | 'follower';

export interface SharedVault extends VaultStore {
  /** Which side of the channel this tab is on right now. */
  readonly role: Role;
  /** Every change any tab makes, this one's included, in order. */
  onChange(listener: (changes: Change[]) => void): () => void;
  /** This tab is going away: release the database and say so. */
  shutdown(): Promise<void>;
}

export interface SharedVaultDeps {
  /** This tab's id; anything unique per page load. */
  tabId: string;
  locks: LockManagerLike;
  bus: ChannelLike;
  /** Open the LOCAL store (the sqlite worker). Throws while the handles are taken. */
  open: () => Promise<VaultStore>;
  /** Tells a "handles still taken" failure from a real one. */
  isBusy?: (err: unknown) => boolean;
  /**
   * How long the owner may stay SILENT before a request to it is given up
   * on. Any word from the owner — an answer to anyone, a change — counts,
   * so a slow owner busy with another tab is not mistaken for a dead one.
   * The same span bounds a wait with NO owner: after the owner leaves, the
   * next one must announce itself within it or everything waiting fails.
   */
  requestTimeoutMs?: number;
  /** How long a starting tab waits to learn who owns the vault. */
  bootTimeoutMs?: number;
  /** Pauses between attempts to open a busy database, in order. */
  retryDelaysMs?: readonly number[];
  now?: () => number;
}

/**
 * Adds up to ~12 s; the dead tab's handles are usually free within one.
 * Few hops on purpose: a hidden tab's nested timers are throttled hard
 * after the fifth in a chain, and the next owner is often a hidden tab.
 */
const DEFAULT_RETRY: readonly number[] = [300, 700, 1500, 3000, 6000];

const NOT_ANSWERING = 'The tab holding the vault is not answering.';
const NO_DB_FILE = 'This vault is not one database file.';

interface Pending {
  id: number;
  op: Op;
  args: Args;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** When it was (last) sent, for the silence timeout. */
  sentAt: number;
  /** Which owner it was last sent to; null if never sent. */
  sentTo: string | null;
  /** Sent to the current owner and awaiting its answer. */
  inFlight: boolean;
  /** Reads issued by a re-drive's own check: sent at once, outside the queue. */
  direct: boolean;
  /** Wakes the re-drive loop when this request is done with. */
  onSettled?: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a request changes, for the `changed` broadcast. */
function changesOf(op: Op, args: Args): Change[] {
  switch (op) {
    case 'write':
    case 'create':
    case 'mkdir':
    case 'remove':
      return [{ op, path: String(args['path']) }];
    case 'rename':
      return [{ op, path: String(args['from']), to: String(args['to']) }];
    case 'setMeta':
      return [{ op, path: String(args['key']) }];
    case 'importDb':
      // Everything changed at once; there is no path to name.
      return [{ op: 'reload', path: '' }];
    default:
      return [];
  }
}

function runOn(store: VaultStore, op: Op, args: Args): Promise<unknown> {
  switch (op) {
    case 'loadAll':
      return store.loadAll();
    case 'read':
      return store.read(String(args['path']));
    case 'list':
      return store.list(String(args['prefix']));
    case 'write':
      return store.write(args as unknown as FileWrite);
    case 'create':
      return store.create(args as unknown as FileWrite);
    case 'mkdir':
      return store.mkdir(String(args['path']));
    case 'rename':
      return store.rename(String(args['from']), String(args['to']));
    case 'remove':
      return store.remove(String(args['path']));
    case 'getMeta':
      return store.getMeta(String(args['key']));
    case 'setMeta':
      return store.setMeta(String(args['key']), String(args['value']));
    case 'usage':
      return store.usage ? store.usage() : Promise.resolve(null);
    case 'exportDb':
      return store.exportDb ? store.exportDb() : Promise.reject(new Error(NO_DB_FILE));
    case 'importDb':
      return store.importDb
        ? store.importDb(args['bytes'] as Uint8Array)
        : Promise.reject(new Error(NO_DB_FILE));
  }
}

export function sharedVault(deps: SharedVaultDeps): SharedVault {
  const { tabId, locks, bus } = deps;
  const isBusy = deps.isBusy ?? ((err: unknown) => String(err).includes('notey-vault-busy'));
  const requestTimeoutMs = deps.requestTimeoutMs ?? 20_000;
  const bootTimeoutMs = deps.bootTimeoutMs ?? 60_000;
  const retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY;
  const now = deps.now ?? (() => Date.now());

  let role: Role = 'starting';
  let local: VaultStore | null = null;
  let ownerId: string | null = null;
  let ownerBackend = 'sqlite';
  /** The last time the owner said anything at all. */
  let ownerHeard = 0;
  /**
   * Bumped every time the owner this tab talks to changes. A re-drive's
   * check compares it before and after: an answer from a previous owner
   * says nothing about the current one.
   */
  let ownerEpoch = 0;
  /** Running while no owner is known and something is waiting for one. */
  let ownerlessTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(changes: Change[]) => void>();
  let shut = false;
  /** Set for exactly as long as a re-drive loop is running. */
  let draining = false;
  /** That loop's completion, for whoever must wait on it. */
  let drainDone: Promise<void> | null = null;
  let initPromise: Promise<void> | null = null;
  let resolveInit: (() => void) | null = null;
  let rejectInit: ((err: Error) => void) | null = null;
  /** Resolving this returns the owner lock. */
  let releaseOwnerLock: (() => void) | null = null;

  const post = (msg: Msg): void => {
    try {
      bus.postMessage(msg);
    } catch {
      // A closed channel: this tab is on its way out.
    }
  };

  const emit = (changes: Change[]): void => {
    if (changes.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(changes);
      } catch {
        // One listener's failure is not another's problem.
      }
    }
  };

  const finish = (p: Pending, outcome: { ok: true; value: unknown } | { ok: false; error: Error }): void => {
    if (!pending.has(p.id)) return;
    pending.delete(p.id);
    clearTimeout(p.timer);
    p.inFlight = false;
    if (outcome.ok) {
      p.resolve(outcome.value);
      if (MUTATIONS.has(p.op)) emit(changesOf(p.op, p.args));
    } else {
      p.reject(outcome.error);
    }
    p.onSettled?.();
  };

  const failAll = (message: string): void => {
    for (const p of [...pending.values()]) finish(p, { ok: false, error: new Error(message) });
  };

  /* ── running requests ─────────────────────────────────────────────── */

  /** The owner's path: run it here, tell everyone. */
  async function runLocally(op: Op, args: Args): Promise<unknown> {
    if (!local) throw new Error('vault not open');
    const result = await runOn(local, op, args);
    if (MUTATIONS.has(op)) {
      const changes = changesOf(op, args);
      post({ type: 'changed', by: tabId, changes });
      emit(changes);
    }
    return result;
  }

  /**
   * While no owner is known there is nobody whose silence could be
   * measured per request, so the wait itself gets one clock: if no owner
   * has spoken up by then, everything waiting is failed rather than left
   * hanging on a lock winner that never announces.
   */
  function armOwnerless(): void {
    if (ownerlessTimer !== undefined || shut || pending.size === 0) return;
    ownerlessTimer = setTimeout(() => {
      ownerlessTimer = undefined;
      if (!ownerId) failAll(NOT_ANSWERING);
    }, requestTimeoutMs);
  }

  function clearOwnerless(): void {
    clearTimeout(ownerlessTimer);
    ownerlessTimer = undefined;
  }

  /**
   * Give up on a request only once the owner has been silent for the
   * whole timeout — an owner answering OTHER tabs is alive, just busy.
   */
  function armTimeout(p: Pending): void {
    clearTimeout(p.timer);
    const check = (): void => {
      if (!pending.has(p.id)) return;
      if (!p.inFlight) {
        // Taken out of flight by an owner change: the re-drive re-sends
        // it, or — with no owner to send to — the ownerless clock covers it.
        if (!ownerId) armOwnerless();
        return;
      }
      const quietFor = now() - Math.max(p.sentAt, ownerHeard);
      if (quietFor < requestTimeoutMs) {
        p.timer = setTimeout(check, requestTimeoutMs - quietFor);
        return;
      }
      finish(p, { ok: false, error: new Error(NOT_ANSWERING) });
    };
    p.timer = setTimeout(check, requestTimeoutMs);
  }

  /** A follower's path: ask the owner. Waits for one if none is known. */
  function send(p: Pending): void {
    if (!ownerId || shut) {
      armOwnerless(); // owner-ready will get to it, or the clock will
      return;
    }
    p.sentTo = ownerId;
    p.sentAt = now();
    p.inFlight = true;
    armTimeout(p);
    post({ type: 'req', from: tabId, id: p.id, op: p.op, args: p.args });
  }

  function call<T>(op: Op, args: Args = {}, direct = false): Promise<T> {
    if (shut) return Promise.reject(new Error('vault closed'));
    if (role === 'owner') return runLocally(op, args) as Promise<T>;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        id,
        op,
        args,
        resolve: resolve as (v: unknown) => void,
        reject,
        sentAt: 0,
        sentTo: null,
        inFlight: false,
        direct,
      };
      pending.set(id, p);
      // While a re-drive is replaying older requests in order, new ones
      // wait their turn behind them; the re-drive's own reads do not.
      if (!draining || direct) send(p);
    });
  }

  /**
   * The owner this tab was talking to is not the one it will talk to
   * next: a new one announced itself, the old one left, or this tab took
   * over. Whatever was in flight goes again; a check read from the old
   * owner is worthless (and would never be re-sent), so it is failed and
   * the re-drive, woken here, looks again; see the epoch test in drain().
   */
  function ownerChanged(): void {
    ownerEpoch++;
    for (const p of [...pending.values()]) {
      clearTimeout(p.timer);
      p.inFlight = false;
      if (p.direct) finish(p, { ok: false, error: new Error('owner changed') });
      else p.onSettled?.();
    }
  }

  /**
   * A request that was sent to an owner who has since gone may already
   * have happened. Sending again is harmless for everything but `rename`
   * and `create`: those would fail as "exists" — the very clash they are
   * meant to report — so look first. Asked of whoever owns the vault now;
   * drain() discards the answer if that changes mid-look.
   */
  async function alreadyDone(p: Pending): Promise<{ done: boolean; value?: unknown }> {
    const no = { done: false };
    if (p.sentTo === null || (p.op !== 'rename' && p.op !== 'create')) return no;
    if (role !== 'owner' && !ownerId) return no; // nobody to ask yet; drain() waits
    try {
      if (p.op === 'rename') {
        const [to, from] = await Promise.all([
          call<FileRow | null>('read', { path: p.args['to'] }, true),
          call<FileRow | null>('read', { path: p.args['from'] }, true),
        ]);
        return { done: to !== null && from === null };
      }
      // A create is done when the row it asked for is there as asked; a
      // row with other content is somebody else's, and a real clash.
      const row = await call<FileRow | null>('read', { path: p.args['path'] }, true);
      const same =
        row !== null && row.kind === p.args['kind'] && (row.content ?? null) === (p.args['content'] ?? null);
      return same ? { done: true, value: row } : no;
    } catch {
      return no;
    }
  }

  /**
   * Re-drive everything in flight against whoever owns the vault now,
   * strictly in the order it was issued and one at a time, so nothing
   * that was sequenced by the caller can land out of order. One loop at a
   * time; a second call joins the running one.
   */
  function drain(): Promise<void> {
    if (!draining) drainDone = drainLoop();
    return drainDone!;
  }

  async function drainLoop(): Promise<void> {
    draining = true;
    try {
      while (!shut) {
        const next = [...pending.values()]
          .filter((p) => !p.inFlight && !p.direct)
          .sort((a, b) => a.id - b.id)[0];
        if (!next) break;
        const epoch = ownerEpoch;
        const check = await alreadyDone(next);
        if (ownerEpoch !== epoch) continue; // asked the wrong owner: look again
        if (check.done) {
          finish(next, { ok: true, value: check.value });
          continue;
        }
        if (!pending.has(next.id)) continue;
        if (role === 'owner') {
          pending.delete(next.id);
          clearTimeout(next.timer);
          try {
            next.resolve(await runLocally(next.op, next.args));
          } catch (err) {
            next.reject(err instanceof Error ? err : new Error(String(err)));
          }
          continue;
        }
        if (!ownerId) break; // nobody to send to; the next owner-ready resumes
        await new Promise<void>((done) => {
          next.onSettled = done;
          send(next);
        });
        next.onSettled = undefined;
      }
    } finally {
      draining = false;
    }
  }

  /* ── the owner ────────────────────────────────────────────────────── */

  async function becomeOwner(): Promise<void> {
    let store: VaultStore | null = null;
    for (let attempt = 0; ; attempt++) {
      if (shut) return;
      try {
        store = await deps.open();
        break;
      } catch (err) {
        const delay = retryDelays[attempt];
        if (!isBusy(err) || delay === undefined) {
          // Not a wait-for-it failure: this tab cannot serve. Give the
          // lock back so the next tab may try for itself.
          const error = err instanceof Error ? err : new Error(String(err));
          shut = true;
          rejectInit?.(error);
          failAll(error.message);
          return;
        }
        await sleep(delay);
      }
    }
    if (shut) {
      await store.close?.().catch(() => {});
      return;
    }
    local = store;
    role = 'owner';
    ownerId = tabId;
    ownerBackend = store.backend;
    post({ type: 'owner-ready', owner: tabId, backend: store.backend });
    resolveInit?.();
    clearOwnerless();
    // Whatever this tab was waiting on from the old owner is now its own
    // to do, before it answers anyone else. A re-drive parked on the old
    // owner's answer is woken to carry on locally, and waited for.
    ownerChanged();
    await drain();
  }

  function runElection(): void {
    locks
      .request(OWNER_LOCK, { mode: 'exclusive' }, async () => {
        if (shut) return;
        await becomeOwner();
        if (shut) return;
        await new Promise<void>((resolve) => {
          releaseOwnerLock = resolve;
        });
      })
      .catch((err: unknown) => {
        if (role === 'starting') rejectInit?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  async function serve(msg: Extract<Msg, { type: 'req' }>): Promise<void> {
    if (role !== 'owner' || !local) return; // not ours to answer
    try {
      const result = await runOn(local, msg.op, msg.args);
      post({ type: 'res', to: msg.from, id: msg.id, ok: true, result: result ?? null });
      if (MUTATIONS.has(msg.op)) {
        const changes = changesOf(msg.op, msg.args);
        post({ type: 'changed', by: msg.from, changes });
        emit(changes);
      }
    } catch (err) {
      post({ type: 'res', to: msg.from, id: msg.id, ok: false, error: String(err) });
    }
  }

  /* ── the channel ──────────────────────────────────────────────────── */

  const onMessage = (event: { data: unknown }): void => {
    const msg = event.data as Msg | null;
    if (!msg || typeof msg !== 'object' || shut) return;
    switch (msg.type) {
      case 'req':
        void serve(msg);
        return;
      case 'res': {
        ownerHeard = now();
        if (msg.to !== tabId) return;
        const p = pending.get(msg.id);
        if (!p) return;
        if (msg.ok) finish(p, { ok: true, value: msg.result });
        else finish(p, { ok: false, error: new Error(msg.error ?? 'vault op failed') });
        return;
      }
      case 'owner-ready': {
        if (role === 'owner') return; // cannot happen: the lock is exclusive
        ownerHeard = now();
        const changed = ownerId !== msg.owner;
        ownerId = msg.owner;
        ownerBackend = msg.backend;
        clearOwnerless();
        if (role === 'starting') {
          role = 'follower';
          resolveInit?.();
        }
        // Whatever the old owner had was lost with it: everything goes
        // again, in order.
        if (changed) ownerChanged();
        void drain();
        return;
      }
      case 'owner-gone':
        if (ownerId === msg.owner) {
          ownerId = null;
          // Nothing can be answered until the next owner: the per-request
          // clocks stop and the one ownerless clock starts.
          ownerChanged();
          armOwnerless();
        }
        return;
      case 'who-owns':
        if (role === 'owner' && local) post({ type: 'owner-ready', owner: tabId, backend: local.backend });
        return;
      case 'changed':
        ownerHeard = now();
        // Our own changes were emitted when they happened.
        if (msg.by !== tabId) emit(msg.changes);
        return;
    }
  };

  /* ── the store ────────────────────────────────────────────────────── */

  const vault: SharedVault = {
    get backend() {
      if (role === 'owner' && local) return local.backend;
      if (role === 'follower') return `${ownerBackend} — via another tab`;
      return 'sqlite (starting)';
    },
    get role() {
      return role;
    },

    init() {
      if (initPromise) return initPromise;
      initPromise = new Promise<void>((resolve, reject) => {
        resolveInit = resolve;
        rejectInit = reject;
      });
      bus.addEventListener('message', onMessage);
      runElection();
      post({ type: 'who-owns', from: tabId });
      const timer = setTimeout(() => {
        if (role === 'starting') {
          rejectInit?.(new Error('Another tab has the vault but is not answering. Close it and reload.'));
        }
      }, bootTimeoutMs);
      return initPromise.finally(() => clearTimeout(timer));
    },

    loadAll: () => call<FileRow[]>('loadAll'),
    read: (path) => call<FileRow | null>('read', { path }),
    list: (prefix) => call<FileRow[]>('list', { prefix }),
    write: (file) => call<FileRow>('write', { ...file }),
    create: (file) => call<FileRow>('create', { ...file }),
    mkdir: (path) => call<void>('mkdir', { path }),
    rename: (from, to) => call<void>('rename', { from, to }),
    remove: (path) => call<void>('remove', { path }),
    getMeta: (key) => call<string | null>('getMeta', { key }),
    setMeta: (key, value) => call<void>('setMeta', { key, value }),
    usage: () => call<{ bytes: number } | null>('usage'),
    exportDb: () => call<Uint8Array>('exportDb'),
    importDb: (bytes) => call<{ files: number; notes: number }>('importDb', { bytes }),

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async shutdown() {
      if (shut) return;
      shut = true;
      clearOwnerless();
      failAll('vault closed');
      if (role === 'owner') {
        post({ type: 'owner-gone', owner: tabId });
        await local?.close?.().catch(() => {});
        local = null;
      }
      releaseOwnerLock?.();
      bus.removeEventListener('message', onMessage);
      try {
        bus.close();
      } catch {
        // already closed
      }
    },

    close() {
      return vault.shutdown();
    },
  };

  return vault;
}
