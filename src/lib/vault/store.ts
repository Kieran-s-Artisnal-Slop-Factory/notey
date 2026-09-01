/**
 * The backend picker, and the hand-off between tabs.
 *
 * Tauri gets real files; browsers get sqlite-wasm. Both arrive by dynamic
 * import so neither build carries the other's code.
 *
 * ## Why a hand-off and not sharing
 *
 * One browser tab at a time can hold the vault, and that is a platform
 * limit rather than a decision: the sqlite SAH-pool VFS needs the OPFS
 * sync-access-handle API, which exists **only in dedicated workers**, and a
 * SharedWorker can neither use it nor start a dedicated worker that could
 * (Chrome does not define `Worker` in that scope). No arrangement of
 * workers shares one OPFS database.
 *
 * So instead of failing, tabs pass the vault between them. A tab that
 * cannot open it asks over a BroadcastChannel; whoever holds it flushes,
 * closes, and says so; the asker opens. The tab that let go keeps every
 * note it had already read and says it has gone read-only, with one button
 * to take the vault back.
 *
 * The upshot for editing: two tabs can never write to one note at the same
 * time, because only one of them can write at all.
 */
import type { VaultStore } from './types';
import { isTauri } from './tauriStore';

const CHANNEL = 'notey-vault';

type Signal = { type: 'please-release' } | { type: 'released' } | { type: 'taken' };

let opened: Promise<VaultStore> | null = null;
let channel: BroadcastChannel | null = null;
/** Set while this tab has stepped aside for another one. */
let steppedAside = false;
const listeners = new Set<(handed: boolean) => void>();

/** Told when this tab gains or loses the vault. */
export function onVaultHandover(listener: (handed: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(handed: boolean): void {
  steppedAside = handed;
  for (const listener of listeners) listener(handed);
}

function openChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<Signal>) => {
    if (event.data?.type !== 'please-release') return;
    // Someone else wants it. Let go, but only if we actually have it.
    void (async () => {
      if (!opened || steppedAside) {
        channel?.postMessage({ type: 'released' } satisfies Signal);
        return;
      }
      try {
        const store = await opened;
        await store.close?.();
      } catch {
        // Closing failed; say so anyway, or the asker waits forever.
      }
      opened = null;
      announce(true);
      channel?.postMessage({ type: 'released' } satisfies Signal);
    })();
  };
  return channel;
}

/** Wait for whoever holds the vault to let go of it. */
function askForVault(timeoutMs = 6_000): Promise<boolean> {
  const bus = openChannel();
  if (!bus) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      bus.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(ok);
    };
    const onMessage = (event: MessageEvent<Signal>): void => {
      if (event.data?.type === 'released') done(true);
    };
    bus.addEventListener('message', onMessage);
    const timer = setTimeout(() => done(false), timeoutMs);
    bus.postMessage({ type: 'please-release' } satisfies Signal);
  });
}

async function start(): Promise<VaultStore> {
  if (isTauri()) {
    const { tauriStore } = await import('./tauriStore');
    const store = tauriStore();
    await store.init();
    return store;
  }
  const { sqliteStore } = await import('./sqliteStore');
  const store = sqliteStore();
  await store.init();
  return store;
}

/**
 * Open the vault, once per page. A second tab is refused by the browser,
 * not by us — call `takeVault()` to ask the other tab to hand it over.
 */
export function openVaultStore(): Promise<VaultStore> {
  openChannel();
  opened ??= start().catch((err) => {
    opened = null; // a failed open may be retried
    throw err;
  });
  return opened;
}

/** True while another tab holds the vault and this one has stepped aside. */
export function vaultHandedOver(): boolean {
  return steppedAside;
}

/**
 * Take the vault for this tab: ask the holder to let go, then open. The
 * other tab keeps what it has read and goes read-only until it asks back.
 */
export async function takeVault(): Promise<VaultStore> {
  await askForVault();
  opened = null;
  const store = await openVaultStore();
  announce(false);
  channel?.postMessage({ type: 'taken' } satisfies Signal);
  return store;
}
