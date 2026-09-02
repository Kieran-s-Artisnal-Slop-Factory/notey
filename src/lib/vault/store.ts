/**
 * The backend picker, and the page-level vault singleton.
 *
 * Tauri gets real files; browsers get sqlite-wasm. Both arrive by dynamic
 * import so neither build carries the other's code.
 *
 * ## Many tabs
 *
 * A browser can open the OPFS database from ONE dedicated worker at a
 * time (the VFS takes exclusive sync-access handles, which exist only in
 * that scope — see sqliteStore.ts). So in the browser the store handed out
 * here is the shared one from tabs.ts: whichever tab holds the
 * `notey:vault-owner` Web Lock opens the worker and serves the rest over
 * a BroadcastChannel, and when it goes the next tab in the queue takes
 * over. Every tab can read and write; `onVaultChange` is how a tab hears
 * what the others did.
 *
 * Which tab may write a given NOTE is a separate question, answered by a
 * lock per open note (noteLocks.ts) — that is the part the page enforces.
 */
import type { VaultStore } from './types';
import { isTauri } from './tauriStore';
import { sharedVault, VAULT_CHANNEL, type Change } from './tabs';
import { platformLocks } from './noteLocks';

let opened: Promise<VaultStore> | null = null;
const changeListeners = new Set<(changes: Change[]) => void>();

/**
 * Hear every change made through the vault — by this tab or another.
 * Fires nothing on Tauri (one window, and the app refreshes after its
 * own writes anyway).
 */
export function onVaultChange(listener: (changes: Change[]) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function newTabId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function start(): Promise<VaultStore> {
  if (isTauri()) {
    const { tauriStore } = await import('./tauriStore');
    const store = tauriStore();
    await store.init();
    return store;
  }

  const { sqliteStore, VAULT_BUSY } = await import('./sqliteStore');
  const openLocal = async (): Promise<VaultStore> => {
    const store = sqliteStore();
    await store.init();
    return store;
  };

  const locks = platformLocks();
  const bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(VAULT_CHANNEL) : null;
  if (!locks || !bus) {
    // No way to coordinate tabs (a very old browser): one tab, as before.
    return openLocal();
  }

  const vault = sharedVault({
    tabId: newTabId(),
    locks,
    bus,
    open: openLocal,
    isBusy: (err) => String(err).includes(VAULT_BUSY),
  });
  vault.onChange((changes) => {
    for (const listener of [...changeListeners]) listener(changes);
  });
  // Leaving: let the database go so the next tab can have it.
  //
  // Order: NoteyApp registers its own pagehide flush synchronously in
  // onMount, and openVaultStore() is only reached later in that mount
  // (after an await); this listener is added after start()'s own awaits
  // on top of that. So on pagehide the app's flush ALWAYS runs first.
  //
  // What that buys, and what it does not. shutdown() closes the vault
  // synchronously (every later call is refused), so only what the flush
  // manages to post before its first real await survives:
  //   - the plain case — body edits, title already committed, no save in
  //     flight — posts its write before this runs; the owner's worker
  //     (or the owner tab) executes it, and close() waits for it.
  //   - a rename at unload (a title edited and not yet blurred) first
  //     takes a note lock, which is an IPC away; by then the vault is
  //     shut and the rename is refused. Same when the flush is queued
  //     behind an autosave still in flight. Those are best effort: the
  //     last persisted state is what the next open sees.
  // Holding shutdown until the flush settles would not help: the page is
  // gone before an async flush finishes, so the browser would free the
  // worker and the owner lock on its own schedule and the next tab would
  // have to poll for the handles (the "held" retry in sqlite-worker.ts).
  // A clean hand-over now beats a title that lands sometimes.
  window.addEventListener('pagehide', () => void vault.shutdown());
  // Back from the back/forward cache: the vault was shut down on the way
  // out, so start the page again rather than run on a closed store.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  await vault.init();
  return vault;
}

/** Open the vault, once per page. */
export function openVaultStore(): Promise<VaultStore> {
  opened ??= start().catch((err) => {
    opened = null; // a failed open may be retried
    throw err;
  });
  return opened;
}
