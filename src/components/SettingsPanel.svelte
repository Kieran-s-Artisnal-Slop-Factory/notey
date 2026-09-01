<script lang="ts">
  /**
   * Settings, as a view inside the command palette rather than a page of
   * its own — changing how the app looks should not take you away from
   * what you were writing.
   *
   * Every control applies immediately: the look is three attributes on
   * <html> (see prefs.applyLook), so there is nothing to save and no way
   * to be looking at a setting that is not in force.
   */
  import { onMount } from 'svelte';
  import {
    ACCENTS,
    DESKS,
    applyLook,
    loadPrefs,
    savePrefs,
    type AccentName,
    type DeskStyle,
    type PageTheme,
    type Prefs,
    type StartupMode,
  } from '../lib/prefs';
  import { requestPersistentStorage, storageEstimate, type PersistState } from '../lib/persistence';
  import { openVaultStore } from '../lib/vault/store';

  let prefs = $state<Prefs>(loadPrefs());
  let backend = $state('…');
  let vaultBytes = $state<number | null>(null);
  let estimate = $state<{ usage: number; quota: number } | null>(null);
  let persistState = $state<PersistState | null>(null);

  const deskGroups = ['Plain', 'Wood', 'Leather'] as const;
  const desksIn = (group: (typeof deskGroups)[number]) => DESKS.filter((d) => d.group === group);

  onMount(() => {
    void (async () => {
      try {
        const store = await openVaultStore();
        backend = store.backend;
        vaultBytes = (await store.usage?.())?.bytes ?? null;
      } catch (err) {
        backend = 'failed to open: ' + String(err);
      }
      estimate = await storageEstimate();
    })();
  });

  function update(changes: Partial<Prefs>): void {
    prefs = savePrefs(changes);
    applyLook(prefs);
  }

  const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1) + ' MB';
</script>

<div class="settings" data-testid="notey-settings">
  <section>
    <p class="eyebrow">Opening the app</p>
    <div class="choices">
      {#each [
        { id: 'blank', label: 'A blank page', hint: 'nothing filed yet' },
        { id: 'last', label: 'The last note', hint: 'where you left off' },
      ] as const as option (option.id)}
        <button
          class="choice"
          class:on={prefs.startup === option.id}
          data-testid={`notey-startup-${option.id}`}
          onclick={() => update({ startup: option.id as StartupMode })}
        >
          <span>{option.label}</span>
          <span class="hint">{option.hint}</span>
        </button>
      {/each}
    </div>
  </section>

  <section>
    <p class="eyebrow">The paper</p>
    <div class="choices">
      {#each [
        { id: 'system', label: 'System' },
        { id: 'light', label: 'Paper' },
        { id: 'dark', label: 'Lamplight' },
      ] as const as option (option.id)}
        <button
          class="choice"
          class:on={prefs.page === option.id}
          data-testid={`notey-page-${option.id}`}
          onclick={() => update({ page: option.id as PageTheme })}
        >
          <span>{option.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <section>
    <p class="eyebrow">The desk</p>
    <div class="swatches">
      <button
        class="swatch"
        class:on={prefs.desk === 'system'}
        title="Follow the paper"
        data-testid="notey-desk-system"
        onclick={() => update({ desk: 'system' })}
      >
        <span class="chip chip-split"></span>
        <span class="swatch-label">Match</span>
      </button>
    </div>
    {#each deskGroups as group (group)}
      <p class="group">{group}</p>
      <div class="swatches">
        {#each desksIn(group) as desk (desk.id)}
          <button
            class="swatch"
            class:on={prefs.desk === desk.id}
            data-testid={`notey-desk-${desk.id}`}
            onclick={() => update({ desk: desk.id as DeskStyle })}
          >
            <span class="chip" data-desk-chip={desk.id} style={`--chip: ${desk.sample}`}></span>
            <span class="swatch-label">{desk.label}</span>
          </button>
        {/each}
      </div>
    {/each}
  </section>

  <section>
    <p class="eyebrow">The pen</p>
    <div class="swatches">
      {#each ACCENTS as accent (accent.id)}
        <button
          class="swatch"
          class:on={prefs.accent === accent.id}
          data-testid={`notey-accent-${accent.id}`}
          onclick={() => update({ accent: accent.id as AccentName })}
        >
          <span class="chip" style={`--chip: ${accent.sample}`}></span>
          <span class="swatch-label">{accent.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <section>
    <p class="eyebrow">Your vault</p>
    <p class="line">
      <strong data-testid="notey-backend">{backend}</strong>
      {#if vaultBytes !== null}<span class="muted"> · {mb(vaultBytes)}</span>{/if}
    </p>
    {#if backend.startsWith('files')}
      <p class="muted line">
        Plain .md files in Documents/Notey — back that folder up like any other.
      </p>
    {:else}
      <p class="muted line">
        Notes live in this browser only. Clearing site data deletes them.
      </p>
      <div class="row">
        <button class="btn btn-sm" onclick={() => void requestPersistentStorage().then((s) => (persistState = s))}>
          Ask for persistent storage
        </button>
        {#if persistState}<span class="muted">{persistState}</span>{/if}
      </div>
      {#if estimate}
        <p class="muted line">
          The browser says {mb(estimate.usage)} used of {mb(estimate.quota)} allowed.
        </p>
      {/if}
    {/if}
  </section>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    overflow-y: auto;
    min-height: 0;
    padding: var(--space-2) var(--space-1) var(--space-1);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .group {
    font-size: var(--font-size-eyebrow);
    color: var(--text-muted-color);
    margin-top: var(--space-1);
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .choice {
    flex: 1 1 8rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
  }

  .choice .hint {
    font-size: var(--font-size-eyebrow);
    color: var(--text-muted-color);
  }

  .choice.on {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .swatch {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-color);
    font-family: var(--font-body);
    font-size: var(--font-size-eyebrow);
    cursor: pointer;
  }

  .swatch:hover {
    border-color: var(--border-strong-color);
  }

  .swatch.on {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .chip {
    width: 1.15rem;
    height: 1.15rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong-color);
    background: var(--chip, var(--surface-color));
    flex: none;
  }

  /* "Match" is both papers at once. */
  .chip-split {
    background: linear-gradient(135deg, #e7dec6 50%, #23201a 50%);
  }

  /* A hint of the real thing on the wood and leather chips. */
  .chip[data-desk-chip^='wood'] {
    background-image: repeating-linear-gradient(
      92deg,
      rgb(0 0 0 / 0.22) 0 1px,
      transparent 1px 4px
    );
  }

  .chip[data-desk-chip^='leather'] {
    background-image: radial-gradient(rgb(255 255 255 / 0.22) 0.5px, transparent 0.6px);
    background-size: 3px 3px;
  }

  .line {
    font-size: var(--font-size-sm);
  }
</style>
