/**
 * The notey suite: the vault, the page, the palette, the editor faces,
 * links, search, exports and preferences — against the production build
 * (the only build with the service worker in it).
 *
 * notey has no sidebar: everything except writing runs through Ctrl+K, so
 * most of these tests drive the palette.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from './helpers/app';
import type { App } from './helpers/app';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

/**
 * The app boots onto the blank page. Wait for three separate things, in
 * order: the sheet exists, the vault has opened (the boot line goes), and
 * the editor has finished mounting. A click that lands before the editor
 * mount finishes is swallowed by the mount, so this is not belt-and-braces.
 */
async function openApp(app: App): Promise<void> {
  await app.goto('/');
  await app.ready();
  await expect(app.page.getByTestId('notey-sheet')).toBeVisible({ timeout: 30_000 });
  await expect(app.page.getByTestId('notey-booting')).toHaveCount(0, { timeout: 30_000 });
  await expect(app.page.locator('[data-testid="notebook-canvas"], [data-testid="notebook-source"]'))
    .toBeVisible({ timeout: 30_000 });
}

/** Open a note by its ?note= link and wait until the page really shows it. */
async function openNoteByLink(app: App, noteTitle: string): Promise<void> {
  await app.goto('/?note=' + encodeURIComponent(noteTitle));
  await app.ready();
  await expect(app.page.getByTestId('notebook-title')).toHaveValue(noteTitle, { timeout: 30_000 });
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('notey-palette')).toBeVisible({ timeout: 10_000 });
}

const item = (page: Page, label: string) =>
  page.locator(`[data-testid="notey-palette-item"][data-label="${label}"]`);

/** Open the palette and pick one command by its exact label. */
async function runCommand(page: Page, label: string): Promise<void> {
  await openPalette(page);
  await item(page, label).click();
}

/** Create a note through the palette and wait until it is really open. */
async function newNote(page: Page): Promise<void> {
  await runCommand(page, 'New note');
  // Wait for the NEW note to be open, not for a title field to exist — the
  // field is one element every page binds into; an early fill RENAMES the
  // previously open note.
  await expect(page.getByTestId('notebook-title')).toHaveValue('Untitled', { timeout: 30_000 });
}

/**
 * Name the open note. The title commits on blur or Enter — not on every
 * keystroke — so a test that wants it saved has to leave the field, the
 * same as a person does.
 */
async function setTitle(page: Page, text: string): Promise<void> {
  const field = page.getByTestId('notebook-title');
  await field.fill(text);
  await field.blur();
}

/** Type into the Crepe canvas and let the debounce chain settle. */
async function typeInCanvas(page: Page, text: string): Promise<void> {
  const canvas = page.locator('[data-testid="notebook-canvas"] [contenteditable="true"]');
  await canvas.click();
  await page.keyboard.type(text);
  // Milkdown coalesces ~200 ms + editor 150 ms + app 400 ms.
  await page.waitForTimeout(900);
}

test.describe('the page', () => {
  test('opens blank and unfiled, and writes nothing', async ({ app }) => {
    await openApp(app);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('');
    await expect(app.page.getByTestId('notebook-title')).toHaveAttribute('placeholder', 'Untitled');
    // Nothing filed yet, so there is no frontmatter to show.
    await expect(app.page.getByTestId('notey-frontmatter')).toHaveCount(0);
    // Crepe paints its placeholder from an attribute, not from text.
    await expect(app.page.locator('.crepe-placeholder')).toHaveAttribute(
      'data-placeholder',
      /Press Ctrl\+K/
    );
    expect(await app.loadAll()).toEqual([]);
  });

  test('has no sidebar — the book is the only chrome', async ({ app }) => {
    await openApp(app);
    await expect(app.page.getByTestId('notey-book')).toBeVisible();
    await expect(app.page.locator('.library')).toHaveCount(0);
  });

  test('the sheet keeps an 8 by 11 page shape', async ({ app }) => {
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await openApp(app);
    const box = await app.page.getByTestId('notey-sheet').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height / box!.width).toBeCloseTo(11 / 8, 1);
  });

  test('a long note grows the sheet instead of spilling onto the desk', async ({ app }) => {
    await app.page.setViewportSize({ width: 1280, height: 900 });
    await openApp(app);
    await typeInCanvas(app.page, 'line one');
    for (let i = 0; i < 40; i++) await app.page.keyboard.press('Enter');
    await app.page.keyboard.type('the last line');
    await app.page.waitForTimeout(900);
    const { sheetBottom, editorBottom } = await app.page.evaluate(() => ({
      sheetBottom: document.querySelector('[data-testid="notey-sheet"]')!.getBoundingClientRect()
        .bottom,
      editorBottom: document.querySelector('[data-testid="notebook-editor"]')!.getBoundingClientRect()
        .bottom,
    }));
    expect(editorBottom).toBeLessThanOrEqual(sheetBottom);
  });

  test('backend is real sqlite over OPFS in the browser build', async ({ app }) => {
    await openApp(app);
    expect(await app.backend()).toContain('OPFS');
  });
});

