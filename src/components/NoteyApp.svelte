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
  import { openVaultStore } from '../lib/vault/store';
  import type { FolderEntry, Note, VaultStore } from '../lib/vault/types';
  import { loadPrefs, loadScratch, savePrefs, saveScratch, type EditorMode } from '../lib/prefs';

  const SAVE_DEBOUNCE_MS = 400;

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
  let extraRows = $state<{ key: string; value: string }[]>([]);
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
  let feedback = $state<string | null>(null);
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let missingLink = $state<string | null>(null);
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

  onMount(() => {
    // The page already IS the blank scratch (see bootScratch above); all
    // that is left is to open the vault and honour a deep link.
    void (async () => {
      try {
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
        if (bootPrefs.startup === 'blank') return; // already on the blank page
        const remembered = bootPrefs.lastNote
          ? notes.find((n) => n.id === bootPrefs.lastNote)
          : undefined;
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
        paletteOpen = !paletteOpen;
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
    mountPath = note.id;
    mountIsScratch = false;
    editorKey++;
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

  function openScratch(opts: { silent?: boolean } = {}): void {
    void (async () => {
      if (!opts.silent) await flushSave();
      const scratch = loadScratch();
      currentPath = null;
      scratchOpen = true;
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
      createdAt = null;
      updatedAt = '';
      assetStore = null;
      assetCount = 0;
      assetBytes = 0;
      renameOffer = null;
      exportNote = null;
      saveState = null;
    })();
  }

  async function closeNote(): Promise<void> {
    await flushSave();
    savePrefs({ lastNote: null });
    openScratch();
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
    const to = uniqueFolderPath(folder.parent_id, name.trim(), allPaths().filter((p) => p !== folder.id));
    await store.rename(folder.id, to);
    if (currentPath?.startsWith(folder.id + '/')) {
      currentPath = to + currentPath.slice(folder.id.length);
      parentId = parentOf(currentPath);
    }
    await refreshFromRows();
    flash('Folder renamed. Wiki links resolve by note title, so they still work.');
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
    const path = uniqueNotePath(folder, newTitle, allPaths());
    const note: Note = {
      id: path,
      title: stemOf(nameOf(path)),
      body_md: text,
      aliases: [],
      tags: parseTags(tagsText),
      parent_id: folder,
      fm: {},
      created_at: now,
      updated_at: now,
    };
    await store.write({ path, kind: 'note', content: noteContentOf(note) });
    saveScratch({ title: '', body: '' });
    await refreshFromRows();
    scratchOpen = false;
    const created = notes.find((n) => n.id === path);
    if (created) await openNote(created);
    flash(folder ? `Filed in ${folder}.` : 'Filed in the Pile.');
  }

  /* ── autosave ──────────────────────────────────────────────────────── */
  function scheduleSave(): void {
    if (scratchOpen) {
      saveScratch({ title, body });
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
      saveScratch({ title, body });
      return;
    }
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await doSave();
    }
  }

  function extrasToFm(
    rows: { key: string; value: string }[],
    original: Record<string, unknown>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      const before = original[key];
      // An untouched non-string value keeps its type; edited values are text.
      out[key] =
        before !== undefined && typeof before !== 'string' && JSON.stringify(before) === row.value
          ? before
          : row.value;
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
    const renames = oldTitle !== '' && oldTitle.toLowerCase() !== 'untitled' && nextTitleRaw !== oldTitle;
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
        targetPath = uniqueNotePath(targetFolder, nextTitleRaw, allPaths().filter((p) => p !== id));
        if (folderChanged) nextBody = await moveNoteAssets(id, targetPath, nextBody);
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
      await store.write({
        path: targetPath,
        kind: 'note',
        content: noteContentOf(note, fmData.get(id) ?? {}),
      });
      await refreshFromRows();

      if (currentPath !== id) return; // the user moved on; the write stands
      currentPath = targetPath;
      // The same editor is still mounted; it now belongs to the new path.
      if (mountPath === id) mountPath = targetPath;
      body = nextBody;
      aliases = nextAliases;
      savedTitle = nextTitleRaw;
      updatedAt = now;
      createdAt = note.created_at;
      saveState = 'saved';
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
      saveState = 'error';
      flash('Save failed: ' + String(err));
    }
  }

  /** A late editor flush after a switch: write to THAT note, not the open one. */
  function onBodyChange(md: string): void {
    const forPath = mountPath;
    const wasScratch = mountIsScratch;
    if (wasScratch) {
      if (scratchOpen) body = md;
      saveScratch({ title: scratchOpen ? title : '', body: md });
      return;
    }
    if (forPath === currentPath) {
      body = md;
      scheduleSave();
      return;
    }
    void (async () => {
      if (!store || !forPath) return;
      const row = notes.find((n) => n.id === forPath);
      if (!row) return;
      const patched: Note = { ...row, body_md: md, updated_at: new Date().toISOString() };
      await store.write({
        path: forPath,
        kind: 'note',
        content: noteContentOf(patched, fmData.get(forPath) ?? {}),
      });
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
      if (siblings.some((n) => assetRefsIn(n.body_md).includes(ref))) continue;
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
    const parent = folder.parent_id;
    // Children move up, never cascade: notes go through the asset-aware
    // move; subfolders rename wholesale (their .assets ride along).
    for (const n of notes.filter((n) => n.parent_id === folder.id)) {
      const target = uniqueNotePath(parent, n.title, allPaths().filter((p) => p !== n.id));
      const newBody = await moveNoteAssets(n.id, target, n.body_md);
      await store.rename(n.id, target);
      if (newBody !== n.body_md) {
        const moved: Note = { ...n, id: target, body_md: newBody, parent_id: parent };
        await store.write({
          path: target,
          kind: 'note',
          content: noteContentOf(moved, fmData.get(n.id) ?? {}),
        });
      }
      if (currentPath === n.id) currentPath = target;
    }
    for (const f of folders.filter((f) => f.parent_id === folder.id)) {
      const target = uniqueFolderPath(parent, f.title, allPaths().filter((p) => p !== f.id));
      await store.rename(f.id, target);
      if (currentPath?.startsWith(f.id + '/')) currentPath = target + currentPath.slice(f.id.length);
    }
    await store.remove(folder.id);
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
      for (const n of chosen) {
        const base = n.id === currentPath ? parseTags(tagsText) : n.tags;
        const next = action === 'tag-add' ? addTags(base, change) : removeTags(base, change);
        if (next.length === base.length && next.every((t, i) => t === base[i])) continue;
        const row: Note = { ...n, tags: next, updated_at: new Date().toISOString() };
        await store.write({ path: n.id, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) });
        if (n.id === currentPath) tagsText = next.join(', ');
        touched++;
      }
      await refreshFromRows();
      return `${action === 'tag-add' ? 'Added' : 'Removed'} ${change.length} tag${change.length === 1 ? '' : 's'} on ${touched} note${touched === 1 ? '' : 's'}.`;
    }

    if (action === 'move') {
      const target = argument === '' || argument === undefined ? null : argument;
      let moved = 0;
      for (const n of chosen) {
        if (n.parent_id === target) continue;
        const to = uniqueNotePath(target, n.title, allPaths().filter((p) => p !== n.id));
        const newBody = await moveNoteAssets(n.id, to, n.body_md);
        await store.rename(n.id, to);
        const row: Note = {
          ...n,
          id: to,
          parent_id: target,
          body_md: newBody,
          updated_at: new Date().toISOString(),
        };
        await store.write({ path: to, kind: 'note', content: noteContentOf(row, fmData.get(n.id) ?? {}) });
        if (currentPath === n.id) {
          currentPath = to;
          parentId = target;
        }
        moved++;
      }
      await refreshFromRows();
      return `Moved ${moved} note${moved === 1 ? '' : 's'}.`;
    }

    // delete
    if (!confirm(`Delete ${chosen.length} note${chosen.length === 1 ? '' : 's'}? Their images go with them.`)) {
      return 'Nothing deleted.';
    }
    if (currentPath && paths.includes(currentPath)) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      currentPath = null;
    }
    for (const n of chosen) {
      await removeNoteAssetsFor(n);
      await store.remove(n.id);
    }
    await refreshFromRows();
    if (!currentPath) openScratch({ silent: true });
    return `Deleted ${chosen.length} note${chosen.length === 1 ? '' : 's'}.`;
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
    extraRows = [...extraRows, { key: '', value: '' }];
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
  <div class="desk">
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

    <article class="sheet" data-testid="notey-sheet" class:unfiled={scratchOpen}>
      <header class="sheet-head">
        <div class="head-left">
          {#if breadcrumb.length > 0}
            <nav class="breadcrumb" data-testid="notebook-breadcrumb">
              {#each breadcrumb as crumb, i (i)}
                <span>{crumb}</span><span class="crumb-sep">/</span>
              {/each}
            </nav>
          {:else if !scratchOpen}
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
            <p class="muted aliases" data-testid="notebook-aliases">
              Also answers to: {aliases.join(', ')}
            </p>
          {/if}
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
                disabled={switching}
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
                disabled={switching}
                oninput={scheduleSave}
              />
            </div>
            {#each extraRows as row, i (i)}
              <div class="fm-row">
                <input
                  class="fm-key fm-key-input"
                  type="text"
                  placeholder="key"
                  aria-label="Frontmatter field name"
                  bind:value={row.key}
                  oninput={scheduleSave}
                />
                <input
                  class="fm-input"
                  type="text"
                  placeholder="value"
                  aria-label="Frontmatter field value"
                  bind:value={row.value}
                  oninput={scheduleSave}
                />
                <button class="fm-remove" title="Remove field" onclick={() => removeExtraRow(i)}>×</button>
              </div>
            {/each}
            <button class="fm-add" data-testid="notey-fm-add" onclick={addExtraRow}>+ field</button>
          </div>
        {/if}

        {#if saveState}
          <div class="head-stamp" data-testid="notebook-save-state" aria-live="polite">
            {#if saveState === 'saving'}<span class="stamp">Saving…</span>
            {:else if saveState === 'saved'}<span class="stamp stamp-ok">Saved</span>
            {:else}<span class="stamp stamp-bad">Not saved</span>{/if}
          </div>
        {/if}
      </header>

      <div class="red-rule" aria-hidden="true"></div>

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
            placeholder="Press Ctrl+K for commands, or just start typing."
            minHeight="20rem"
          />
        {/key}
      </div>
    </article>
  </div>

  {#if paletteOpen}
    <CommandPalette
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
      onSettings={() => (location.href = href('/settings/'))}
      onClose={() => (paletteOpen = false)}
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

  /* ── the book ──────────────────────────────────────────────────────── */
  .book {
    position: fixed;
    top: calc(var(--navbar-height) + var(--space-3));
    right: var(--space-5);
    /* Above the palette backdrop (z-index 80): the book opens the library
       and must also be able to close it. */
    z-index: 90;
    width: 2.6rem;
    height: 2.2rem;
    display: grid;
    place-items: center;
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-muted-color);
    transition: color 120ms ease;
  }

  .book:hover,
  .book.open {
    color: var(--color-stamp);
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
  }

  /* ── the sheet: a page, 8 × 11 ─────────────────────────────────────── */
  .sheet {
    --page-width: 120ch;
    width: var(--page-width);
    max-width: 100%;
    aspect-ratio: 8/11;
    /* A real page: it is this tall even when empty, and grows past it
       rather than clipping when the writing runs long. */
    min-height: calc(var(--page-width) * 11 / 8);
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-1);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    position: relative;
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

  .editor-host {
    height:100%;
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
