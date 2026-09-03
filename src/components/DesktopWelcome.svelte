<script lang="ts">
  /**
   * The first thing the desktop app says: here is where your notes will
   * be written, and you can put them somewhere else.
   *
   * It exists because the desktop build writes REAL files to a REAL
   * folder, and a person should never have to go looking for their own
   * notes afterwards. It is shown once — choosing a folder (or accepting
   * the one offered) is what makes it a first run — and the same folder
   * and picker live in Settings from then on.
   */
  import { rootLabel } from '../lib/vault/desktopPaths';

  let {
    folder,
    onKeep,
    onChoose,
  }: {
    /** Where notes will go if nothing is changed. */
    folder: string;
    onKeep: () => void;
    /** Opens the folder picker; resolves to the folder now in force. */
    onChoose: () => Promise<string | null>;
  } = $props();

  let busy = $state(false);

  async function choose(): Promise<void> {
    busy = true;
    try {
      await onChoose();
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop" data-testid="notey-welcome">
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="notey-welcome-title">
    <p class="eyebrow">Welcome</p>
    <h1 id="notey-welcome-title">Your notes are files</h1>
    <p>
      notey writes plain <code>.md</code> files you can open in anything, back up like
      any other folder, and keep long after notey is gone. They will be here:
    </p>
    <p class="folder" data-testid="notey-welcome-folder" title={folder}>
      <strong>{rootLabel(folder)}</strong>
      <span class="path">{folder}</span>
    </p>
    <div class="row">
      <button class="btn" data-testid="notey-welcome-keep" disabled={busy} onclick={onKeep}>
        Keep it here
      </button>
      <button
        class="btn btn-quiet"
        data-testid="notey-welcome-choose"
        disabled={busy}
        onclick={() => void choose()}
      >
        Choose another folder…
      </button>
    </div>
    <p class="muted">You can move it later in Settings.</p>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-5);
    background: var(--scrim-color);
  }

  .card {
    width: min(34rem, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    box-shadow: var(--shadow-2);
  }

  h1 {
    margin: 0;
    font-family: var(--font-display, var(--font-body));
    font-size: var(--font-size-xl);
  }

  p {
    margin: 0;
  }

  /* The path is the point of the dialog, so it gets to be legible. */
  .folder {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3);
    border-left: 2px solid var(--color-primary);
    background: var(--surface-raised-color);
  }

  .path {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-eyebrow);
    color: var(--text-muted-color);
    overflow-wrap: anywhere;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .muted {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }
</style>
