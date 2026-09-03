import { describe, expect, it } from 'vitest';
import { memoryStore } from './memoryStore';
import { zipBytes, zipEntries } from '../zip';
import {
  dbFileName,
  describeDrop,
  describeImport,
  dropIntoVault,
  exportFileName,
  exportVault,
  importVault,
  isMarkdownFile,
} from './transfer';
import type { VaultStore } from './types';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const read = async (store: VaultStore, path: string): Promise<string | null> =>
  (await store.read(path))?.content ?? null;

/** A vault with a notebook, a loose note, an image and an empty notebook. */
async function seeded(): Promise<VaultStore> {
  const store = memoryStore();
  await store.init();
  await store.write({ path: 'Work/Plan.md', kind: 'note', content: '# Plan\n\nDo the thing.' });
  await store.write({ path: 'Loose.md', kind: 'note', content: 'On its own.' });
  await store.write({
    path: 'Work/.assets/shot.png',
    kind: 'asset',
    content: 'AAECAw==',
    mime: 'image/png',
    bytes: 4,
  });
  await store.mkdir('Empty');
  return store;
}

describe('exportVault', () => {
  it('writes the vault as the folders and files it would be on disk', async () => {
    const store = await seeded();
    const out = await exportVault(store);
    expect({ notes: out.notes, assets: out.assets, folders: out.folders }).toEqual({
      notes: 2,
      assets: 1,
      folders: 3, // Work, Work/.assets, Empty
    });
    const names = zipEntries(out.bytes).map((e) => e.name);
    expect(names).toContain('Work/Plan.md');
    expect(names).toContain('Loose.md');
    expect(names).toContain('Work/.assets/shot.png');
    // An empty notebook survives as a folder entry.
    expect(names).toContain('Empty/');
  });

  it('carries note text and image bytes, not metadata about them', async () => {
    const store = await seeded();
    const entries = zipEntries((await exportVault(store)).bytes);
    const plan = entries.find((e) => e.name === 'Work/Plan.md')!;
    expect(new TextDecoder().decode(plan.data)).toBe('# Plan\n\nDo the thing.');
    const shot = entries.find((e) => e.name === 'Work/.assets/shot.png')!;
    expect([...shot.data]).toEqual([0, 1, 2, 3]);
  });

  it('names the file for the day it was made', () => {
    expect(exportFileName(new Date('2026-09-02T10:00:00Z'))).toBe('notey-2026-09-02.zip');
    expect(dbFileName(new Date('2026-09-02T10:00:00Z'))).toBe('notey-2026-09-02.sqlite');
  });
});

