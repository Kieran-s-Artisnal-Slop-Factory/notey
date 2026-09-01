<script lang="ts">
  /**
   * Settings: the startup preference, the theme, and the truth about where
   * the vault lives (backend tier, size, persistent-storage state).
   */
  import { onMount } from 'svelte';
  import { applyTheme, loadPrefs, savePrefs, type StartupMode, type ThemeChoice } from '../lib/prefs';
  import { requestPersistentStorage, storageEstimate, type PersistState } from '../lib/persistence';
  import { openVaultStore } from '../lib/vault/store';
  import { isTauri } from '../lib/vault/tauriStore';

  let startup = $state<StartupMode>('last');
  let theme = $state<ThemeChoice>('system');
  let backend = $state<string>('…');
  let vaultBytes = $state<number | null>(null);
  let persistState = $state<PersistState | null>(null);
  let estimate = $state<{ usage: number; quota: number } | null>(null);

  onMount(() => {
    const prefs = loadPrefs();
    startup = prefs.startup;
    theme = prefs.theme;
    void (async () => {
      try {
        // The page-singleton store stays open for the page's lifetime;
        // closing it here would strand any later reader of the same page.
        const store = await openVaultStore();
        backend = store.backend;
        vaultBytes = (await store.usage?.())?.bytes ?? null;
      } catch (err) {
        backend = 'failed to open: ' + String(err);
      }
      estimate = await storageEstimate();
    })();
  });

  function setStartup(next: StartupMode): void {
    startup = next;
    savePrefs({ startup: next });
  }

  function setTheme(next: ThemeChoice): void {
    theme = next;
    savePrefs({ theme: next });
    applyTheme(next);
  }

  async function persist(): Promise<void> {
    persistState = await requestPersistentStorage();
  }

  const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1) + ' MB';
</script>

<div class="settings stack">
  <section class="card stack">
    <h1 class="eyebrow eyebrow-stamp">Settings</h1>

    <h2>Opening the app</h2>
    <label class="choice">
      <input type="radio" name="startup" checked={startup === 'last'} onchange={() => setStartup('last')} data-testid="notey-startup-last" />
      Reopen the note I had open
    </label>
    <label class="choice">
      <input type="radio" name="startup" checked={startup === 'blank'} onchange={() => setStartup('blank')} data-testid="notey-startup-blank" />
      Open to a blank page with no file yet
    </label>
    <p class="muted">
      The blank page is a scratch buffer in this browser — “File this note” turns it into a real
      note in the Pile.
    </p>

    <h2>Theme</h2>
    <div class="row">
      <label class="choice"><input type="radio" name="theme" checked={theme === 'system'} onchange={() => setTheme('system')} /> System</label>
      <label class="choice"><input type="radio" name="theme" checked={theme === 'light'} onchange={() => setTheme('light')} /> Paper</label>
      <label class="choice"><input type="radio" name="theme" checked={theme === 'dark'} onchange={() => setTheme('dark')} /> Lamplight</label>
    </div>
  </section>

  <section class="card stack">
    <h2>Your vault</h2>
    <p>
      Backend: <strong data-testid="notey-backend">{backend}</strong>
      {#if vaultBytes !== null}· vault size {mb(vaultBytes)}{/if}
    </p>
    {#if isTauri()}
      <p class="muted">Notes are plain .md files in Documents/Notey — back that folder up like any other.</p>
    {:else}
      <p class="muted">
        Notes live in this browser only. Clearing site data deletes them. Export what matters, and
        ask the browser to protect the storage:
      </p>
      <div class="row">
        <button class="btn btn-sm" onclick={() => void persist()}>Ask for persistent storage</button>
        {#if persistState}<span class="muted">{persistState}</span>{/if}
      </div>
      {#if estimate}
        <p class="muted">Browser says: {mb(estimate.usage)} used of {mb(estimate.quota)} allowed.</p>
      {/if}
    {/if}
  </section>
</div>

<style>
  .settings {
    max-width: 44rem;
    margin: var(--space-6) auto;
    padding: 0 var(--space-4);
  }

  .card {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    padding: var(--space-5);
  }

  h2 {
    font-size: var(--font-size-lg);
    margin-top: var(--space-3);
  }

  .choice {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
  }

  input[type='radio'] {
    accent-color: var(--color-primary);
  }
</style>
