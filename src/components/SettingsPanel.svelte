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
    GRAINS,
    PAPERS,
    applyLook,
    loadPrefs,
    savePrefs,
    type AccentName,
    type DeskStyle,
    type GrainSize,
    type PageTheme,
    type Prefs,
    type StartupMode,
  } from '../lib/prefs';
  import { requestPersistentStorage, storageEstimate, type PersistState } from '../lib/persistence';
  import { openVaultStore } from '../lib/vault/store';
  import {
    dbFileName,
    describeImport,
    exportFileName,
    exportVault,
    importVault,
  } from '../lib/vault/transfer';
  import { notesHeldElsewhere, platformLocks, VAULT_MUTATE_LOCK } from '../lib/vault/noteLocks';
  import { downloadBlob } from '../lib/exportFile';

  let {
    onChooseFolder = undefined,
  }: {
    /** Desktop only: pick the folder the vault lives in. */
    onChooseFolder?: (() => Promise<string | null>) | undefined;
  } = $props();

  let prefs = $state<Prefs>(loadPrefs());
  let backend = $state('…');
  let vaultBytes = $state<number | null>(null);
  let estimate = $state<{ usage: number; quota: number } | null>(null);
  let persistState = $state<PersistState | null>(null);
  /** What the last export or import did, in one line, or what went wrong. */
  let transferNote = $state<string | null>(null);
  let transferring = $state(false);
  let fileField = $state<HTMLInputElement | undefined>();
  let dbField = $state<HTMLInputElement | undefined>();
  /** Whether this backend is one database file (the browser's; not the desktop's). */
  let hasDbFile = $state(false);
  /** The desktop's folder, as the backend line reports it: `files (<path>)`. */
  const folder = $derived(/^files \((.*)\)$/.exec(backend)?.[1] ?? null);

  const deskGroups = ['Plain', 'Wood', 'Leather'] as const;
  const desksIn = (group: (typeof deskGroups)[number]) => DESKS.filter((d) => d.group === group);

  onMount(() => {
    void (async () => {
      try {
        const store = await openVaultStore();
        backend = store.backend;
        hasDbFile = typeof store.exportDb === 'function';
        vaultBytes = (await store.usage?.())?.bytes ?? null;
      } catch (err) {
        backend = 'failed to open: ' + String(err);
      }
      estimate = await storageEstimate();
    })();
  });

  /**
   * The whole vault as a zip of the folders and files it would be on disk.
   * A backup, a way to move to another browser, and something you can just
   * unzip and read — the same shape the desktop build keeps on disk.
   */
  async function exportEverything(): Promise<void> {
    transferring = true;
    transferNote = null;
    try {
      const store = await openVaultStore();
      const out = await exportVault(store);
      downloadBlob(new Blob([out.bytes as BlobPart], { type: 'application/zip' }), exportFileName());
      transferNote = `Exported ${out.notes} note${out.notes === 1 ? '' : 's'}` +
        (out.assets > 0 ? ` and ${out.assets} image${out.assets === 1 ? '' : 's'}` : '') + '.';
      vaultBytes = (await store.usage?.())?.bytes ?? vaultBytes;
    } catch (err) {
      transferNote = 'Export failed: ' + String(err);
    } finally {
      transferring = false;
    }
  }

  /**
   * Read a zip back in. Nothing is overwritten: a note already here with
   * the same words is left alone, and one that clashes is filed alongside
   * under a free name — so importing a stale backup can only ever add.
   * Held under the vault's mutate lock, and notes another tab has open are
   * left to that tab.
   */
  async function importEverything(file: File): Promise<void> {
    transferring = true;
    transferNote = null;
    try {
      const store = await openVaultStore();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const locks = platformLocks();
      const held = await notesHeldElsewhere(locks, null);
      const run = (): Promise<string> =>
        importVault(store, bytes, { held }).then(describeImport);
      transferNote = locks
        ? await locks.request(VAULT_MUTATE_LOCK, { mode: 'exclusive' }, run)
        : await run();
      vaultBytes = (await store.usage?.())?.bytes ?? vaultBytes;
    } catch (err) {
      transferNote = 'Import failed: ' + String(err);
    } finally {
      transferring = false;
    }
  }

  /**
   * The database file itself. Not a backup — the zip above is that — but
   * the thing you open in a SQLite browser when someone's notes are behaving
   * oddly and you want to see the rows they actually have.
   */
  async function exportDatabase(): Promise<void> {
    transferring = true;
    transferNote = null;
    try {
      const store = await openVaultStore();
      if (!store.exportDb) throw new Error('this vault is not one database file');
      const bytes = await store.exportDb();
      downloadBlob(
        new Blob([bytes as BlobPart], { type: 'application/vnd.sqlite3' }),
        dbFileName()
      );
      transferNote = `Exported the database — ${mb(bytes.byteLength)}.`;
    } catch (err) {
      transferNote = 'Export failed: ' + String(err);
    } finally {
      transferring = false;
    }
  }

  /**
   * Take someone else's database and become it. Destructive on purpose:
   * the point is to see exactly what they see, so a merge would be the
   * wrong answer. Every tab reloads afterwards (the vault they were
   * showing no longer exists).
   */
  async function replaceFromDatabase(file: File): Promise<void> {
    const sure = confirm(
      `Replace this vault with “${file.name}”?\n\n` +
        'Every note here is deleted and the ones in that file take their ' +
        'place. Export first if you want yours back.'
    );
    if (!sure) return;
    transferring = true;
    transferNote = null;
    try {
      const store = await openVaultStore();
      if (!store.importDb) throw new Error('this vault is not one database file');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const out = await store.importDb(bytes);
      transferNote =
        `Replaced the vault: ${out.notes} note${out.notes === 1 ? '' : 's'} ` +
        `in ${out.files} row${out.files === 1 ? '' : 's'}. Reloading…`;
    } catch (err) {
      transferNote = 'Import failed: ' + String(err);
    } finally {
      transferring = false;
    }
  }

  function onDbPicked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void replaceFromDatabase(file);
  }

  function onFilePicked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Clear it, or picking the same file twice fires nothing the second time.
    input.value = '';
    if (file) void importEverything(file);
  }

  function update(changes: Partial<Prefs>): void {
    prefs = savePrefs(changes);
    applyLook(prefs);
  }

  /**
   * A size a person can read. A fresh vault is tens of kilobytes, so
   * rounding everything to MB reports "0.0 MB" for a database that is
   * plainly not empty.
   */
  const mb = (bytes: number): string =>
    bytes < 1024
      ? `${bytes} bytes`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(0)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    <div class="swatches">
      <button
        class="swatch"
        class:on={prefs.page === 'system'}
        title="Follow the system"
        data-testid="notey-page-system"
        onclick={() => update({ page: 'system' })}
      >
        <span class="chip chip-split"></span>
        <span class="swatch-label">System</span>
      </button>
      {#each PAPERS as paper (paper.id)}
        <button
          class="swatch"
          class:on={prefs.page === paper.id}
          title={paper.hint}
          data-testid={`notey-page-${paper.id}`}
          onclick={() => update({ page: paper.id as PageTheme })}
        >
          <span class="chip chip-paper" style={`--chip: ${paper.sample}; --chip-ink: ${paper.ink}`}
          ></span>
          <span class="swatch-label">{paper.label}</span>
        </button>
      {/each}
    </div>
    <label class="toggle">
      <input
        type="checkbox"
        checked={prefs.rule}
        data-testid="notey-rule-toggle"
        onchange={(event) => update({ rule: (event.currentTarget as HTMLInputElement).checked })}
      />
      The red rule under the header
    </label>
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
    <p class="eyebrow">The grain</p>
    <div class="choices">
      {#each GRAINS as option (option.id)}
        <button
          class="choice"
          class:on={prefs.grain === option.id}
          data-testid={`notey-grain-${option.id}`}
          onclick={() => update({ grain: option.id as GrainSize })}
        >
          <span>{option.label}</span>
        </button>
      {/each}
    </div>
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
    <div class="row">
      <button
        class="btn btn-sm"
        data-testid="notey-export-vault"
        disabled={transferring}
        onclick={() => void exportEverything()}>Export everything</button
      >
      <button
        class="btn btn-sm"
        data-testid="notey-import-vault"
        disabled={transferring}
        onclick={() => fileField?.click()}>Import a zip</button
      >
      <input
        class="file-field"
        type="file"
        accept=".zip,application/zip"
        aria-label="Choose a vault zip to import"
        data-testid="notey-import-file"
        bind:this={fileField}
        onchange={onFilePicked}
      />
    </div>
    <p class="muted line">
      A zip of your notebooks and notes as plain .md files, images and all.
      Importing adds to what is here and overwrites nothing — a note that
      clashes is filed alongside.
    </p>
    {#if hasDbFile}
      <div class="row">
        <button
          class="btn btn-sm"
          data-testid="notey-export-db"
          disabled={transferring}
          onclick={() => void exportDatabase()}>Export .sqlite</button
        >
        <button
          class="btn btn-sm"
          data-testid="notey-import-db"
          disabled={transferring}
          onclick={() => dbField?.click()}>Replace from .sqlite</button
        >
        <input
          class="file-field"
          type="file"
          accept=".sqlite,.db,.sqlite3,application/vnd.sqlite3,application/x-sqlite3"
          aria-label="Choose a .sqlite database to replace this vault with"
          data-testid="notey-import-db-file"
          bind:this={dbField}
          onchange={onDbPicked}
        />
      </div>
      <p class="muted line">
        The database file itself — open it in any SQLite browser to read the
        rows notey stored. Replacing swaps this whole vault for the one in
        the file, so it is the way to look at someone else's notes, not a
        way to merge them.
      </p>
    {/if}

    {#if transferNote}
      <p class="line" data-testid="notey-transfer-note" aria-live="polite">{transferNote}</p>
    {/if}

    {#if folder !== null}
      <p class="muted line">
        Plain .md files in a real folder — back it up like any other.
      </p>
      {#if onChooseFolder}
        <div class="row">
          <button
            class="btn btn-sm"
            data-testid="notey-choose-folder"
            disabled={transferring}
            onclick={() => void onChooseFolder?.()}>Change folder…</button
          >
          <span class="muted">Notes already written stay where they are.</span>
        </div>
      {/if}
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

  /* Buttons and their note, side by side until the panel is too narrow. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  /* The picker is driven by the button beside it, never shown itself. */
  .file-field {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
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

  /* "Match" and "System" are both papers at once. */
  .chip-split {
    background: linear-gradient(135deg, #e7dec6 50%, #23201a 50%);
  }

  /* A paper chip shows its ink as a written line. */
  .chip-paper {
    position: relative;
    overflow: hidden;
  }

  .chip-paper::after {
    content: '';
    position: absolute;
    left: 2px;
    right: 2px;
    top: 50%;
    height: 1px;
    background: var(--chip-ink, currentColor);
    box-shadow:
      0 -3px 0 var(--chip-ink, currentColor),
      0 3px 0 var(--chip-ink, currentColor);
    opacity: 0.75;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .toggle input {
    accent-color: var(--color-primary);
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