describe('importVault', () => {
  it('restores an exported vault into an empty one, byte for byte', async () => {
    const from = await seeded();
    const archive = (await exportVault(from)).bytes;

    const to = memoryStore();
    await to.init();
    const report = await importVault(to, archive);
    expect({ notes: report.notes, assets: report.assets }).toEqual({ notes: 2, assets: 1 });
    expect(await read(to, 'Work/Plan.md')).toBe('# Plan\n\nDo the thing.');
    expect(await read(to, 'Loose.md')).toBe('On its own.');
    expect(await read(to, 'Work/.assets/shot.png')).toBe('AAECAw==');
    // The empty notebook too.
    expect((await to.loadAll()).map((r) => `${r.kind}:${r.path}`)).toContain('dir:Empty');
  });

  it('importing the same archive twice changes nothing the second time', async () => {
    const from = await seeded();
    const archive = (await exportVault(from)).bytes;
    const to = memoryStore();
    await to.init();
    await importVault(to, archive);
    const before = await to.loadAll();

    const again = await importVault(to, archive);
    expect(again.notes).toBe(0);
    expect(again.alongside).toEqual([]);
    expect(again.already).toBe(3); // two notes and the image
    expect((await to.loadAll()).map((r) => r.path)).toEqual(before.map((r) => r.path));
  });

  it('a note that clashes is filed alongside, never over the top', async () => {
    const to = memoryStore();
    await to.init();
    await to.write({ path: 'Loose.md', kind: 'note', content: 'MINE, do not lose me.' });
    const archive = zipBytes([{ name: 'Loose.md', data: text('The other one.') }]);

    const report = await importVault(to, archive);
    expect(report.notes).toBe(1);
    expect(report.alongside).toEqual([{ from: 'Loose.md', to: 'Loose 2.md' }]);
    expect(await read(to, 'Loose.md')).toBe('MINE, do not lose me.');
    expect(await read(to, 'Loose 2.md')).toBe('The other one.');
  });

  it('an image whose name is taken is left alone — the name IS the reference', async () => {
    const to = memoryStore();
    await to.init();
    await to.write({
      path: '.assets/shot.png',
      kind: 'asset',
      content: 'BBBB',
      mime: 'image/png',
      bytes: 3,
    });
    const archive = zipBytes([{ name: '.assets/shot.png', data: new Uint8Array([9, 9, 9]) }]);

    const report = await importVault(to, archive);
    expect(report.assets).toBe(0);
    expect(report.already).toBe(1);
    expect(await read(to, '.assets/shot.png')).toBe('BBBB');
  });

  it('refuses paths that climb out of the vault, and skips what is not a note', async () => {
    const to = memoryStore();
    await to.init();
    const archive = zipBytes([
      { name: '../escape.md', data: text('nope') },
      { name: '/rooted.md', data: text('still fine') },
      { name: 'notes.txt', data: text('not markdown') },
      { name: 'Keep.md', data: text('yes') },
    ]);

    const report = await importVault(to, archive);
    expect(await read(to, 'Keep.md')).toBe('yes');
    // A leading slash is just a path; climbing out is not.
    expect(await read(to, 'rooted.md')).toBe('still fine');
    expect((await to.loadAll()).map((r) => r.path)).not.toContain('../escape.md');
    expect(report.skipped.map((s) => s.name).sort()).toEqual(['../escape.md', 'notes.txt']);
  });

  it('leaves alone the notes another tab has open', async () => {
    const to = memoryStore();
    await to.init();
    const archive = zipBytes([
      { name: 'Busy.md', data: text('theirs') },
      { name: 'Free.md', data: text('mine') },
    ]);

    const report = await importVault(to, archive, { held: new Set(['Busy.md']) });
    expect(await read(to, 'Busy.md')).toBeNull();
    expect(await read(to, 'Free.md')).toBe('mine');
    expect(report.skipped).toEqual([{ name: 'Busy.md', why: 'open in another tab' }]);
  });

  it('an archive that is not a zip is an error, not a half-import', async () => {
    const to = memoryStore();
    await to.init();
    await expect(importVault(to, text('just some text'))).rejects.toThrow(/not a zip/);
    expect(await to.loadAll()).toEqual([]);
  });
});

