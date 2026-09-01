import { describe, expect, it } from 'vitest';
import {
  ASSET_PREFIX,
  AssetTooLarge,
  assetBytesOf,
  assetNameOf,
  base64ToBlob,
  blobToBase64,
  dataUrlOf,
  isAssetRef,
  MAX_ASSET_BYTES,
  uniqueAssetName,
} from './assets';

// The vault-backed store (vault/assetStore.ts) is a thin wrapper over the
// VaultStore seam and is covered by the Playwright suite; this file holds
// the pure parts.

describe('asset refs', () => {
  it('recognises the .assets/ prefix and nothing else', () => {
    expect(isAssetRef(`${ASSET_PREFIX}shot.png`)).toBe(true);
    expect(isAssetRef('.assets/')).toBe(false);
    expect(isAssetRef('assets/shot.png')).toBe(false);
    expect(isAssetRef('https://example.com/a.png')).toBe(false);
    expect(isAssetRef('images/a.png')).toBe(false);
    expect(isAssetRef('')).toBe(false);
  });

  it('extracts the filename, tolerating a query or fragment', () => {
    expect(assetNameOf('.assets/shot-2.png')).toBe('shot-2.png');
    expect(assetNameOf('.assets/shot.png#top')).toBe('shot.png');
    expect(assetNameOf('.assets/shot.png?x=1')).toBe('shot.png');
    expect(assetNameOf('.assets/#top')).toBeNull();
    expect(assetNameOf('https://example.com/a.png')).toBeNull();
    expect(assetNameOf('')).toBeNull();
  });

  it('refuses a ref that tries to leave the asset directory', () => {
    expect(assetNameOf('.assets/../secret.md')).toBeNull();
    expect(assetNameOf('.assets/deep/one.png')).toBeNull();
  });
});

describe('uniqueAssetName', () => {
  it('keeps a free name and sanitizes the stem', () => {
    expect(uniqueAssetName('shot.png', new Set())).toBe('shot.png');
    expect(uniqueAssetName('my shot!.png', new Set())).toBe('my-shot.png');
  });

  it('suffixes on a clash, case-insensitively', () => {
    expect(uniqueAssetName('shot.png', new Set(['Shot.png']))).toBe('shot-2.png');
    expect(uniqueAssetName('shot.png', new Set(['shot.png', 'shot-2.png']))).toBe('shot-3.png');
  });

  it('keeps the .excalidraw.png compound suffix intact on a clash', () => {
    expect(uniqueAssetName('drawing.excalidraw.png', new Set(['drawing.excalidraw.png']))).toBe(
      'drawing-2.excalidraw.png'
    );
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes through a Blob', async () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const b64 = await blobToBase64(new Blob([bytes], { type: 'image/png' }));
    expect(b64).not.toContain('data:');
    const back = base64ToBlob(b64, 'image/png');
    expect(back.type).toBe('image/png');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);
  });

  it('matches btoa on text', async () => {
    const text = 'hello, notebook';
    const b64 = await blobToBase64(new Blob([new TextEncoder().encode(text)]));
    expect(b64).toBe(btoa(text));
  });

  it('handles the empty blob and blobs past the chunk size', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('');
    const big = new Uint8Array(0x8000 * 2 + 17).fill(0xab);
    const b64 = await blobToBase64(new Blob([big]));
    expect(new Uint8Array(await base64ToBlob(b64, '').arrayBuffer())).toEqual(big);
  });

  it('builds a data: URL with a fallback mime', () => {
    expect(dataUrlOf({ mime: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA');
    expect(dataUrlOf({ mime: '', data: 'AAAA' })).toBe('data:application/octet-stream;base64,AAAA');
  });
});

describe('the cap', () => {
  it('is two megabytes', () => {
    expect(MAX_ASSET_BYTES).toBe(2 * 1024 * 1024);
  });

  it('names the size and the limit in MB', () => {
    const err = new AssetTooLarge(3 * 1024 * 1024);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AssetTooLarge');
    expect(err.message).toBe('3 MB is over the 2 MB limit for one image');
    expect(err.bytes).toBe(3 * 1024 * 1024);
    expect(err.limit).toBe(MAX_ASSET_BYTES);
  });

  it('keeps a decimal when the size is not a whole number', () => {
    const err = new AssetTooLarge(2 * 1024 * 1024 + 40_000);
    expect(err.message).toMatch(/^2\.0 MB is over the 2 MB limit/);
    expect(new AssetTooLarge(2_600_000).message).toMatch(/^2\.5 MB/);
  });
});

describe('assetBytesOf', () => {
  it('sums decoded sizes and ignores junk', () => {
    expect(assetBytesOf([])).toBe(0);
    expect(assetBytesOf([{ bytes: 10 }, { bytes: 32 }])).toBe(42);
    expect(assetBytesOf([{ bytes: 10 }, { bytes: Number.NaN }, { bytes: Infinity }])).toBe(10);
  });
});
