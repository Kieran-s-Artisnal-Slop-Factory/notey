<script lang="ts">
  /**
   * The formula editor — a MathLive `<math-field>` in a dialog.
   *
   * Maths used to be something you typed as LaTeX and found out about in
   * Preview. This is the other way round: you write the formula as it will
   * look, and the LaTeX is what falls out. The two halves are shown side by
   * side and edit each other, because knowing `\frac` is faster than
   * clicking when you do know it, and useless when you don't.
   *
   * Three settings are load-bearing:
   *
   * **`soundsDirectory = null`** skips 227 KB of keypress `.wav` files that
   * are not vendored (`public/math/PROVENANCE.txt` records the choice). Left
   * unset, MathLive requests them from a directory that does not exist.
   *
   * **`fontsDirectory = null`** hands the faces to the stylesheet instead.
   * `ensureFontCss` loads the one with `--ML__static-fonts:true` in it, which
   * tells MathLive's loader to stand down: the browser then pulls the two
   * faces a formula actually uses rather than all twenty.
   *
   * **The inline shortcuts are LEFT ON.** They are the reason this is easier
   * than typing LaTeX: "sqrt" becomes a radical, "pi" becomes π, "sum"
   * becomes Σ with its limits. (useful's napkin editor switches them off
   * because its variables are multi-letter words like `costPerMonth`, where
   * a shortcut firing mid-word corrupts the formula. Here the variables are
   * `x` and `n`, and the shortcuts are the whole point.)
   *
   * Escape belongs to the mathfield while the mathfield has focus — it is
   * how you leave MathLive's own LaTeX-command entry — so it only closes
   * this dialog from outside the field.
   */
  import { onDestroy, onMount } from 'svelte';
  import { ensureFontCss } from '../../lib/math/fonts';
  import { MATRIX_MAX, matrixLatex } from '../../lib/notebook/mathText';

  let {
    initial = '',
    display = false,
    onSave,
    onCancel,
  }: {
    /** Existing LaTeX when editing; '' for a new formula. */
    initial?: string;
    /** Whether it is set on its own line (`$$…$$`) or in the sentence. */
    display?: boolean;
    onSave: (latex: string, display: boolean) => void;
    onCancel: () => void;
  } = $props();

  interface Field extends HTMLElement {
    value: string;
    executeCommand(command: string | [string, ...unknown[]]): boolean;
  }

  let host: HTMLDivElement | undefined = $state();
  let modal: HTMLDivElement | undefined = $state();
  let field: Field | undefined;
  let latex = $state(initial);
  let asBlock = $state(display);
  let ready = $state(false);
  let error = $state<string | null>(null);
  let destroyed = false;
  /** Set while WE are writing into the field, so its `input` does not echo. */
  let writing = false;
  /** Where focus was before this opened, to put it back on close. */
  let cameFrom: HTMLElement | null = null;
  /** A mousedown that started on the backdrop, so a drag out cannot dismiss. */
  let pressedBackdrop = false;

  /** In an attribute, every `{` would start a Svelte expression. */
  const LATEX_HINT = '\\frac{1}{2}';

  /**
   * The few insertions worth a button. Everything else is on MathLive's own
   * keyboard (the ⌨ in the field) or a typed shortcut; this is the shelf of
   * things people reach for constantly. `#0` is where the caret lands, `#?`
   * is a placeholder to tab through.
   */
  const SHELF: { label: string; latex: string; title: string }[] = [
    { label: '¹⁄ₓ', latex: '\\frac{#0}{#?}', title: 'Fraction' },
    { label: '√', latex: '\\sqrt{#0}', title: 'Square root' },
    { label: 'xⁿ', latex: '#0^{#?}', title: 'Power' },
    { label: 'xₙ', latex: '#0_{#?}', title: 'Subscript' },
    { label: 'Σ', latex: '\\sum_{#?}^{#?}#0', title: 'Sum' },
    { label: '∫', latex: '\\int_{#?}^{#?}#0', title: 'Integral' },
    { label: '(  )', latex: '\\left(#0\\right)', title: 'Brackets that grow' },
  ];

  /**
   * The matrix button asks for a size before it inserts anything. A fixed
   * 2 × 2 meant adding rows and columns afterwards through MathLive's menu,
   * one at a time, which is the least findable thing in the editor. Rows
   * first, then columns, the way a matrix is named (a 2 × 3 has 2 rows).
   */
  let sizing = $state(false);
  let rows = $state(2);
  let cols = $state(2);
  let rowsField: HTMLInputElement | undefined = $state();

  function openSizer(): void {
    sizing = !sizing;
    if (sizing) queueMicrotask(() => rowsField?.select());
  }

  function insertMatrix(): void {
    sizing = false;
    insert(matrixLatex(rows, cols));
  }

  function onSizeKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    insertMatrix();
  }

  onMount(async () => {
    // Before anything is awaited: the note behind must stop being the thing
    // the keyboard talks to, or the first keystroke lands in it.
    cameFrom = document.activeElement as HTMLElement | null;
    cameFrom?.blur?.();
    modal?.focus();
    ensureFontCss();
    try {
      const { MathfieldElement } = await import('mathlive');
      if (destroyed) return;
      MathfieldElement.soundsDirectory = null;
      MathfieldElement.fontsDirectory = null;

      const created = new MathfieldElement() as unknown as Field;
      created.setAttribute('data-testid', 'notebook-math-field');
      created.setAttribute('aria-label', 'Formula');
      created.addEventListener('input', () => {
        if (writing) return;
        latex = created.value;
      });
      // MathLive builds the field AFTER it is attached (`mount`), and hands
      // focus to its own keyboard sink a frame or two after THAT — measured
      // at ~35 ms, during which a key goes to the dialog and is lost. So the
      // "Loading…" line stays until the keyboard has actually arrived: when
      // it goes, typing works. That is the moment people start typing.
      created.addEventListener(
        'mount',
        () => {
          if (destroyed) return;
          field = created;
          // Anything typed into the LaTeX box while it was being built.
          if (created.value !== latex) pushLatex(latex);
          const active = document.activeElement;
          const unclaimed = !active || active === document.body || active === modal;
          if (!unclaimed) {
            // They have already clicked into something else; leave it.
            ready = true;
            return;
          }
          const arrived = () => {
            if (!destroyed) ready = true;
          };
          created.addEventListener('focusin', arrived, { once: true });
          // Never strand the dialog on "Loading…" if focus goes elsewhere.
          setTimeout(arrived, 500);
          created.focus();
        },
        { once: true }
      );
      host?.append(created);
      created.value = latex;
    } catch (err) {
      if (!destroyed) {
        error = err instanceof Error ? err.message : 'The formula editor failed to load.';
      }
    }
  });

  onDestroy(() => {
    destroyed = true;
    cameFrom?.focus?.();
  });

  /** Typed into the LaTeX box: push it in without bouncing it back out. */
  function pushLatex(next: string): void {
    latex = next;
    if (!field || field.value === next) return;
    writing = true;
    field.value = next;
    writing = false;
  }

  function insert(snippet: string): void {
    if (!field) return;
    field.focus();
    field.executeCommand(['insert', snippet, { focus: true, feedback: false }]);
    latex = field.value;
  }

  /**
   * Escape is the mathfield's while the mathfield has it — MathLive uses it
   * to leave the `\command` entry mode, and a dialog that closed on it would
   * take the key away and throw the formula out at the same time.
   */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // One step back at a time: the size picker, then the dialog.
    if (sizing) {
      event.preventDefault();
      sizing = false;
      field?.focus();
      return;
    }
    const active = document.activeElement;
    if (field && (active === field || field.contains(active as Node))) return;
    onCancel();
  }

  function save(): void {
    const body = latex.trim();
    if (!body) return;
    onSave(body, asBlock);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  role="presentation"
  onmousedown={(e) => (pressedBackdrop = e.target === e.currentTarget)}
  onclick={(e) => {
    if (e.target === e.currentTarget && pressedBackdrop) onCancel();
    pressedBackdrop = false;
  }}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label="Formula"
    tabindex="-1"
    bind:this={modal}
    data-testid="notebook-math-dialog"
  >
    <div class="head">
      <h3>{initial ? 'Edit formula' : 'Formula'}</h3>
      <button type="button" class="close" aria-label="Close" onclick={onCancel}>×</button>
    </div>

    <div class="shelf">
      {#each SHELF as item (item.latex)}
        <button
          type="button"
          class="chip"
          title={item.title}
          disabled={!ready}
          onclick={() => insert(item.latex)}>{item.label}</button
        >
      {/each}
      <button
        type="button"
        class="chip"
        class:on={sizing}
        title="Matrix — choose its size"
        aria-expanded={sizing}
        data-testid="notebook-math-matrix"
        disabled={!ready}
        onclick={openSizer}>[ ]</button
      >
      <span class="muted small">
        …or just type: <code>sqrt</code>, <code>pi</code>, <code>sum</code> and
        <code>/</code> become what they mean.
      </span>
    </div>

    {#if sizing}
      <div class="sizer" data-testid="notebook-math-matrix-size">
        <label>
          Rows
          <input
            type="number"
            min="1"
            max={MATRIX_MAX}
            data-testid="notebook-math-matrix-rows"
            bind:this={rowsField}
            bind:value={rows}
            onkeydown={onSizeKey}
          />
        </label>
        <span aria-hidden="true">×</span>
        <label>
          Columns
          <input
            type="number"
            min="1"
            max={MATRIX_MAX}
            data-testid="notebook-math-matrix-cols"
            bind:value={cols}
            onkeydown={onSizeKey}
          />
        </label>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          data-testid="notebook-math-matrix-insert"
          onclick={insertMatrix}>Insert {rows || 1} × {cols || 1} matrix</button
        >
        <button type="button" class="btn btn-sm" onclick={() => (sizing = false)}>Cancel</button>
      </div>
    {/if}

    <div class="field" bind:this={host}>
      {#if !ready && !error}
        <p class="muted small" data-testid="notebook-math-loading">Loading the formula editor…</p>
      {/if}
      {#if error}
        <p class="err" role="alert" data-testid="notebook-math-error">{error}</p>
      {/if}
    </div>

    <label class="latex">
      <span class="muted small">LaTeX</span>
      <input
        type="text"
        class="latex-input"
        data-testid="notebook-math-latex"
        spellcheck="false"
        placeholder={LATEX_HINT}
        value={latex}
        oninput={(e) => pushLatex(e.currentTarget.value)}
      />
    </label>

    <div class="actions">
      <label class="block-toggle">
        <input
          type="checkbox"
          data-testid="notebook-math-display"
          bind:checked={asBlock}
        />
        On its own line
      </label>
      <span class="muted small">
        {asBlock ? 'Written as $$…$$' : 'Written as $…$, in the sentence'}
      </span>
      <button type="button" class="btn" data-testid="notebook-math-cancel" onclick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="notebook-math-save"
        onclick={save}
        disabled={!latex.trim()}
      >
        {initial ? 'Update formula' : 'Insert formula'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim-color);
    display: grid;
    place-items: center;
    z-index: 70;
    padding: var(--space-4);
  }

  .modal {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-strong-color);
    outline: 1px dashed var(--border-color);
    outline-offset: 4px;
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-2);
    padding: var(--space-4);
    width: min(48rem, 100%);
    max-height: min(90vh, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .head h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--tracking-label);
  }

  .close {
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-xl);
    line-height: 1;
    cursor: pointer;
    padding: 0 var(--space-2);
  }

  .shelf {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .chip {
    min-width: 2.4rem;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    font-size: var(--font-size-md);
    line-height: 1.4;
  }

  .chip:hover:not(:disabled) {
    border-color: var(--color-primary);
  }

  .chip.on {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .sizer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border: 1px dashed var(--border-strong-color);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
  }

  .sizer label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .sizer input {
    width: 3.5rem;
    padding: var(--space-1);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    font-family: var(--font-mono);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .field {
    min-height: 5rem;
    display: flex;
    align-items: center;
  }

  /* The custom element is not in this component's markup, so it needs the
     global escape to be styled at all. */
  .field :global(math-field) {
    display: block;
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-xl);
  }

  .field :global(math-field:focus-within) {
    border-color: var(--color-primary);
    outline: none;
  }

  .latex {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .latex-input {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
    color: var(--text-color);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .block-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--font-size-sm);
  }

  .actions .btn:first-of-type {
    margin-left: auto;
  }

  .muted {
    color: var(--text-muted-color);
  }

  .small {
    font-size: var(--font-size-sm);
  }

  .err {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
    margin: 0;
  }
</style>
