<script lang="ts">
  /**
   * Ctrl+K — the whole control surface.
   *
   * notey has no sidebar and no toolbar of its own: the page is the page,
   * and every navigation and command runs through here. The palette is a
   * stack of VIEWS, not a menu that closes on every press — picking
   * "View notebooks" stays open and shows the notebooks, because browsing
   * is a thing you do several steps of. Only an action that puts you on a
   * page (open a note, create one, print) closes it.
   *
   * Views: root (commands + matching notes), notebooks, one notebook,
   * the pile, this note's links, and the small inline editors (name a
   * notebook, tag a selection, move a selection).
   */
  import SettingsPanel from './SettingsPanel.svelte';
  import { fuzzyScore } from '../lib/fuzzy';
  import { displayTitle } from '../lib/notebook/model';
  import { backlinks, findWikiLinks, resolveNote } from '../lib/notebook/wiki';
  import { parseQuery, searchNotes } from '../lib/vault/search';
  import { nameOf } from '../lib/vault/model';
  import type { FolderEntry, Note } from '../lib/vault/types';

  type View =
    | 'root'
    | 'notebooks'
    | 'notebook'
    | 'pile'
    | 'links'
    | 'new-notebook'
    | 'tag'
    | 'move'
    | 'settings';

  let {
    notes,
    folders,
    current,
    scratchOpen,
    scratchDirty,
    onOpenNote,
    onCreateNote,
    onCreateNotebook,
    onRenameFolder,
    onDeleteFolder,
    onBlank,
    onFileScratch,
    onNoteAction,
    onBulk,
    onClose,
  }: {
    notes: readonly Note[];
    folders: readonly FolderEntry[];
    current: Note | null;
    scratchOpen: boolean;
    scratchDirty: boolean;
    onOpenNote: (note: Note) => void;
    onCreateNote: (folder: string | null, title?: string) => void;
    onCreateNotebook: (name: string, parent: string | null) => Promise<void>;
    onRenameFolder: (folder: FolderEntry, name: string) => Promise<void>;
    onDeleteFolder: (folder: FolderEntry) => Promise<void>;
    onBlank: () => void;
    onFileScratch: (folder: string | null) => void;
    onNoteAction: (action: 'md' | 'html' | 'print' | 'close' | 'delete') => void;
    onBulk: (
      action: 'export-md' | 'export-html' | 'tag-add' | 'tag-remove' | 'move' | 'delete',
      paths: string[],
      argument?: string
    ) => Promise<string>;
    onClose: () => void;
  } = $props();

  let view = $state<View>('root');
  /** Which notebook the 'notebook' view is showing. */
  let openFolder = $state<string | null>(null);
  /** What a 'new-notebook' will be created inside. */
  let newParent = $state<string | null>(null);
  /** The folder being renamed, when the name editor is a rename. */
  let renaming = $state<FolderEntry | null>(null);
  let query = $state('');
  let active = $state(0);
  let selected = $state<ReadonlySet<string>>(new Set());
  let receipt = $state<string | null>(null);
  let busy = $state(false);
  let field = $state<HTMLInputElement | undefined>();
  let panelEl = $state<HTMLDivElement | undefined>();
  let listEl = $state<HTMLUListElement | undefined>();

  interface Item {
    id: string;
    label: string;
    hint?: string;
    /** Rows that can join a selection (notes only). */
    path?: string;
    /**
     * A `header` is a section label, not a target: it renders differently,
     * arrow keys step over it, and Enter can never land on it.
     */
    kind?: 'header';
    run: () => void;
  }

  const header = (id: string, label: string): Item => ({
    id: 'hdr:' + id,
    label,
    kind: 'header',
    run: () => {},
  });

  const close = (): void => onClose();

  function go(next: View, opts: { folder?: string | null; parent?: string | null } = {}): void {
    view = next;
    if (opts.folder !== undefined) openFolder = opts.folder;
    if (opts.parent !== undefined) newParent = opts.parent;
    query = '';
    active = 0;
    receipt = null;
    if (field) field.focus();
    else panelEl?.focus();
  }

  /* ── the rows for each view ────────────────────────────────────────── */

  const notesIn = (folder: string | null): Note[] =>
    notes
      .filter((n) => n.parent_id === folder)
      .sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));

  const foldersIn = (parent: string | null): FolderEntry[] =>
    folders.filter((f) => f.parent_id === parent).sort((a, b) => a.title.localeCompare(b.title));

  function noteItem(note: Note): Item {
    return {
      id: 'note:' + note.id,
      label: displayTitle(note),
      hint: note.parent_id ?? 'the Pile',
      path: note.id,
      run: () => {
        onOpenNote(note);
        close();
      },
    };
  }

  function folderItem(folder: FolderEntry): Item {
    const count = notes.filter((n) => n.id.startsWith(folder.id + '/')).length;
    return {
      id: 'folder:' + folder.id,
      label: folder.title,
      hint: `${count} note${count === 1 ? '' : 's'}`,
      run: () => go('notebook', { folder: folder.id }),
    };
  }

  /** The root command list, before filtering. */
  const commands = $derived.by<Item[]>(() => {
    const list: Item[] = [
      {
        id: 'cmd:new-note',
        label: 'New note',
        hint: 'in the Pile',
        run: () => {
          onCreateNote(null);
          close();
        },
      },
      {
        id: 'cmd:new-notebook',
        label: 'New notebook…',
        run: () => {
          renaming = null;
          go('new-notebook', { parent: null });
        },
      },
      { id: 'cmd:notebooks', label: 'View notebooks', hint: `${folders.length}`, run: () => go('notebooks') },
      {
        id: 'cmd:pile',
        label: 'View the Pile',
        hint: `${notesIn(null).length}`,
        run: () => go('pile'),
      },
      {
        id: 'cmd:blank',
        label: 'Blank page',
        hint: 'unfiled',
        run: () => {
          onBlank();
          close();
        },
      },
    ];
    if (scratchOpen && scratchDirty) {
      list.push({
        id: 'cmd:file',
        label: 'File this note in the Pile',
        run: () => {
          onFileScratch(null);
          close();
        },
      });
      for (const folder of folders) {
        list.push({
          id: 'cmd:file:' + folder.id,
          label: `File this note in ${folder.title}`,
          hint: folder.id,
          run: () => {
            onFileScratch(folder.id);
            close();
          },
        });
      }
    }
    if (current) {
      list.push(
        { id: 'cmd:links', label: 'Links to and from this note', run: () => go('links') },
        {
          id: 'cmd:md',
          label: 'Export as Markdown',
          run: () => {
            onNoteAction('md');
            close();
          },
        },
        {
          id: 'cmd:html',
          label: 'Export as HTML',
          hint: 'one self-contained file',
          run: () => {
            onNoteAction('html');
            close();
          },
        },
        {
          id: 'cmd:print',
          label: 'Print / Save as PDF',
          run: () => {
            onNoteAction('print');
            close();
          },
        },
        {
          id: 'cmd:close',
          label: 'Close this note',
          run: () => {
            onNoteAction('close');
            close();
          },
        },
        {
          id: 'cmd:delete',
          label: 'Delete this note',
          run: () => {
            onNoteAction('delete');
            close();
          },
        }
      );
    }
    list.push({
      id: 'cmd:settings',
      label: 'Settings',
      hint: 'paper, desk, pen',
      run: () => go('settings'),
    });
    return list;
  });

  /** Every row the current view offers, already filtered by the query. */
  const items = $derived.by<Item[]>(() => {
    const q = query.trim();
    if (view === 'root') {
      const scored = commands
        .map((item) => ({ item, score: q === '' ? 0 : (fuzzyScore(q, item.label) ?? -1) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score);
      const hits =
        q === ''
          ? notes
              .slice()
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .slice(0, 5)
          : searchNotes(notes, parseQuery(q))
              .slice(0, 8)
              .map((hit) => hit.note);
      // Two lists in one, so label them — a note and a command look alike
      // at a glance, and the difference decides what Enter will do.
      const rows: Item[] = [];
      if (scored.length > 0) {
        rows.push(header('commands', 'Commands'), ...scored.map((entry) => entry.item));
      }
      if (hits.length > 0) {
        rows.push(header('notes', q === '' ? 'Recent notes' : 'Notes'), ...hits.map(noteItem));
      }
      return rows;
    }

    const match = (label: string): boolean => q === '' || (fuzzyScore(q, label) ?? -1) >= 0;

    if (view === 'notebooks') {
      const rows: Item[] = foldersIn(null).filter((f) => match(f.title)).map(folderItem);
      if (q === '') {
        rows.push({
          id: 'act:new-notebook',
          label: '+ New notebook…',
          run: () => {
            renaming = null;
            go('new-notebook', { parent: null });
          },
        });
      }
      return rows;
    }

    if (view === 'notebook' && openFolder) {
      const rows: Item[] = [
        ...foldersIn(openFolder).filter((f) => match(f.title)).map(folderItem),
        ...notesIn(openFolder).filter((n) => match(displayTitle(n))).map(noteItem),
      ];
      if (q === '') {
        const folder = folders.find((f) => f.id === openFolder);
        rows.push(
          {
            id: 'act:new-note',
            label: '+ New note here',
            run: () => {
              onCreateNote(openFolder);
              close();
            },
          },
          {
            id: 'act:new-sub',
            label: '+ New folder inside',
            run: () => {
              renaming = null;
              go('new-notebook', { parent: openFolder });
            },
          }
        );
        if (folder) {
          rows.push(
            {
              id: 'act:rename',
              label: 'Rename this notebook…',
              run: () => {
                renaming = folder;
                go('new-notebook', { parent: folder.parent_id });
              },
            },
            {
              id: 'act:delete-folder',
              label: 'Delete this notebook',
              hint: 'notes inside move up',
              run: () => {
                void onDeleteFolder(folder).then(() => go('notebooks'));
              },
            }
          );
        }
      }
      return rows;
    }

    if (view === 'pile') {
      const rows: Item[] = notesIn(null).filter((n) => match(displayTitle(n))).map(noteItem);
      if (q === '') {
        rows.push({
          id: 'act:new-note',
          label: '+ New note in the Pile',
          run: () => {
            onCreateNote(null);
            close();
          },
        });
      }
      return rows;
    }

    if (view === 'links' && current) {
      const rows: Item[] = [];
      for (const back of backlinks(notes, current)) {
        rows.push({
          id: 'in:' + back.note.id,
          label: displayTitle(back.note),
          hint: back.count > 1 ? `links here ×${back.count}` : 'links here',
          run: () => {
            onOpenNote(back.note);
            close();
          },
        });
      }
      const seen = new Set<string>();
      for (const link of findWikiLinks(current.body_md)) {
        const key = link.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const target = resolveNote(notes, link.title);
        rows.push({
          id: 'out:' + link.title,
          label: link.title,
          hint: target ? 'linked from here' : 'not a note yet — create it',
          run: () => {
            // A link to a note that does not exist yet creates it UNDER THAT
            // NAME, beside the note that links to it — otherwise the link
            // it was created from would still be dangling.
            if (target) onOpenNote(target);
            else onCreateNote(current.parent_id, link.title);
            close();
          },
        });
      }
      return rows.filter((row) => match(row.label));
    }

    return [];
  });

  /** The rows a keypress can land on — everything but the headings. */
  const targets = $derived(items.filter((item) => item.kind !== 'header'));
  const selectable = $derived(items.filter((item) => item.path !== undefined));
  const canSelect = $derived(view === 'pile' || view === 'notebook');
  const moveTargets = $derived(
    folders.filter((f) => ![...selected].some((p) => f.id === p || f.id.startsWith(p + '/')))
  );

  const title = $derived.by(() => {
    if (view === 'notebooks') return 'Notebooks';
    if (view === 'notebook') return openFolder ?? 'Notebook';
    if (view === 'pile') return 'The Pile';
    if (view === 'links') return `Links · ${current ? displayTitle(current) : ''}`;
    if (view === 'new-notebook') return renaming ? `Rename ${renaming.title}` : 'Name the notebook';
    if (view === 'tag') return `Tag ${selected.size} note${selected.size === 1 ? '' : 's'}`;
    if (view === 'move') return `Move ${selected.size} note${selected.size === 1 ? '' : 's'}`;
    if (view === 'settings') return 'Settings';
    return null;
  });

  $effect(() => {
    void view;
    if (field) field.focus();
    else panelEl?.focus();
  });

  $effect(() => {
    void query;
    void view;
    active = 0;
  });

  // Keep the highlighted row on screen when arrowing through a long list.
  $effect(() => {
    void active;
    listEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  });

  function back(): void {
    if (view === 'notebook') go('notebooks');
    else if (view === 'root') close();
    else go('root');
  }

  function toggleSelected(path: string): void {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selected = next;
  }

  async function runBulk(
    action: 'export-md' | 'export-html' | 'tag-add' | 'tag-remove' | 'move' | 'delete',
    argument?: string
  ): Promise<void> {
    if (selected.size === 0 || busy) return;
    busy = true;
    try {
      const said = await onBulk(action, [...selected], argument);
      if (action === 'delete' || action === 'move') selected = new Set();
      if (view === 'tag' || view === 'move') {
        // Back to the list this started from — through go(), so the tag
        // text or destination filter does not stay on as a search and
        // hide every row.
        go(openFolder ? 'notebook' : 'pile');
      }
      receipt = said;
    } finally {
      busy = false;
    }
  }

  async function commitName(): Promise<void> {
    const name = query.trim();
    if (!name || busy) return;
    busy = true;
    try {
      if (renaming) {
        await onRenameFolder(renaming, name);
        const wasParent = renaming.parent_id;
        renaming = null;
        go('notebooks', { folder: wasParent });
      } else {
        await onCreateNotebook(name, newParent);
        go(newParent ? 'notebook' : 'notebooks', { folder: newParent });
      }
    } finally {
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (view === 'settings') {
      // A form, not a list: leave every other key to the controls.
      if (event.key === 'Escape') {
        event.preventDefault();
        back();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      back();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, targets.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (view === 'new-notebook') void commitName();
      else if (view === 'tag') void runBulk(event.shiftKey ? 'tag-remove' : 'tag-add', query.trim());
      else targets[active]?.run();
    } else if (event.key === 'Backspace' && query === '' && view !== 'root') {
      event.preventDefault();
      back();
    } else if (event.key === ' ' && canSelect && event.ctrlKey) {
      // Ctrl+Space ticks the highlighted row without leaving the keyboard.
      const path = targets[active]?.path;
      if (path) {
        event.preventDefault();
        toggleSelected(path);
      }
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class="backdrop"
  data-testid="notey-palette"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="panel"
    role="dialog"
    aria-label="Commands"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={onKeydown}
  >
    {#if title}
      <div class="crumb">
        <button class="crumb-back" onclick={back} aria-label="Back">‹</button>
        <span class="eyebrow">{title}</span>
      </div>
    {/if}

    {#if view !== 'settings'}
    <input
      bind:this={field}
      bind:value={query}
      type="text"
      autocomplete="off"
      spellcheck="false"
      aria-label={view === 'new-notebook' ? 'Notebook name' : 'Command or note'}
      placeholder={view === 'new-notebook'
        ? 'Notebook name, then Enter'
        : view === 'tag'
          ? 'tags, comma-separated · Enter adds, Shift+Enter removes'
          : view === 'root'
            ? 'Type a command, or search your notes…'
            : 'Filter…'}
      data-testid="notey-palette-input"
    />
    {/if}

    {#if view === 'move'}
      <ul class="results" bind:this={listEl}>
        <li>
          <button class="row" data-testid="notey-palette-move-target" onclick={() => void runBulk('move', '')}>
            <span class="row-label">— the Pile —</span>
          </button>
        </li>
        {#each moveTargets as target (target.id)}
          <li>
            <button class="row" data-testid="notey-palette-move-target" onclick={() => void runBulk('move', target.id)}>
              <span class="row-label">{target.id}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if view === 'new-notebook' || view === 'tag'}
      <p class="hint muted">
        {view === 'new-notebook'
          ? 'Enter creates it. Escape goes back.'
          : 'Enter adds the tags to the ticked notes; Shift+Enter removes them.'}
      </p>
    {:else if view === 'settings'}
      <SettingsPanel />
    {:else}
      <ul class="results" bind:this={listEl}>
        {#each items as item (item.id)}
          {#if item.kind === 'header'}
            <li class="section" aria-hidden="true">{item.label}</li>
          {:else}
            {@const i = targets.indexOf(item)}
            <li class="result-row">
            {#if canSelect && item.path}
              <input
                type="checkbox"
                class="tick"
                aria-label={`Select ${item.label}`}
                data-testid="notey-palette-tick"
                data-title={item.label}
                checked={selected.has(item.path)}
                onchange={() => item.path && toggleSelected(item.path)}
              />
            {/if}
            <button
              class="row"
              class:active={i === active}
              data-active={i === active}
              data-testid="notey-palette-item"
              data-label={item.label}
              onmouseenter={() => (active = i)}
              onclick={item.run}
            >
              <span class="row-label">{item.label}</span>
              {#if item.hint}<span class="row-hint">{item.hint}</span>{/if}
            </button>
            </li>
          {/if}
        {:else}
          <li class="none muted" data-testid="notey-palette-empty">Nothing here.</li>
        {/each}
      </ul>
    {/if}

    {#if canSelect && selected.size > 0}
      <div class="bulk" data-testid="notey-palette-bulk">
        <span class="eyebrow">{selected.size} ticked</span>
        <button class="btn btn-sm" disabled={busy} data-testid="notey-palette-export-md" onclick={() => void runBulk('export-md')}>.md zip</button>
        <button class="btn btn-sm" disabled={busy} data-testid="notey-palette-export-html" onclick={() => void runBulk('export-html')}>.html zip</button>
        <button class="btn btn-sm" disabled={busy} data-testid="notey-palette-tag" onclick={() => go('tag')}>Tag</button>
        <button class="btn btn-sm" disabled={busy} data-testid="notey-palette-move" onclick={() => go('move')}>Move</button>
        <button class="btn btn-sm btn-danger" disabled={busy} data-testid="notey-palette-delete" onclick={() => void runBulk('delete')}>Delete</button>
        <button class="btn btn-sm" disabled={busy} onclick={() => (selected = new Set())}>Clear</button>
      </div>
    {/if}

    {#if selectable.length > 0 && selected.size === 0 && canSelect}
      <p class="hint muted">Tick a row (or Ctrl+Space) to act on several at once.</p>
    {/if}

    {#if receipt}
      <p class="receipt" role="status" data-testid="notey-palette-receipt">{receipt}</p>
    {/if}
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
    padding-top: 10vh;
    z-index: 80;
  }

  .panel {
    width: min(38rem, 94vw);
    max-height: 76vh;
    background: var(--surface-raised-color);
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-2);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .crumb-back {
    border: 0;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: var(--font-size-lg);
    line-height: 1;
    padding: 0 var(--space-1);
  }

  .crumb-back:hover {
    color: var(--color-stamp);
  }

  .panel input[type='text'] {
    width: 100%;
    font-size: var(--font-size-lg);
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
  }

  .result-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .tick {
    accent-color: var(--color-primary);
    flex: none;
  }

  .row {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: 0;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    color: var(--text-color);
    border-radius: var(--radius-sm);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
  }

  .row.active {
    background: var(--color-primary-soft);
  }

  .row-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-hint {
    color: var(--text-muted-color);
    font-size: var(--font-size-eyebrow);
    flex: none;
  }

  .section {
    padding: var(--space-3) var(--space-3) var(--space-1);
    font-size: var(--font-size-eyebrow);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
    font-weight: 700;
    color: var(--text-muted-color);
    border-bottom: 1px solid var(--border-color);
    margin-bottom: var(--space-1);
  }

  .results > .section:first-child {
    padding-top: var(--space-1);
  }

  .none,
  .hint {
    padding: var(--space-2) var(--space-3);
    font-size: var(--font-size-eyebrow);
  }

  .bulk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    border-top: 1px dashed var(--border-strong-color);
    padding-top: var(--space-2);
  }

  .receipt {
    font-size: var(--font-size-sm);
    color: var(--color-success);
  }
</style>
