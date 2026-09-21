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
    await expect(app.page.getByTestId('notebook-aliases')).toHaveValue('');
    // A SECOND rename is a real one, and does leave an alias.
    await titleField.fill('Better name');
    await titleField.blur();
    await expect(app.page.getByTestId('notebook-aliases')).toHaveValue(/Real name/, {
      timeout: 10_000,
    });
  });
});

test.describe('the page, in use', () => {
  test('clicking blank paper below the writing puts the caret at the end', async ({ app }) => {
    await openApp(app);
    await typeInCanvas(app.page, 'first line');
    /*
     * Click low on the sheet but still on screen: the page is 8 x 11, so
     * its bottom edge is well below the viewport and a click there would
     * land nowhere at all.
     */
    const sheet = (await app.page.getByTestId('notey-sheet').boundingBox())!;
    const viewport = app.page.viewportSize()!;
    const y = Math.min(sheet.y + sheet.height - 60, viewport.height - 40);
    await app.page.mouse.click(sheet.x + sheet.width / 2, y);
    await app.page.keyboard.type(' and more');
    await app.page.waitForTimeout(900);
    await expect(app.page.getByTestId('notebook-editor-host')).toContainText('first line and more');
  });

  test('a breadcrumb opens the palette on that notebook', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work/Plan.md', kind: 'note', content: 'plan' });
    await openNoteByLink(app, 'Plan');
    await app.page.getByTestId('notey-breadcrumb-link').first().click();
    await expect(app.page.getByTestId('notey-palette')).toBeVisible();
    await expect(app.page.locator('.crumb .eyebrow')).toHaveText('Work');
    await expect(item(app.page, '+ New note here')).toBeVisible();
  });
});