describe('dropIntoVault', () => {
  const dropped = (name: string, text: string) => ({ name, text });
  const taken = async (store: VaultStore): Promise<string[]> =>
    (await store.loadAll()).map((r) => r.path);

  it('files a dropped markdown file under its own name, text untouched', async () => {
    const store = memoryStore();
    await store.init();
    const body = '---\ntags:\n  - kept\n---\n\nFrom somewhere else.';
    const report = await dropIntoVault(store, [dropped('Notes from a talk.md', body)], null, []);
    expect(report).toMatchObject({ opened: 'Notes from a talk.md', created: 1, already: 0 });
    // Byte for byte: a file that already had frontmatter keeps it.
    expect(await read(store, 'Notes from a talk.md')).toBe(body);
  });

  it('drops into the notebook you are in, not always the Pile', async () => {
    const store = memoryStore();
    await store.init();
    await store.mkdir('Work');
    const report = await dropIntoVault(store, [dropped('Plan.md', 'x')], 'Work', await taken(store));
    expect(report.opened).toBe('Work/Plan.md');
  });

  it('a name already taken is filed alongside, and the original is untouched', async () => {
    const store = memoryStore();
    await store.init();
    await store.write({ path: 'Plan.md', kind: 'note', content: 'mine' });
    const report = await dropIntoVault(store, [dropped('Plan.md', 'theirs')], null, await taken(store));
    expect(report.alongside).toEqual([{ from: 'Plan.md', to: 'Plan 2.md' }]);
    expect(report.opened).toBe('Plan 2.md');
    expect(await read(store, 'Plan.md')).toBe('mine');
    expect(await read(store, 'Plan 2.md')).toBe('theirs');
  });

  it('the same file dropped twice is recognised, not duplicated', async () => {
    const store = memoryStore();
    await store.init();
    const file = dropped('Plan.md', 'the same words');
    await dropIntoVault(store, [file], null, await taken(store));
    const again = await dropIntoVault(store, [file], null, await taken(store));
    expect(again).toMatchObject({ created: 0, already: 1, opened: 'Plan.md' });
    expect((await store.loadAll()).map((r) => r.path)).toEqual(['Plan.md']);
  });

  it('several at once all land, and the first is the one to open', async () => {
    const store = memoryStore();
    await store.init();
    const report = await dropIntoVault(
      store,
      [dropped('One.md', '1'), dropped('Two.md', '2'), dropped('One.md', 'another one')],
      null,
      []
    );
    expect(report.created).toBe(3);
    expect(report.opened).toBe('One.md');
    // The third clashes with the first from the SAME drop.
    expect(report.alongside).toEqual([{ from: 'One.md', to: 'One 2.md' }]);
    expect(await read(store, 'One 2.md')).toBe('another one');
  });

  it('a name no filesystem would take is sanitised like any other title', async () => {
    const store = memoryStore();
    await store.init();
    const report = await dropIntoVault(store, [dropped('a/b<c>.md', 'x')], null, []);
    // Only the filename is used, the characters no disk takes become -,
    // and a trailing one is trimmed the way sanitizeTitle trims any title.
    expect(report.opened).toBe('b-c.md');
  });
});

describe('isMarkdownFile', () => {
  it('knows the extensions a note can arrive as', () => {
    expect(['a.md', 'a.MD', 'a.markdown', 'a.mkd'].every(isMarkdownFile)).toBe(true);
    expect(['a.txt', 'a.png', 'a.mdx', 'md', 'a.md.png'].some(isMarkdownFile)).toBe(false);
  });
});

describe('describeDrop', () => {
  it('says what happened in one line', () => {
    expect(describeDrop({ opened: 'A.md', created: 2, already: 0, alongside: [] })).toBe(
      'Added 2 notes.'
    );
    expect(
      describeDrop({ opened: 'A.md', created: 1, already: 1, alongside: [{ from: 'A.md', to: 'A 2.md' }] })
    ).toBe('Added 1 note. 1 already here. Filed alongside: A 2.');
    expect(describeDrop({ opened: null, created: 0, already: 0, alongside: [] })).toBe('Nothing to add.');
  });
});

describe('describeImport', () => {
  it('says what happened in one line', () => {
    expect(
      describeImport({ notes: 2, assets: 1, folders: 0, alongside: [], already: 0, skipped: [] })
    ).toBe('Imported 2 notes, 1 image.');
    expect(
      describeImport({
        notes: 1,
        assets: 0,
        folders: 0,
        alongside: [{ from: 'A.md', to: 'A 2.md' }],
        already: 3,
        skipped: [{ name: 'B.md', why: 'open in another tab' }],
      })
    ).toBe('Imported 1 note. 3 already here. 1 clash filed alongside: A 2. 1 left alone: open in another tab.');
    expect(
      describeImport({ notes: 0, assets: 0, folders: 0, alongside: [], already: 0, skipped: [] })
    ).toBe('Nothing new to import.');
  });
});