test.describe('the palette', () => {
  test('the book opens and closes it', async ({ app }) => {
    await openApp(app);
    await app.page.getByTestId('notey-book').click();
    await expect(app.page.getByTestId('notey-palette')).toBeVisible();
    await app.page.getByTestId('notey-book').click();
    await expect(app.page.getByTestId('notey-palette')).toHaveCount(0);
  });

  test('commands and notes are listed under their own headings', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Findable.md', kind: 'note', content: 'body' });
    await openApp(app);
    await openPalette(app.page);
    const sections = app.page.locator('[data-testid="notey-palette"] .section');
    await expect(sections).toHaveText(['Commands', 'Recent notes']);
    await app.page.getByTestId('notey-palette-input').fill('findable');
    await expect(sections.last()).toHaveText('Notes');
  });

  test('viewing notebooks stays in the palette; opening a note leaves it', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work/Plan.md', kind: 'note', content: 'plan' });
    await openApp(app);
    await runCommand(app.page, 'View notebooks');
    await expect(app.page.getByTestId('notey-palette')).toBeVisible();
    await item(app.page, 'Work').click();
    // Still open, now showing that notebook and its actions.
    await expect(app.page.getByTestId('notey-palette')).toBeVisible();
    await expect(item(app.page, '+ New note here')).toBeVisible();
    await item(app.page, 'Plan').click();
    // Opening a note puts you on the page, so the palette closes.
    await expect(app.page.getByTestId('notey-palette')).toHaveCount(0);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Plan');
  });

  test('creates a notebook and stays put', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'New notebook…');
    await app.page.getByTestId('notey-palette-input').fill('Journal');
    await app.page.getByTestId('notey-palette-input').press('Enter');
    await expect(item(app.page, 'Journal')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await app.read('Journal'))?.kind ?? null, { timeout: 10_000 })
      .toBe('dir');
  });

  test('Escape walks back a level, then closes', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'View notebooks');
    await app.page.getByTestId('notey-palette-input').press('Escape');
    // Back at the root, still open.
    await expect(item(app.page, 'View notebooks')).toBeVisible();
    await app.page.getByTestId('notey-palette-input').press('Escape');
    await expect(app.page.getByTestId('notey-palette')).toHaveCount(0);
  });

  test('searches notes by title and body from the root', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Sourdough.md',
      kind: 'note',
      content: '---\ntags: [baking]\n---\n\nKnead the dough well.\n',
    });
    await app.write({ path: 'Other.md', kind: 'note', content: 'Nothing to see.' });
    await openApp(app);
    await openPalette(app.page);
    await app.page.getByTestId('notey-palette-input').fill('knead');
    await expect(item(app.page, 'Sourdough')).toBeVisible();
    await expect(item(app.page, 'Other')).toHaveCount(0);
    await app.page.getByTestId('notey-palette-input').fill('tag:baking');
    await expect(item(app.page, 'Sourdough')).toBeVisible();
    await app.page.getByTestId('notey-palette-input').fill('tag:nope');
    await expect(item(app.page, 'Sourdough')).toHaveCount(0);
  });
});

