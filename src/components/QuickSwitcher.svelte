<script lang="ts">
  /**
   * Ctrl+K: fuzzy-find a note by title or path, Enter opens it. The match
   * quality comes from lib/fuzzy.ts (title scored first, path as fallback).
   */
  import { fuzzyScore } from '../lib/fuzzy';
  import { displayTitle } from '../lib/notebook/model';
  import type { Note } from '../lib/vault/types';

  let {
    notes,
    onPick,
    onClose,
  }: {
    notes: readonly Note[];
    onPick: (note: Note) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let active = $state(0);
  let field = $state<HTMLInputElement | undefined>();

  const results = $derived.by(() => {
    const q = query.trim();
    const scored: { note: Note; score: number }[] = [];
    for (const note of notes) {
      if (q === '') {
        scored.push({ note, score: 0 });
        continue;
      }
      const byTitle = fuzzyScore(q, displayTitle(note));
      const byPath = fuzzyScore(q, note.id);
      const score = Math.max(byTitle ?? -1, (byPath ?? -1) * 0.8);
      if (score >= 0) scored.push({ note, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.note.updated_at.localeCompare(b.note.updated_at) * -1
    );
    return scored.slice(0, 12).map((s) => s.note);
  });

  $effect(() => {
    field?.focus();
  });

  $effect(() => {
    void query;
    active = 0;
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, results.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = results[active];
      if (pick) onPick(pick);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="backdrop"
  data-testid="notey-switcher"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="panel" role="dialog" aria-label="Go to note">
    <input
      bind:this={field}
      bind:value={query}
      onkeydown={onKeydown}
      type="text"
      placeholder="Go to note…"
      aria-label="Go to note"
      data-testid="notey-switcher-input"
    />
    <ul class="results">
      {#each results as note, i (note.id)}
        <li>
          <button class="result" class:active={i === active} data-testid="notey-switcher-result" onclick={() => onPick(note)}>
            <span class="result-title">{displayTitle(note)}</span>
            {#if note.parent_id}<span class="result-path">{note.parent_id}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="none">Nothing matches.</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim-color);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 70;
  }

  .panel {
    width: min(34rem, 92vw);
    background: var(--surface-raised-color);
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .panel input {
    width: 100%;
    font-size: var(--font-size-lg);
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }

  .result {
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    font-family: var(--font-body);
    color: var(--text-color);
    border-radius: var(--radius-sm);
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .result.active,
  .result:hover {
    background: var(--color-primary-soft);
  }

  .result-path {
    color: var(--text-muted-color);
    font-size: var(--font-size-eyebrow);
  }

  .none {
    padding: var(--space-3);
    color: var(--text-muted-color);
  }
</style>
