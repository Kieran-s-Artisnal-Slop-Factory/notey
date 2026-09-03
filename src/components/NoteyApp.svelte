<script lang="ts">
  /**
   * The app: a page, and a book you can open.
   *
   * There is no sidebar and no toolbar. notey opens on a blank, unfiled
   * page — a title and a sheet — and everything else (notebooks, the
   * Pile, exports, deletes, settings) lives behind Ctrl+K, or behind the
   * book in the corner, which is the same palette opened on the library.
   *
   * Invariants carried over from useful's notebook:
   *  - The markdown string is the single source of truth; the editor is a
   *    view. Autosave = 400 ms after the last change; flush on pagehide,
   *    visibility-hidden, note switch, unmount, and before bulk/exports.
   *  - Page load writes nothing (an unresolved ?note= deep link offers a
   *    Create button, it never creates).
   *  - Backlinks are computed, never stored.
   *  - Rename pushes the old title into aliases; rewriting other notes'
   *    [[links]] is one explicit button, offered with a count.
   *  - Deleting a folder moves its notes up, never cascades.
   *  - Editor changes carry the note path they were mounted with; a late
   *    flush after switching writes to that path, never the open snapshot.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import MarkdownEditor from './notebook/MarkdownEditor.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { href } from '../lib/paths';
  import { downloadBlob, downloadText } from '../lib/exportFile';
  import { zipBlob, type ZipEntry } from '../lib/zip';
  import { renderMarkdown } from '../lib/markdown';
  import { renderMathIn } from '../lib/notebook/math';
  import { getMermaid, renderInto } from '../lib/notebook/mermaid';
  import { collectMathFonts } from '../lib/notebook/mathFonts';
  import { externalReferences, htmlExport, markdownExport, printDocument } from '../lib/notebook/export';
  import { addTags, exportFileName, removeTags } from '../lib/notebook/bulk';
  import { displayTitle, parseTags } from '../lib/notebook/model';
  import { backlinks, findWikiLinks, resolveNote, rewriteWikiLinks } from '../lib/notebook/wiki';
  import { parseNoteContent } from '../lib/vault/frontmatter';
  import { fromFields, switchKind, toFields, type FieldKind, type FmField } from '../lib/vault/fmFields';
  import {
    assetRefsIn,
    isAssetPath,
    nameOf,
    noteContentOf,
    parentOf,
    sanitizeTitle,
    stemOf,
    toFolder,
    toNote,
    uniqueFolderPath,
    uniqueNotePath,
  } from '../lib/vault/model';
  import { noteAssetStore, type NoteAssetStore } from '../lib/vault/assetStore';
  import { describeDrop, dropIntoVault, isMarkdownFile } from '../lib/vault/transfer';
  import { rootLabel } from '../lib/vault/desktopPaths';
  import { onVaultChange, openVaultStore, remountVault } from '../lib/vault/store';
  import { isTauri } from '../lib/vault/tauriStore';
  import DesktopWelcome from './DesktopWelcome.svelte';
  import type { Change } from '../lib/vault/tabs';
  import {
    holdLock,
    holdNote,
    notesHeldElsewhere,
    platformLocks,
    queueForNote,
    SCRATCH_LOCK,
    VAULT_MUTATE_LOCK,
    type NoteHold,
  } from '../lib/vault/noteLocks';
  import MarkdownPreview from './notebook/MarkdownPreview.svelte';
  import type { FolderEntry, Note, VaultStore } from '../lib/vault/types';
  import {
    loadPrefs,
    loadScratch,
    savePrefs,
    saveScratch,
    type EditorMode,
    type ScratchScope,
  } from '../lib/prefs';

  /*
   * Long enough that ordinary typing is one write rather than twenty. The
   * editor's own debounce (150 ms) sits in front of this, and a flush on
   * blur, switch, export or pagehide means nothing waits on the timer to
   * be safe.
   */
  const SAVE_DEBOUNCE_MS = 1500;
  /** A save that failed (the tab holding the vault was slow, say) tries again by itself. */
  const SAVE_RETRY_MS = 5000;

  /*
   * Read once, at script init. This island is client:only, so localStorage
   * is there — and it MUST be read here rather than in onMount, because
   * MarkdownEditor is created during this component's first render and
   * takes `mode` and `value` as initial values only. Setting them in
   * onMount is too late: the editor is already mounted in the wrong face
   * with an empty document.
   */
  const bootPrefs = loadPrefs();
  const bootScratch = loadScratch();

  /* ── vault + model ─────────────────────────────────────────────────── */
  let store: VaultStore | null = null;
  let booted = $state(false);
  let bootError = $state<string | null>(null);
  let folders = $state<FolderEntry[]>([]);
  let notes = $state<Note[]>([]);
  /** Original frontmatter maps, path → data, for order-preserving saves. */
  const fmData = new Map<string, Record<string, unknown>>();

  /* ── the open page ─────────────────────────────────────────────────── */
  let currentPath = $state<string | null>(null);
  /** True while the page is the unfiled blank one. */
  let scratchOpen = $state(true);
  let title = $state(bootScratch.title);
  let body = $state(bootScratch.body);
  let tagsText = $state('');
  let aliases = $state<string[]>([]);
  let parentId = $state<string | null>(null);
  let extraRows = $state<FmField[]>([]);
  /** Fields whose YAML will not parse; their old value is kept meanwhile. */
  let invalidFields = $state<string[]>([]);
  /** Aliases are edited as a field, comma-separated, like tags. */
  let aliasesText = $state('');
  let createdAt = $state<string | null>(null);
  let updatedAt = $state('');
  let savedTitle = $state('');
  let renameOffer = $state<{ from: string; to: string; count: number } | null>(null);
  let assetStore = $state<NoteAssetStore | null>(null);
  let assetCount = $state(0);
  let assetBytes = $state(0);

  /* ── chrome (what little there is) ─────────────────────────────────── */
  let mode = $state<EditorMode>(bootPrefs.mode);
  let paletteOpen = $state(false);
  /** Which view the palette should open on, when it is not the root. */
  let paletteAt = $state<string | null>(null);

  /** Open the library straight onto one notebook — what a crumb does. */
  function openPaletteAt(folder: string): void {
    paletteAt = folder;
    paletteOpen = true;
  }
  let feedback = $state<string | null>(null);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let missingLink = $state<string | null>(null);
  /* ── one writer per page ───────────────────────────────────────────── */
  const locks = platformLocks();
  /** The lock on whatever page is open: a note, or the blank page. */
  let hold: NoteHold | null = null;
  /**
   * Another tab is writing the open note. This page shows it read-only,
   * follows that tab's saves, and is promoted the moment it lets go — if
   * this tab is visible; a tab you are not looking at never takes a note
   * from one you are.
   */
  let lockedElsewhere = $state(false);
  /** Notes other tabs have open right now, for the palette's hints. */
  let heldPaths = $state<ReadonlySet<string>>(new Set());
  /** Where the blank page's text lives: shared with every tab, or this tab's own. */
  let scratchScope: ScratchScope = 'shared';
  /**
   * Set while this tab is in the middle of its own multi-step change, so
   * the change feed does not "follow" a rename this tab is doing itself.
   */
  let selfMutating = false;
  /** The open note was deleted in another tab; the next save files it again. */
  let detached = $state(false);
  /**
   * The whole vault was replaced from a database file (in this tab or
   * another). Everything on screen belongs to a vault that is gone, so the
   * page starts again — and must NOT write first: this page's note would
   * land in someone else's vault.
   */
  let vaultReplaced = $state(false);
  /**
   * A file is being dragged over the page. Counted rather than set,
   * because dragenter/dragleave fire for every element the pointer
   * crosses — a plain boolean flickers off the moment the cursor moves
   * from the desk onto the sheet.
   */
  let dragDepth = $state(0);
  const dragging = $derived(dragDepth > 0);

  /* ── the desktop's folder ──────────────────────────────────────────── */
  /** True in the Tauri build, which has a real folder and real files. */
  const desktop = isTauri();
  /** The folder the vault is mounted on; shown by the welcome. */
  let vaultFolder = $state('');
  /** Shown once, until a folder has been chosen deliberately. */
  let welcomeOpen = $state(false);
  /** Saves run one after another, never overlapping. */
  let saveChain: Promise<void> = Promise.resolve();
  /** Writes still landing for a page whose lock is about to be let go. */
  const lateWrites = new Map<string, Promise<unknown>>();
  /** Holds on their way out: let go of, but a last write may still be landing. */
  const retiring = new Set<NoteHold>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when the read-only view should re-render what it shows. */
  let previewNonce = $state(0);
  let exportNote = $state<string | null>(null);
  let printHtml = $state('');
  let editor = $state<MarkdownEditor | undefined>();
  let titleField = $state<HTMLInputElement | undefined>();
  let switching = $state(false);
  let destroyed = false;
  /*
   * The editor is keyed on this, not on the note's path: a rename CHANGES
   * the path, and keying on it would tear the editor down and build it
   * again in the middle of typing — losing the undo history and the caret
   * every time the title is edited. It changes only when a different
   * document is opened.
   */
  let editorKey = $state(0);
  /*
   * Which document the mounted editor belongs to. Plain variables, not
   * state: they are read by onChange, including the flush that fires while
   * the old editor is being destroyed, and they are always updated after
   * that flush (openNote awaits flushSave before touching them).
   */
  let mountPath: string | null = null;
  let mountIsScratch = true;
  /*
   * Notes created in this session that have never been deliberately named.
   * Renaming one is not a rename — it is the first naming — so it must not
   * leave an alias behind, or every note that started life as `Untitled`
   * answers to `Untitled` forever and clutters every [[link]] search.
   */
  const unnamed = new Set<string>();

  /* ── autosave ──────────────────────────────────────────────────────── */
  let saveState = $state<'saved' | 'saving' | 'error' | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  /* ── derived ───────────────────────────────────────────────────────── */
  const current = $derived(notes.find((n) => n.id === currentPath) ?? null);
  const folderOptions = $derived(
    [...folders].sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()))
  );
  const fileStem = $derived((title.trim() || 'note').replace(/[^a-z0-9._-]+/gi, '-'));
  const scratchDirty = $derived(scratchOpen && (title.trim() !== '' || body.trim() !== ''));
  const breadcrumb = $derived(
    currentPath && parentId ? parentId.split('/') : ([] as string[])
  );

  /* ── wiki plumbing ─────────────────────────────────────────────────── */
  const wikiHref = (t: string): string => href('/') + '?note=' + encodeURIComponent(t);
  const wikiExists = (t: string): boolean => resolveNote(notes, t) !== null;

  function navigateWiki(t: string): void {
    const found = resolveNote(notes, t);
    if (found) void openNote(found);
    else void createNote(t.trim() || 'Untitled', current ? current.parent_id : null);
  }

  function flash(message: string): void {
    feedback = message;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => (feedback = null), 4000);
  }

  /* ── boot ──────────────────────────────────────────────────────────── */
  async function refreshFromRows(): Promise<void> {
    if (!store) return;
    const rows = await store.loadAll();
    const nextFolders: FolderEntry[] = [];
    const nextNotes: Note[] = [];
    fmData.clear();
    for (const row of rows) {
      if (isAssetPath(row.path)) continue;
      if (row.kind === 'dir') nextFolders.push(toFolder(row.path));
      else if (row.kind === 'note') {
        nextNotes.push(toNote(row));
        fmData.set(row.path, parseNoteContent(row.content ?? '').data);
      }
    }
    folders = nextFolders;
    notes = nextNotes;
  }

  /** A refresh soon, coalescing a burst of changes, never mid-save. */
  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void saveChain.then(() => refreshFromRows()).then(() => refreshHeld());
    }, 250);
  }

  async function refreshHeld(): Promise<void> {
    heldPaths = await notesHeldElsewhere(locks, currentPath);
  }

  /*
   * ── the locks ──────────────────────────────────────────────────────
   * One tab writes a note at a time. The tab that has it open holds its
   * Web Lock; another tab opening the same note reads it and queues, and
   * is promoted when the first lets go. Everything below is the page's
   * side of that: taking a lock, keeping it across a rename, handing it
   * on only after the last write for that page has landed.
   */

  /** A hold on a page, wired so a late grant promotes this page. */
  function pageHold(path: string): NoteHold {
    const h: NoteHold = holdNote(path, locks, () => onPromoted(h));
    return h;
  }

  /** Take a page's lock. False when another tab has it (we are queued). */
  async function acquire(path: string): Promise<boolean> {
    const h = pageHold(path);
    const mine = await h.ready;
    if (currentPath !== path || destroyed) {
      void h.release(); // the page moved on while the answer was coming
      return mine;
    }
    // A second acquire for the same page (a visibility flip mid-open)
    // landed first: keep that one, or this tab queues behind its own lock.
    if (hold && hold !== h && hold.path === path && hold.status !== 'released') {
      void h.release();
      return hold.status === 'held';
    }
    hold = h;
    return mine;
  }

  /**
   * Let a page's lock go — once the last write for that page has landed.
   * Called right after `editorKey` changes, so the tick spans the DOM
   * update that destroys the old editor: its flush registers any write it
   * still owed (onBodyChange, lateWrites) before the wait below looks.
   */
  function retireHold(old: NoteHold): Promise<void> {
    retiring.add(old);
    return (async () => {
      try {
        await tick();
        const late = lateWrites.get(old.path);
        if (late) await late.catch(() => undefined);
        await old.release();
      } finally {
        retiring.delete(old);
      }
    })();
  }

  /** Whether this tab holds `path` right now — the open page, or one on its way out. */
  function holding(path: string): boolean {
    const is = (h: NoteHold | null): boolean =>
      h !== null && h.path === path && h.status === 'held';
    return is(hold) || [...retiring].some(is);
  }

  /**
   * The open page's path changed (a rename, a move, a folder rename):
   * hold the new path before letting the old one go, so there is never a
   * moment when the note is somewhere nobody holds. `taken` is a hold on
   * `to` the caller already has — a move this tab makes itself takes it
   * BEFORE the file is there. False, and nothing touched, when the page
   * moved on from `from` while the answer was coming.
   */
  async function relockOpen(from: string, to: string, taken?: NoteHold): Promise<boolean> {
    const next = taken ?? pageHold(to);
    const mine = await next.ready;
    if (currentPath !== from || destroyed) {
      void next.release();
      return false;
    }
    const old = hold;
    hold = next;
    lockedElsewhere = !mine;
    currentPath = to;
    if (mountPath === from) mountPath = to;
    savePrefs({ lastNote: to });
    if (old) void retireHold(old);
    return true;
  }

  /**
   * Move the open note as one step of a tree change this tab is making.
   * Its new path is held BEFORE the file is there — a tab reading the
   * note hears the rename first, and must find the new path taken rather
   * than free — then the page follows. Throws, having moved nothing, if
   * the new path is another tab's.
   */
  async function moveOpen(from: string, to: string, move: () => Promise<void>): Promise<void> {
    const next = pageHold(to);
    if (!(await next.ready)) {
      await next.release();
      throw new Error(`“${stemOf(nameOf(to))}” is open in another tab`);
    }
    try {
      await move();
    } catch (err) {
      void next.release();
      throw err;
    }
    if (await relockOpen(from, to, next)) parentId = parentOf(to);
  }

  /**
   * Another tab moved the open note; the page follows it. While that tab
   * is writing it, the new path is its lock to hold: this page never
   * TAKES a free one — it queues, as it was queued on the old path — and
   * stays read-only until its turn comes. A hidden page does not even
   * queue; resumeWaitingWhenVisible does when it is looked at again.
   */
  async function followRename(from: string, to: string): Promise<void> {
    if (!lockedElsewhere) {
      if (await relockOpen(from, to)) {
        parentId = parentOf(to);
        flash(`Moved in another tab: now ${to}.`);
      }
      return;
    }
    if (currentPath !== from || destroyed) return;
    const old = hold;
    hold = null;
    if (old) void old.release();
    currentPath = to;
    if (mountPath === from) mountPath = to;
    parentId = parentOf(to);
    savePrefs({ lastNote: to });
    if (document.visibilityState !== 'hidden') {
      const h: NoteHold = queueForNote(to, locks, () => onPromoted(h));
      hold = h;
    }
    flash(`Moved in another tab: now ${to}.`);
  }

  function onPromoted(h: NoteHold): void {
    if (hold === h) void promote();
  }

  /** A queued hold was granted: this page is the writer now. */
  async function promote(): Promise<void> {
    if (!hold || hold.status !== 'held' || !currentPath || !lockedElsewhere) return;
    await reloadOpenNote();
    lockedElsewhere = false;
    editorKey++;
    void refreshHeld();
    flash('The other tab has moved on; this page is yours to write.');
  }

  /** Re-read the open note from the vault — the other tab may have saved. */
  async function reloadOpenNote(): Promise<void> {
    if (!store || !currentPath) return;
    const path = currentPath;
    const row = await store.read(path);
    if (!row || row.kind !== 'note' || currentPath !== path) return;
    const note = toNote(row);
    fmData.set(path, parseNoteContent(row.content ?? '').data);
    title = note.title;
    savedTitle = note.title;
    body = note.body_md;
    tagsText = note.tags.join(', ');
    aliases = [...note.aliases];
    aliasesText = note.aliases.join(', ');
    extraRows = toFields(fmData.get(path) ?? {});
    createdAt = note.created_at;
    updatedAt = note.updated_at;
    previewNonce++;
  }

  /** A hidden tab never takes a note from the one you are looking at. */
  function stopWaitingWhileHidden(): void {
    if (lockedElsewhere && hold?.status === 'waiting') void hold.release();
  }

  function resumeWaitingWhenVisible(): void {
    // Mid-switch, openNote's own acquire is on its way; a second would race it.
    if (switching || !lockedElsewhere || !currentPath) return;
    if (hold && hold.status !== 'released') return;
    void acquire(currentPath).then((mine) => {
      if (mine) void promote();
    });
  }

  /** Run a multi-step change to the tree with no other tab's interleaved. */
  function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
    return locks ? locks.request(VAULT_MUTATE_LOCK, { mode: 'exclusive' }, () => fn()) : fn();
  }

  /**
   * Touch a note only while holding it. The open note is already ours;
   * any other is taken for the length of `fn` if it is free, and left
   * alone ("held") if another tab is writing it.
   */
  async function withNoteLock<T>(path: string, fn: () => Promise<T>): Promise<T | 'held'> {
    if (path === currentPath && !lockedElsewhere) return fn();
    const h = holdNote(path, locks);
    if (!(await h.ready)) {
      await h.release();
      return 'held';
    }
    try {
      return await fn();
    } finally {
      await h.release();
    }
  }

  /** Every note under a folder, held for an operation; null if any is open in another tab. */
  async function holdAllUnder(folder: string): Promise<NoteHold[] | null> {
    const holds: NoteHold[] = [];
    for (const n of notes.filter((n) => n.id.startsWith(folder + '/'))) {
      if (n.id === currentPath && !lockedElsewhere) continue; // ours already
      const h = holdNote(n.id, locks);
      if (!(await h.ready)) {
        await Promise.all([h, ...holds].map((x) => x.release()));
        return null;
      }
      holds.push(h);
    }
    return holds;
  }

  const leftAlone = (n: number): string =>
    n > 0 ? ` ${n} left alone: open in another tab.` : '';

  /**
   * The blank page is one page, shared by every tab through localStorage,
   * so it is locked like a note. A tab that cannot have it writes on a
   * fresh sheet of its own instead (sessionStorage: this tab, reloads
   * included, nothing else) and never touches the shared one. Nobody
   * queues for a blank page.
   */
  async function claimScratch(): Promise<void> {
    // A sheet of this tab's own with writing on it stays this tab's until
    // it is filed or emptied (fileScratch clears the sheet it filed): the
    // shared page coming free must not swap it out from under the words.
    const own = loadScratch('tab');
    if (own.title !== '' || own.body !== '') {
      scratchScope = 'tab';
      return;
    }
    const h = holdLock(SCRATCH_LOCK, locks);
    const mine = await h.ready;
    if (!scratchOpen || currentPath !== null) {
      void h.release();
      return;
    }
    if (mine) {
      hold = h;
      scratchScope = 'shared';
    } else {
      void h.release();
      scratchScope = 'tab';
    }
  }

  /**
   * The change feed. Most of it is "refresh the model soon"; the rest is
   * about the open page when ANOTHER tab moved, removed or saved it —
   * this tab's own changes arrive too, while `selfMutating` is set.
   */
  function onChanges(changes: Change[]): void {
    // A replaced vault is not a change to react to; it is a different
    // vault. Every tab starts again, whichever one did it — including the
    // tab that asked, once it has shown what happened.
    if (changes.some((change) => change.op === 'reload')) {
      vaultReplaced = true;
      clearTimeout(saveTimer);
      saveTimer = undefined;
      clearTimeout(refreshTimer);
      flash('The vault was replaced from a database file. Starting again…');
      setTimeout(() => location.reload(), 1500);
      return;
    }
    scheduleRefresh();
    if (selfMutating || !currentPath || scratchOpen) return;
    const open = currentPath;
    for (const change of changes) {
      const under = (p: string): boolean => open === p || open.startsWith(p + '/');
      if (change.op === 'rename' && change.to !== undefined && under(change.path)) {
        void followRename(open, change.to + open.slice(change.path.length));
        return;
      }
      if (change.op === 'remove' && under(change.path)) {
        detached = true;
        flash('This note was deleted in another tab. Keep writing and it is filed again.');
        return;
      }
      if ((change.op === 'write' || change.op === 'create') && change.path === open) {
        if (lockedElsewhere) void reloadOpenNote();
        else detached = false;
      }
    }
  }

  onMount(() => {
    // The page already IS the blank scratch (see bootScratch above); all
    // that is left is to open the vault and honour a deep link.
    void (async () => {
      try {
        // The blank page first — it is a page like any other, and this
        // tab may not be the one writing on it.
        await claimScratch();
        if (scratchScope === 'tab' && scratchOpen) {
          const own = loadScratch('tab');
          title = own.title;
          body = own.body;
          editorKey++;
        }
        store = await openVaultStore();
        await refreshFromRows();
        booted = true;
        // A deep link beats the startup preference; it is an explicit ask.
        const wanted = new URLSearchParams(location.search).get('note');
        if (wanted) {
          const found = resolveNote(notes, wanted);
          if (found) await openNote(found);
          else missingLink = wanted;
          return;
        }
        if (desktop) {
          const { isFirstRun, resolveDesktopVault, takePendingOpen } = await import(
            '../lib/vault/desktop'
          );
          vaultFolder = (await resolveDesktopVault()).root;
          // Say where the files are going before writing any.
          welcomeOpen = isFirstRun();
          const launch = takePendingOpen();
          if (launch) {
            await openLaunchFile(launch);
            return;
          }
        }
        if (bootPrefs.startup === 'blank') return; // already on the blank page
        const remembered = bootPrefs.lastNote
          ? notes.find((n) => n.id === bootPrefs.lastNote)
          : undefined;
        // The last note may be being written in another tab right now. A
        // fresh tab that lands read-only on it before you asked for
        // anything is a trap, so it stays blank; the palette says where
        // the note is.
        if (remembered && !(await notesHeldElsewhere(locks)).has(remembered.id)) {
          await openNote(remembered, { remember: false });
        }
      } catch (err) {
        bootError = String(err);
        booted = true;
      }
    })();

    // What the other tabs do to the vault, this one hears about.
    const stopWatching = onVaultChange((changes) => onChanges(changes));

    const onHide = (): void => void flushSave();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        void flushSave();
        stopWaitingWhileHidden();
      } else {
        resumeWaitingWhenVisible();
      }
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        paletteOpen = !paletteOpen;
      }
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKeydown);
    return () => {
      stopWatching();
      clearTimeout(refreshTimer);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKeydown);
    };
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(feedbackTimer);
    void flushSave();
    void hold?.release();
  });

  $effect(() => {
    if (paletteOpen) void refreshHeld();
  });

  /* ── open / close ──────────────────────────────────────────────────── */
  async function openNote(note: Note, opts: { remember?: boolean } = {}): Promise<void> {
    if (currentPath === note.id && !scratchOpen) return;
    await flushSave();
    // The page being left lets its lock go — after its last write lands.
    const previous = hold;
    hold = null;
    // Reopening the very page being left: let go first, or we queue behind ourselves.
    if (previous?.path === note.id) await retireHold(previous);
    const retire = previous && previous.path !== note.id ? previous : null;
    scratchOpen = false;
    switching = true;
    currentPath = note.id;
    mountPath = note.id;
    mountIsScratch = false;
    title = note.title;
    savedTitle = note.title;
    body = note.body_md;
    tagsText = note.tags.join(', ');
    aliases = [...note.aliases];
    parentId = note.parent_id;
    extraRows = toFields(fmData.get(note.id) ?? {});
    aliasesText = note.aliases.join(', ');
    invalidFields = [];
    createdAt = note.created_at;
    updatedAt = note.updated_at;
    renameOffer = null;
    exportNote = null;
    saveState = null;
    missingLink = null;
    titleDirty = false;
    detached = false;
    // Ours until the lock says otherwise: a read-only flag left over from
    // the last page would drop a save scheduled while the answer comes.
    // The editor mounts on the new document now rather than after, so a
    // lock that IS ours (the usual case) costs no second mount.
    lockedElsewhere = false;
    editorKey++;
    // After the key bump: the old editor's destroy flush lands in this DOM
    // update, and retireHold waits for the write it registers.
    if (retire) void retireHold(retire);
    try {
      if (!store) return;
      // One writer per note: take its lock, or read while another tab writes.
      const mine = await acquire(note.id);
      if (destroyed || currentPath !== note.id) return;
      if (!mine) lockedElsewhere = true;
      const assets = noteAssetStore(store, note.id);
      await assets.prime();
      if (destroyed || currentPath !== note.id) return;
      assetStore = assets;
      const stats = assets.stats();
      assetCount = stats.count;
      assetBytes = stats.bytes;
      previewNonce++;
      if (opts.remember !== false) savePrefs({ lastNote: note.id });
      void refreshHeld();
    } finally {
      switching = false;
    }
  }

  function openScratch(opts: { silent?: boolean } = {}): void {
    void (async () => {
      if (!opts.silent) await flushSave();
      const previous = hold;
      hold = null;
      // Already on the blank page: let its lock go first, or the claim
      // below finds this tab's own lock in the way and hands out a fresh sheet.
      if (previous?.path === SCRATCH_LOCK) await retireHold(previous);
      const retire = previous && previous.path !== SCRATCH_LOCK ? previous : null;
      currentPath = null;
      scratchOpen = true;
      lockedElsewhere = false;
      detached = false;
      try {
        await claimScratch();
        if (!scratchOpen || currentPath !== null) return; // moved on already
        const scratch = loadScratch(scratchScope);
        mountPath = null;
        mountIsScratch = true;
        editorKey++;
        title = scratch.title;
        savedTitle = '';
        body = scratch.body;
        tagsText = '';
        aliases = [];
        parentId = null;
        extraRows = [];
        aliasesText = '';
        invalidFields = [];
        createdAt = null;
        updatedAt = '';
        assetStore = null;
        assetCount = 0;
        assetBytes = 0;
        renameOffer = null;
        exportNote = null;
        saveState = null;
        void refreshHeld();
      } finally {
        // After the key bump (see openNote): the old editor's last write is
        // registered in this DOM update, and retireHold waits for it.
        if (retire) void retireHold(retire);
      }
    })();
  }

  async function closeNote(): Promise<void> {
    await flushSave();
    savePrefs({ lastNote: null });
    openScratch();
  }

  /* ── create ────────────────────────────────────────────────────────── */
  const allPaths = (): string[] => [...folders.map((f) => f.id), ...notes.map((n) => n.id)];

  /**
   * Make a new file at a free name. Two tabs can pick the same free name
   * from their own copies of the tree, so the vault refuses an existing
   * path and this picks again from a fresh read.
   */
  async function createFresh(
    folder: string | null,
    wanted: string,
    build: (path: string) => string
  ): Promise<string> {
    if (!store) throw new Error('the vault is not open');
    let path = uniqueNotePath(folder, wanted, allPaths());
    for (let attempt = 0; ; attempt++) {
      try {
        await store.create({ path, kind: 'note', content: build(path) });
        return path;
      } catch (err) {
        if (attempt >= 3 || !/exists/.test(String(err))) throw err;
        await refreshFromRows(); // another tab took that name first
        path = uniqueNotePath(folder, wanted, allPaths());
      }
    }
  }

  async function createNote(newTitle: string, folder: string | null): Promise<void> {
    if (!store) return;
    switching = true;
    try {
      const now = new Date().toISOString();
      const path = await createFresh(folder, newTitle, (p) =>
        noteContentOf({
          id: p,
          title: stemOf(nameOf(p)),
          body_md: '',
          aliases: [],
          tags: [],
          parent_id: folder,
          fm: {},
          created_at: now,
          updated_at: now,
        })
      );
      unnamed.add(path);
      await refreshFromRows();
      const created = notes.find((n) => n.id === path);
      if (created) await openNote(created);
      if (newTitle === 'Untitled') {
        await tick();
        titleField?.select();
      }
    } finally {
      switching = false;
    }
  }

  async function createNotebook(name: string, parent: string | null): Promise<void> {
    if (!store || !name.trim()) return;
    const path = uniqueFolderPath(parent, name.trim(), allPaths());
    await store.mkdir(path);
    await refreshFromRows();
    flash(`Notebook “${nameOf(path)}” created.`);
  }

  async function renameFolder(folder: FolderEntry, name: string): Promise<void> {
    if (!store || !name.trim() || name.trim() === folder.title) return;
    await flushSave();
    // Every note inside moves; none may be being written in another tab.
    const held = await holdAllUnder(folder.id);
    if (!held) {
      flash('A note in that notebook is open in another tab; close it there first.');
      return;
    }
    let failed: string | null = null;
    selfMutating = true;
    try {
      await withVaultLock(async () => {
        const to = uniqueFolderPath(folder.parent_id, name.trim(), allPaths().filter((p) => p !== folder.id));
        const rename = (): Promise<void> => store!.rename(folder.id, to);
        // The open note moves with it: its new path is held before the file is there.
        const open = currentPath;
        if (open?.startsWith(folder.id + '/')) await moveOpen(open, to + open.slice(folder.id.length), rename);
        else await rename();
      });
    } catch (err) {
      failed = String(err);
    } finally {
      selfMutating = false;
      await Promise.all(held.map((h) => h.release()));
    }
    await refreshFromRows();
    flash(failed ? 'Rename failed: ' + failed : 'Folder renamed. Wiki links resolve by note title, so they still work.');
  }

  /* ── file the blank page ───────────────────────────────────────────── */
  async function fileScratch(folder: string | null): Promise<void> {
    if (!store || !scratchOpen) return;
    editor?.flush();
    const text = body;
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const firstLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '')
      ?.slice(0, 60);
    const newTitle = title.trim() || heading || firstLine || 'Untitled';
    const now = new Date().toISOString();
    const path = await createFresh(folder, newTitle, (p) =>
      noteContentOf({
        id: p,
        title: stemOf(nameOf(p)),
        body_md: text,
        aliases: [],
        tags: parseTags(tagsText),
        parent_id: folder,
        fm: {},
        created_at: now,
        updated_at: now,
      })
    );
    saveScratch({ title: '', body: '' }, scratchScope);
    await refreshFromRows();
    scratchOpen = false;
    const created = notes.find((n) => n.id === path);
    if (created) await openNote(created);
    flash(folder ? `Filed in ${folder}.` : 'Filed in the Pile.');
  }

  /*
   * The title is the filename, so committing it renames a file and can
   * leave an alias behind. Doing that per keystroke turns every typo into
   * a rename and memorialises the misspellings; it commits on blur or
   * Enter instead (Escape puts back the saved one). A flush still writes
   * whatever is in the field, so nothing is lost by not blurring.
   */
  let titleDirty = $state(false);

  function onTitleInput(): void {
    titleDirty = true;
    if (scratchOpen) saveScratch({ title, body }, scratchScope);
  }

  function commitTitle(): void {
    if (!titleDirty) return;
    titleDirty = false;
    if (scratchOpen) {
      saveScratch({ title, body }, scratchScope);
      return;
    }
    // A commit is deliberate — leaving the field IS the decision — so it
    // writes now rather than waiting out the typing debounce.
    clearTimeout(saveTimer);
    saveTimer = undefined;
    saveState = 'saving';
    void doSave();
  }

  /* ── autosave ──────────────────────────────────────────────────────── */
  function scheduleSave(): void {
    if (scratchOpen) {
      saveScratch({ title, body }, scratchScope);
      return;
    }
    if (!currentPath) return;
    saveState = 'saving';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Everything the page owes the file, written — and landed. Every caller
   * is about to move on (another page, a folder rename, the tab closing),
   * and a save the timer already started is still on the chain: leaving
   * before it lands would let the note's lock go with the write still
   * travelling, and a tab promoted on it would read the row from before.
   */
  async function flushSave(): Promise<void> {
    // The vault these words belong to is gone (see `vaultReplaced`).
    if (vaultReplaced) return;
    editor?.flush();
    if (scratchOpen) {
      titleDirty = false;
      saveScratch({ title, body }, scratchScope);
      return;
    }
    // A title typed but not yet blurred still has to reach the file.
    const owed = (titleDirty && currentPath !== null) || saveTimer !== undefined;
    titleDirty = false;
    if (owed) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      void doSave();
    }
    await saveChain;
  }

  /** Saves never overlap: each waits for the one before it. */
  function doSave(): Promise<void> {
    const run = saveChain.then(() => saveNow()).catch(() => undefined);
    saveChain = run;
    return run;
  }

  async function saveNow(): Promise<void> {
    if (!store) return;
    // Another tab is writing this note; this page only reads it.
    if (lockedElsewhere) {
      saveState = null;
      return;
    }
    const id = currentPath;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!id) return;
    // No row means another tab deleted the note under us; what this page
    // holds is filed again at the same path.
    const row = notes.find((n) => n.id === id);
    const original = fmData.get(id) ?? {};

    const oldTitle = savedTitle.trim();
    const nextTitleRaw = title.trim() || 'Untitled';
    /*
     * A rename worth remembering is one where the OLD name was a name —
     * something another note might have linked to. A note that was still
     * `Untitled` (or `Untitled 2`, which is what the second one is called)
     * is being named for the first time, and leaves no alias behind.
     */
    const wasNamed =
      oldTitle !== '' && !/^untitled(\s+\d+)?$/i.test(oldTitle) && !unnamed.has(id);
    const renames = wasNamed && nextTitleRaw !== oldTitle;
    /*
     * Aliases are an ordinary frontmatter field you can edit, and a rename
     * pushes the old name onto it. Both paths meet here.
     */
    const typedAliases = parseTags(aliasesText);
    const nextAliases = (renames ? [...typedAliases, oldTitle] : typedAliases).filter(
      (a, i, all) =>
        a.toLowerCase() !== nextTitleRaw.toLowerCase() &&
        all.findIndex((b) => b.toLowerCase() === a.toLowerCase()) === i
    );

    const targetFolder = parentId;
    let targetPath = id;
    let nextBody = body;
    const folderChanged = row ? targetFolder !== row.parent_id : false;
    const titleChanged = sanitizeTitle(nextTitleRaw) !== stemOf(nameOf(id));
    /** The new path's lock, taken BEFORE the file moves there. */
    let nextHold: NoteHold | null = null;
    let retry = true;
    selfMutating = true;

    try {
      if (row && (folderChanged || titleChanged)) {
        await withVaultLock(async () => {
          // A path another tab has open is not free, whatever the tree says.
          const taken = new Set(allPaths().filter((p) => p !== id));
          for (const held of await notesHeldElsewhere(locks, id)) taken.add(held);
          targetPath = uniqueNotePath(targetFolder, nextTitleRaw, taken);
          if (targetPath === id) return;
          nextHold = holdNote(targetPath, locks);
          if (!(await nextHold.ready)) {
            retry = false;
            throw new Error(`“${stemOf(nameOf(targetPath))}” is open in another tab`);
          }
          if (folderChanged) nextBody = await moveNoteAssets(id, targetPath, nextBody);
          try {
            await store!.rename(id, targetPath);
          } catch (err) {
            // Already moved — an answer lost between tabs — is not a failure.
            const [there, here] = await Promise.all([store!.read(targetPath), store!.read(id)]);
            if (!(there && !here)) throw err;
          }
        });
      }

      const now = new Date().toISOString();
      const builtFm = fromFields(extraRows);
      invalidFields = builtFm.invalid;
      const note: Note = {
        id: targetPath,
        title: stemOf(nameOf(targetPath)),
        body_md: nextBody,
        aliases: nextAliases,
        tags: parseTags(tagsText),
        parent_id: targetFolder,
        fm: builtFm.data,
        created_at: createdAt ?? now,
        updated_at: now,
      };
      // Not without the lock. The page may have moved on while this save
      // waited its turn (its lock is let go once the chain has drained),
      // or the lock may still be being answered: a write from a tab that
      // does not hold the note is the one thing all of this exists to stop.
      if (currentPath !== id || destroyed) {
        if (nextHold) void (nextHold as NoteHold).release();
        return;
      }
      if (hold?.status !== 'held') {
        if (nextHold) void (nextHold as NoteHold).release();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void doSave(), SAVE_RETRY_MS);
        return;
      }
      const write = store.write({
        path: targetPath,
        kind: 'note',
        content: noteContentOf(note, original),
      });
      // Under both paths, so retireHold on either waits for it to land.
      lateWrites.set(id, write);
      lateWrites.set(targetPath, write);
      try {
        await write;
      } finally {
        for (const p of [id, targetPath]) if (lateWrites.get(p) === write) lateWrites.delete(p);
      }
      detached = false;
      await refreshFromRows();

      if (currentPath !== id) {
        // The user moved on; the write stands, and nobody holds the new path.
        if (nextHold) void (nextHold as NoteHold).release();
        return;
      }
      if (nextHold) {
        const old = hold;
        hold = nextHold;
        nextHold = null;
        if (old) void retireHold(old);
      }
      currentPath = targetPath;
      // The same editor is still mounted; it now belongs to the new path.
      if (mountPath === id) mountPath = targetPath;
      body = nextBody;
      aliases = nextAliases;
      aliasesText = nextAliases.join(', ');
      savedTitle = nextTitleRaw;
      updatedAt = now;
      createdAt = note.created_at;
      saveState = 'saved';
      // It has a name of its own now, so the next rename is a real one.
      if (!/^untitled(\s+\d+)?$/i.test(nextTitleRaw)) {
        unnamed.delete(id);
        unnamed.delete(targetPath);
      } else if (unnamed.has(id)) {
        unnamed.add(targetPath);
      }
      savePrefs({ lastNote: targetPath });
      if (targetPath !== id && assetStore && store) {
        const assets = noteAssetStore(store, targetPath);
        await assets.prime();
        assetStore = assets;
      }
      if (renames) {
        const ghost: Note = { ...note, title: oldTitle, aliases: [] };
        const count = backlinks(notes, ghost).filter((b) => b.note.id !== targetPath).length;
        renameOffer = count > 0 ? { from: oldTitle, to: nextTitleRaw, count } : null;
      }
    } catch (err) {
      if (nextHold) void (nextHold as NoteHold).release();
      saveState = 'error';
      flash('Save failed: ' + String(err));
      // The words are still here; try again by itself in a moment.
      if (retry && currentPath === id) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void doSave(), SAVE_RETRY_MS);
      }
    } finally {
      selfMutating = false;
    }
  }

  /** A late editor flush after a switch: write to THAT note, not the open one. */
  function onBodyChange(md: string): void {
    const forPath = mountPath;
    const wasScratch = mountIsScratch;
    if (wasScratch) {
      if (scratchOpen) body = md;
      saveScratch({ title: scratchOpen ? title : '', body: md }, scratchScope);
      return;
    }
    if (forPath === currentPath) {
      body = md;
      scheduleSave();
      return;
    }
    void (async () => {
      if (!store || !forPath) return;
      // Only while the note is still there and still this tab's to write:
      // after a delete here the flush would file it again, and after the
      // lock was let go it would write behind whichever tab holds it now.
      const row = notes.find((n) => n.id === forPath);
      if (!row || !holding(forPath)) return;
      const patched: Note = { ...row, body_md: md, updated_at: new Date().toISOString() };
      // The old page's lock is let go only after this lands (retireHold).
      const write = store.write({
        path: forPath,
        kind: 'note',
        content: noteContentOf(patched, fmData.get(forPath) ?? {}),
      });
      lateWrites.set(forPath, write);
      try {
        await write;
      } finally {
        if (lateWrites.get(forPath) === write) lateWrites.delete(forPath);
      }
      await refreshFromRows();
    })();
  }

  /* ── asset moves (a note changed folder) ───────────────────────────── */
  async function moveNoteAssets(fromPath: string, toPath: string, md: string): Promise<string> {
    if (!store) return md;
    const fromFolder = parentOf(fromPath);
    const toFolder = parentOf(toPath);
    if (fromFolder === toFolder) return md;
    let out = md;
    const refs = assetRefsIn(md);
    if (refs.length === 0) return md;
    const othersInFolder = notes.filter((n) => n.id !== fromPath && n.parent_id === fromFolder);
    const targetDir = toFolder ? `${toFolder}/.assets` : '.assets';
    const targetNames = new Set(
      (await store.list(targetDir)).filter((r) => r.kind === 'asset').map((r) => nameOf(r.path))
    );
    for (const ref of refs) {
      const name = ref.slice('.assets/'.length);
      const fromAsset = fromFolder ? `${fromFolder}/.assets/${name}` : `.assets/${name}`;
      const rowAsset = await store.read(fromAsset);
      if (!rowAsset || rowAsset.content === null) continue;
      let targetName = name;
      if (targetNames.has(name)) {
        // Same-name file already at the destination — keep both.
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (targetNames.has(`${stem}-${n}${ext}`)) n++;
        targetName = `${stem}-${n}${ext}`;
        out = out.split(`.assets/${name}`).join(`.assets/${targetName}`);
      }
      targetNames.add(targetName);
      await store.write({
        path: toFolder ? `${toFolder}/.assets/${targetName}` : `.assets/${targetName}`,
        kind: 'asset',
        content: rowAsset.content,
        mime: rowAsset.mime,
        bytes: rowAsset.bytes,
      });
      // Remove the original only when no sibling note still references it.
      const stillUsed = othersInFolder.some((n) => assetRefsIn(n.body_md).includes(ref));
      if (!stillUsed) await store.remove(fromAsset);
    }
    return out;
  }

  /* ── rename offer ──────────────────────────────────────────────────── */
  async function rewriteLinks(): Promise<void> {
    if (!store || !renameOffer) return;
    const { from, to } = renameOffer;
    let count = 0;
    let held = 0;
    for (const n of notes) {
      if (n.id === currentPath) continue;
      const hasLink = findWikiLinks(n.body_md).some(
        (l) => l.title.trim().toLowerCase() === from.toLowerCase()
      );
      if (!hasLink) continue;
      const next: Note = {
        ...n,
        body_md: rewriteWikiLinks(n.body_md, from, to),
        updated_at: new Date().toISOString(),
      };
      const r = await withNoteLock(n.id, () =>
        store!.write({ path: n.id, kind: 'note', content: noteContentOf(next, fmData.get(n.id) ?? {}) })
      );
      if (r === 'held') held++;
      else count++;
    }
    await refreshFromRows();
    renameOffer = null;
    flash(`Updated links in ${count} note${count === 1 ? '' : 's'}.` + leftAlone(held));
  }

  /* ── delete ────────────────────────────────────────────────────────── */
  async function removeNoteAssetsFor(note: Note): Promise<void> {
    if (!store) return;
    const folder = note.parent_id;
    const siblings = notes.filter((n) => n.id !== note.id && n.parent_id === folder);
    for (const ref of assetRefsIn(note.body_md)) {
      if (siblings.some((n) => assetRefsIn(n.body_md).includes(ref))) continue;
      const name = ref.slice('.assets/'.length);
      await store.remove(folder ? `${folder}/.assets/${name}` : `.assets/${name}`);
    }
  }

  async function deleteNote(note: Note): Promise<void> {
    if (!store) return;
    if (note.id === currentPath && lockedElsewhere) {
      flash('This note is being written in another tab; it cannot be deleted from here.');
      return;
    }
    if (!confirm(`Delete “${displayTitle(note)}”? Its images go with it.`)) return;
    const isOpen = note.id === currentPath;
    if (isOpen) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await saveChain; // nothing in flight can file it again
    } else {
      await flushSave();
    }
    // The open note is this tab's already: asking the lock manager for it
    // again would be refused (a lock is not re-entrant) and read as
    // "another tab has it". The page stays on the note until it is gone.
    const own = isOpen && !lockedElsewhere;
    const remove = async (): Promise<void> => {
      await removeNoteAssetsFor(note);
      await store!.remove(note.id);
    };
    selfMutating = true;
    try {
      const r = own ? await remove() : await withNoteLock(note.id, remove);
      if (r === 'held') {
        flash('That note is open in another tab; close it there first.');
        return;
      }
    } finally {
      selfMutating = false;
    }
    // Gone: the page leaves it. Its lock is retired by openScratch, after
    // the model no longer has the note — a late editor flush then finds
    // nothing to write to, rather than filing the note again.
    if (isOpen) currentPath = null;
    await refreshFromRows();
    if (!currentPath) openScratch({ silent: true });
    flash('Note deleted.');
  }

  async function deleteFolder(folder: FolderEntry): Promise<void> {
    if (!store) return;
    const insideNotes = notes.filter((n) => n.id.startsWith(folder.id + '/'));
    const message =
      insideNotes.length > 0
        ? `Delete “${folder.title}”? The ${insideNotes.length} note${insideNotes.length === 1 ? '' : 's'} inside move up a level, they are not deleted.`
        : `Delete the empty “${folder.title}”?`;
    if (!confirm(message)) return;
    await flushSave();
    // Every note inside moves; none may be being written in another tab.
    const held = await holdAllUnder(folder.id);
    if (!held) {
      flash('A note in that notebook is open in another tab; close it there first.');
      return;
    }
    const parent = folder.parent_id;
    selfMutating = true;
    try {
      await withVaultLock(async () => {
        // Children move up, never cascade: notes go through the asset-aware
        // move; subfolders rename wholesale (their .assets ride along).
        for (const n of notes.filter((n) => n.parent_id === folder.id)) {
          const target = uniqueNotePath(parent, n.title, allPaths().filter((p) => p !== n.id));
          const newBody = await moveNoteAssets(n.id, target, n.body_md);
          await store!.rename(n.id, target);
          if (newBody !== n.body_md) {
            const moved: Note = { ...n, id: target, body_md: newBody, parent_id: parent };
            await store!.write({
              path: target,
              kind: 'note',
              content: noteContentOf(moved, fmData.get(n.id) ?? {}),
            });
          }
          if (currentPath === n.id) await relockOpen(target);
        }
        for (const f of folders.filter((f) => f.parent_id === folder.id)) {
          const target = uniqueFolderPath(parent, f.title, allPaths().filter((p) => p !== f.id));
          await store!.rename(f.id, target);
          if (currentPath?.startsWith(f.id + '/')) await relockOpen(target + currentPath.slice(f.id.length));
        }
        await store!.remove(folder.id);
      });
    } finally {
      selfMutating = false;
      await Promise.all(held.map((h) => h.release()));
    }
    await refreshFromRows();
    if (currentPath) {
      const reopened = notes.find((n) => n.id === currentPath);
      if (reopened) parentId = reopened.parent_id;
      else {
        currentPath = null;
        openScratch({ silent: true });
      }
    }
    flash('Notebook deleted; its notes moved up.');
  }

  function setMode(next: EditorMode): void {
    mode = next;
    savePrefs({ mode: next });
  }

  /* ── bulk, driven from the palette ─────────────────────────────────── */
  async function runBulk(
    action: 'export-md' | 'export-html' | 'tag-add' | 'tag-remove' | 'move' | 'delete',
    paths: string[],
    argument?: string
  ): Promise<string> {
    if (!store || paths.length === 0) return '';
    await flushSave();
    const chosen = paths
      .map((path) => notes.find((n) => n.id === path))
      .filter((n): n is Note => n !== undefined);

    if (action === 'export-md' || action === 'export-html') {
      const format = action === 'export-md' ? 'md' : 'html';
      const entries: ZipEntry[] = [];
      const taken = new Set<string>();
      let externals = 0;
      for (const n of chosen) {
        const isOpen = n.id === currentPath;
        const noteTitle = isOpen ? title.trim() || 'Untitled' : displayTitle(n);
        const noteBody = isOpen ? body : n.body_md;
        let assets: NoteAssetStore;
        if (isOpen && assetStore) assets = assetStore;
        else {
          assets = noteAssetStore(store, n.id);
          await assets.prime();
        }
        const urls = assetDataUrls(noteBody, assets);
        const name = exportFileName(noteTitle, format, taken);
        if (format === 'md') {
          entries.push({
            name,
            data: markdownExport({ title: noteTitle, body_md: noteBody }, { assets: urls, inlineAssets: true }),
          });
        } else {
          const { html, fonts, css } = await renderForExport(noteBody, urls);
          const doc = htmlExport({ title: noteTitle, bodyHtml: html, extraCss: css ? [css] : [], fonts });
          externals += externalReferences(doc).length;
          entries.push({ name, data: doc });
        }
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(zipBlob(entries), `notes-${stamp}.zip`);
      return (
        `Exported ${entries.length} note${entries.length === 1 ? '' : 's'}.` +
        (externals > 0 ? ` ${externals} external link${externals === 1 ? '' : 's'} left as written.` : '')
      );
    }

    if (action === 'tag-add' || action === 'tag-remove') {
      const change = parseTags(argument ?? '');
      if (change.length === 0) return 'No tags given.';
      let touched = 0;
      let held = 0;
      for (const n of chosen) {
        const base = n.id === currentPath ? parseTags(tagsText) : n.tags;
        const next = action === 'tag-add' ? addTags(base, change) : removeTags(base, change);
        if (next.length === base.length && next.every((t, i) => t === base[i])) continue;
        const row: Note = { ...n, tags: next, updated_at: new Date().toISOString() };
        const r = await withNoteLock(n.id, () =>
          store!.write({ path: n.id, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) })
        );
        if (r === 'held') {
          held++;
          continue;
        }
        if (n.id === currentPath) tagsText = next.join(', ');
        touched++;
      }
      await refreshFromRows();
      return (
        `${action === 'tag-add' ? 'Added' : 'Removed'} ${change.length} tag${change.length === 1 ? '' : 's'} on ${touched} note${touched === 1 ? '' : 's'}.` +
        leftAlone(held)
      );
    }

    if (action === 'move') {
      const target = argument === '' || argument === undefined ? null : argument;
      let moved = 0;
      let held = 0;
      selfMutating = true;
      try {
        await withVaultLock(async () => {
          for (const n of chosen) {
            if (n.parent_id === target) continue;
            const r = await withNoteLock(n.id, async () => {
              const to = uniqueNotePath(target, n.title, allPaths().filter((p) => p !== n.id));
              const newBody = await moveNoteAssets(n.id, to, n.body_md);
              await store!.rename(n.id, to);
              const row: Note = {
                ...n,
                id: to,
                parent_id: target,
                body_md: newBody,
                updated_at: new Date().toISOString(),
              };
              await store!.write({ path: to, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) });
              if (currentPath === n.id) {
                await relockOpen(to);
                parentId = target;
              }
            });
            if (r === 'held') held++;
            else moved++;
          }
        });
      } finally {
        selfMutating = false;
      }
      await refreshFromRows();
      return `Moved ${moved} note${moved === 1 ? '' : 's'}.` + leftAlone(held);
    }

    // delete
    if (!confirm(`Delete ${chosen.length} note${chosen.length === 1 ? '' : 's'}? Their images go with them.`)) {
      return 'Nothing deleted.';
    }
    if (currentPath && paths.includes(currentPath) && !lockedElsewhere) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await saveChain; // nothing in flight can file it again
    }
    let deleted = 0;
    let held = 0;
    selfMutating = true;
    try {
      await withVaultLock(async () => {
        for (const n of chosen) {
          const r = await withNoteLock(n.id, async () => {
            await removeNoteAssetsFor(n);
            await store!.remove(n.id);
          });
          if (r === 'held') {
            held++;
            continue;
          }
          deleted++;
          if (currentPath === n.id) {
            currentPath = null;
            const old = hold;
            hold = null;
            if (old) void retireHold(old);
          }
        }
      });
    } finally {
      selfMutating = false;
    }
    await refreshFromRows();
    if (!currentPath) openScratch({ silent: true });
    return `Deleted ${deleted} note${deleted === 1 ? '' : 's'}.` + leftAlone(held);
  }

  /* ── exports (the open note) ───────────────────────────────────────── */
  function assetDataUrls(
    md: string = body,
    assets: NoteAssetStore | null = assetStore
  ): Map<string, string> {
    const map = new Map<string, string>();
    if (!assets) return map;
    for (const ref of assetRefsIn(md)) {
      const url = assets.resolve?.(ref);
      if (url) map.set(ref, url);
    }
    return map;
  }

  function downloadMarkdown(): void {
    editor?.flush();
    const md = markdownExport(
      { title: title.trim() || 'Untitled', body_md: body },
      { assets: assetDataUrls(), inlineAssets: true }
    );
    downloadText(md, `${fileStem}.md`, 'text/markdown');
    exportNote = null;
  }

  async function renderForExport(
    md: string = body,
    assets: Map<string, string> = assetDataUrls()
  ): Promise<{ html: string; fonts: Awaited<ReturnType<typeof collectMathFonts>>; css: string }> {
    const host = document.createElement('div');
    host.className = 'prose';
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:60rem;';
    document.body.append(host);
    try {
      host.innerHTML = renderMarkdown(md, {
        wikiLinks: { href: wikiHref, exists: wikiExists },
        resolveImage: (src) => assets.get(src),
      });
      await renderMathIn(host);
      const pres = [...host.querySelectorAll<HTMLElement>('pre.mermaid')];
      if (pres.length > 0) {
        await getMermaid();
        await renderInto(pres);
      }
      const fonts = host.querySelector('.katex') ? await collectMathFonts(host) : [];
      let css = '';
      if (fonts.length > 0) {
        css = await fetch(href('/math/katex.css')).then((r) => (r.ok ? r.text() : ''));
      }
      return { html: host.innerHTML, fonts, css };
    } finally {
      host.remove();
    }
  }

  async function downloadHtml(): Promise<void> {
    editor?.flush();
    const { html, fonts, css } = await renderForExport();
    const doc = htmlExport({
      title: title.trim() || 'Untitled',
      bodyHtml: html,
      extraCss: css ? [css] : [],
      fonts,
    });
    const externals = externalReferences(doc);
    exportNote =
      externals.length > 0
        ? `The file references ${externals.length} external URL${externals.length === 1 ? '' : 's'} (links you wrote); everything else is inlined.`
        : null;
    downloadText(doc, `${fileStem}.html`, 'text/html');
  }

  async function printNote(): Promise<void> {
    editor?.flush();
    const { html } = await renderForExport();
    printHtml = html;
    await tick();
    printDocument(title.trim() || 'Untitled');
    setTimeout(() => (printHtml = ''), 1000);
  }

  function noteAction(action: 'md' | 'html' | 'print' | 'close' | 'delete'): void {
    if (action === 'md') downloadMarkdown();
    else if (action === 'html') void downloadHtml();
    else if (action === 'print') void printNote();
    else if (action === 'close') void closeNote();
    else if (action === 'delete' && current) void deleteNote(current);
  }

  /* ── frontmatter extras ────────────────────────────────────────────── */
  function addExtraRow(): void {
    extraRows = [...extraRows, { key: '', kind: 'text', value: '' }];
  }

  /**
   * A click on the paper, below or beside the writing, puts the caret at
   * the end of it. On a real page there is no "outside the text" to click,
   * and a page that swallows a click reads as broken.
   *
   * Only bare paper counts: a click that landed on a control, a link, or
   * inside the editor is that thing's click, not the page's.
   */
  function onSheetClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea, select, button, a, label, [contenteditable="true"]')) return;
    // The editor's own chrome is not blank paper.
    if (target.closest('.editor-toolbar')) return;
    if (window.getSelection()?.toString()) return; // a drag-select, not a click
    editor?.focusEnd();
  }

  /* ── the desktop: which folder, and which file ─────────────────────── */

  /**
   * Mount another folder and open a note in it. This is what makes notey
   * an editor rather than only a vault: the file's own folder becomes the
   * vault, so every ordinary save writes back where the file came from.
   */
  async function mountAt(root: string, open: string | null): Promise<void> {
    await flushSave();
    // The page being left belongs to the old vault.
    const previous = hold;
    hold = null;
    currentPath = null;
    if (previous) void retireHold(previous);
    store = await remountVault(root);
    vaultFolder = root;
    await refreshFromRows();
    if (open) await openLaunchFile(open);
    else openScratch({ silent: true });
    flash(`Editing in ${rootLabel(root)}.`);
  }

  /**
   * Open a note the desktop was pointed at. `notey todo.md` for a file
   * that is not there yet starts it, which is what an editor does.
   */
  async function openLaunchFile(path: string): Promise<void> {
    if (!store) return;
    let note = notes.find((n) => n.id === path);
    if (!note) {
      const now = new Date().toISOString();
      await store.create({
        path,
        kind: 'note',
        content: noteContentOf({
          id: path,
          title: stemOf(nameOf(path)),
          body_md: '',
          aliases: [],
          tags: [],
          parent_id: parentOf(path),
          fm: {},
          created_at: now,
          updated_at: now,
        }),
      });
      await refreshFromRows();
      note = notes.find((n) => n.id === path);
    }
    if (note) await openNote(note, { remember: false });
  }

  /** Ctrl+K → Edit existing file: pick a `.md` anywhere and edit it there. */
  async function editExistingFile(): Promise<void> {
    try {
      const { chooseVaultFile } = await import('../lib/vault/desktop');
      const target = await chooseVaultFile();
      if (!target) return;
      await mountAt(target.root, target.open);
    } catch (err) {
      flash('Could not open that file: ' + String(err));
    }
  }

  /** The welcome's "choose another folder" — and Settings' button. */
  async function chooseFolder(): Promise<string | null> {
    const { chooseVaultFolder } = await import('../lib/vault/desktop');
    const root = await chooseVaultFolder();
    if (root) await mountAt(root, null);
    return root;
  }

  /* ── dropping a markdown file on the page ──────────────────────────── */

  /** Only a drag carrying FILES is ours; dragging text or a block is not. */
  function isFileDrag(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes('Files') ?? false;
  }

  function onDragEnter(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth++;
  }

  function onDragOver(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    // Without this the browser navigates to the file instead.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }

  /** Where a dropped file lands: the notebook you are in, or the Pile. */
  const dropFolder = $derived(scratchOpen ? null : parentId);

  function onDrop(event: DragEvent): void {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length === 0) return;
    void addDroppedFiles(dropped);
  }

  /**
   * Markdown files become notes and the first one opens. Anything else is
   * named rather than silently ignored — a dropped PNG that vanishes looks
   * like a bug.
   */
  async function addDroppedFiles(dropped: readonly File[]): Promise<void> {
    if (!store) return;
    const md = dropped.filter((file) => isMarkdownFile(file.name));
    const other = dropped.length - md.length;
    if (md.length === 0) {
      flash(
        other === 1
          ? 'That is not a markdown file — notey opens .md files.'
          : 'Those are not markdown files — notey opens .md files.'
      );
      return;
    }
    const folder = dropFolder;
    try {
      // Whatever is being written here goes in first, so a drop that opens
      // another note cannot strand it.
      await flushSave();
      const files = await Promise.all(
        md.map(async (file) => ({ name: file.name, text: await file.text() }))
      );
      const report = await dropIntoVault(store, files, folder, allPaths());
      await refreshFromRows();
      const opened = report.opened ? notes.find((n) => n.id === report.opened) : undefined;
      if (opened) await openNote(opened);
      flash(describeDrop(report) + (other > 0 ? ` ${other} not markdown, left out.` : ''));
    } catch (err) {
      flash('Could not add that file: ' + String(err));
    }
  }

  /** Grow a YAML field with what it holds, up to a sensible ceiling. */
  function yamlRows(value: string): number {
    return Math.min(8, value.split(String.fromCharCode(10)).length + 1);
  }

  /** text → list → yaml → text: one button cycles a field's shape. */
  function cycleFieldKind(index: number): void {
    const next: Record<FieldKind, FieldKind> = { text: 'list', list: 'yaml', yaml: 'text' };
    const row = extraRows[index];
    if (!row) return;
    extraRows = extraRows.map((f, i) => (i === index ? switchKind(f, next[f.kind]) : f));
    scheduleSave();
  }

  function removeExtraRow(index: number): void {
    extraRows = extraRows.filter((_, i) => i !== index);
    scheduleSave();
  }

  function fmStamp(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  }
