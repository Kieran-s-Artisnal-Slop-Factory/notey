/**
 * The backend picker. Tauri gets real files; browsers get sqlite-wasm.
 * Both arrive by dynamic import so neither build carries the other's code.
 *
 * The store is a per-page SINGLETON: the OPFS SAH pool takes exclusive
 * locks, so a second worker on the same page (a remounted island, the
 * Settings card) must reuse the first connection instead of fighting it.
 */
import type { VaultStore } from './types';
import { isTauri } from './tauriStore';

let opened: Promise<VaultStore> | null = null;

export function openVaultStore(): Promise<VaultStore> {
  opened ??= (async () => {
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
  })().catch((err) => {
    opened = null; // a failed open may be retried (e.g. the other tab closed)
    throw err;
  });
  return opened;
}
