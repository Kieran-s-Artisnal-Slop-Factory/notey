/**
 * The editor's AssetStore over the vault: one instance per open note,
 * mapping `.assets/<name>` refs to rows in `<note's folder>/.assets/`.
 *
 * `resolve()` must be synchronous (Crepe calls it mid-render), so `prime()`
 * loads every asset in the note's `.assets/` into a Map first — mount the
 * editor only after priming.
 */
import {
  AssetTooLarge,
  ASSET_PREFIX,
  MAX_ASSET_BYTES,
  assetNameOf,
  base64ToBlob,
  blobToBase64,
  dataUrlOf,
  uniqueAssetName,
  type AssetStore,
} from '../notebook/assets';
import { assetPathFor, parentOf } from './model';
import type { VaultStore } from './types';

export interface NoteAssetStore extends AssetStore {
  /** Load every asset beside the note into the cache. Safe to call again. */
  prime(): Promise<void>;
  /** Forget a name (after a remove) so `resolve()` stops answering for it. */
  forget(name: string): void;
  /** Names and decoded sizes of everything primed (the Export card's count). */
  stats(): { count: number; bytes: number };
}

interface CachedAsset {
  mime: string;
  data: string;
  bytes: number;
}

export function noteAssetStore(vault: VaultStore, notePath: string): NoteAssetStore {
  const folder = parentOf(notePath);
  const assetDir = folder ? `${folder}/.assets` : '.assets';
  const cache = new Map<string, CachedAsset>();

  const pathOf = (name: string): string => assetPathFor(notePath, name);

  return {
    async prime() {
      const rows = await vault.list(assetDir);
      for (const row of rows) {
        if (row.kind !== 'asset' || row.content === null) continue;
        const name = row.path.slice(assetDir.length + 1);
        if (name && !name.includes('/')) {
          cache.set(name, {
            mime: row.mime ?? 'application/octet-stream',
            data: row.content,
            bytes: row.bytes ?? 0,
          });
        }
      }
    },

    forget(name) {
      cache.delete(name);
    },

    stats() {
      let bytes = 0;
      for (const a of cache.values()) bytes += a.bytes;
      return { count: cache.size, bytes };
    },

    async save(blob, filename) {
      if (blob.size > MAX_ASSET_BYTES) throw new AssetTooLarge(blob.size);
      const name = uniqueAssetName(filename || 'image.png', new Set(cache.keys()));
      const data = await blobToBase64(blob);
      const mime = blob.type || 'application/octet-stream';
      await vault.write({ path: pathOf(name), kind: 'asset', content: data, mime, bytes: blob.size });
      cache.set(name, { mime, data, bytes: blob.size });
      return ASSET_PREFIX + name;
    },

    async replace(src, blob) {
      const name = assetNameOf(src);
      if (!name) return;
      if (blob.size > MAX_ASSET_BYTES) throw new AssetTooLarge(blob.size);
      const data = await blobToBase64(blob);
      const mime = blob.type || cache.get(name)?.mime || 'application/octet-stream';
      await vault.write({ path: pathOf(name), kind: 'asset', content: data, mime, bytes: blob.size });
      cache.set(name, { mime, data, bytes: blob.size });
    },

    async load(src) {
      const name = assetNameOf(src);
      if (!name) return null;
      const cached = cache.get(name);
      if (cached) return base64ToBlob(cached.data, cached.mime);
      const row = await vault.read(pathOf(name));
      if (!row || row.content === null) return null;
      const asset: CachedAsset = {
        mime: row.mime ?? 'application/octet-stream',
        data: row.content,
        bytes: row.bytes ?? 0,
      };
      cache.set(name, asset);
      return base64ToBlob(asset.data, asset.mime);
    },

    resolve(src) {
      const name = assetNameOf(src);
      if (!name) return undefined;
      const cached = cache.get(name);
      return cached ? dataUrlOf(cached) : undefined;
    },

    nameOf(src) {
      // The ref carries its filename — that is the point of the scheme.
      return assetNameOf(src) ?? undefined;
    },
  };
}