</script>

{#if bootError}
  <div class="boot-error" role="alert">
    <p class="eyebrow eyebrow-stamp">The vault did not open</p>
    <p>{bootError}</p>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="desk"
    class:dropping={dragging}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if dragging}
      <!-- Named, so it is obvious WHERE the file will land before letting go. -->
      <div class="drop-hint" data-testid="notey-drop-hint" aria-hidden="true">
        <p>Drop a .md file to open it as a note</p>
        <p class="drop-where">
          {dropFolder ? `into ${dropFolder}` : 'into the Pile'}
        </p>
      </div>
    {/if}
    <!-- The one piece of chrome: a book. Closed on the page, open while
         the library is showing. -->
    <button
      class="book"
      class:open={paletteOpen}
      data-testid="notey-book"
      aria-label={paletteOpen ? 'Close the library' : 'Open the library'}
      aria-expanded={paletteOpen}
      title={paletteOpen ? 'Close (Esc)' : 'Library (Ctrl+K)'}
      onclick={() => (paletteOpen = !paletteOpen)}
    >
      {#if paletteOpen}
        <!-- open book -->
        <svg viewBox="0 0 32 26" aria-hidden="true">
          <path d="M16 6.5C13 3.6 8.6 2.8 3.5 3.4v17c5.1-.6 9.5.2 12.5 3.1 3-2.9 7.4-3.7 12.5-3.1v-17C23.4 2.8 19 3.6 16 6.5Z" />
          <path class="spine" d="M16 6.5v17" />
          <path class="line" d="M7 8.6c2.2-.2 4.4 0 6 .8M7 12.4c2.2-.2 4.4 0 6 .8M19 9.4c1.6-.8 3.8-1 6-.8M19 13.2c1.6-.8 3.8-1 6-.8" />
        </svg>
      {:else}
        <!-- closed book -->
        <svg viewBox="0 0 32 26" aria-hidden="true">
          <path d="M6 2.5h17a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2Z" />
          <path class="spine" d="M9 2.5v21" />
          <path class="line" d="M13 8h9M13 12h9" />
        </svg>
      {/if}
    </button>

    {#if feedback}
      <p class="feedback" role="status" data-testid="notebook-feedback">{feedback}</p>
    {/if}

    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <article
      class="sheet"
      data-testid="notey-sheet"
      class:unfiled={scratchOpen}
      onclick={onSheetClick}
    >
      <header class="sheet-head">
        <div class="head-left">
          {#if breadcrumb.length > 0}
            <nav class="breadcrumb" data-testid="notebook-breadcrumb">
              {#each breadcrumb as crumb, i (i)}
                <button
                  class="crumb"
                  data-testid="notey-breadcrumb-link"
                  title={`Open ${breadcrumb.slice(0, i + 1).join('/')} in the palette`}
                  onclick={() => openPaletteAt(breadcrumb.slice(0, i + 1).join('/'))}
                >{crumb}</button><span class="crumb-sep">/</span>
              {/each}
            </nav>
          {:else if !scratchOpen}
            <p class="eyebrow"></p>
          {/if}
          <input
            class="title-input"
            type="text"
            placeholder="Untitled"
            aria-label="Note title"
            data-testid="notebook-title"
            bind:this={titleField}
            bind:value={title}
            disabled={switching || lockedElsewhere}
            oninput={onTitleInput}
            onblur={commitTitle}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                (event.currentTarget as HTMLInputElement).blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                title = savedTitle;
                titleDirty = false;
                (event.currentTarget as HTMLInputElement).blur();
              }
            }}
          />
        </div>

        <!-- Frontmatter: above the red line, on the right. The unfiled
             page has none — there is nothing true to say about it yet. -->
        {#if !scratchOpen}
          <div class="head-right" data-testid="notey-frontmatter">
            <div class="fm-row">
              <span class="fm-key">created</span>
              <span class="fm-value">{fmStamp(createdAt)}</span>
            </div>
            <div class="fm-row">
              <span class="fm-key">updated</span>
              <span class="fm-value">{fmStamp(updatedAt)}</span>
            </div>
            <div class="fm-row">
              <label class="fm-key" for="notey-inside">Notebook</label>
              <select
                id="notey-inside"
                class="fm-input"
                data-testid="notebook-parent"
                bind:value={parentId}
                disabled={switching || lockedElsewhere}
                onchange={scheduleSave}
              >
                <option value={null}>— the Pile —</option>
                {#each folderOptions as folder (folder.id)}
                  <option value={folder.id}>{folder.id}</option>
                {/each}
              </select>
            </div>
            <div class="fm-row">
              <label class="fm-key" for="notey-tags">tags</label>
              <input
                id="notey-tags"
                class="fm-input"
                type="text"
                placeholder="comma, separated"
                data-testid="notebook-tags"
                bind:value={tagsText}
                disabled={switching || lockedElsewhere}
                oninput={scheduleSave}
              />
            </div>
            <div class="fm-row">
              <label class="fm-key" for="notey-aliases">aliases</label>
              <input
                id="notey-aliases"
                class="fm-input"
                type="text"
                placeholder="other names"
                data-testid="notebook-aliases"
                bind:value={aliasesText}
                disabled={switching || lockedElsewhere}
                oninput={scheduleSave}
              />
            </div>
            {#each extraRows as row, i (i)}
              <div class="fm-row" class:fm-row-block={row.kind === 'yaml'}>
                <input
                  class="fm-key fm-key-input"
                  type="text"
                  placeholder="key"
                  aria-label="Frontmatter field name"
                  data-testid="notey-fm-key"
                  disabled={lockedElsewhere}
                  bind:value={row.key}
                  oninput={scheduleSave}
                />
                {#if row.kind === 'yaml'}
                  <textarea
                    class="fm-input fm-yaml"
                    class:invalid={invalidFields.includes(row.key.trim())}
                    rows={yamlRows(row.value)}
                    placeholder="key: value"
                    aria-label="Frontmatter field value, as YAML"
                    data-testid="notey-fm-value"
                    disabled={lockedElsewhere}
                    bind:value={row.value}
                    oninput={scheduleSave}
                  ></textarea>
                {:else}
                  <input
                    class="fm-input"
                    type="text"
                    placeholder={row.kind === 'list' ? 'comma, separated' : 'value'}
                    aria-label="Frontmatter field value"
                    data-testid="notey-fm-value"
                    disabled={lockedElsewhere}
                    bind:value={row.value}
                    oninput={scheduleSave}
                  />
                {/if}
                <button
                  class="fm-kind"
                  data-testid="notey-fm-kind"
                  data-kind={row.kind}
                  title={row.kind === 'text'
                    ? 'A single value — click for a list'
                    : row.kind === 'list'
                      ? 'A list — click for YAML'
                      : 'YAML — click for a single value'}
                  aria-label={`Field shape: ${row.kind}`}
                  disabled={lockedElsewhere}
                  onclick={() => cycleFieldKind(i)}
                >
                  {#if row.kind === 'text'}
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg>
                  {:else if row.kind === 'list'}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="3.2" cy="4.5" r="1" /><path d="M6.5 4.5H13" />
                      <circle cx="3.2" cy="8" r="1" /><path d="M6.5 8H13" />
                      <circle cx="3.2" cy="11.5" r="1" /><path d="M6.5 11.5H13" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 3H4.5A1.5 1.5 0 0 0 3 4.5v2A1.5 1.5 0 0 1 1.5 8 1.5 1.5 0 0 1 3 9.5v2A1.5 1.5 0 0 0 4.5 13H6" />
                      <path d="M10 3h1.5A1.5 1.5 0 0 1 13 4.5v2A1.5 1.5 0 0 0 14.5 8 1.5 1.5 0 0 0 13 9.5v2a1.5 1.5 0 0 1-1.5 1.5H10" />
                    </svg>
                  {/if}
                </button>
                <button class="fm-remove" title="Remove field" disabled={lockedElsewhere} onclick={() => removeExtraRow(i)}>×</button>
              </div>
            {/each}
            {#if invalidFields.length > 0}
              <p class="fm-warn" data-testid="notey-fm-invalid">
                {invalidFields.join(', ')}: not valid YAML — the last good value was kept.
              </p>
            {/if}
            <button class="fm-add" data-testid="notey-fm-add" disabled={lockedElsewhere} onclick={addExtraRow}>+ field</button>
          </div>
        {/if}

        {#if lockedElsewhere}
          <div class="head-stamp" data-testid="notebook-save-state" aria-live="polite">
            <span class="stamp stamp-bad" data-testid="notey-stamp-read-only">Open in another tab</span>
          </div>
        {:else if saveState}
          <div class="head-stamp" data-testid="notebook-save-state" aria-live="polite">
            {#if saveState === 'saving'}<span class="stamp">Saving…</span>
            {:else if saveState === 'saved'}<span class="stamp stamp-ok">Saved</span>
            {:else}<span class="stamp stamp-bad">Not saved</span>{/if}
          </div>
        {/if}
      </header>

      <div class="red-rule" data-testid="notey-rule" aria-hidden="true"></div>

      {#if lockedElsewhere}
        <p class="notice" data-testid="notey-read-only">
          This note is being written in another tab. It becomes writable here
          when that tab moves on — to another note, the blank page, or closes.
        </p>
      {/if}

      {#if detached}
        <p class="notice notice-warn" data-testid="notey-detached">
          This note was deleted in another tab. Keep writing and it is filed
          again.
        </p>
      {/if}

      {#if missingLink}
        <p class="notice notice-warn" data-testid="notebook-missing-link">
          No note called “{missingLink}”.
          <button
            class="btn btn-sm"
            data-testid="notebook-create-missing"
            onclick={() => {
              const t = missingLink ?? 'Untitled';
              missingLink = null;
              void createNote(t, null);
            }}>Create it</button
          >
        </p>
      {/if}

      {#if renameOffer}
        <p class="notice notice-warn" data-testid="notebook-rename-offer">
          {renameOffer.count} note{renameOffer.count === 1 ? ' still links' : 's still link'} to “{renameOffer.from}”.
          <button class="btn btn-sm" data-testid="notebook-rewrite-links" onclick={() => void rewriteLinks()}>
            Update them to “{renameOffer.to}”
          </button>
        </p>
      {/if}

      {#if exportNote}
        <p class="notice" data-testid="notebook-export-note">{exportNote}</p>
      {/if}

      <div class="editor-host" data-testid="notebook-editor-host">
        {#if lockedElsewhere}
          <!-- Another tab's page: read it, watch it change, write nothing. -->
          <div class="read-only" data-testid="notebook-read-only">
            <MarkdownPreview
              markdown={body}
              resolveImage={assetStore?.resolve?.bind(assetStore)}
              {wikiExists}
              {wikiHref}
              onWikiNavigate={navigateWiki}
              nonce={previewNonce}
            />
          </div>
        {:else}
        {#key editorKey}
          <MarkdownEditor
            bind:this={editor}
            value={body}
            onChange={(md) => onBodyChange(md)}
            assets={assetStore ?? undefined}
            debounce={150}
            {mode}
            onMode={setMode}
            {wikiExists}
            {wikiHref}
            onWikiNavigate={navigateWiki}
            placeholder="Press Ctrl+K for commands, or just start typing (/ for special blocks)."
            minHeight="20rem"
          />
        {/key}
        {/if}
      </div>
    </article>
  </div>

  {#if welcomeOpen}
    <DesktopWelcome
      folder={vaultFolder}
      onKeep={() => {
        // Keeping the offered folder is still a choice: remembering it is
        // what stops this asking again.
        void import('../lib/vault/desktop').then(({ useFolder }) => useFolder(vaultFolder));
        welcomeOpen = false;
      }}
      onChoose={async () => {
        const root = await chooseFolder();
        if (root) welcomeOpen = false;
        return root;
      }}
    />
  {/if}

  {#if paletteOpen}
    <CommandPalette
      startAt={paletteAt}
      {notes}
      {folders}
      {current}
      {scratchOpen}
      {scratchDirty}
      onOpenNote={(note) => void openNote(note)}
      onCreateNote={(folder, noteTitle) => void createNote(noteTitle ?? 'Untitled', folder)}
      onCreateNotebook={createNotebook}
      onRenameFolder={renameFolder}
      onDeleteFolder={deleteFolder}
      onBlank={() => openScratch()}
      onFileScratch={(folder) => void fileScratch(folder)}
      onNoteAction={noteAction}
      onBulk={runBulk}
      {heldPaths}
      readOnly={lockedElsewhere}
      {desktop}
      onEditExisting={desktop ? () => void editExistingFile() : undefined}
      onChooseFolder={desktop ? chooseFolder : undefined}
      onClose={() => {
        paletteOpen = false;
        paletteAt = null;
      }}
    />
  {/if}

  {#if !booted}
    <p class="booting muted" data-testid="notey-booting">Opening the vault…</p>
  {/if}

  {#if printHtml}
    <div class="print-only prose" data-testid="notebook-print-sheet">
      <h1>{title.trim() || 'Untitled'}</h1>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- DOMPurify-sanitized -->
      {@html printHtml}
    </div>
  {/if}
{/if}

<style>
  .desk {
    position: relative;
    padding: var(--space-5) var(--space-5) var(--space-6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    min-height: calc(100dvh - var(--navbar-height));
  }

  /*
   * A drag in progress. The whole desk is the target — there is nothing to
   * aim at, which is the point — and the sheet dims so the hint reads.
   */
  .desk.dropping::after {
    content: '';
    position: fixed;
    inset: 0;
    background: var(--scrim-color);
    pointer-events: none;
    z-index: 80;
  }

  .drop-hint {
    position: fixed;
    inset: var(--space-5);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 2px dashed var(--color-primary);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    box-shadow: var(--shadow-2);
    pointer-events: none;
    z-index: 81;
  }

  .drop-hint p {
    margin: 0;
    font-size: var(--font-size-lg);
  }

  .drop-where {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  /* ── the book ──────────────────────────────────────────────────────── */
  .book {
    position: fixed;
    top: calc(var(--navbar-height) + var(--space-3));
    right: var(--space-5);
    /* Above the palette backdrop (z-index 80): the book opens the library
       and must also be able to close it. */
    z-index: 90;
    width: 2.4rem;
    height: 2.4rem;
    display: grid;
    place-items: center;
    padding: 0.35rem;
    cursor: pointer;
    /*
     * A chip of paper behind it. The book sits out on the desk, and some
     * desks (oak, birch, cream) are close enough to the ink to wash it
     * out; giving it the page's own surface makes it legible on every
     * one of them without a special case per desk.
     */
    background: var(--surface-color);
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-1);
    color: var(--text-muted-color);
    transition:
      color 120ms ease,
      border-color 120ms ease;
  }

  .book:hover,
  .book.open {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .book svg {
    width: 100%;
    height: 100%;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Open, the book is wider and lighter — it has got out of the way. */
  .book.open svg {
    stroke-width: 1.3;
  }

  .book .spine {
    opacity: 0.75;
  }

  .book .line {
    opacity: 0.5;
  }

  .feedback {
    color: var(--color-success);
    font-size: var(--font-size-sm);
  }

  .booting {
    position: fixed;
    bottom: var(--space-3);
    left: var(--space-5);
    font-size: var(--font-size-eyebrow);
    color: var(--desk-ink-muted, var(--text-muted-color));
  }

  /* ── the sheet: a page, 8 × 11 ─────────────────────────────────────── */
  .sheet {
    --page-width: 120ch;
    width: var(--page-width);
    max-width: 100%;
    /*
     * A real page: this tall when empty, and TALLER when the writing runs
     * long. Deliberately min-height and not aspect-ratio — aspect-ratio
     * gives the box a definite height, which content then overflows
     * instead of growing, and the writing spills onto the desk.
     */
    min-height: min(calc(var(--page-width) * 11 / 8), calc(100vw * 11 / 8));
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-1);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    position: relative;
  }

  /*
   * What the paper is PRINTED with, as opposed to what is written on it:
   * a legal pad's blue rules, a blueprint's drafting grid. Painted in a
   * layer of its own behind the writing, so no ported component has to
   * know which paper it is on.
   */
  .sheet::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    background-image: var(--paper-lines, none), var(--paper-grid, none);
    background-size: var(--paper-lines-size, auto), var(--paper-grid-size, auto);
    background-repeat: var(--paper-lines-repeat, repeat), var(--paper-grid-repeat, repeat);
    background-position: var(--paper-lines-position, 0 0), var(--paper-grid-position, 0 0);
    opacity: 0.9;
  }

  /* A legal pad also has a red margin ruled down the left. */
  :global(:root[data-page='legal']) .sheet::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--space-6) - 0.55rem);
    width: 1px;
    background: var(--paper-margin-line, transparent);
    pointer-events: none;
  }

  /* The drafting papers get a two-scale grid. */
  :global(:root[data-page='blueprint']) .sheet,
  :global(:root[data-page='blueprint-inverse']) .sheet {
    --paper-grid:
      linear-gradient(var(--paper-grid-fine) 1px, transparent 1px),
      linear-gradient(90deg, var(--paper-grid-fine) 1px, transparent 1px),
      linear-gradient(var(--paper-grid-major) 1px, transparent 1px),
      linear-gradient(90deg, var(--paper-grid-major) 1px, transparent 1px);
    --paper-grid-size: 24px 24px, 24px 24px, 120px 120px, 120px 120px;
  }

  :global(:root[data-page='legal']) .sheet {
    --paper-lines-size: 100% calc(var(--line-height) * 1em);
  }

  /* Green bar: the bands tile every six lines. */
  :global(:root[data-page='greenbar']) .sheet {
    --paper-lines-size: 100% calc(var(--line-height) * 6em);
  }

  .sheet-head {
    display: grid;
    grid-template-columns: 1fr minmax(13rem, 0.6fr);
    gap: var(--space-5);
    align-items: start;
    padding-bottom: var(--space-4);
  }

  /* Nothing filed yet: the title has the page to itself. */
  .sheet.unfiled .sheet-head {
    grid-template-columns: 1fr;
  }

  .head-left {
    min-width: 0;
  }

  .breadcrumb {
    font-size: var(--font-size-eyebrow);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--text-muted-color);
    font-weight: 700;
  }

  .crumb {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  .crumb:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .crumb-sep {
    margin: 0 var(--space-1);
    color: var(--border-strong-color);
  }

  .title-input {
    width: 100%;
    border: 0;
    background: none;
    padding: var(--space-1) 0;
    font-size: var(--font-size-2xl);
    font-weight: 700;
    font-family: var(--font-body);
    color: var(--text-color);
  }

  .title-input::placeholder {
    color: var(--text-muted-color);
    opacity: 0.45;
  }

  .title-input:focus-visible {
    outline: none;
    border-bottom: 2px dashed var(--color-primary);
  }

  .aliases {
    font-size: var(--font-size-eyebrow);
  }

  .head-right {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--font-size-sm);
    border-left: 1px dashed var(--border-strong-color);
    padding-left: var(--space-4);
  }

  .fm-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .fm-key {
    width: 5.2rem;
    flex: none;
    font-size: var(--font-size-eyebrow);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--text-muted-color);
    font-weight: 700;
  }

  .fm-key-input {
    width: 5.2rem;
    border: 0;
    border-bottom: 1px dashed var(--border-color);
    background: none;
    padding: 0;
    text-transform: none;
  }

  .fm-value {
    color: var(--text-muted-color);
  }

  .fm-input {
    flex: 1;
    min-width: 0;
    border: 0;
    border-bottom: 1px dashed var(--border-color);
    border-radius: 0;
    background: none;
    padding: 0 0 1px;
    font-size: var(--font-size-sm);
  }

  .fm-input:focus-visible {
    outline: none;
    border-bottom: 1px solid var(--color-primary);
  }

  .fm-remove,
  .fm-kind {
    border: 0;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    flex: none;
    padding: 0 1px;
    line-height: 1;
  }

  .fm-kind {
    width: 1.1rem;
    height: 1.1rem;
    display: grid;
    place-items: center;
    opacity: 0.55;
  }

  .fm-kind:hover {
    opacity: 1;
    color: var(--color-primary);
  }

  .fm-kind svg {
    width: 100%;
    height: 100%;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  .fm-kind svg circle {
    fill: currentColor;
    stroke: none;
  }

  /* A YAML field is a block, so its row stacks instead of sitting in line. */
  .fm-row-block {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .fm-yaml {
    flex: 1 1 100%;
    order: 3;
    font-family: var(--font-mono);
    font-size: var(--font-size-eyebrow);
    line-height: 1.45;
    border: 1px dashed var(--border-color);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    resize: vertical;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }

  .fm-yaml.invalid {
    border-color: var(--color-danger);
  }

  .fm-warn {
    font-size: var(--font-size-eyebrow);
    color: var(--color-danger);
  }

  .fm-remove:hover {
    color: var(--color-stamp);
  }

  .fm-add {
    align-self: flex-start;
    border: 0;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-eyebrow);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    cursor: pointer;
    padding: 0;
  }

  .fm-add:hover {
    color: var(--color-primary);
  }

  /* The saved stamp, angled like a real one. */
  .head-stamp {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
  }

  .stamp {
    display: inline-block;
    border: 1.5px solid var(--text-muted-color);
    color: var(--text-muted-color);
    border-radius: var(--radius-sm);
    padding: 0 var(--space-2);
    font-size: var(--font-size-eyebrow);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
    transform: rotate(-3deg);
    opacity: 0.85;
  }

  .stamp-ok {
    border-color: var(--color-success);
    color: var(--color-success);
  }

  .stamp-bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }

  /* THE red rule — a double line, like the head of an index card. Some
     papers (and some people) do not want one; the setting hides it and
     leaves a plain hairline so the header still ends somewhere. */
  :global(:root[data-rule='off']) .red-rule {
    border-top: 1px solid var(--border-color);
    border-bottom: 0;
    height: 1px;
  }

  .red-rule {
    border-top: 2px solid var(--rule-color);
    border-bottom: 1px solid var(--rule-color);
    height: 3px;
    margin: 0 calc(-1 * var(--space-6)) var(--space-4);
  }

  .notice {
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--text-muted-color);
  }

  .notice-warn {
    color: var(--color-warning);
  }

  .read-only {
    min-height: 20rem;
  }

  .editor-host {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .boot-error {
    max-width: 36rem;
    margin: var(--space-6) auto;
    background: var(--surface-color);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    padding: var(--space-5);
  }

  @media (max-width: 56rem) {
    .desk {
      padding: var(--space-3);
    }

    .sheet {
      --page-width: 100%;
      min-height: 0;
      padding: var(--space-4);
    }

    .sheet-head {
      grid-template-columns: 1fr;
    }

    .head-right {
      border-left: 0;
      border-top: 1px dashed var(--border-strong-color);
      padding-left: 0;
      padding-top: var(--space-3);
    }

    .red-rule {
      margin: 0 calc(-1 * var(--space-4)) var(--space-4);
    }

    .book {
      right: var(--space-3);
    }
  }

</style>
