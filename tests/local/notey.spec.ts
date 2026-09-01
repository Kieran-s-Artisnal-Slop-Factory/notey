/**
 * The notey suite: the vault, the editor faces, links, search, exports,
 * bulk operations, and the startup preference — against the production
 * build (the only build with the service worker in it).
 */
import { readFileSync } from 'node:fs';
import { test, expect } from './helpers/app';
import type { App } from './helpers/app';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

/** Create a note and wait until it is really open (title field = Untitled). */
async function newNote(page: Page): Promise<void> {
  await page.getByTestId('notebook-new').click();
  // Wait for the NEW note to be open, not for a title field to exist — the
  // field is one element every note binds into; an early fill RENAMES the
  // previously open note.
  await expect(page.getByTestId('notebook-title')).toHaveValue('Untitled', { timeout: 30_000 });
}

/** Type into the Crepe canvas and let the debounce chain settle. */
async function typeInCanvas(page: Page, text: string): Promise<void> {
  const canvas = page.locator('[data-testid="notebook-canvas"] [contenteditable="true"]');
  await canvas.click();
  await page.keyboard.type(text);
  // Milkdown coalesces ~200 ms + editor 150 ms + app 400 ms.
  await page.waitForTimeout(900);
}

async function openApp(app: App): Promise<void> {
  await app.goto('/');
  await app.ready();
  // Boot is done when the sidebar's empty-state or tree is rendered.
  await expect(
    app.page.getByTestId('notebook-no-notes').or(app.page.getByTestId('notebook-note').first())
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('vault', () => {
  test('page load writes nothing', async ({ app }) => {
    await openApp(app);
    expect(await app.loadAll()).toEqual([]);
  });

  test('backend is real sqlite over OPFS in the browser build', async ({ app }) => {
    await openApp(app);
    expect(await app.backend()).toContain('OPFS');
  });

  test('a note survives a full reload', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('First note');
    await typeInCanvas(app.page, 'The body of the first note.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    await app.goto('/');
    await app.ready();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('First note', {
      timeout: 30_000,
    });
    const row = await app.read('First note.md');
    expect(row?.kind).toBe('note');
    expect(row?.content).toContain('The body of the first note.');
    expect(row?.content).toContain('created:');
  });

  test('the vault is plain markdown with frontmatter', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Tagged');
    await app.page.getByTestId('notebook-tags').fill('alpha, beta');
    await typeInCanvas(app.page, 'Body text.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    const row = await app.read('Tagged.md');
    expect(row?.content).toMatch(/^---\n/);
    expect(row?.content).toContain('tags:');
    expect(row?.content).toContain('- alpha');
    expect(row?.content).toContain('- beta');
    expect(row?.content).toContain('Body text.');
  });
});

test.describe('linking', () => {
  test('a wiki link shows in Links to, resolves after creation, and backlinks', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Alpha');
    await typeInCanvas(app.page, 'See [[Beta]] for more.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    // Links panel: Beta is offered as missing.
    await app.page.locator('summary', { hasText: 'Links' }).click();
    const outlink = app.page.getByTestId('notebook-outlink');
    await expect(outlink).toContainText('Beta');
    await expect(outlink).toContainText('create');
    // Click creates it beside Alpha and opens it.
    await outlink.click();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Beta', { timeout: 30_000 });
    // Beta's backlinks name Alpha.
    await app.page.locator('summary', { hasText: 'Links' }).click();
    await expect(app.page.getByTestId('notebook-backlink')).toHaveAttribute('data-title', 'Alpha');
  });

  test('rename keeps old links working via aliases and offers a rewrite', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Target');
    await typeInCanvas(app.page, 'I am the target.');
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Linker');
    await typeInCanvas(app.page, 'Points at [[Target]].');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    // Reopen Target and rename it.
    await app.page.getByTestId('notebook-note').filter({ hasText: 'Target' }).click();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Target');
    await app.page.getByTestId('notebook-title').fill('Renamed target');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    // The old title became an alias and the rewrite offer counts the linker.
    await expect(app.page.getByTestId('notebook-aliases')).toContainText('Target');
    await expect(app.page.getByTestId('notebook-rename-offer')).toContainText('1 note');
    // The file was renamed on disk.
    expect((await app.read('Renamed target.md'))?.kind).toBe('note');
    expect(await app.read('Target.md')).toBeNull();
    // Take the offer; the linker's markdown is rewritten.
    await app.page.getByTestId('notebook-rewrite-links').click();
    await expect
      .poll(async () => (await app.read('Linker.md'))?.content ?? '')
      .toContain('[[Renamed target]]');
  });

  test('a ?note= deep link opens the note; a missing one offers Create', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Deep.md', kind: 'note', content: 'found by link' });
    await app.goto('/?note=Deep');
    await app.ready();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Deep', { timeout: 30_000 });
    await app.goto('/?note=Nowhere');
    await app.ready();
    await expect(app.page.getByTestId('notebook-missing-link')).toContainText('Nowhere');
    // It never creates on its own.
    expect(await app.read('Nowhere.md')).toBeNull();
    await app.page.getByTestId('notebook-create-missing').click();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Nowhere', {
      timeout: 30_000,
    });
  });
});