test.describe('frontmatter', () => {
  test('aliases are a field, and a rename fills it in', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Named.md', kind: 'note', content: 'body' });
    await openNoteByLink(app, 'Named');
    const aliases = app.page.getByTestId('notebook-aliases');
    await aliases.fill('Another name, A third');
    await aliases.blur();
    await expect
      .poll(async () => (await app.read('Named.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('- Another name');
    expect((await app.read('Named.md'))?.content).toContain('- A third');
  });

  test('a field can be a value, a list, or YAML', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Fields.md', kind: 'note', content: 'body' });
    await openNoteByLink(app, 'Fields');
    await app.page.getByTestId('notey-fm-add').click();
    await app.page.getByTestId('notey-fm-key').fill('people');
    await app.page.getByTestId('notey-fm-value').fill('ada');
    await expect
      .poll(async () => (await app.read('Fields.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('people: ada');
    // One press turns it into a list…
    await app.page.getByTestId('notey-fm-kind').click();
    await app.page.getByTestId('notey-fm-value').fill('ada, grace');
    await expect
      .poll(async () => (await app.read('Fields.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('- grace');
    // …and another turns it into YAML, where a map is possible.
    await app.page.getByTestId('notey-fm-kind').click();
    await app.page.getByTestId('notey-fm-value').fill('host: example.com\nport: 22');
    await expect
      .poll(async () => (await app.read('Fields.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('host: example.com');
    expect((await app.read('Fields.md'))?.content).toContain('port: 22');
  });

  test('a nested map written by hand survives an unrelated edit', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Kept.md',
      kind: 'note',
      content: '---\ndeploy:\n  host: example.com\n  port: 22\nport: 8080\n---\n\nbody\n',
    });
    await openNoteByLink(app, 'Kept');
    // The nested map is offered as YAML, not flattened into a string.
    await expect(app.page.locator('[data-testid="notey-fm-kind"][data-kind="yaml"]')).toHaveCount(1);
    // Touch something else entirely.
    await app.page.getByTestId('notebook-tags').fill('touched');
    await app.page.getByTestId('notebook-tags').blur();
    await expect
      .poll(async () => (await app.read('Kept.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('touched');
    const content = (await app.read('Kept.md'))?.content ?? '';
    expect(content).toContain('host: example.com');
    expect(content).toContain('port: 22');
    expect(content).toContain('port: 8080');
  });
});

/*
 * Two tabs of one profile share one vault. The browser lets only one
 * worker hold the database, so one tab serves the other over a channel
 * (src/lib/vault/tabs.ts); which one is which depends on who opened
 * first, and no test below assumes it.
 */
test.describe('dropping a file', () => {
  /**
   * A real drag: build a DataTransfer in the page, put File objects on it,
   * and dispatch the events the browser would. `setInputFiles` cannot be
   * used here — there is no input; the drop target is the page itself.
   */
  async function dropFiles(page: Page, files: { name: string; text: string }[]): Promise<void> {
    await page.evaluate((dropped) => {
      const data = new DataTransfer();
      for (const file of dropped) {
        data.items.add(new File([file.text], file.name, { type: 'text/markdown' }));
      }
      const desk = document.querySelector('.desk')!;
      for (const type of ['dragenter', 'dragover', 'drop'] as const) {
        desk.dispatchEvent(
          new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
        );
      }
    }, files);
  }

  test('a dropped .md file becomes a note and opens', async ({ app }) => {
    await openApp(app);
    await dropFiles(app.page, [
      { name: 'From my disk.md', text: '---\ntags:\n  - kept\n---\n\nWritten elsewhere.' },
    ]);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('From my disk', {
      timeout: 15_000,
    });
    await expect(app.page.locator('[data-testid="notebook-canvas"]')).toContainText(
      'Written elsewhere.'
    );
    // The file is in the vault, with the frontmatter it arrived with.
    await expect
      .poll(async () => (await app.read('From my disk.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('- kept');
    // And it is a real note: the header shows the tag it came with.
    await expect(app.page.getByTestId('notebook-tags')).toHaveValue('kept');
  });

  test('dropping while another note is open keeps that note and opens the new one', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Being written');
    await typeInCanvas(app.page, 'Half a thought');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', {
      timeout: 10_000,
    });

    await dropFiles(app.page, [{ name: 'Interruption.md', text: 'A different note.' }]);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Interruption', {
      timeout: 15_000,
    });
    // Nothing was lost from the note that was open.
    await expect
      .poll(async () => (await app.read('Being written.md'))?.content ?? '', { timeout: 10_000 })
      .toContain('Half a thought');
  });

  test('a dropped name that clashes is filed alongside, never over the top', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Plan.md', kind: 'note', content: 'The one I already had.' });
    await openApp(app);

    await dropFiles(app.page, [{ name: 'Plan.md', text: 'The one from my disk.' }]);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Plan 2', { timeout: 15_000 });
    expect((await app.read('Plan.md'))?.content).toBe('The one I already had.');
    expect((await app.read('Plan 2.md'))?.content).toBe('The one from my disk.');
  });

  test('a file dropped into a notebook lands in that notebook', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work/Anchor.md', kind: 'note', content: 'anchor' });
    await openApp(app);
    await openNoteByLink(app, 'Anchor');

    await dropFiles(app.page, [{ name: 'Filed here.md', text: 'inside Work' }]);
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('Filed here', {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await app.read('Work/Filed here.md'))?.content ?? '', { timeout: 10_000 })
      .toBe('inside Work');
  });

  test('the web build offers no way to edit a file on disk', async ({ app }) => {
    await openApp(app);
    await openPalette(app.page);
    // A browser cannot write back to where a file came from, so the
    // desktop-only command must not be offered here.
    await expect(item(app.page, 'Edit existing file')).toHaveCount(0);
    await expect(item(app.page, 'New note')).toBeVisible();
  });

  test('a file that is not markdown is refused, and says so', async ({ app }) => {
    await openApp(app);
    await dropFiles(app.page, [{ name: 'photo.png', text: 'not really a png' }]);
    await expect(app.page.getByTestId('notebook-feedback')).toContainText('.md files', {
      timeout: 10_000,
    });
    expect((await app.loadAll()).filter((r) => r.kind === 'note')).toEqual([]);
  });
});

test.describe('two tabs', () => {
  const saved = (page: Page) =>
    expect(page.getByTestId('notebook-save-state')).toContainText('Saved', { timeout: 15_000 });

  /** What the vault says it is, from each tab: exactly one goes through the other. */
  async function roles(a: App, b: App): Promise<string[]> {
    return (await Promise.all([a.backend(), b.backend()])).sort();
  }

  /** Type without waiting out the save chain — the caller wants it in flight. */
  async function typeNow(page: Page, text: string): Promise<void> {
    await page.locator('[data-testid="notebook-canvas"] [contenteditable="true"]').click();
    await page.keyboard.type(text);
  }

  /** Poll the vault itself; the stamp is not a barrier under load. */
  const vaultHas = (app: App, path: string) =>
    expect.poll(async () => (await app.read(path))?.content ?? '', { timeout: 15_000 });

  test('two tabs booting at once settle into one owner and one follower', async ({ app }) => {
    const b = await app.newTab();
    await Promise.all([openApp(app), openApp(b)]);
    const both = await roles(app, b);
    expect(both.filter((line) => line.includes('via another tab'))).toHaveLength(1);
    expect(both.filter((line) => !line.includes('via another tab'))).toHaveLength(1);
  });

  test('two tabs write two different notes, and both persist', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'From A');
    await typeInCanvas(app.page, 'Written in A.');
    await saved(app.page);

    const b = await app.newTab();
    await openApp(b);
    await newNote(b.page);
    await setTitle(b.page, 'From B');
    await typeInCanvas(b.page, 'Written in B.');
    await saved(b.page);

    // One vault, readable from either side.
    await vaultHas(app, 'From B.md').toContain('Written in B.');
    await vaultHas(b, 'From A.md').toContain('Written in A.');
    // And the first tab lists the second's note without a reload.
    await openPalette(app.page);
    await expect(item(app.page, 'From B')).toBeVisible({ timeout: 10_000 });
  });

  test('the same note in a second tab is read-only, follows the writer, and is promoted', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Shared');
    await typeInCanvas(app.page, 'First tab text.');
    await saved(app.page);

    const b = await app.newTab();
    await openNoteByLink(b, 'Shared');
    await expect(b.page.getByTestId('notey-read-only')).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByTestId('notebook-read-only')).toContainText('First tab text.');
    await expect(b.page.getByTestId('notebook-title')).toBeDisabled();
    await expect(b.page.getByTestId('notebook-save-state')).toContainText('Open in another tab');

    // The writer keeps going; the reader sees it land.
    await typeInCanvas(app.page, ' Then more.');
    await saved(app.page);
    await expect(b.page.getByTestId('notebook-read-only')).toContainText('Then more.', { timeout: 15_000 });

    // The writer moves to the blank page; the reader becomes the writer.
    await runCommand(app.page, 'Close this note');
    await expect(b.page.locator('[data-testid="notebook-canvas"], [data-testid="notebook-source"]')).toBeVisible(
      { timeout: 15_000 }
    );
    await expect(b.page.getByTestId('notey-read-only')).toHaveCount(0);
    await typeInCanvas(b.page, ' From B now.');
    await saved(b.page);
    await vaultHas(app, 'Shared.md').toContain('From B now.');
  });

  test('closing one tab mid-write hands the database on and the write still lands', async ({ app }) => {
    await openApp(app);
    const b = await app.newTab();
    await openApp(b);
    // One of them is serving the other; which one is the browser's choice.
    expect((await roles(app, b)).filter((r) => r.includes('via another tab'))).toHaveLength(1);
    await newNote(b.page);
    await setTitle(b.page, 'Survivor');
    await typeInCanvas(b.page, 'Before.');
    await saved(b.page);

    // Type and pull the other tab out from under it, with the write still
    // travelling: if A was serving, B has to finish the job itself.
    await typeNow(b.page, ' After.');
    await app.page.close();
    await saved(b.page);
    await vaultHas(b, 'Survivor.md').toContain('After.');
  });

  test('a tab left on its own keeps the vault across a reload', async ({ app }) => {
    await openApp(app);
    const b = await app.newTab();
    await openApp(b);
    await newNote(b.page);
    await setTitle(b.page, 'Survivor');
    await typeInCanvas(b.page, 'Written once.');
    await saved(b.page);
    await app.page.close();

    await openNoteByLink(b, 'Survivor');
    await expect(b.page.locator('[data-testid="notebook-canvas"], [data-testid="notebook-source"]')).toBeVisible(
      { timeout: 30_000 }
    );
    // Nothing holds it any more, so it opens writable, and one more edit lands.
    await expect(b.page.getByTestId('notey-read-only')).toHaveCount(0);
    await typeInCanvas(b.page, ' And again.');
    await saved(b.page);
    await vaultHas(b, 'Survivor.md').toContain('And again.');
  });

  test('the blank page is one page: a second tab gets a sheet of its own', async ({ app }) => {
    await openApp(app);
    await typeInCanvas(app.page, 'Scratch in A.');

    const b = await app.newTab();
    await openApp(b);
    const canvasB = b.page.locator('[data-testid="notebook-canvas"]');
    await expect(canvasB).not.toContainText('Scratch in A.');
    await typeInCanvas(b.page, 'Scratch in B.');

    // Neither tab's words reach the other's page.
    await expect(app.page.locator('[data-testid="notebook-canvas"]')).toContainText('Scratch in A.');
    await expect(canvasB).not.toContainText('Scratch in A.');
    // The shared sheet is untouched: A reloads and still has its own words.
    await app.goto('/');
    await app.ready();
    await expect(app.page.locator('[data-testid="notebook-canvas"]')).toContainText('Scratch in A.', {
      timeout: 30_000,
    });

    // B's sheet is its own and stays its own, even once A is gone and the
    // shared page is free again.
    await app.page.close();
    await b.goto('/');
    await b.ready();
    await expect(canvasB).toContainText('Scratch in B.', { timeout: 30_000 });
    await expect(canvasB).not.toContainText('Scratch in A.');
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
    await expect(app.page.getByTestId('notebook-aliases')).toHaveValue(/Target/);
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

  test('deleting the open note leaves the blank page behind', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Doomed');
    await typeInCanvas(app.page, 'Not for long.');
    await expect(app.page.getByTestId('notebook-save-state')).toContainText('Saved', { timeout: 10_000 });
    app.page.once('dialog', (d) => void d.accept());
    await runCommand(app.page, 'Delete this note');
    await expect.poll(async () => await app.read('Doomed.md'), { timeout: 10_000 }).toBeNull();
    // Back on the unfiled page, with a working editor.
    await expect(app.page.getByTestId('notebook-title')).toHaveValue('', { timeout: 15_000 });
    await expect(app.page.getByTestId('notebook-title')).toBeEnabled();
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
    // `.ML__latex` is MathLive's; KaTeX drew these until the formula editor
    // arrived, and one engine for writing and another for reading is how a
    // formula comes to look different in the two places.
    await expect(preview.locator('.ML__latex')).toHaveCount(1, { timeout: 30_000 });
    await expect(preview).toContainText('$5 with $10');
  });

  test('the canvas typesets maths too, and still leaves prices alone', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Canvas maths.md',
      kind: 'note',
      content: 'Inline $E=mc^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nIt cost $5 and $10.\n',
    });
    await openNoteByLink(app, 'Canvas maths');
    const canvas = app.page.locator('[data-testid="notebook-canvas"]');
    // Two formulas: one in the sentence, one on its own line.
    await expect(canvas.locator('.math-node')).toHaveCount(2, { timeout: 30_000 });
    await expect(canvas.locator('.math-node.math-node-display')).toHaveCount(1);
    await expect(canvas.locator('.math-node .ML__latex').first()).toBeVisible();
    // micromark reads `$5 and $` as a formula — it strips a space from each
    // side the way a code span does. strictMathPlugin hands it back, so the
    // canvas agrees with the preview about what is money.
    await expect(canvas).toContainText('It cost $5 and $10.');
  });

  test('a formula is written in the formula editor, not in LaTeX', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Circles');
    await typeInCanvas(app.page, 'The area is ');

    await app.page.getByTestId('notebook-toolbar-math').click();
    await expect(app.page.getByTestId('notebook-math-dialog')).toBeVisible({ timeout: 30_000 });
    await expect(app.page.getByTestId('notebook-math-loading')).toHaveCount(0, { timeout: 60_000 });

    // Typing "pi" produces π, not the letters: MathLive's inline shortcuts
    // are what makes this easier than writing LaTeX, and they are left on.
    await app.page.keyboard.type('pi');
    const field = app.page.getByTestId('notebook-math-field');
    await expect.poll(() => field.evaluate((el: HTMLElement & { value: string }) => el.value)).toBe(
      String.raw`\pi`
    );
    // The LaTeX box is the same formula, for anyone who does know LaTeX.
    await expect(app.page.getByTestId('notebook-math-latex')).toHaveValue(String.raw`\pi`);

    await app.page.getByTestId('notebook-math-save').click();
    await expect(app.page.getByTestId('notebook-math-dialog')).toHaveCount(0);
    const node = app.page.locator('[data-testid="notebook-canvas"] .math-node');
    await expect(node).toHaveAttribute('data-value', String.raw`\pi`, { timeout: 10_000 });
    await expect(node.locator('.ML__latex')).toBeVisible();

    // And in the file it is markdown, not a widget.
    await expect
      .poll(async () => (await app.read('Circles.md'))?.content, { timeout: 30_000 })
      .toContain(String.raw`$\pi$`);
  });

  test('double-clicking a formula edits that formula, in place', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Identity.md',
      kind: 'note',
      content: 'The identity $e^{i x} = 1$ is famous.\n',
    });
    await openNoteByLink(app, 'Identity');
    const node = app.page.locator('[data-testid="notebook-canvas"] .math-node');
    await expect(node).toHaveCount(1, { timeout: 30_000 });

    await node.dblclick();
    await expect(app.page.getByTestId('notebook-math-dialog')).toBeVisible({ timeout: 30_000 });
    // It opens ON the formula, rather than on a blank one beside it.
    await expect(app.page.getByTestId('notebook-math-latex')).toHaveValue(String.raw`e^{i x} = 1`);

    await app.page.getByTestId('notebook-math-latex').fill('x = 1');
    await app.page.getByTestId('notebook-math-save').click();
    await expect(app.page.getByTestId('notebook-math-dialog')).toHaveCount(0);

    // ONE formula, changed — not a second one appended at the end.
    await expect(node).toHaveCount(1);
    await expect(node).toHaveAttribute('data-value', 'x = 1', { timeout: 10_000 });
    // (Saving stamps created/updated frontmatter on; the body is what matters.)
    await expect
      .poll(async () => (await app.read('Identity.md'))?.content, { timeout: 30_000 })
      .toContain('The identity $x = 1$ is famous.\n');
  });

  test('in Source view the button edits the formula the cursor is in', async ({ app }) => {
    await openApp(app);
    await app.write({
      path: 'Sums.md',
      kind: 'note',
      content: 'Before.\n\n$$\nx + y\n$$\n\nAfter.\n',
    });
    await openNoteByLink(app, 'Sums');
    await app.page.getByTestId('notebook-mode-source').click();
    const source = app.page.getByTestId('notebook-source');
    await expect(source).toBeVisible({ timeout: 30_000 });
    // Put the caret inside the block, then ask for the formula editor.
    await source.getByText('x + y', { exact: true }).click();
    await app.page.getByTestId('notebook-toolbar-math').click();
    await expect(app.page.getByTestId('notebook-math-dialog')).toBeVisible({ timeout: 30_000 });
    await expect(app.page.getByTestId('notebook-math-latex')).toHaveValue('x + y');
    // It knows this one is set on its own line.
    await expect(app.page.getByTestId('notebook-math-display')).toBeChecked();

    await app.page.getByTestId('notebook-math-latex').fill('x - y');
    await app.page.getByTestId('notebook-math-save').click();
    await expect
      .poll(async () => (await app.read('Sums.md'))?.content, { timeout: 30_000 })
      .toContain('Before.\n\n$$\nx - y\n$$\n\nAfter.\n');
  });

  test('a dollar in prose survives the canvas', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Budget');
    // remark-stringify escapes every `$` once maths is switched on, so this
    // came back out of the canvas as "costs \$7" until unescapeDollars.
    await typeInCanvas(app.page, 'It costs $7 today.');
    await expect
      .poll(async () => (await app.read('Budget.md'))?.content, { timeout: 30_000 })
      .toContain('It costs $7 today.');
  });

  test('the drawing canvas keeps the keyboard, and Escape belongs to it', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Drawing');
    await typeInCanvas(app.page, 'Before the drawing.');

    // Open it the way the ✏ affordance on a drawing does: from INSIDE the
    // text, with the caret still in the note. A real click on the toolbar
    // button would move focus to the button and hide the bug.
    await app.page.locator('[data-testid="notebook-canvas"] [contenteditable="true"]').click();
    expect(
      await app.page.evaluate(
        () => !!document.activeElement?.closest('[data-testid="notebook-canvas"]')
      )
    ).toBe(true);
    await app.page
      .getByTestId('notebook-toolbar-draw')
      .evaluate((el: HTMLElement) => el.click());
    const dialog = app.page.getByTestId('notebook-drawing-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // Excalidraw is a lazy chunk with fonts; wait for the canvas itself.
    await expect(app.page.getByTestId('notebook-drawing-loading')).toHaveCount(0, {
      timeout: 60_000,
    });

    // The note behind must not be what the keyboard talks to: Excalidraw's
    // tool shortcuts are bare digits and letters.
    const inNote = () =>
      app.page.evaluate(
        () => !!document.activeElement?.closest('[data-testid="notebook-canvas"]')
      );
    expect(await inNote()).toBe(false);

    // The keys must reach EXCALIDRAW, not merely miss the note. It binds
    // its shortcuts to its own container unless told otherwise, so a key
    // pressed with focus anywhere else used to vanish. `window.__noteyDrawing`
    // is its live API, exposed in test mode.
    await app.page.waitForFunction(() => (window as any).__noteyDrawing !== undefined, undefined, {
      timeout: 30_000,
    });
    const tool = () =>
      app.page.evaluate(() => (window as any).__noteyDrawing.getAppState().activeTool.type as string);
    const lineInProgress = () =>
      app.page.evaluate(() => (window as any).__noteyDrawing.getAppState().multiElement !== null);

    await app.page.keyboard.press('5'); // the arrow tool
    expect(await tool()).toBe('arrow');
    await app.page.keyboard.press('l'); // the line tool
    expect(await tool()).toBe('line');
    expect(await inNote()).toBe(false);

    // Draw a line point by point, the way that needs Escape to finish.
    const canvas = (await app.page.getByTestId('notebook-drawing-canvas').boundingBox())!;
    const at = (fx: number, fy: number) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy] as const;
    await app.page.mouse.click(...at(0.3, 0.5));
    await app.page.mouse.click(...at(0.5, 0.4));
    await app.page.mouse.click(...at(0.7, 0.6));
    expect(await lineInProgress()).toBe(true);

    // Escape is the canvas's: it finishes the line, and the dialog stays.
    await app.page.keyboard.press('Escape');
    await expect.poll(lineInProgress).toBe(false);
    await expect(dialog).toBeVisible();

    // Nothing leaked into the note.
    await app.page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    const body = app.page.locator('[data-testid="notebook-canvas"]');
    await expect(body).toContainText('Before the drawing.');
    await expect(body).not.toContainText('5');
    await expect(body).not.toContainText('Before the drawing.r');
    await expect
      .poll(async () => (await app.read('Drawing.md'))?.content ?? '', { timeout: 10_000 })
      .not.toMatch(/Before the drawing\.[5r]/);
  });

  test('a drag out of the drawing canvas does not throw the drawing away', async ({ app }) => {
    await openApp(app);
    await newNote(app.page);
    await setTitle(app.page, 'Dragging');
    await app.page.getByTestId('notebook-toolbar-draw').click();
    const dialog = app.page.getByTestId('notebook-drawing-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(app.page.getByTestId('notebook-drawing-loading')).toHaveCount(0, {
      timeout: 60_000,
    });

    // Draw past the edge: the press starts on the canvas and the release
    // lands on the backdrop, which delivers its click to the backdrop.
    const canvas = await app.page.getByTestId('notebook-drawing-canvas').boundingBox();
    await app.page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(4, 4, { steps: 8 }); // out onto the backdrop
    await app.page.mouse.up();
    await expect(dialog).toBeVisible();

    // A click that BEGINS on the backdrop still closes it.
    await app.page.mouse.click(4, 4);
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
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
    // names, which a renderer writes into its MathML and no browser resolves.
    const urls = html.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.filter((url) => !url.startsWith('http://www.w3.org/'))).toEqual([]);
    // MathLive's markup AND its layout rules: the glyphs without the rules
    // are a heap of spans in the wrong places.
    expect(html).toContain('ML__latex');
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

