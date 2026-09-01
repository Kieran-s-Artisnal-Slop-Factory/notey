<script lang="ts">
  /**
   * The app shell: one island owning the vault, the sidebar (notebooks +
   * the Pile), and the sheet of paper the note is written on.
   *
   * Invariants carried over from useful's notebook (see
   * docs/dev/plans/version-0.1.0-phased.md, decision list):
   *  - The markdown string is the single source of truth; the editor is a
   *    view. Autosave = 400 ms after the last change; flush on pagehide,
   *    visibility-hidden, note switch, unmount, and before bulk/exports.
   *  - Page load writes nothing (restores with remember: false; an
   *    unresolved ?note= deep link offers a Create button, never creates).
   *  - Backlinks are computed, never stored.
   *  - Rename pushes the old title into aliases; rewriting other notes'
   *    [[links]] is one explicit button, offered with a count.
   *  - Deleting a folder moves its children up, never cascades.
   *  - Editor changes carry the note path they were mounted with; a late
   *    flush after switching writes to that path, never the open snapshot.
   */
  import { onDestroy, onMount, tick } from 'svelte';
  import MarkdownEditor from './notebook/MarkdownEditor.svelte';
  import QuickSwitcher from './QuickSwitcher.svelte';
  import { href } from '../lib/paths';
  import { downloadBlob, downloadText } from '../lib/exportFile';
  import { zipBlob, type ZipEntry } from '../lib/zip';
  import { renderMarkdown } from '../lib/markdown';
  import { renderMathIn } from '../lib/notebook/math';
  import { getMermaid, renderInto } from '../lib/notebook/mermaid';
  import { collectMathFonts } from '../lib/notebook/mathFonts';
  import { externalReferences, htmlExport, markdownExport, printDocument } from '../lib/notebook/export';
  import { addTags, exportFileName, flattenTree, moveTargets, subtreeIds, removeTags } from '../lib/notebook/bulk';
  import { ancestorsOf, buildTree, displayTitle, parseTags } from '../lib/notebook/model';
  import { backlinks, findWikiLinks, resolveNote, rewriteWikiLinks } from '../lib/notebook/wiki';
  import { parseNoteContent } from '../lib/vault/frontmatter';
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
    treeEntries,
    uniqueFolderPath,
    uniqueNotePath,
  } from '../lib/vault/model';
  import { noteAssetStore, type NoteAssetStore } from '../lib/vault/assetStore';
  import { openVaultStore } from '../lib/vault/store';
  import { isEmptyQuery, parseQuery, searchNotes, type SearchHit } from '../lib/vault/search';
  import type { FolderEntry, Note, VaultStore } from '../lib/vault/types';
  import {
    loadPrefs,
    loadScratch,
    savePrefs,
    saveScratch,
    type EditorMode,
  } from '../lib/prefs';

  type BulkFormat = 'md' | 'html';
  const SAVE_DEBOUNCE_MS = 400;

  /* ── vault + model ─────────────────────────────────────────────────── */
  let store: VaultStore | null = null;
  let booted = $state(false);
  let bootError = $state<string | null>(null);
  let folders = $state<FolderEntry[]>([]);
  let notes = $state<Note[]>([]);
  // Original frontmatter maps, path → data, for order-preserving saves.
  const fmData = new Map<string, Record<string, unknown>>();

  /* ── open note snapshot ────────────────────────────────────────────── */
  let currentPath = $state<string | null>(null);
  let scratchOpen = $state(false);
  let title = $state('');
  let body = $state('');
  let tagsText = $state('');
  let aliases = $state<string[]>([]);
  let parentId = $state<string | null>(null);
  let extraRows = $state<{ key: string; value: string }[]>([]);
  let createdAt = $state<string | null>(null);
  let updatedAt = $state<string>('');
  let savedTitle = $state('');
  let renameOffer = $state<{ from: string; to: string; count: number } | null>(null);
  let assetStore = $state<NoteAssetStore | null>(null);
  let assetCount = $state(0);
  let assetBytes = $state(0);

  /* ── chrome ────────────────────────────────────────────────────────── */
  let mode = $state<EditorMode>('wysiwyg');
  let sidebarOpen = $state(true);
  let search = $state('');
  let collapsed = $state<ReadonlySet<string>>(new Set());
  let feedback = $state<string | null>(null);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let missingLink = $state<string | null>(null);
  let exportNote = $state<string | null>(null);
  let printHtml = $state('');
  let quickOpen = $state(false);
  let editor = $state<MarkdownEditor | undefined>();
  let titleField = $state<HTMLInputElement | undefined>();
  let switching = $state(false);
  let destroyed = false;

  /* ── bulk ──────────────────────────────────────────────────────────── */
  let selected = $state<ReadonlySet<string>>(new Set());
  let bulkTagsText = $state('');
  let bulkParent = $state('');
  let bulkFormat = $state<BulkFormat>('md');
  let bulkBusy = $state(false);
  let bulkNote = $state<string | null>(null);

  /* ── autosave ──────────────────────────────────────────────────────── */
  let saveState = $state<'saved' | 'saving' | 'error' | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  /* ── derived ───────────────────────────────────────────────────────── */
  const current = $derived(notes.find((n) => n.id === currentPath) ?? null);
  const entries = $derived(treeEntries(folders, notes));
  const tree = $derived(buildTree(entries));
  const folderIds = $derived(new Set(folders.map((f) => f.id)));
  const pileNotes = $derived(
    (tree.roots ?? []).filter((e) => !folderIds.has(e.id)).map((e) => e as Note)
  );
  const notebooks = $derived((tree.roots ?? []).filter((e) => folderIds.has(e.id)));
  const query = $derived(parseQuery(search));
  const searching = $derived(!isEmptyQuery(query));
  const hits = $derived(searching ? searchNotes(notes, query) : []);
  const currentLike = $derived(current);
  const linksHere = $derived(currentLike ? backlinks(notes, currentLike) : []);
  const linksOut = $derived.by(() => {
    if (!currentPath && !scratchOpen) return [] as { title: string; note: Note | null }[];
    const seen = new Set<string>();
    const out: { title: string; note: Note | null }[] = [];
    for (const link of findWikiLinks(body)) {
      const key = link.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: link.title, note: resolveNote(notes, link.title) });
    }
    return out;
  });
  const breadcrumb = $derived(current ? ancestorsOf(entries, current) : []);
  const folderOptions = $derived(
    [...folders].sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()))
  );
  const fileStem = $derived((title.trim() || 'note').replace(/[^a-z0-9._-]+/gi, '-'));
  const selectedNotes = $derived(flattenTree(tree).filter((n) => selected.has(n.id) && !folderIds.has(n.id)));
  const selectedCount = $derived(selectedNotes.length);
  const bulkTargets = $derived(
    moveTargets(entries, selected).filter((e) => folderIds.has(e.id))
  );
  const selectableNotes = $derived(searching ? hits.map((h) => h.note) : notes);

  /* ── wiki plumbing ─────────────────────────────────────────────────── */
  const wikiHref = (t: string): string => href('/') + '?note=' + encodeURIComponent(t);
  const wikiExists = (t: string): boolean => resolveNote(notes, t) !== null;

  function navigateWiki(t: string): void {
    const found = resolveNote(notes, t);
    if (found) void openNote(found);
    else void createNote(t.trim() || 'Untitled', current ? current.parent_id : null);
  }

  /* ── feedback ──────────────────────────────────────────────────────── */
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

  onMount(() => {
    const prefs = loadPrefs();
    if (prefs.mode === 'source' || prefs.mode === 'preview') mode = prefs.mode;
    sidebarOpen = prefs.sidebarOpen;

    void (async () => {
      try {
        store = await openVaultStore();
        await refreshFromRows();
        booted = true;
        // Deep link beats the startup preference; it is an explicit ask.
        const wanted = new URLSearchParams(location.search).get('note');
        if (wanted) {
          const found = resolveNote(notes, wanted);
          if (found) await openNote(found);
          else missingLink = wanted;
          return;
        }
        if (prefs.startup === 'blank') {
          openScratch();
          return;
        }
        const remembered = prefs.lastNote ? notes.find((n) => n.id === prefs.lastNote) : undefined;
        if (remembered) await openNote(remembered, { remember: false });
      } catch (err) {
        bootError = String(err);
      }
    })();

    const onHide = (): void => void flushSave();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') void flushSave();
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        quickOpen = !quickOpen;
      }
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKeydown);
    };
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(feedbackTimer);
    void flushSave();
  });

  /* ── open / close ──────────────────────────────────────────────────── */
  function snapshotExtras(data: Record<string, unknown>): { key: string; value: string }[] {
    const OWNED = new Set(['created', 'updated', 'tags', 'aliases']);
    return Object.entries(data)
      .filter(([key]) => !OWNED.has(key))
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }));
  }

  async function openNote(note: Note, opts: { remember?: boolean } = {}): Promise<void> {
    if (currentPath === note.id && !scratchOpen) return;
    await flushSave();
    scratchOpen = false;
    switching = true;
    currentPath = note.id;
    title = note.title;
    savedTitle = note.title;
    body = note.body_md;
    tagsText = note.tags.join(', ');
    aliases = [...note.aliases];
    parentId = note.parent_id;
    extraRows = snapshotExtras(fmData.get(note.id) ?? {});
    createdAt = note.created_at;
    updatedAt = note.updated_at;
    renameOffer = null;
    exportNote = null;
    saveState = null;
    missingLink = null;
    try {
      if (!store) return;
      const assets = noteAssetStore(store, note.id);
      await assets.prime();
      if (destroyed || currentPath !== note.id) return;
      assetStore = assets;
      const stats = assets.stats();
      assetCount = stats.count;
      assetBytes = stats.bytes;
      if (opts.remember !== false) savePrefs({ lastNote: note.id });
    } finally {
      switching = false;
    }
  }

  function openScratch(): void {
    void (async () => {
      await flushSave();
      currentPath = null;
      scratchOpen = true;
      title = '';
      savedTitle = '';
      body = loadScratch();
      tagsText = '';
      aliases = [];
      parentId = null;
      extraRows = [];
      createdAt = null;
      updatedAt = '';
      assetStore = null;
      assetCount = 0;
      assetBytes = 0;
      renameOffer = null;
      saveState = null;
    })();
  }

  async function closeNote(): Promise<void> {
    await flushSave();
    currentPath = null;
    scratchOpen = false;
    savePrefs({ lastNote: null });
  }

  /* ── create ────────────────────────────────────────────────────────── */
  const allPaths = (): string[] => [...folders.map((f) => f.id), ...notes.map((n) => n.id)];

  async function createNote(newTitle: string, folder: string | null): Promise<void> {
    if (!store) return;
    switching = true;
    try {
      const now = new Date().toISOString();
      const path = uniqueNotePath(folder, newTitle, allPaths());
      const note: Note = {
        id: path,
        title: stemOf(nameOf(path)),
        body_md: '',
        aliases: [],
        tags: [],
        parent_id: folder,
        fm: {},
        created_at: now,
        updated_at: now,
      };
      await store.write({ path, kind: 'note', content: noteContentOf(note) });
      await refreshFromRows();
      if (folder && collapsed.has(folder)) {
        const next = new Set(collapsed);
        next.delete(folder);
        collapsed = next;
      }
      const created = notes.find((n) => n.id === path);
      if (created) await openNote(created);
      flash('Note created.');
      if (newTitle === 'Untitled') {
        await tick();
        titleField?.select();
      }
    } finally {
      switching = false;
    }
  }

  /* One inline name editor at a time: a new notebook, a new subfolder, or
     a folder rename. prompt() is unusable chrome; the input lives in the
     tree where the name will land. */
  let nameEditor = $state<{ kind: 'new-book' | 'new-sub' | 'rename'; target: string | null; value: string } | null>(null);

  function startNewNotebook(): void {
    nameEditor = { kind: 'new-book', target: null, value: '' };
  }

  function startNewSubfolder(parent: string): void {
    const next = new Set(collapsed);
    next.delete(parent);
    collapsed = next;
    nameEditor = { kind: 'new-sub', target: parent, value: '' };
  }

  function startRenameFolder(folder: FolderEntry): void {
    nameEditor = { kind: 'rename', target: folder.id, value: folder.title };
  }

  async function commitNameEditor(): Promise<void> {
    if (!store || !nameEditor) return;
    const { kind, target, value } = nameEditor;
    const name = value.trim();
    nameEditor = null;
    if (!name) return;
    if (kind === 'new-book') {
      const path = uniqueFolderPath(null, name, allPaths());
      await store.mkdir(path);
      await refreshFromRows();
      flash(`Notebook “${nameOf(path)}” created.`);
    } else if (kind === 'new-sub' && target) {
      const path = uniqueFolderPath(target, name, allPaths());
      await store.mkdir(path);
      await refreshFromRows();
    } else if (kind === 'rename' && target) {
      const folder = toFolder(target);
      if (name === folder.title) return;
      await flushSave();
      const to = uniqueFolderPath(folder.parent_id, name, allPaths().filter((p) => p !== target));
      await store.rename(target, to);
      if (currentPath?.startsWith(target + '/')) {
        currentPath = to + currentPath.slice(target.length);
        parentId = parentOf(currentPath);
      }
      await refreshFromRows();
      flash('Folder renamed. Wiki links resolve by note title, so they still work.');
    }
  }

  function nameEditorKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitNameEditor();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      nameEditor = null;
    }
  }

  /* ── file the scratch buffer ───────────────────────────────────────── */
  async function fileScratch(): Promise<void> {
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
    const path = uniqueNotePath(null, newTitle, allPaths());
    const note: Note = {
      id: path,
      title: stemOf(nameOf(path)),
      body_md: text,
      aliases: [],
      tags: parseTags(tagsText),
      parent_id: null,
      fm: {},
      created_at: now,
      updated_at: now,
    };
    await store.write({ path, kind: 'note', content: noteContentOf(note) });
    saveScratch('');
    await refreshFromRows();
    scratchOpen = false;
    const created = notes.find((n) => n.id === path);
    if (created) await openNote(created);
    flash('Filed into the Pile.');
  }

  /* ── autosave ──────────────────────────────────────────────────────── */
  function scheduleSave(): void {
    if (scratchOpen) {
      saveScratch(body);
      return;
    }
    if (!currentPath) return;
    saveState = 'saving';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
  }

  async function flushSave(): Promise<void> {
    editor?.flush();
    if (scratchOpen) {
      saveScratch(body);
      return;
    }
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await doSave();
    }
  }

  function extrasToFm(rows: { key: string; value: string }[], original: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      const before = original[key];
      // An untouched non-string value keeps its type; edited values are text.
      out[key] = before !== undefined && typeof before !== 'string' && JSON.stringify(before) === row.value ? before : row.value;
    }
    return out;
  }

  async function doSave(): Promise<void> {
    if (!store) return;
    const id = currentPath;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!id) return;
    const row = notes.find((n) => n.id === id);
    if (!row) {
      saveState = 'error';
      return;
    }

    const oldTitle = savedTitle.trim();
    const nextTitleRaw = title.trim() || 'Untitled';
    const renames =
      oldTitle !== '' && oldTitle.toLowerCase() !== 'untitled' && nextTitleRaw !== oldTitle;
    const nextAliases = renames
      ? [...new Set([...aliases, oldTitle])].filter((a) => a.toLowerCase() !== nextTitleRaw.toLowerCase())
      : aliases;

    const targetFolder = parentId;
    let targetPath = id;
    let nextBody = body;
    const folderChanged = targetFolder !== row.parent_id;
    const titleChanged = sanitizeTitle(nextTitleRaw) !== stemOf(nameOf(id));

    try {
      if (folderChanged || titleChanged) {
        targetPath = uniqueNotePath(
          targetFolder,
          nextTitleRaw,
          allPaths().filter((p) => p !== id)
        );
        if (folderChanged) {
          nextBody = await moveNoteAssets(id, targetPath, nextBody);
        }
        await store.rename(id, targetPath);
      }

      const now = new Date().toISOString();
      const note: Note = {
        id: targetPath,
        title: stemOf(nameOf(targetPath)),
        body_md: nextBody,
        aliases: nextAliases,
        tags: parseTags(tagsText),
        parent_id: targetFolder,
        fm: extrasToFm(extraRows, fmData.get(id) ?? {}),
        created_at: createdAt ?? now,
        updated_at: now,
      };
      await store.write({ path: targetPath, kind: 'note', content: noteContentOf(note, fmData.get(id) ?? {}) });
      await refreshFromRows();

      if (currentPath !== id) return; // the user moved on; the write stands
      currentPath = targetPath;
      body = nextBody;
      aliases = nextAliases;
      savedTitle = nextTitleRaw;
      updatedAt = now;
      createdAt = note.created_at;
      saveState = 'saved';
      if (currentPath) savePrefs({ lastNote: currentPath });
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
      saveState = 'error';
      flash('Save failed: ' + String(err));
    }
  }

  /** A late editor flush after a switch: write to THAT note, not the open one. */
  function onBodyChange(md: string, forPath: string | null, wasScratch: boolean): void {
    if (wasScratch) {
      if (scratchOpen) {
        body = md;
        saveScratch(md);
      } else saveScratch(md);
      return;
    }
    if (forPath === currentPath) {
      body = md;
      scheduleSave();
      return;
    }
    // Stale flush — patch the old note's row directly.
    void (async () => {
      if (!store || !forPath) return;
      const row = notes.find((n) => n.id === forPath);
      if (!row) return;
      const now = new Date().toISOString();
      const patched: Note = { ...row, body_md: md, updated_at: now };
      await store.write({ path: forPath, kind: 'note', content: noteContentOf(patched, fmData.get(forPath) ?? {}) });
      await refreshFromRows();
    })();
  }

  /* ── asset moves (note changed folder) ─────────────────────────────── */
  async function moveNoteAssets(fromPath: string, toPath: string, md: string): Promise<string> {
    if (!store) return md;
    const fromFolder = parentOf(fromPath);
    const toFolder2 = parentOf(toPath);
    if (fromFolder === toFolder2) return md;
    let out = md;
    const refs = assetRefsIn(md);
    if (refs.length === 0) return md;
    const othersInFolder = notes.filter((n) => n.id !== fromPath && n.parent_id === fromFolder);
    const targetDir = toFolder2 ? `${toFolder2}/.assets` : '.assets';
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
        path: toFolder2 ? `${toFolder2}/.assets/${targetName}` : `.assets/${targetName}`,
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
    for (const n of notes) {
      if (n.id === currentPath) continue;
      const hasLink = findWikiLinks(n.body_md).some((l) => l.title.trim().toLowerCase() === from.toLowerCase());
      if (!hasLink) continue;
      const next: Note = { ...n, body_md: rewriteWikiLinks(n.body_md, from, to), updated_at: new Date().toISOString() };
      await store.write({ path: n.id, kind: 'note', content: noteContentOf(next, fmData.get(n.id) ?? {}) });
      count++;
    }
    await refreshFromRows();
    renameOffer = null;
    flash(`Updated links in ${count} note${count === 1 ? '' : 's'}.`);
  }

  /* ── delete ────────────────────────────────────────────────────────── */
  async function removeNoteAssetsFor(note: Note): Promise<void> {
    if (!store) return;
    const folder = note.parent_id;
    const siblings = notes.filter((n) => n.id !== note.id && n.parent_id === folder);
    for (const ref of assetRefsIn(note.body_md)) {
      const used = siblings.some((n) => assetRefsIn(n.body_md).includes(ref));
      if (used) continue;
      const name = ref.slice('.assets/'.length);
      await store.remove(folder ? `${folder}/.assets/${name}` : `.assets/${name}`);
    }
  }

  async function deleteNote(note: Note): Promise<void> {
    if (!store) return;
    if (!confirm(`Delete “${displayTitle(note)}”? Its images go with it.`)) return;
    if (note.id === currentPath) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      currentPath = null;
    } else {
      await flushSave();
    }
    await removeNoteAssetsFor(note);
    await store.remove(note.id);
    const nextSelected = new Set(selected);
    nextSelected.delete(note.id);
    selected = nextSelected;
    await refreshFromRows();
    flash('Note deleted.');
  }

  async function deleteFolder(folder: FolderEntry): Promise<void> {
    if (!store) return;
    const inside = subtreeIds(tree, folder.id).filter((p) => p !== folder.id);
    const noteCount = inside.filter((p) => !folderIds.has(p)).length;
    const message =
      inside.length > 0
        ? `Delete “${folder.title}”? The ${noteCount} note${noteCount === 1 ? '' : 's'} inside move up a level, they are not deleted.`
        : `Delete the empty “${folder.title}”?`;
    if (!confirm(message)) return;
    await flushSave();
    const parent = folder.parent_id;
    // Children move up, never cascade: notes go through the asset-aware
    // move; subfolders rename wholesale (their .assets ride along).
    const childNotes = notes.filter((n) => n.parent_id === folder.id);
    const childFolders = folders.filter((f) => f.parent_id === folder.id);
    for (const n of childNotes) {
      const target = uniqueNotePath(parent, n.title, allPaths().filter((p) => p !== n.id));
      const newBody = await moveNoteAssets(n.id, target, n.body_md);
      await store.rename(n.id, target);
      if (newBody !== n.body_md) {
        const moved: Note = { ...n, id: target, body_md: newBody, parent_id: parent };
        await store.write({ path: target, kind: 'note', content: noteContentOf(moved, fmData.get(n.id) ?? {}) });
      }
      if (currentPath === n.id) currentPath = target;
    }
    for (const f of childFolders) {
      const target = uniqueFolderPath(parent, f.title, allPaths().filter((p) => p !== f.id));
      await store.rename(f.id, target);
      if (currentPath?.startsWith(f.id + '/')) currentPath = target + currentPath.slice(f.id.length);
    }
    await store.remove(folder.id);
    await refreshFromRows();
    if (currentPath) {
      const reopened = notes.find((n) => n.id === currentPath);
      if (reopened) {
        parentId = reopened.parent_id;
      } else {
        currentPath = null;
      }
    }
    flash('Notebook deleted; its notes moved up.');
  }

  /* ── tree chrome ───────────────────────────────────────────────────── */
  function toggleCollapsed(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function toggleSidebar(): void {
    sidebarOpen = !sidebarOpen;
    savePrefs({ sidebarOpen });
    if (!sidebarOpen) selected = new Set();
  }

  function setMode(next: EditorMode): void {
    mode = next;
    savePrefs({ mode: next });
  }

  /* ── bulk ──────────────────────────────────────────────────────────── */
  function toggleSelected(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function selectAll(): void {
    selected = new Set([...selected, ...selectableNotes.map((n) => n.id)]);
  }

  function selectNone(): void {
    selected = new Set();
  }

  async function bulkTags(action: 'add' | 'remove'): Promise<void> {
    if (!store || selectedCount === 0 || bulkBusy) return;
    const change = parseTags(bulkTagsText);
    if (change.length === 0) return;
    await flushSave();
    bulkBusy = true;
    try {
      let touched = 0;
      for (const n of selectedNotes) {
        const base = n.id === currentPath ? parseTags(tagsText) : n.tags;
        const next = action === 'add' ? addTags(base, change) : removeTags(base, change);
        if (next.length === base.length && next.every((t, i) => t === base[i])) continue;
        const row: Note = { ...n, tags: next, updated_at: new Date().toISOString() };
        await store.write({ path: n.id, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) });
        if (n.id === currentPath) tagsText = next.join(', ');
        touched++;
      }
      await refreshFromRows();
      bulkNote = `${action === 'add' ? 'Added' : 'Removed'} ${change.length} tag${change.length === 1 ? '' : 's'} on ${touched} note${touched === 1 ? '' : 's'}.`;
    } finally {
      bulkBusy = false;
    }
  }

  async function bulkMove(): Promise<void> {
    if (!store || selectedCount === 0 || bulkBusy) return;
    const target = bulkParent === '' ? null : bulkParent;
    if (target !== null && !bulkTargets.some((t) => t.id === target)) {
      bulkNote = 'That destination is no longer available.';
      return;
    }
    await flushSave();
    bulkBusy = true;
    try {
      let moved = 0;
      for (const n of selectedNotes) {
        if (n.parent_id === target) continue;
        const to = uniqueNotePath(target, n.title, allPaths().filter((p) => p !== n.id));
        const newBody = await moveNoteAssets(n.id, to, n.body_md);
        await store.rename(n.id, to);
        const row: Note = { ...n, id: to, parent_id: target, body_md: newBody, updated_at: new Date().toISOString() };
        await store.write({ path: to, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) });
        if (currentPath === n.id) {
          currentPath = to;
          parentId = target;
        }
        moved++;
      }
      if (target && collapsed.has(target)) {
        const next = new Set(collapsed);
        next.delete(target);
        collapsed = next;
      }
      selected = new Set();
      await refreshFromRows();
      bulkNote = `Moved ${moved} note${moved === 1 ? '' : 's'}.`;
    } finally {
      bulkBusy = false;
    }
  }

  async function bulkDelete(): Promise<void> {
    if (!store || selectedCount === 0 || bulkBusy) return;
    if (!confirm(`Delete ${selectedCount} note${selectedCount === 1 ? '' : 's'}? Their images go with them.`)) return;
    if (currentPath && selected.has(currentPath)) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      currentPath = null;
    } else {
      await flushSave();
    }
    bulkBusy = true;
    try {
      const doomed = [...selectedNotes];
      for (const n of doomed) {
        await removeNoteAssetsFor(n);
        await store.remove(n.id);
      }
      selected = new Set();
      await refreshFromRows();
      bulkNote = `Deleted ${doomed.length} note${doomed.length === 1 ? '' : 's'}.`;
    } finally {
      bulkBusy = false;
    }
  }

  async function bulkExport(): Promise<void> {
    if (!store || selectedCount === 0 || bulkBusy) return;
    await flushSave();
    bulkBusy = true;
    try {
      const entriesOut: ZipEntry[] = [];
      const taken = new Set<string>();
      let externals = 0;
      for (const n of selectedNotes) {
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
        const name = exportFileName(noteTitle, bulkFormat, taken);
        if (bulkFormat === 'md') {
          entriesOut.push({ name, data: markdownExport({ title: noteTitle, body_md: noteBody }, { assets: urls, inlineAssets: true }) });
        } else {
          const { html, fonts, css } = await renderForExport(noteBody, urls);
          const doc = htmlExport({ title: noteTitle, bodyHtml: html, extraCss: css ? [css] : [], fonts });
          externals += externalReferences(doc).length;
          entriesOut.push({ name, data: doc });
        }
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(zipBlob(entriesOut), `notes-${stamp}.zip`);
      bulkNote =
        `Exported ${entriesOut.length} note${entriesOut.length === 1 ? '' : 's'}.` +
        (externals > 0 ? ` ${externals} external link${externals === 1 ? '' : 's'} left as written.` : '');
    } finally {
      bulkBusy = false;
    }
  }

  /* ── exports (single note) ─────────────────────────────────────────── */
  function assetDataUrls(md: string = body, assets: NoteAssetStore | null = assetStore): Map<string, string> {
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
    const md = markdownExport({ title: title.trim() || 'Untitled', body_md: body }, { assets: assetDataUrls(), inlineAssets: true });
    downloadText(md, `${fileStem}.md`, 'text/markdown');
    exportNote = null;
  }

  async function renderForExport(md: string = body, assets: Map<string, string> = assetDataUrls()): Promise<{ html: string; fonts: Awaited<ReturnType<typeof collectMathFonts>>; css: string }> {
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
    const doc = htmlExport({ title: title.trim() || 'Untitled', bodyHtml: html, extraCss: css ? [css] : [], fonts });
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

  /* ── frontmatter extras ────────────────────────────────────────────── */
  function addExtraRow(): void {
    extraRows = [...extraRows, { key: '', value: '' }];
  }

  function removeExtraRow(index: number): void {
    extraRows = extraRows.filter((_, i) => i !== index);
    scheduleSave();
  }

  function fmStamp(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  }
</script>

{#if bootError}
  <div class="boot-error" role="alert">
    <p class="eyebrow eyebrow-stamp">The vault did not open</p>
    <p>{bootError}</p>
  </div>
{:else}
  <div class="app" class:library-open={sidebarOpen}>
    <aside class="library" data-print="hide" hidden={!sidebarOpen}>
      <div class="library-controls">
        <button class="btn btn-sm" data-testid="notebook-new" onclick={() => void createNote('Untitled', null)}>+ Note</button>
        <button class="btn btn-sm" data-testid="notey-new-notebook" onclick={startNewNotebook}>+ Notebook</button>
      </div>
      {#if nameEditor?.kind === 'new-book'}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name-editor"
          type="text"
          placeholder="Notebook name (Enter)"
          data-testid="notey-name-editor"
          autofocus
          bind:value={nameEditor.value}
          onkeydown={nameEditorKeydown}
          onblur={() => void commitNameEditor()}
        />
      {/if}
      <input
        class="library-search"
        type="search"
        placeholder="Search… (tag:x book:y)"
        data-testid="notebook-search"
        bind:value={search}
      />

      {#if selectedCount > 0}
        <section class="bulk" data-testid="notebook-bulk">
          <div class="row wrap">
            <span class="eyebrow" data-testid="notebook-bulk-selected">{selectedCount} selected</span>
            <button class="btn btn-sm" data-testid="notebook-bulk-select-all" onclick={selectAll}>All</button>
            <button class="btn btn-sm" data-testid="notebook-bulk-select-none" onclick={selectNone}>Clear</button>
          </div>
          <div class="row wrap">
            <select data-testid="notebook-bulk-format" bind:value={bulkFormat}>
              <option value="md">Markdown</option>
              <option value="html">HTML</option>
            </select>
            <button class="btn btn-sm" data-testid="notebook-bulk-export" disabled={bulkBusy} onclick={() => void bulkExport()}>.zip</button>
          </div>
          <div class="row wrap">
            <input type="text" placeholder="tags, comma-separated" data-testid="notebook-bulk-tags" bind:value={bulkTagsText} />
            <button class="btn btn-sm" data-testid="notebook-bulk-tags-add" disabled={bulkBusy} onclick={() => void bulkTags('add')}>Add</button>
            <button class="btn btn-sm" data-testid="notebook-bulk-tags-remove" disabled={bulkBusy} onclick={() => void bulkTags('remove')}>Remove</button>
          </div>
          <div class="row wrap">
            <select data-testid="notebook-bulk-parent" bind:value={bulkParent}>
              <option value="">— the Pile —</option>
              {#each bulkTargets as target (target.id)}
                <option value={target.id}>{target.id}</option>
              {/each}
            </select>
            <button class="btn btn-sm" data-testid="notebook-bulk-move" disabled={bulkBusy} onclick={() => void bulkMove()}>Move</button>
            <button class="btn btn-sm btn-danger" data-testid="notebook-bulk-delete" disabled={bulkBusy} onclick={() => void bulkDelete()}>Delete</button>
          </div>
        </section>
      {/if}
      <p class="bulk-note" role="status" data-testid="notebook-bulk-note">{bulkNote ?? ''}</p>

      {#if !booted}
        <p class="muted">Opening the vault…</p>
      {:else if searching}
        <ul class="tree flat" data-testid="notebook-search-results">
          {#each hits as hit (hit.note.id)}
            <li>
              {@render noteRow(hit.note, 0, true)}
              {#if hit.snippet}<p class="snippet">{hit.snippet}</p>{/if}
            </li>
          {:else}
            <li class="muted" data-testid="notebook-no-matches">Nothing matches that.</li>
          {/each}
        </ul>
      {:else}
        <p class="eyebrow section-label">The Pile</p>
        <ul class="tree" data-testid="notebook-tree">
          {#each pileNotes as note (note.id)}
            <li>{@render noteRow(note, 0, false)}</li>
          {:else}
            <li class="muted" data-testid="notebook-no-notes">No loose notes yet.</li>
          {/each}
        </ul>
        <p class="eyebrow section-label">Notebooks</p>
        <ul class="tree">
          {#each notebooks as book (book.id)}
            <li>{@render branch(book, 0)}</li>
          {:else}
            <li class="muted">No notebooks yet.</li>
          {/each}
        </ul>
      {/if}
    </aside>

    <section class="desk">
      <div class="desk-bar" data-print="hide">
        <button class="btn btn-sm" data-testid="notebook-toggle-library" onclick={toggleSidebar}>
          {sidebarOpen ? '‹ Library' : '› Library'}
        </button>
        {#if feedback}<span class="feedback" role="status" data-testid="notebook-feedback">{feedback}</span>{/if}
        {#if missingLink}
          <span class="missing-banner" data-testid="notebook-missing-link">
            No note called “{missingLink}”.
            <button class="btn btn-sm" data-testid="notebook-create-missing" onclick={() => { const t = missingLink ?? 'Untitled'; missingLink = null; void createNote(t, null); }}>
              Create it
            </button>
          </span>
        {/if}
        <span class="desk-spacer"></span>
        <button class="btn btn-sm" onclick={() => (quickOpen = true)} title="Ctrl+K">Go to…</button>
        <button class="btn btn-sm" data-testid="notey-scratch" onclick={openScratch}>Blank page</button>
      </div>

      {#if currentPath !== null || scratchOpen}
        <article class="sheet" data-testid="notey-sheet">
          <header class="sheet-head">
            <div class="head-left">
              {#if breadcrumb.length > 0}
                <nav class="breadcrumb" data-testid="notebook-breadcrumb">
                  {#each breadcrumb as crumb (crumb.id)}
                    <span>{crumb.title}</span><span class="crumb-sep">/</span>
                  {/each}
                </nav>
              {:else if scratchOpen}
                <p class="eyebrow eyebrow-stamp">Unfiled · lives in this browser tab</p>
              {:else}
                <p class="eyebrow">The Pile</p>
              {/if}
              <input
                class="title-input"
                type="text"
                placeholder="Untitled"
                aria-label="Note title"
                data-testid="notebook-title"
                bind:this={titleField}
                bind:value={title}
                disabled={switching}
                oninput={scheduleSave}
              />
              {#if aliases.length > 0}
                <p class="muted aliases" data-testid="notebook-aliases">Also answers to: {aliases.join(', ')}</p>
              {/if}
            </div>

            <div class="head-right">
              {#if !scratchOpen}
                <div class="fm-row">
                  <span class="fm-key">created</span>
                  <span class="fm-value">{fmStamp(createdAt)}</span>
                </div>
                <div class="fm-row">
                  <span class="fm-key">updated</span>
                  <span class="fm-value">{fmStamp(updatedAt)}</span>
                </div>
                <div class="fm-row">
                  <label class="fm-key" for="notey-inside">inside</label>
                  <select id="notey-inside" class="fm-input" data-testid="notebook-parent" bind:value={parentId} disabled={switching} onchange={scheduleSave}>
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
                    disabled={switching}
                    oninput={scheduleSave}
                  />
                </div>
                {#each extraRows as row, i (i)}
                  <div class="fm-row">
                    <input class="fm-key fm-key-input" type="text" placeholder="key" bind:value={row.key} oninput={scheduleSave} />
                    <input class="fm-input" type="text" placeholder="value" bind:value={row.value} oninput={scheduleSave} />
                    <button class="fm-remove" title="Remove field" onclick={() => removeExtraRow(i)}>×</button>
                  </div>
                {/each}
                <button class="fm-add" data-testid="notey-fm-add" onclick={addExtraRow}>+ field</button>
              {:else}
                <div class="fm-row">
                  <label class="fm-key" for="notey-tags-scratch">tags</label>
                  <input id="notey-tags-scratch" class="fm-input" type="text" placeholder="comma, separated" bind:value={tagsText} />
                </div>
                <button class="btn btn-sm btn-primary" data-testid="notey-file-scratch" onclick={() => void fileScratch()}>File this note</button>
              {/if}
            </div>

            {#if !scratchOpen}
              <div class="head-stamp" data-testid="notebook-save-state" aria-live="polite">
                {#if saveState === 'saving'}<span class="stamp">Saving…</span>
                {:else if saveState === 'saved'}<span class="stamp stamp-ok">Saved</span>
                {:else if saveState === 'error'}<span class="stamp stamp-bad">Not saved</span>{/if}
              </div>
            {/if}
          </header>

          <div class="red-rule" aria-hidden="true"></div>

          {#if renameOffer}
            <p class="rename-offer" data-testid="notebook-rename-offer">
              {renameOffer.count} note{renameOffer.count === 1 ? ' still links' : 's still link'} to “{renameOffer.from}”.
              <button class="btn btn-sm" data-testid="notebook-rewrite-links" onclick={() => void rewriteLinks()}>
                Update them to “{renameOffer.to}”
              </button>
            </p>
          {/if}

          <div class="editor-host" data-testid="notebook-editor-host">
            {#key scratchOpen ? '×scratch×' : currentPath}
              {@const editingPath = currentPath}
              {@const editingScratch = scratchOpen}
              <MarkdownEditor
                bind:this={editor}
                value={body}
                onChange={(md) => onBodyChange(md, editingPath, editingScratch)}
                assets={assetStore ?? undefined}
                debounce={150}
                {mode}
                onMode={setMode}
                {wikiExists}
                {wikiHref}
                onWikiNavigate={navigateWiki}
                placeholder="Write… Link with [[Title]], cite with Alt+0."
                minHeight="24rem"
              />
            {/key}
          </div>

          {#if !scratchOpen}
            <footer class="sheet-foot" data-print="hide">
              <details class="foot-card">
                <summary class="eyebrow">Links {linksHere.length + linksOut.length > 0 ? `· ${linksHere.length} in / ${linksOut.length} out` : ''}</summary>
                <div class="foot-body">
                  <p class="eyebrow">Linked from</p>
                  {#if linksHere.length === 0}
                    <p class="muted" data-testid="notebook-no-backlinks">Nothing links here yet.</p>
                  {:else}
                    <ul class="link-list" data-testid="notebook-backlinks">
                      {#each linksHere as back (back.note.id)}
                        <li>
                          <button class="link-btn" data-testid="notebook-backlink" data-title={back.note.title} onclick={() => void openNote(back.note)}>
                            {displayTitle(back.note)}
                          </button>
                          {#if back.count > 1}<span class="muted">×{back.count}</span>{/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <p class="eyebrow">Links to</p>
                  {#if linksOut.length === 0}
                    <p class="muted">No [[links]] in this note.</p>
                  {:else}
                    <ul class="link-list" data-testid="notebook-outlinks">
                      {#each linksOut as out (out.title)}
                        <li>
                          <button class="link-btn" class:missing={!out.note} data-testid="notebook-outlink" onclick={() => navigateWiki(out.title)}>
                            {out.title}{out.note ? '' : ' (create)'}
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              </details>

              <details class="foot-card">
                <summary class="eyebrow">Export</summary>
                <div class="foot-body">
                  <div class="row wrap">
                    <button class="btn btn-sm" data-testid="notebook-export-md" onclick={downloadMarkdown}>Download Markdown</button>
                    <button class="btn btn-sm" data-testid="notebook-export-html" onclick={() => void downloadHtml()}>Download HTML</button>
                    <button class="btn btn-sm" data-testid="notebook-print" onclick={() => void printNote()}>Print / PDF</button>
                  </div>
                  {#if assetCount > 0}
                    <p class="muted" data-testid="notebook-asset-summary">
                      {assetCount} image{assetCount === 1 ? '' : 's'}, {Math.round(assetBytes / 1024)} KB
                    </p>
                  {/if}
                  {#if exportNote}<p class="muted" data-testid="notebook-export-note">{exportNote}</p>{/if}
                </div>
              </details>

              <div class="row">
                <button class="btn btn-sm" data-testid="notebook-close" onclick={() => void closeNote()}>Close</button>
                {#if current}
                  <button class="btn btn-sm btn-danger" data-testid="notebook-delete" onclick={() => current && void deleteNote(current)}>Delete</button>
                {/if}
              </div>
            </footer>
          {/if}
        </article>
      {:else}
        <div class="sheet empty-sheet" data-testid="notebook-empty">
          <p class="eyebrow eyebrow-stamp">Acc. No. 0001 · your collection</p>
          <h1>A page is waiting.</h1>
          <p class="muted">
            Make a note, file it in a notebook, or drop it on the Pile. Link thoughts with
            [[double brackets]] and the notebook remembers who links back.
          </p>
          <div class="row">
            <button class="btn btn-primary" onclick={() => void createNote('Untitled', null)}>Start a note</button>
            <button class="btn" onclick={openScratch}>Blank page</button>
          </div>
        </div>
      {/if}
    </section>
  </div>

  {#if quickOpen}
    <QuickSwitcher
      {notes}
      onPick={(note) => {
        quickOpen = false;
        void openNote(note);
      }}
      onClose={() => (quickOpen = false)}
    />
  {/if}

  {#if printHtml}
    <div class="print-only prose" data-testid="notebook-print-sheet">
      <h1>{title.trim() || 'Untitled'}</h1>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- DOMPurify-sanitized -->
      {@html printHtml}
    </div>
  {/if}
{/if}

{#snippet noteRow(note: Note, depth: number, withPath: boolean)}
  <div class="tree-row" style={`--depth:${depth}`}>
    <input
      type="checkbox"
      class="row-check"
      aria-label={`Select ${displayTitle(note)}`}
      data-testid="notebook-bulk-check"
      data-title={note.title}
      checked={selected.has(note.id)}
      onchange={() => toggleSelected(note.id)}
    />
    <button
      class="row-title"
      class:current={note.id === currentPath}
      data-testid="notebook-note"
      data-title={note.title}
      onclick={() => void openNote(note)}
    >
      {displayTitle(note)}
      {#if withPath && note.parent_id}<span class="row-path">{note.parent_id}</span>{/if}
    </button>
    <button class="row-x" title="Delete note" data-testid={`notebook-delete-${note.id}`} onclick={() => void deleteNote(note)}>×</button>
  </div>
{/snippet}

{#snippet branch(entry: Note, depth: number)}
  {@const kids = tree.children.get(entry.id) ?? []}
  {@const isOpen = !collapsed.has(entry.id)}
  <div class="tree-row folder-row" style={`--depth:${depth}`}>
    <button class="row-caret" title={isOpen ? 'Collapse' : 'Expand'} data-testid={`notebook-collapse-${entry.id}`} onclick={() => toggleCollapsed(entry.id)}>
      {isOpen ? '▾' : '▸'}
    </button>
    {#if nameEditor?.kind === 'rename' && nameEditor.target === entry.id}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="name-editor in-row"
        type="text"
        data-testid="notey-name-editor"
        autofocus
        bind:value={nameEditor.value}
        onkeydown={nameEditorKeydown}
        onblur={() => void commitNameEditor()}
      />
    {:else}
      <button class="row-title folder-title" onclick={() => toggleCollapsed(entry.id)}>{entry.title}</button>
    {/if}
    <button class="row-x" title="New note inside" data-testid={`notebook-new-child-${entry.id}`} onclick={() => void createNote('Untitled', entry.id)}>+</button>
    <button class="row-x" title="New folder inside" onclick={() => startNewSubfolder(entry.id)}>▸+</button>
    <button class="row-x" title="Rename folder" onclick={() => startRenameFolder(toFolder(entry.id))}>✎</button>
    <button class="row-x" title="Delete folder" data-testid={`notebook-delete-${entry.id}`} onclick={() => void deleteFolder(toFolder(entry.id))}>×</button>
  </div>
  {#if nameEditor?.kind === 'new-sub' && nameEditor.target === entry.id}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="name-editor in-row"
      style={`margin-left: calc(${depth + 1} * var(--space-4))`}
      type="text"
      placeholder="Folder name (Enter)"
      data-testid="notey-name-editor"
      autofocus
      bind:value={nameEditor.value}
      onkeydown={nameEditorKeydown}
      onblur={() => void commitNameEditor()}
    />
  {/if}
  {#if isOpen}
    <ul class="tree nested">
      {#each kids as kid (kid.id)}
        <li>
          {#if folderIds.has(kid.id)}
            {@render branch(kid, depth + 1)}
          {:else}
            {@render noteRow(kid, depth + 1, false)}
          {/if}
        </li>
      {/each}
      {#if kids.length === 0}
        <li class="muted empty-branch" style={`--depth:${depth + 1}`}>empty</li>
      {/if}
    </ul>
  {/if}
{/snippet}

<style>
  .app {
    display: grid;
    grid-template-columns: 1fr;
    min-height: calc(100dvh - var(--navbar-height));
  }

  .app.library-open {
    grid-template-columns: var(--sidebar-width) 1fr;
  }

  /* ── the library (sidebar) ─────────────────────────────────────────── */
  .library {
    border-right: 1px solid var(--border-strong-color);
    padding: var(--space-4);
    position: sticky;
    top: 0;
    max-height: calc(100dvh - var(--navbar-height));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: color-mix(in srgb, var(--surface-color) 45%, var(--bg-color));
  }

  .library-controls {
    display: flex;
    gap: var(--space-2);
  }

  .library-search {
    width: 100%;
  }

  .section-label {
    margin-top: var(--space-3);
    border-bottom: 1px solid var(--border-color);
    padding-bottom: var(--space-1);
  }

  .tree {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .tree.nested {
    margin-left: 0;
  }

  .tree-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding-left: calc(var(--depth, 0) * var(--space-4));
    border-radius: var(--radius-sm);
  }

  .tree-row:hover {
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  }

  .row-check {
    accent-color: var(--color-primary);
  }

  .row-title {
    flex: 1;
    text-align: left;
    background: none;
    border: 0;
    padding: var(--space-1) var(--space-1);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    color: var(--text-color);
    overflow-wrap: anywhere;
  }

  .row-title.current {
    color: var(--color-primary-strong);
    font-weight: 700;
  }

  .folder-title {
    font-weight: 700;
    letter-spacing: var(--tracking-wide);
  }

  .row-path {
    display: block;
    font-size: var(--font-size-eyebrow);
    color: var(--text-muted-color);
  }

  .row-caret,
  .row-x {
    background: none;
    border: 0;
    cursor: pointer;
    color: var(--text-muted-color);
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    padding: 0 var(--space-1);
    opacity: 0;
  }

  .row-caret {
    opacity: 1;
  }

  .tree-row:hover .row-x,
  .row-x:focus-visible {
    opacity: 1;
  }

  .row-x:hover {
    color: var(--color-stamp);
  }

  .snippet {
    margin: 0 0 var(--space-2) calc(var(--space-4) + 1.2rem);
    font-size: var(--font-size-eyebrow);
    color: var(--text-muted-color);
  }

  .empty-branch {
    padding-left: calc(var(--depth, 0) * var(--space-4) + 1.4rem);
    font-size: var(--font-size-eyebrow);
  }

  .bulk {
    border: 1px solid var(--border-strong-color);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--surface-raised-color);
  }

  .bulk select,
  .bulk input[type='text'] {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .bulk-note:empty {
    display: none;
  }

  .bulk-note {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .name-editor {
    width: 100%;
    font-size: var(--font-size-sm);
  }

  .name-editor.in-row {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-1);
  }

  /* ── the desk + sheet ──────────────────────────────────────────────── */
  .desk {
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .desk-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .desk-spacer {
    flex: 1;
  }

  .feedback {
    color: var(--color-success);
    font-size: var(--font-size-sm);
  }

  .missing-banner {
    color: var(--color-warning);
    font-size: var(--font-size-sm);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sheet {
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-1);
    max-width: var(--page-max-width);
    width: 100%;
    margin: 0 auto;
    padding: var(--space-6);
    position: relative;
  }

  .empty-sheet {
    text-align: center;
    padding: var(--space-6) var(--space-6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
  }

  .sheet-head {
    display: grid;
    grid-template-columns: 1fr minmax(14rem, 0.7fr);
    gap: var(--space-5);
    align-items: start;
    padding-bottom: var(--space-4);
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

  .title-input:focus-visible {
    outline: none;
    border-bottom: 2px dashed var(--color-primary);
  }

  .aliases {
    font-size: var(--font-size-eyebrow);
  }

  /* Frontmatter block: above the red line, on the right. */
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

  .fm-remove {
    border: 0;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
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

  /* THE red rule — a double line, like the head of an index card. */
  .red-rule {
    border-top: 2px solid var(--rule-color);
    border-bottom: 1px solid var(--rule-color);
    height: 3px;
    margin: 0 calc(-1 * var(--space-6)) var(--space-4);
  }

  .rename-offer {
    font-size: var(--font-size-sm);
    color: var(--color-warning);
    margin-bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .editor-host {
    min-width: 0;
  }

  .sheet-foot {
    margin-top: var(--space-5);
    border-top: 1px dashed var(--border-strong-color);
    padding-top: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .foot-card summary {
    cursor: pointer;
    list-style: none;
  }

  .foot-card summary::before {
    content: '▸ ';
  }

  .foot-card[open] summary::before {
    content: '▾ ';
  }

  .foot-body {
    padding: var(--space-3) 0 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .link-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .link-btn {
    border: 0;
    background: none;
    color: var(--color-primary);
    text-decoration: underline;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    padding: 0;
  }

  .link-btn.missing {
    color: var(--color-stamp);
    text-decoration-style: dashed;
  }

  .boot-error {
    max-width: 36rem;
    margin: var(--space-6) auto;
    background: var(--surface-color);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    padding: var(--space-5);
  }

  @media (max-width: 52rem) {
    .app.library-open {
      grid-template-columns: 1fr;
    }

    .app.library-open .desk {
      display: none;
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

    .desk {
      padding: var(--space-3);
    }

    .sheet {
      padding: var(--space-4);
    }

    .red-rule {
      margin: 0 calc(-1 * var(--space-4)) var(--space-4);
    }
  }
</style>