test.describe('organizing', () => {
  test('notebooks: create, file a note inside, move it back out', async ({ app }) => {
    await openApp(app);
    await app.page.getByTestId('notey-new-notebook').click();
    await app.page.getByTestId('notey-name-editor').fill('Work');
    await app.page.getByTestId('notey-name-editor').press('Enter');
    await expect(app.page.locator('.folder-title', { hasText: 'Work' })).toBeVisible();
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Plan');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    await app.page.getByTestId('notebook-parent').selectOption('Work');
    await expect
      .poll(async () => (await app.read('Work/Plan.md'))?.kind ?? null, { timeout: 10_000 })
      .toBe('note');
    expect(await app.read('Plan.md')).toBeNull();
    await expect(app.page.getByTestId('notebook-breadcrumb')).toContainText('Work');
  });

  test('deleting a notebook moves its notes up, never deletes them', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Box/Keep me.md', kind: 'note', content: 'precious' });
    await app.goto('/');
    await app.ready();
    app.page.once('dialog', (d) => void d.accept());
    await app.page.getByTestId('notebook-delete-Box').click();
    await expect
      .poll(async () => (await app.read('Keep me.md'))?.content ?? null, { timeout: 10_000 })
      .toContain('precious');
    expect(await app.read('Box/Keep me.md')).toBeNull();
  });

  test('search finds body text with a snippet, and tag: filters', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Sourdough.md',
      kind: 'note',
      content: '---\ntags: [baking]\n---\n\nKnead the dough well.\n',
    });
    await app.write({ path: 'Other.md', kind: 'note', content: 'Nothing to see.' });
    await app.goto('/');
    await app.ready();
    await app.page.getByTestId('notebook-search').fill('knead');
    const results = app.page.getByTestId('notebook-search-results');
    await expect(results.getByTestId('notebook-note')).toHaveCount(1);
    await expect(results).toContainText('Knead the dough');
    await app.page.getByTestId('notebook-search').fill('tag:baking');
    await expect(results.getByTestId('notebook-note')).toHaveCount(1);
    await app.page.getByTestId('notebook-search').fill('tag:nope');
    await expect(app.page.getByTestId('notebook-no-matches')).toBeVisible();
  });

  test('bulk: tag and delete act on ticked notes only', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'One.md', kind: 'note', content: 'one' });
    await app.write({ path: 'Two.md', kind: 'note', content: 'two' });
    await app.goto('/');
    await app.ready();
    await app.page.getByTestId('notebook-bulk-check').first().check();
    await app.page.getByTestId('notebook-bulk-tags').fill('shared');
    await app.page.getByTestId('notebook-bulk-tags-add').click();
    await expect(app.page.getByTestId('notebook-bulk-note')).toContainText('Added 1 tag on 1 note');
    expect((await app.read('One.md'))?.content).toContain('shared');
    expect((await app.read('Two.md'))?.content).not.toContain('shared');
    app.page.once('dialog', (d) => void d.accept());
    await app.page.getByTestId('notebook-bulk-delete').click();
    await expect
      .poll(async () => await app.read('One.md'), { timeout: 10_000 })
      .toBeNull();
    expect((await app.read('Two.md'))?.content).toContain('two');
  });
});