test.describe('offline', () => {
  // A whole-build download per test context, eight contexts at once, from one
  // single-threaded static server: generous, and inside the test's own limit.
  test.describe.configure({ timeout: 150_000 });

  /**
   * Ask the worker how much of the build it has. The page cannot work this
   * out for itself: `precache.json` is the worker's list and the caches are
   * the worker's, so every answer is a round trip.
   */
  async function offlineStatus(page: Page) {
    return page.evaluate(
      () =>
        new Promise<{ ready: boolean; missing: number; total: number }>((resolve, reject) => {
          const controller = navigator.serviceWorker.controller;
          if (!controller) return reject(new Error('no service worker is controlling this page'));
          const timer = setTimeout(() => reject(new Error('the worker did not answer')), 30_000);
          const onMessage = (event: MessageEvent) => {
            if (event.data?.type !== 'notey-offline-status') return;
            clearTimeout(timer);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve(event.data);
          };
          navigator.serviceWorker.addEventListener('message', onMessage);
          controller.postMessage({ type: 'notey-offline', action: 'status' });
        })
    );
  }

  test('one visit downloads the whole build, not just what was used', async ({ app }) => {
    await openApp(app);
    await app.page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

    // The download runs in the background from the moment the worker
    // activates, so this is a wait, not a trigger. Generous: the whole
    // build is several hundred files.
    await expect
      .poll(async () => (await offlineStatus(app.page)).ready, { timeout: 120_000 })
      .toBe(true);

    const status = await offlineStatus(app.page);
    // Every file the build emitted — pages and chunks nobody opened, the
    // sqlite engine, every font. A crawl over the shell used to guess at
    // this list and miss whatever it could not see in minified code.
    expect(status.total).toBeGreaterThan(300);
    expect(status.missing).toBe(0);

    // And they really are in Cache Storage, not just counted.
    const cached = await app.page.evaluate(async () => {
      let n = 0;
      for (const key of await caches.keys()) n += (await (await caches.open(key)).keys()).length;
      return n;
    });
    expect(cached).toBeGreaterThanOrEqual(status.total);
  });

  test('an update keeps the previous build for tabs still running it, and no older', async ({
    app,
  }) => {
    await openApp(app);
    await expect
      .poll(async () => (await offlineStatus(app.page)).ready, { timeout: 120_000 })
      .toBe(true);

    // Pretend two deployments happened before this one: the worker's note
    // says the last build it finished was "previous-build", and the one
    // before that had a chunk of its own.
    const base = new URL(app.page.url()).pathname.replace(/[^/]*$/, '');
    const previousChunk = base + '_astro/from-the-previous-build.js';
    const olderChunk = base + '_astro/from-two-builds-ago.js';
    await app.page.evaluate(
      async ({ base, previousChunk, olderChunk }) => {
        const cache = await caches.open('notey-cache-v3');
        await cache.put(previousChunk, new Response('// previous'));
        await cache.put(olderChunk, new Response('// older'));
        await cache.put(
          base + '__notey-precache-state',
          new Response(
            JSON.stringify({ built: 'previous-build', urls: [previousChunk], previous: [olderChunk] })
          )
        );
      },
      { base, previousChunk, olderChunk }
    );

    // A complete run of THIS build now demotes "previous-build" to the
    // generation it keeps, and lets the one before that go.
    await app.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent) => {
            if (event.data?.type !== 'notey-offline-done') return;
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve();
          };
          navigator.serviceWorker.addEventListener('message', onMessage);
          navigator.serviceWorker.controller!.postMessage({ type: 'notey-offline', action: 'download' });
        })
    );
    const left = await app.page.evaluate(
      async ({ previousChunk, olderChunk }) => {
        const cache = await caches.open('notey-cache-v3');
        return {
          previous: Boolean(await cache.match(previousChunk)),
          older: Boolean(await cache.match(olderChunk)),
        };
      },
      { previousChunk, olderChunk }
    );
    // A tab opened before the update is still running that build's code, and
    // its lazy chunks exist nowhere else once the host has replaced them.
    expect(left.previous).toBe(true);
    // Two builds back is gone: nothing should still be running it.
    expect(left.older).toBe(false);
  });

  test('settings say how much is left, and keep saying it until it is done', async ({
    app,
  }) => {
    await openApp(app);
    await expect
      .poll(async () => (await offlineStatus(app.page)).ready, { timeout: 120_000 })
      .toBe(true);

    // Lose three files, the way an evicted entry or a run cut short would,
    // while this worker still believes it finished.
    await app.page.evaluate(async () => {
      const cache = await caches.open('notey-cache-v3');
      const chunks = (await cache.keys()).filter((r) => /\/_astro\/.+\.js$/.test(r.url));
      for (const request of chunks.slice(0, 3)) await cache.delete(request);
    });

    await runCommand(app.page, 'Settings');
    const line = app.page.getByTestId('notey-offline-status');
    await expect(line).toBeVisible({ timeout: 30_000 });
    // Opening the panel is enough: the question itself sets the worker going
    // again, and the line keeps itself current rather than stopping at the
    // count it was opened with.
    await expect(line).toContainText('Ready to work offline', { timeout: 60_000 });
    // Nothing left to fetch, so there is nothing to press.
    await expect(app.page.getByTestId('notey-offline-download')).toHaveCount(0);
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

  test('the paper can be a legal pad, and the red rule can go', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'Settings');
    await app.page.getByTestId('notey-page-legal').click();
    await expect
      .poll(() => app.page.evaluate(() => document.documentElement.dataset['page']))
      .toBe('legal');
    // The pad is ruled: the sheet paints lines the plain papers do not.
    const lines = await app.page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="notey-sheet"]')!, '::before')
        .backgroundImage
    );
    expect(lines).toContain('gradient');
    await app.page.getByTestId('notey-rule-toggle').uncheck();
    await expect
      .poll(() => app.page.evaluate(() => document.documentElement.dataset['rule']))
      .toBe('off');
    await app.goto('/');
    await app.ready();
    // Both survive the reload, applied before the first paint.
    expect(
      await app.page.evaluate(() => [
        document.documentElement.dataset['page'],
        document.documentElement.dataset['rule'],
      ])
    ).toEqual(['legal', 'off']);
  });

  test('green bar paper prints its bands and tractor-feed holes', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'Settings');
    await app.page.getByTestId('notey-page-greenbar').click();
    await expect
      .poll(() => app.page.evaluate(() => document.documentElement.dataset['page']))
      .toBe('greenbar');
    const printed = await app.page.evaluate(() => {
      const before = getComputedStyle(document.querySelector('[data-testid="notey-sheet"]')!, '::before');
      return { image: before.backgroundImage, repeat: before.backgroundRepeat };
    });
    // The bands are one repeating gradient; the holes are two radial ones
    // that repeat down the edges only.
    expect(printed.image).toContain('repeating-linear-gradient');
    expect(printed.image.match(/radial-gradient/g)?.length).toBe(2);
    expect(printed.repeat).toContain('repeat-y');
    await app.goto('/');
    await app.ready();
    expect(await app.page.evaluate(() => document.documentElement.dataset['page'])).toBe('greenbar');
  });

  test('the desk grain can be re-scaled', async ({ app }) => {
    await openApp(app);
    await runCommand(app.page, 'Settings');
    await app.page.getByTestId('notey-desk-leather-rich').click();
    const grainSize = () =>
      app.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--grain-scale').trim()
      );
    await app.page.getByTestId('notey-grain-fine').click();
    // Browsers serialise a custom property as written, minus the leading
    // zero, so compare as a number rather than as text.
    expect(Number(await grainSize())).toBeCloseTo(0.4);
    await app.page.getByTestId('notey-grain-coarse').click();
    expect(Number(await grainSize())).toBeCloseTo(1);
  });

  test('the vault exports to a zip and imports back into an empty one', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work/Kept.md', kind: 'note', content: '---\ntags:\n  - x\n---\n\nThe body.' });
    await app.write({ path: 'Loose.md', kind: 'note', content: 'On its own.' });
    await openApp(app);

    // Export: a real download, and the app says what went into it.
    await runCommand(app.page, 'Settings');
    const download = await Promise.all([
      app.page.waitForEvent('download', { timeout: 30_000 }),
      app.page.getByTestId('notey-export-vault').click(),
    ]).then(([d]) => d);
    expect(download.suggestedFilename()).toMatch(/^notey-\d{4}-\d{2}-\d{2}\.zip$/);
    const saved = await download.path();
    await expect(app.page.getByTestId('notey-transfer-note')).toContainText('Exported 2 notes');

    // A second, separate browser profile: same app, empty vault.
    const other = await app.page.context().browser()!.newContext();
    await other.addInitScript(() => {
      try {
        localStorage.setItem('notey-test-mode', '1');
      } catch {}
    });
    const fresh = await other.newPage();
    await fresh.goto('/');
    await expect(fresh.getByTestId('notey-sheet')).toBeVisible({ timeout: 30_000 });
    await expect(fresh.getByTestId('notey-booting')).toHaveCount(0, { timeout: 30_000 });

    await fresh.keyboard.press('Control+k');
    await fresh.locator('[data-testid="notey-palette-item"][data-label="Settings"]').click();
    await fresh.getByTestId('notey-import-file').setInputFiles(saved!);
    await expect(fresh.getByTestId('notey-transfer-note')).toContainText('Imported 2 notes', {
      timeout: 30_000,
    });

    // The notes are really in the other vault, frontmatter and all.
    const rows = await fresh.evaluate(() => (window as any).__notey.loadAll());
    const byPath = Object.fromEntries(
      (rows as { path: string; content: string | null }[]).map((r) => [r.path, r.content])
    );
    expect(byPath['Work/Kept.md']).toContain('The body.');
    expect(byPath['Work/Kept.md']).toContain('- x');
    expect(byPath['Loose.md']).toBe('On its own.');

    // Importing it again adds nothing.
    await fresh.getByTestId('notey-import-file').setInputFiles(saved!);
    await expect(fresh.getByTestId('notey-transfer-note')).toContainText('already here', {
      timeout: 30_000,
    });
    await other.close();
  });

  test('importing over a note that differs files it alongside, never over the top', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Loose.md', kind: 'note', content: 'Mine, keep me.' });
    await openApp(app);
    await runCommand(app.page, 'Settings');
    const download = await Promise.all([
      app.page.waitForEvent('download', { timeout: 30_000 }),
      app.page.getByTestId('notey-export-vault').click(),
    ]).then(([d]) => d);
    const saved = await download.path();

    // Change the note, then import the archive of how it used to be.
    await app.write({ path: 'Loose.md', kind: 'note', content: 'Changed since.' });
    await app.page.getByTestId('notey-import-file').setInputFiles(saved!);
    await expect(app.page.getByTestId('notey-transfer-note')).toContainText('filed alongside', {
      timeout: 30_000,
    });
    expect((await app.read('Loose.md'))?.content).toBe('Changed since.');
    expect((await app.read('Loose 2.md'))?.content).toBe('Mine, keep me.');
  });

  test('the database dumps to a .sqlite file and replaces a vault from one', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Work/Kept.md', kind: 'note', content: 'Rows to look at.' });
    await openApp(app);

    await runCommand(app.page, 'Settings');
    const download = await Promise.all([
      app.page.waitForEvent('download', { timeout: 30_000 }),
      app.page.getByTestId('notey-export-db').click(),
    ]).then(([d]) => d);
    expect(download.suggestedFilename()).toMatch(/^notey-\d{4}-\d{2}-\d{2}\.sqlite$/);
    const saved = (await download.path())!;
    await expect(app.page.getByTestId('notey-transfer-note')).toContainText('Exported the database');

    // It is a real SQLite file: any tool that reads the header reads this.
    const head = readFileSync(saved).subarray(0, 16);
    expect(new TextDecoder().decode(head)).toBe('SQLite format 3\0');

    // A separate profile — someone else's browser — becomes this vault.
    const other = await app.page.context().browser()!.newContext();
    await other.addInitScript(() => {
      try {
        localStorage.setItem('notey-test-mode', '1');
      } catch {}
    });
    const fresh = await other.newPage();
    await fresh.goto('/');
    await expect(fresh.getByTestId('notey-sheet')).toBeVisible({ timeout: 30_000 });
    await expect(fresh.getByTestId('notey-booting')).toHaveCount(0, { timeout: 30_000 });
    await fresh.keyboard.press('Control+k');
    await fresh.locator('[data-testid="notey-palette-item"][data-label="Settings"]').click();
    fresh.once('dialog', (d) => void d.accept());
    await fresh.getByTestId('notey-import-db-file').setInputFiles(saved);
    await expect(fresh.getByTestId('notey-transfer-note')).toContainText('Replaced the vault', {
      timeout: 30_000,
    });

    // It reloads itself, because everything it was showing is gone.
    await fresh.waitForFunction(() => (window as any).__notey !== undefined, undefined, {
      timeout: 30_000,
    });
    await expect
      .poll(
        async () =>
          (await fresh.evaluate(() => (window as any).__notey.read('Work/Kept.md')))?.content ?? '',
        { timeout: 30_000 }
      )
      .toContain('Rows to look at.');
    await other.close();
  });

  test('a file that is not a notey database is refused, and changes nothing', async ({ app }) => {
    await openApp(app);
    await app.write({ path: 'Safe.md', kind: 'note', content: 'Still here.' });
    await openApp(app);
    await runCommand(app.page, 'Settings');
    app.page.once('dialog', (d) => void d.accept());
    await app.page.getByTestId('notey-import-db-file').setInputFiles({
      name: 'not-a-database.sqlite',
      mimeType: 'application/vnd.sqlite3',
      buffer: Buffer.from('SQLite format 3\0' + 'x'.repeat(1024)),
    });
    await expect(app.page.getByTestId('notey-transfer-note')).toContainText('Import failed', {
      timeout: 30_000,
    });
    expect((await app.read('Safe.md'))?.content).toBe('Still here.');
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