test.describe('naming', () => {
  test('the title commits on blur, not on every keystroke', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    const titleField = app.page.getByTestId('notebook-title');
    await titleField.fill('Draftt');
    await app.page.waitForTimeout(2000);
    // Nothing is written while the caret is still in the field, so a typo
    // on the way to the real name never reaches the disk.
    expect(await app.read('Draftt.md')).toBeNull();
    await titleField.fill('Draft');
    await titleField.blur();
    await expect
      .poll(async () => (await app.read('Draft.md'))?.kind ?? null, { timeout: 10_000 })
      .toBe('note');
    expect(await app.read('Draftt.md')).toBeNull();
  });

  test('naming a new note for the first time leaves no alias behind', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    const titleField = app.page.getByTestId('notebook-title');
    await titleField.fill('Real name');
    await titleField.blur();
    await expect
      .poll(async () => (await app.read('Real name.md'))?.content ?? null, { timeout: 10_000 })
      .toContain('created:');
    // It was never called anything anyone could have linked to.
    expect((await app.read('Real name.md'))?.content).not.toContain('aliases');
    await expect(app.page.getByTestId('notebook-aliases')).toHaveCount(0);
    // A SECOND rename is a real one, and does leave an alias.
    await titleField.fill('Better name');
    await titleField.blur();
    await expect(app.page.getByTestId('notebook-aliases')).toContainText('Real name', {
      timeout: 10_000,
    });
  });
});

test.describe('vault', () => {
  test('a note survives a full reload', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'First note');
    await typeInCanvas(app.page, 'The body of the first note.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    // The startup preference is "blank", so reopen the note by its link.
    await openNoteByLink(app, 'First note');
    const row = await app.read('First note.md');
    expect(row?.kind).toBe('note');
    expect(row?.content).toContain('The body of the first note.');
    expect(row?.content).toContain('created:');
  });

  test('the vault is plain markdown with frontmatter', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Tagged');
    await app.page.getByTestId('notebook-tags').fill('alpha, beta');
    await typeInCanvas(app.page, 'Body text.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    const row = await app.read('Tagged.md');
    expect(row?.content).toMatch(/^---\n/);
    expect(row?.content).toContain('- alpha');
    expect(row?.content).toContain('- beta');
    expect(row?.content).toContain('Body text.');
  });
});

