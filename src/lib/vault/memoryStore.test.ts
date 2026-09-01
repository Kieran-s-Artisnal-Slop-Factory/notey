import { describe, expect, it } from 'vitest';
import { memoryStore } from './memoryStore';

// memoryStore is the CONTRACT spec: what passes here is what the sqlite
// worker and the Tauri store must also do.

describe('memoryStore (the VaultStore contract)', () => {
  it('writes create parent dirs implicitly', async () => {
    const store = memoryStore();
    await store.init();
    await store.write({ path: 'Work/Deep/Plan.md', kind: 'note', content: 'x' });
    const all = await store.loadAll();
    expect(all.map((r) => `${r.kind}:${r.path}`)).toEqual([
      'dir:Work',
      'dir:Work/Deep',
      'note:Work/Deep/Plan.md',
    ]);
  });

  it('loadAll omits asset content; list and read include it', async () => {
    const store = memoryStore();
    await store.init();
    await store.write({ path: 'Note.md', kind: 'note', content: 'hello' });
    await store.write({ path: '.assets/x.png', kind: 'asset', content: 'AAAA', mime: 'image/png', bytes: 3 });
    const all = await store.loadAll();
    expect(all.find((r) => r.kind === 'asset')!.content).toBeNull();
    expect(all.find((r) => r.kind === 'note')!.content).toBe('hello');
    expect((await store.list('.assets'))[1]!.content).toBe('AAAA');
    expect((await store.read('.assets/x.png'))!.content).toBe('AAAA');
  });

  it('rename moves a subtree and refuses an occupied target', async () => {
    const store = memoryStore();
    await store.init();
    await store.write({ path: 'A/one.md', kind: 'note', content: '1' });
    await store.write({ path: 'A/sub/two.md', kind: 'note', content: '2' });
    await store.write({ path: 'B/other.md', kind: 'note', content: '3' });
    await store.rename('A', 'C');
    const paths = (await store.loadAll()).map((r) => r.path);
    expect(paths).toContain('C/one.md');
    expect(paths).toContain('C/sub/two.md');
    expect(paths).not.toContain('A/one.md');
    await expect(store.rename('C', 'B')).rejects.toThrow(/exists/);
  });

  it('remove deletes a file or a whole subtree', async () => {
    const store = memoryStore();
    await store.init();
    await store.write({ path: 'A/one.md', kind: 'note', content: '1' });
    await store.write({ path: 'A/sub/two.md', kind: 'note', content: '2' });
    await store.remove('A/one.md');
    expect((await store.read('A/one.md'))).toBeNull();
    await store.remove('A');
    expect((await store.loadAll()).map((r) => r.path)).toEqual([]);
  });

  it('meta round-trips', async () => {
    const store = memoryStore();
    await store.init();
    expect(await store.getMeta('k')).toBeNull();
    await store.setMeta('k', 'v');
    expect(await store.getMeta('k')).toBe('v');
  });
});
