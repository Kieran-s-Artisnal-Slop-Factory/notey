/**
 * One note, one writer: a Web Lock per open note.
 *
 * The tab that has a note open in its editor holds the exclusive lock
 * `notey:note:<path>` for as long as the note is open. A second tab that
 * opens the same note is told so, shows it read-only, and queues for the
 * lock; the moment the first tab lets go (closes the note, opens another,
 * or is closed — the browser releases a tab's locks when it goes) the
 * second tab is promoted and can write.
 *
 * Locks are per origin and per profile, so every tab of one vault shares
 * one table, and nothing here has to talk to another tab to know what it
 * has open: `navigator.locks.query()` says.
 *
 * `LockManagerLike` is injected so the whole thing runs in node under a
 * fake (fakePlatform.ts); in the browser it is `navigator.locks`.
 */
import type { LockManagerLike } from './fakePlatform';

export const NOTE_LOCK_PREFIX = 'notey:note:';
/** The blank page: one shared sheet, so one writer, like any note. */
export const SCRATCH_LOCK = 'notey:scratch';
/**
 * Held around a multi-step change to the tree (a folder rename or delete,
 * a bulk move or delete, a save that renames) so two tabs' sequences
 * cannot interleave. Never held while waiting on a note lock, so it
 * cannot deadlock.
 */
export const VAULT_MUTATE_LOCK = 'notey:vault-mutate';

export function noteLockName(path: string): string {
  return NOTE_LOCK_PREFIX + path;
}

export type HoldStatus = 'pending' | 'held' | 'waiting' | 'released';

export interface NoteHold {
  readonly path: string;
  /** Where this hold is at; `waiting` means another tab has the note. */
  readonly status: HoldStatus;
  /**
   * Settles after the first attempt: true when the lock was free and is
   * ours, false when another tab has it and we are now queued behind it
   * (or the hold was released before the answer came).
   */
  readonly ready: Promise<boolean>;
  /**
   * Let go, or stop waiting. Resolves once the lock manager has actually
   * released the lock — a hold taken straight after can then be granted
   * at once rather than seeing this tab's own lock as "held elsewhere".
   * Safe to call more than once.
   */
  release(): Promise<void>;
}

/**
 * Take the lock for `path`, or queue for it. `onHeld` fires when a queued
 * hold is promoted — never for one that was free at once (`ready` says
 * so). Pass `null` for `locks` where the API is missing: the note is then
 * simply treated as ours.
 */
export function holdNote(path: string, locks: LockManagerLike | null, onHeld?: () => void): NoteHold {
  return holdLock(noteLockName(path), locks, onHeld, path);
}

/**
 * Queue for `path` without first trying to take it. For a page that is
 * already reading another tab's note when that tab moves it: the new
 * path is that tab's too, and a reader must not become the writer just
 * because it heard about the move a moment before the writer relocked.
 * `ready` settles false at once; `onHeld` fires when the turn comes.
 */
export function queueForNote(
  path: string,
  locks: LockManagerLike | null,
  onHeld?: () => void
): NoteHold {
  return holdLock(noteLockName(path), locks, onHeld, path, { queued: true });
}

/** `holdNote` for any lock name — the blank page uses it. */
export function holdLock(
  name: string,
  locks: LockManagerLike | null,
  onHeld?: () => void,
  path: string = name,
  opts: { queued?: boolean } = {}
): NoteHold {
  let status: HoldStatus = 'pending';
  /** Resolving this is what releases a lock we hold. */
  let letGo: (() => void) | null = null;
  const abort = new AbortController();
  let resolveReady: (v: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => (resolveReady = resolve));
  /** The lock manager's own promises: settled once it has let go. */
  const requests: Promise<unknown>[] = [];

  const release = (): Promise<void> => {
    if (status !== 'released') {
      status = 'released';
      letGo?.();
      letGo = null;
      abort.abort();
      resolveReady(false);
    }
    return Promise.all(requests.map((r) => r.catch(() => undefined))).then(() => undefined);
  };

  if (!locks) {
    status = 'held';
    resolveReady(true);
    return { path, status: 'held', ready, release };
  }

  /** Runs with the lock ours: holds it until `release()`. */
  const keep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      letGo = resolve;
    });

  /** Second attempt: queue behind whoever has it. */
  const queueBehind = (): void => {
    const queued = locks.request(name, { mode: 'exclusive', signal: abort.signal }, () => {
      // Released between the grant and this callback: hand it back.
      if (status === 'released') return undefined;
      status = 'held';
      onHeld?.();
      return keep();
    });
    requests.push(queued);
    queued.catch(() => {
      // Aborted: we stopped waiting. Nothing else to do.
    });
  };

  if (opts.queued) {
    status = 'waiting';
    queueBehind();
    resolveReady(false);
    return {
      path,
      get status() {
        return status;
      },
      ready,
      release,
    };
  }

  const first = locks
    .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (status === 'released') {
        resolveReady(false);
        return undefined; // whatever was granted goes straight back
      }
      if (!lock) {
        status = 'waiting';
        queueBehind();
        resolveReady(false);
        return undefined;
      }
      status = 'held';
      resolveReady(true);
      return keep();
    });
  requests.push(first);
  first.catch(() => {
    // The lock manager refused outright (a detached document, say).
    if (status === 'pending') status = 'waiting';
    resolveReady(false);
  });

  return {
    path,
    get status() {
      return status;
    },
    ready,
    release,
  };
}

/**
 * Paths of notes some OTHER tab has open right now. `ownPath` is the note
 * this tab holds (if any) and is left out.
 */
export async function notesHeldElsewhere(
  locks: LockManagerLike | null,
  ownPath: string | null = null
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!locks) return out;
  let held: { name: string }[] = [];
  try {
    held = (await locks.query()).held;
  } catch {
    return out;
  }
  for (const lock of held) {
    if (!lock.name.startsWith(NOTE_LOCK_PREFIX)) continue;
    const path = lock.name.slice(NOTE_LOCK_PREFIX.length);
    if (path !== ownPath) out.add(path);
  }
  return out;
}

/** `navigator.locks` when the browser has it, else null. */
export function platformLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as { locks?: unknown }).locks;
  return locks && typeof (locks as { request?: unknown }).request === 'function'
    ? (locks as LockManagerLike)
    : null;
}
