/**
 * Test doubles for the two browser APIs the multi-tab vault is built on:
 * the Web Locks API (`navigator.locks`) and BroadcastChannel. Both follow
 * the platform's semantics closely enough that tabs.test.ts and
 * noteLocks.test.ts can script several "tabs" in one node process, kill
 * one, and watch the others recover.
 *
 * Not a test file itself (vitest only runs `*.test.ts`); shared by them.
 */

/* ── Web Locks ───────────────────────────────────────────────────────── */

export type LockMode = 'exclusive' | 'shared';

export interface FakeLockOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

export interface FakeLockInfo {
  name: string;
  mode: LockMode;
  clientId: string;
}

/** The subset of `LockManager` the vault uses. */
export interface LockManagerLike {
  request<T>(name: string, callback: (lock: { name: string; mode: LockMode } | null) => T | Promise<T>): Promise<T>;
  request<T>(
    name: string,
    options: FakeLockOptions,
    callback: (lock: { name: string; mode: LockMode } | null) => T | Promise<T>
  ): Promise<T>;
  query(): Promise<{ held: FakeLockInfo[]; pending: FakeLockInfo[] }>;
}

interface Held {
  name: string;
  mode: LockMode;
  clientId: string;
}

interface Waiting {
  name: string;
  mode: LockMode;
  clientId: string;
  grant: () => void;
  abort: (err: Error) => void;
  signal?: AbortSignal;
}

function abortError(): Error {
  const err = new Error('The lock request was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * One lock table shared by every fake "tab". `client(id)` returns that
 * tab's `navigator.locks`; `unload(id)` does what closing the tab does —
 * releases everything it held and forgets everything it was waiting for.
 */
export class FakeLocks {
  private held: Held[] = [];
  private waiting: Waiting[] = [];

  /** Every lock currently held, for assertions. */
  heldNames(): string[] {
    return this.held.map((h) => h.name);
  }

  client(clientId: string): LockManagerLike {
    const request = <T>(
      name: string,
      optionsOrCb: FakeLockOptions | ((lock: { name: string; mode: LockMode } | null) => T | Promise<T>),
      maybeCb?: (lock: { name: string; mode: LockMode } | null) => T | Promise<T>
    ): Promise<T> => {
      const options: FakeLockOptions = typeof optionsOrCb === 'function' ? {} : optionsOrCb;
      const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb)!;
      const mode = options.mode ?? 'exclusive';
      if (options.signal?.aborted) return Promise.reject(abortError());

      const run = async (): Promise<T> => {
        const entry: Held = { name, mode, clientId };
        this.held.push(entry);
        // The platform grants synchronously in queue order but runs the
        // callback in a later task — a release() issued in between must
        // see the grant handed straight back.
        await Promise.resolve();
        try {
          return await callback({ name, mode });
        } finally {
          this.held = this.held.filter((h) => h !== entry);
          this.pump();
        }
      };

      if (this.grantable(name, mode)) return run();
      if (options.ifAvailable) return Promise.resolve().then(() => callback(null));

      return new Promise<T>((resolve, reject) => {
        const entry: Waiting = {
          name,
          mode,
          clientId,
          signal: options.signal,
          grant: () => {
            options.signal?.removeEventListener('abort', onAbort);
            run().then(resolve, reject);
          },
          abort: (err) => {
            options.signal?.removeEventListener('abort', onAbort);
            reject(err);
          },
        };
        const onAbort = (): void => {
          this.waiting = this.waiting.filter((w) => w !== entry);
          entry.abort(abortError());
        };
        options.signal?.addEventListener('abort', onAbort);
        this.waiting.push(entry);
      });
    };

    return {
      request: request as LockManagerLike['request'],
      query: async () => ({
        held: this.held.map((h) => ({ ...h })),
        pending: this.waiting.map((w) => ({ name: w.name, mode: w.mode, clientId: w.clientId })),
      }),
    };
  }

  /** The tab went away: its locks are released, its queued requests dropped. */
  unload(clientId: string): void {
    // Queued requests from a dead tab simply never resolve, like the real
    // thing (the page is gone; nobody is waiting on that promise).
    this.waiting = this.waiting.filter((w) => w.clientId !== clientId);
    const dropped = this.held.filter((h) => h.clientId === clientId);
    this.held = this.held.filter((h) => h.clientId !== clientId);
    if (dropped.length > 0) this.pump();
  }

  /** Can a request for `name` in `mode` be granted right now? Requests
   *  queue in order: a request behind a conflicting one waits too. */
  private grantable(name: string, mode: LockMode, before?: Waiting): boolean {
    const conflicts = (other: LockMode): boolean => mode === 'exclusive' || other === 'exclusive';
    if (this.held.some((h) => h.name === name && conflicts(h.mode))) return false;
    for (const w of this.waiting) {
      if (w === before) break;
      if (w.name === name && conflicts(w.mode)) return false;
    }
    return true;
  }

  private pump(): void {
    // Grant in queue order until the first request that must still wait.
    for (const w of [...this.waiting]) {
      if (!this.waiting.includes(w)) continue;
      if (!this.grantable(w.name, w.mode, w)) continue;
      this.waiting = this.waiting.filter((x) => x !== w);
      w.grant();
    }
  }
}

/* ── BroadcastChannel ────────────────────────────────────────────────── */

/** The subset of `BroadcastChannel` the vault uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

interface Endpoint {
  listeners: Set<(event: { data: unknown }) => void>;
  open: boolean;
}

/**
 * One named channel every fake tab connects to. Messages are delivered
 * asynchronously to every OTHER open endpoint, in the order they were
 * posted (which is what the real one guarantees per sender). A structured
 * clone is simulated with JSON so a test cannot accidentally share objects
 * between "tabs".
 */
export class FakeBus {
  private endpoints = new Set<Endpoint>();
  /** Every message posted, for assertions. */
  readonly log: unknown[] = [];
  /** Set to drop every message from a given endpoint (a frozen tab). */
  private muted = new Set<Endpoint>();
  private handles = new Map<ChannelLike, Endpoint>();

  connect(): ChannelLike {
    const endpoint: Endpoint = { listeners: new Set(), open: true };
    this.endpoints.add(endpoint);
    const channel: ChannelLike = {
      postMessage: (message) => {
        if (!endpoint.open || this.muted.has(endpoint)) return;
        const copy = JSON.parse(JSON.stringify(message)) as unknown;
        this.log.push(copy);
        queueMicrotask(() => {
          for (const other of this.endpoints) {
            if (other === endpoint || !other.open || this.muted.has(other)) continue;
            for (const listener of [...other.listeners]) listener({ data: JSON.parse(JSON.stringify(copy)) });
          }
        });
      },
      addEventListener: (_type, listener) => endpoint.listeners.add(listener),
      removeEventListener: (_type, listener) => endpoint.listeners.delete(listener),
      close: () => {
        endpoint.open = false;
        this.endpoints.delete(endpoint);
      },
    };
    this.handles.set(channel, endpoint);
    return channel;
  }

  /** A frozen tab: it neither sends nor receives until thawed. */
  freeze(channel: ChannelLike): void {
    const endpoint = this.handles.get(channel);
    if (endpoint) this.muted.add(endpoint);
  }

  thaw(channel: ChannelLike): void {
    const endpoint = this.handles.get(channel);
    if (endpoint) this.muted.delete(endpoint);
  }
}

/** Let queued microtasks (bus deliveries) run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
