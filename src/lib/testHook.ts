/**
 * `window.__notey` — the Playwright suite's window into the vault. Raw
 * reads and writes over the same VaultStore the app uses (the page-level
 * singleton, so the hook and the app see one database). Storage-agnostic
 * on purpose: the specs don't know whether rows live in sqlite or on disk.
 */
import { openVaultStore } from './vault/store';
import type { FileRow, FileWrite } from './vault/types';

export interface NoteyTestHook {
  backend(): Promise<string>;
  loadAll(): Promise<FileRow[]>;
  read(path: string): Promise<FileRow | null>;
  write(file: FileWrite): Promise<FileRow>;
  remove(path: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
}

declare global {
  interface Window {
    __notey?: NoteyTestHook;
  }
}

export function installTestHook(): void {
  const hook: NoteyTestHook = {
    backend: async () => (await openVaultStore()).backend,
    loadAll: async () => (await openVaultStore()).loadAll(),
    read: async (path) => (await openVaultStore()).read(path),
    write: async (file) => (await openVaultStore()).write(file),
    remove: async (path) => (await openVaultStore()).remove(path),
    getMeta: async (key) => (await openVaultStore()).getMeta(key),
  };
  window.__notey = hook;
}