test.describe('editor', () => {
  test('footnotes: Alt+0 cites at the cursor and files the definition', async ({ app }) => {
    test.slow();
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-title').fill('Cited');
    await typeInCanvas(app.page, 'A claim worth citing.');
    await app.page.keyboard.press('Alt+Digit0');
    // The dialog opens on the new footnote; write it and save.
    await app.page.locator('.backdrop textarea').fill('The source of the claim.');
    await app.page.getByRole('button', { name: 'Save footnotes' }).click();
    await expect
      .poll(async () => (await app.read('Cited.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('[^1]: The source of the claim.');
    expect((await app.read('Cited.md'))?.content).toContain('[^1]');
  });

  test('a mermaid fence renders in the preview face', async ({ app }) => {
    test.slow();
    await openApp(app);
    await app.write({
      path: 'Diagram.md',
      kind: 'note',
      content: '```mermaid\nflowchart LR\n  A[Idea] --> B[Note]\n```\n',
    });
    await app.goto('/?note=Diagram');
    await app.ready();
    await app.page.getByTestId('notebook-mode-preview').click();
    await expect(app.page.locator('[data-testid="notebook-preview"] .mermaid-rendered svg')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('maths render in the preview face; prices stay prose', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Maths.md',
      kind: 'note',
      content: 'Inline $E=mc^2$ and $5 with $10 stay prose.\n',
    });
    await app.goto('/?note=Maths');
    await app.ready();
    await app.page.getByTestId('notebook-mode-preview').click();
    const preview = app.page.getByTestId('notebook-preview');
    await expect(preview.locator('.katex')).toHaveCount(1, { timeout: 30_000 });
    await expect(preview).toContainText('$5 with $10');
  });

  test('the editor face is remembered', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await app.page.getByTestId('notebook-mode-source').click();
    await expect(app.page.getByTestId('notebook-source')).toBeVisible();
    await app.goto('/');
    await app.ready();
    await expect(app.page.getByTestId('notebook-source')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('exports', () => {
  test('the HTML export is one self-contained file', async ({ app }) => {
    test.slow();
    await openApp(app);
    await app.write({
      path: 'Exported.md',
      kind: 'note',
      content: '# Heading\n\nSome **bold** prose and $x^2$ maths.\n',
    });
    await app.goto('/?note=Exported');
    await app.ready();
    const download = app.page.waitForEvent('download');
    await app.page.getByTestId('notebook-export-html').click();
    const file = await download;
    const html = readFileSync(await file.path(), 'utf8');
    expect(file.suggestedFilename()).toBe('Exported.html');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html.match(/https?:\/\//g) ?? []).toEqual([]);
    expect(html).toContain('katex');
  });

  test('the Markdown export carries the title as an H1', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Plain.md', kind: 'note', content: 'Just prose.\n' });
    await app.goto('/?note=Plain');
    await app.ready();
    const download = app.page.waitForEvent('download');
    await app.page.getByTestId('notebook-export-md').click();
    const file = await download;
    const md = readFileSync(await file.path(), 'utf8');
    expect(md).toContain('# Plain');
    expect(md).toContain('Just prose.');
  });

  test('bulk export downloads one zip', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Zip one.md', kind: 'note', content: 'first' });
    await app.write({ path: 'Zip two.md', kind: 'note', content: 'second' });
    await app.goto('/');
    await app.ready();
    for (const box of await app.page.getByTestId('notebook-bulk-check').all()) {
      await box.check();
    }
    const download = app.page.waitForEvent('download');
    await app.page.getByTestId('notebook-bulk-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^notes-\d{4}-\d{2}-\d{2}\.zip$/);
    const bytes = readFileSync(await file.path());
    // Zip magic + both filenames present in the archive directory.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const text = bytes.toString('latin1');
    expect(text).toContain('Zip-one.md');
    expect(text).toContain('Zip-two.md');
  });
});

test.describe('preferences', () => {
  test('the blank-startup preference opens an unfiled page; filing lands in the Pile', async ({
    app,
  }) => {
    await openApp(app);
    await app.page.evaluate(() => {
      localStorage.setItem('notey-prefs', JSON.stringify({ startup: 'blank' }));
    });
    await app.goto('/');
    await app.ready();
    await expect(app.page.getByTestId('notey-file-scratch')).toBeVisible({ timeout: 30_000 });
    expect(await app.loadAll()).toEqual([]); // still no file
    await typeInCanvas(app.page, '# Filed thought\n\nBody.');
    await app.page.getByTestId('notey-file-scratch').click();
    await expect
      .poll(async () => (await app.loadAll()).map((r) => r.path), { timeout: 10_000 })
      .toContain('Filed thought.md');
  });

  test('settings shows the storage backend', async ({ app }) => {
    await app.goto('/settings/');
    await app.ready();
    await expect(app.page.getByTestId('notey-backend')).toContainText('sqlite', {
      timeout: 30_000,
    });
  });
});