test.describe('linking', () => {
  test('a wiki link is listed, resolves after creation, and backlinks', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Alpha');
    await typeInCanvas(app.page, 'See [[Beta]] for more.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    // The Links view offers Beta as a note that does not exist yet.
    await runCommand(app.page, 'Links to and from this note');
    const missing = item(app.page, 'Beta');
    await expect(missing).toContainText('not a note yet');
    await missing.click();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Beta', { timeout: 30_000 });
    // Beta's links view names Alpha as linking here.
    await runCommand(app.page, 'Links to and from this note');
    await expect(item(app.page, 'Alpha')).toContainText('links here');
  });

  test('rename keeps old links working via aliases and offers a rewrite', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Target');
    await typeInCanvas(app.page, 'I am the target.');
    await newNote(app.page);
    await setTitle(app.page, 'Linker');
    await typeInCanvas(app.page, 'Points at [[Target]].');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    await runCommand(app.page, 'View the Pile');
    await item(app.page, 'Target').click();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Target');
    await setTitle(app.page, 'Renamed target');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });
    await expect(app.page.getByTestId('notebook-aliases')).toContainText('Target');
    await expect(app.page.getByTestId('notebook-rename-offer')).toContainText('1 note');
    // The file was renamed on disk.
    expect((await app.read('Renamed target.md'))?.kind).toBe('note');
    expect(await app.read('Target.md')).toBeNull();
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
  test('a note moves into a notebook and the file moves with it', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work', kind: 'dir', content: null });
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Plan');
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
    await openApp(app);
    await runCommand(app.page, 'View notebooks');
    await item(app.page, 'Box').click();
    app.page.once('dialog', (d) => void d.accept());
    await item(app.page, 'Delete this notebook').click();
    await expect
      .poll(async () => (await app.read('Keep me.md'))?.content ?? null, { timeout: 10_000 })
      .toContain('precious');
    expect(await app.read('Box/Keep me.md')).toBeNull();
  });

  test('bulk: tick notes in the Pile, then tag and delete them', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'One.md', kind: 'note', content: 'one' });
    await app.write({ path: 'Two.md', kind: 'note', content: 'two' });
    await openApp(app);
    await runCommand(app.page, 'View the Pile');
    await app.page.locator('[data-testid="notey-palette-tick"][data-title="One"]').check();
    await expect(app.page.getByTestId('notey-palette-bulk')).toContainText('1 ticked');
    await app.page.getByTestId('notey-palette-tag').click();
    await app.page.getByTestId('notey-palette-input').fill('shared');
    await app.page.getByTestId('notey-palette-input').press('Enter');
    await expect(app.page.getByTestId('notey-palette-receipt')).toContainText('Added 1 tag');
    expect((await app.read('One.md'))?.content).toContain('shared');
    expect((await app.read('Two.md'))?.content).not.toContain('shared');
    await app.page.locator('[data-testid="notey-palette-tick"][data-title="One"]').check();
    app.page.once('dialog', (d) => void d.accept());
    await app.page.getByTestId('notey-palette-delete').click();
    await expect.poll(async () => await app.read('One.md'), { timeout: 10_000 }).toBeNull();
    expect((await app.read('Two.md'))?.content).toContain('two');
  });

  test('bulk: move ticked notes into a notebook', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Loose.md', kind: 'note', content: 'loose' });
    await app.write({ path: 'Shelf', kind: 'dir', content: null });
    await openApp(app);
    await runCommand(app.page, 'View the Pile');
    await app.page.locator('[data-testid="notey-palette-tick"][data-title="Loose"]').check();
    await app.page.getByTestId('notey-palette-move').click();
    await app.page
      .locator('[data-testid="notey-palette-move-target"]', { hasText: 'Shelf' })
      .click();
    await expect
      .poll(async () => (await app.read('Shelf/Loose.md'))?.kind ?? null, { timeout: 10_000 })
      .toBe('note');
  });
});

test.describe('editor', () => {
  test('footnotes: Alt+0 cites at the cursor and files the definition', async ({ app }) => {
    test.slow();
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Cited');
    await typeInCanvas(app.page, 'A claim worth citing.');
    await app.page.keyboard.press('Alt+Digit0');
    const dialogText = app.page.locator('.backdrop textarea');
    await expect(dialogText).toBeVisible({ timeout: 15_000 });
    await dialogText.fill('The source of the claim.');
    await app.page.getByRole('button', { name: 'Save footnotes' }).click();
    await expect
      .poll(async () => (await app.read('Cited.md'))?.content ?? '', { timeout: 15_000 })
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
    await openNoteByLink(app, 'Diagram');
    await app.page.getByTestId('notebook-mode-preview').click();
    await expect(
      app.page.locator('[data-testid="notebook-preview"] .mermaid-rendered svg')
    ).toBeVisible({ timeout: 30_000 });
  });

  test('maths render in the preview face; prices stay prose', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Maths.md',
      kind: 'note',
      content: 'Inline $E=mc^2$ and $5 with $10 stay prose.\n',
    });
    await openNoteByLink(app, 'Maths');
    await app.page.getByTestId('notebook-mode-preview').click();
    const preview = app.page.getByTestId('notebook-preview');
    await expect(preview.locator('.katex')).toHaveCount(1, { timeout: 30_000 });
    await expect(preview).toContainText('$5 with $10');
  });

  test('the editor face is remembered', async ({ app }) => {
    await openApp(app);
    await app.page.getByTestId('notebook-mode-source').click();
    await expect(app.page.getByTestId('notebook-source')).toBeVisible({ timeout: 15_000 });
    await openApp(app);
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
    await openNoteByLink(app, 'Exported');
    const download = app.page.waitForEvent('download');
    await runCommand(app.page, 'Export as HTML');
    const file = await download;
    const html = readFileSync(await file.path(), 'utf8');
    expect(file.suggestedFilename()).toBe('Exported.html');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    // Nothing is fetched: the only absolute URLs left are XML namespace
    // names, which KaTeX writes into its MathML and no browser resolves.
    const urls = html.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.filter((url) => !url.startsWith('http://www.w3.org/'))).toEqual([]);
    expect(html).toContain('katex');
    // The maths faces travel with the file rather than being linked.
    expect(html).toContain('@font-face');
    expect(html).toContain('data:font/woff2;base64,');
  });

  test('the Markdown export carries the title as an H1', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Plain.md', kind: 'note', content: 'Just prose.\n' });
    await openNoteByLink(app, 'Plain');
    const download = app.page.waitForEvent('download');
    await runCommand(app.page, 'Export as Markdown');
    const file = await download;
    const md = readFileSync(await file.path(), 'utf8');
    expect(md).toContain('# Plain');
    expect(md).toContain('Just prose.');
  });

  test('a bulk export downloads one zip', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Zip one.md', kind: 'note', content: 'first' });
    await app.write({ path: 'Zip two.md', kind: 'note', content: 'second' });
    await openApp(app);
    await runCommand(app.page, 'View the Pile');
    for (const tick of await app.page.getByTestId('notey-palette-tick').all()) {
      await tick.check();
    }
    const download = app.page.waitForEvent('download');
    await app.page.getByTestId('notey-palette-export-md').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^notes-\d{4}-\d{2}-\d{2}\.zip$/);
    const bytes = readFileSync(await file.path());
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const text = bytes.toString('latin1');
    expect(text).toContain('Zip-one.md');
    expect(text).toContain('Zip-two.md');
  });
});

