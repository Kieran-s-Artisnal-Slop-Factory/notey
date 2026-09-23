import { test, expect } from './helpers/app';

test('probe: which dialog loses the prose', async ({ app }) => {
  test.slow();
  await app.goto('/');
  await app.ready();
  await expect(app.page.getByTestId('notey-sheet')).toBeVisible({ timeout: 30_000 });
  await expect(app.page.locator('[data-testid="notebook-canvas"]')).toBeVisible({
    timeout: 30_000,
  });

  // A named note, the way the failing test sets one up.
  await app.page.keyboard.press('Control+k');
  await expect(app.page.getByTestId('notey-palette')).toBeVisible({ timeout: 10_000 });
  await app.page
    .locator('[data-testid="notey-palette-item"][data-label="New note"]')
    .click();
  await expect(app.page.getByTestId('notebook-title')).toHaveValue('Untitled', { timeout: 30_000 });
  const title = app.page.getByTestId('notebook-title');
  await title.fill('Probe');
  await title.blur();

  const canvas = app.page.locator('[data-testid="notebook-canvas"] [contenteditable="true"]');
  await canvas.click();
  await app.page.keyboard.type('Before.');
  await app.page.waitForTimeout(900);

  const state = async (label: string) => {
    const text = await canvas.first().innerText();
    const file = (await app.read('Probe.md'))?.content ?? '(no file)';
    console.log(label, JSON.stringify({ canvas: text, file: file.replace(/\n/g, '|') }));
  };
  await state('TYPED   ');

  await app.page.keyboard.press('Alt+KeyF');
  await expect(app.page.getByTestId('notebook-math-dialog')).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId('notebook-math-cancel').click();
  await state('FORMULA ');

  await canvas.click();
  await app.page.keyboard.press('Alt+KeyM');
  await expect(app.page.getByTestId('notebook-diagram-dialog')).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId('notebook-diagram-cancel').click();
  await state('DIAGRAM ');

  await canvas.click();
  await app.page.keyboard.press('Alt+KeyE');
  await expect(app.page.getByTestId('notebook-drawing-dialog')).toBeVisible({ timeout: 30_000 });
  await app.page.getByRole('button', { name: 'Close' }).first().click();
  await expect(app.page.getByTestId('notebook-drawing-dialog')).toHaveCount(0);
  await state('DRAWING ');

  await canvas.click();
  await state('BEFORE 0');
  console.log('SELECTION', JSON.stringify(await app.page.evaluate(() => {
    const s = document.getSelection();
    return {
      collapsed: s?.isCollapsed,
      anchor: s?.anchorNode?.nodeName + ':' + s?.anchorOffset,
      focus: s?.focusNode?.nodeName + ':' + s?.focusOffset,
      text: s?.toString(),
      active: document.activeElement?.className?.slice(0, 30),
    };
  })));
  await app.page.keyboard.press('Alt+Digit0');
  await expect(app.page.getByTestId('notebook-footnote-dialog')).toBeVisible({ timeout: 15_000 });
  await state('OPENED  ');
  await app.page.keyboard.press('Alt+Digit0');
  await expect(app.page.getByTestId('notebook-footnote-dialog')).toHaveCount(0);
  await app.page.waitForTimeout(900);
  await state('FOOTNOTE');
});
