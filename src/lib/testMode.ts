/**
 * The test-mode gate. The Playwright suite sets
 * `localStorage['notey-test-mode'] = '1'` via an init script before the
 * first navigation; only then is the hook chunk fetched, so a real user
 * never downloads it.
 */
export function installTestHookIfEnabled(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('notey-test-mode') !== '1') return;
  } catch {
    return; // sandboxed frame — not a test context
  }
  void import('./testHook').then((m) => m.installTestHook());
}