test.describe('preferences', () => {
  test('the blank page keeps what you type, and filing lands it in the Pile', async ({ app }) => {
    await openApp(app);
    await typeInCanvas(app.page, 'A thought with nowhere to live yet.');
    // Still nothing written to the vault.
    expect(await app.loadAll()).toEqual([]);
    // It survives a reload, because the scratch lives in this browser.
    await openApp(app);
    await expect(app.page.getByTestId('notebook-editor-host')).toContainText('nowhere to live', {
      timeout: 30_000,
    });

    await setTitle(app.page, 'Filed thought');
    await runCommand(app.page, 'File this note in the Pile');
    await expect
      .poll(async () => (await app.loadAll()).map((r) => r.path), { timeout: 10_000 })
      .toContain('Filed thought.md');
  });

  test('choosing "reopen the last note" brings it back', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Sticky.md', kind: 'note', content: 'stays open' });
    await openNoteByLink(app, 'Sticky');
    await runCommand(app.page, 'Settings');
    await app.page.getByTestId('notey-startup-last').click();
    await app.goto('/');
    await app.ready();
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Sticky', { timeout: 30_000 });
  });

  test('settings live in the palette and name the storage backend', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'Settings');
    // Still in the palette — settings are a view, not a page.
    await expect(app.page.getByTestId('notey-palette')).toBeVisible();
    await expect(app.page.getByTestId('notey-settings')).toBeVisible();
    await expect(app.page.getByTestId('notey-backend')).toContainText('sqlite', {
      timeout: 30_000,
    });
    // Escape goes back to the commands, not out of the app.
    await app.page.keyboard.press('Escape');
    await expect(item(app.page, 'View the Pile')).toBeVisible();
  });

  test('the paper, the desk and the pen are chosen separately', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'Settings');
    await app.page.getByTestId('notey-page-light').click();
    await app.page.getByTestId('notey-desk-wood-mahogany').click();
    await app.page.getByTestId('notey-accent-oxblood').click();
    const look = () =>
      app.page.evaluate(() => {
        const r = document.documentElement;
        return { page: r.dataset['page'], desk: r.dataset['desk'], accent: r.dataset['accent'] };
      });
    // A dark desk under a light page is the point of splitting them.
    expect(await look()).toEqual({ page: 'light', desk: 'wood-mahogany', accent: 'oxblood' });
    const textured = await app.page.evaluate(
      () => getComputedStyle(document.body).backgroundImage
    );
    expect(textured).toContain('data:image/svg+xml');
    // And it survives a reload, applied before the first paint.
    await app.goto('/');
    await app.ready();
    expect(await look()).toEqual({ page: 'light', desk: 'wood-mahogany', accent: 'oxblood' });
  });
});
