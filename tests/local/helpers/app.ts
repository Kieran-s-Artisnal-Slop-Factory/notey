/**
 * The app fixture, ported from useful's harness and simplified for notey's
 * vault: every test gets a FRESH browser context (fresh OPFS, fresh
 * service worker), the test hook rides in via an init script, and any
 * console error or page error fails the test at teardown.
 */
import { test as base, expect, type Page } from '@playwright/test';
import type { FileRow, FileWrite } from '../../../src/lib/vault/types';

export interface App {
  page: Page;
  errors: string[];
  goto(path?: string): Promise<void>;
  /** Wait for hydration + the test hook. */
  ready(): Promise<void>;
  /** Allow a console error this test provokes on purpose. */
  expectConsoleError(pattern: RegExp): void;
  /** Raw vault reads/writes through window.__notey. */
  loadAll(): Promise<FileRow[]>;
  read(path: string): Promise<FileRow | null>;
  write(file: FileWrite): Promise<FileRow>;
  backend(): Promise<string>;
}

// Chromium noise that is the platform's, not the app's.
const PLATFORM_NOISE = [/net::ERR_NO_BUFFER_SPACE/i];

export const test = base.extend<{ app: App }>({
  app: async ({ browser }, use) => {
    const context = await browser.newContext();
    // Init scripts run in every frame; a sandboxed frame throws on
    // localStorage, hence the try/catch.
    await context.addInitScript(() => {
      try {
        localStorage.setItem('notey-test-mode', '1');
      } catch {}
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const expected: RegExp[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    const hook = async <T>(body: string): Promise<T> => {
      await page.waitForFunction(() => (window as any).__notey !== undefined, undefined, {
        timeout: 15_000,
      });
      return page.evaluate(`(async () => ${body})()`) as Promise<T>;
    };

    const app: App = {
      page,
      errors,
      async goto(path = '/') {
        await page.goto(path);
      },
      async ready() {
        await page.waitForFunction(() => (window as any).__notey !== undefined, undefined, {
          timeout: 15_000,
        });
        // Astro removes the `ssr` attribute when an island hydrates.
        await page.waitForFunction(
          () => document.querySelectorAll('astro-island[ssr]').length === 0,
          undefined,
          { timeout: 15_000 }
        );
      },
      expectConsoleError(pattern) {
        expected.push(pattern);
      },
      loadAll: () => hook(`(window).__notey.loadAll()`),
      read: (path) => hook(`(window).__notey.read(${JSON.stringify(path)})`),
      write: (file) => hook(`(window).__notey.write(${JSON.stringify(file)})`),
      backend: () => hook(`(window).__notey.backend()`),
    };

    await use(app);

    const unexplained = errors.filter(
      (line) =>
        !PLATFORM_NOISE.some((noise) => noise.test(line)) &&
        !expected.some((pattern) => pattern.test(line))
    );
    expect(unexplained, 'console errors during the test').toEqual([]);
    await context.close();
  },
});

export { expect };
