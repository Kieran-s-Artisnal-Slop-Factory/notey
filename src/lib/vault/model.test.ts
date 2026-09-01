import { describe, expect, it } from 'vitest';
import {
  assetPathFor,
  assetRefsIn,
  isAssetPath,
  joinPath,
  nameOf,
  normalizePath,
  notePath,
  noteContentOf,
  parentOf,
  sanitizeTitle,
  stemOf,
  toNote,
  treeEntries,
  uniqueFolderPath,
  uniqueNotePath,
} from './model';
import { buildTree } from '../notebook/model';

describe('path algebra', () => {
  it('normalizes separators and edges', () => {
    expect(normalizePath('\\a\\\\b/')).toBe('a/b');
    expect(normalizePath('/Work/Ideas/')).toBe('Work/Ideas');
    expect(normalizePath('')).toBe('');
  });

  it('parent, name, stem', () => {
    expect(parentOf('Work/Ideas/Plan.md')).toBe('Work/Ideas');
    expect(parentOf('Plan.md')).toBeNull();
    expect(nameOf('Work/Plan.md')).toBe('Plan.md');
    expect(stemOf('Plan.md')).toBe('Plan');
    expect(stemOf('Plan.MD')).toBe('Plan');
    expect(stemOf('no-extension')).toBe('no-extension');
    expect(joinPath(null, 'Plan.md')).toBe('Plan.md');
    expect(joinPath('Work', 'Plan.md')).toBe('Work/Plan.md');
  });

  it('recognises asset paths at any depth', () => {
    expect(isAssetPath('.assets')).toBe(true);
    expect(isAssetPath('.assets/x.png')).toBe(true);
    expect(isAssetPath('Work/.assets')).toBe(true);
    expect(isAssetPath('Work/.assets/x.png')).toBe(true);
    expect(isAssetPath('Work/Plan.md')).toBe(false);
    expect(isAssetPath('Work/assets/x.png')).toBe(false);
  });
});

describe('sanitizeTitle', () => {
  it('keeps spaces and unicode, swaps filesystem-hostile characters', () => {
    expect(sanitizeTitle('My note: draft?')).toBe('My note- draft');
    expect(sanitizeTitle('a/b\\c')).toBe('a-b-c');
    expect(sanitizeTitle('café ☕ notes')).toBe('café ☕ notes');
  });

  it('never yields an empty or dot-leading name', () => {
    expect(sanitizeTitle('')).toBe('Untitled');
    expect(sanitizeTitle('   ')).toBe('Untitled');
    expect(sanitizeTitle('...')).toBe('Untitled');
    expect(sanitizeTitle('.assets')).toBe('assets');
  });
});

describe('unique paths', () => {
  it('builds a note path and dodges clashes case-insensitively', () => {
    expect(notePath('Work', 'Plan')).toBe('Work/Plan.md');
    expect(uniqueNotePath('Work', 'Plan', ['Work/plan.md'])).toBe('Work/Plan 2.md');
    expect(uniqueNotePath(null, 'Plan', ['Plan.md', 'Plan 2.md'])).toBe('Plan 3.md');
    expect(uniqueFolderPath(null, 'Work', ['work'])).toBe('Work 2');
  });
});

describe('asset helpers', () => {
  it('places assets beside the note', () => {
    expect(assetPathFor('Work/Plan.md', 'x.png')).toBe('Work/.assets/x.png');
    expect(assetPathFor('Plan.md', 'x.png')).toBe('.assets/x.png');
    expect(assetPathFor('Work', 'x.png', 'dir')).toBe('Work/.assets/x.png');
  });

  it('finds the asset refs in a body, deduped', () => {
    const md = '![a](.assets/one.png) and ![b](.assets/two.excalidraw.png) again ![a](.assets/one.png)';
    expect(assetRefsIn(md)).toEqual(['.assets/one.png', '.assets/two.excalidraw.png']);
    expect(assetRefsIn('no refs here')).toEqual([]);
  });
});

describe('toNote / noteContentOf', () => {
  it('parses a file into the Note shape the tree machinery expects', () => {
    const note = toNote({
      path: 'Work/Plan.md',
      content: '---\ntags: [a]\naliases: [Old plan]\ncreated: 2026-01-01\nupdated: 2026-02-02\n---\n\n# Plan\n',
      mtime: '2026-03-03T00:00:00.000Z',
    });
    expect(note.id).toBe('Work/Plan.md');
    expect(note.title).toBe('Plan');
    expect(note.parent_id).toBe('Work');
    expect(note.tags).toEqual(['a']);
    expect(note.aliases).toEqual(['Old plan']);
    expect(note.body_md).toBe('# Plan\n');
    expect(note.created_at).toBe('2026-01-01');
    expect(note.updated_at).toBe('2026-02-02');
  });

  it('falls back to mtime when frontmatter has no dates', () => {
    const note = toNote({ path: 'Plan.md', content: 'x', mtime: '2026-03-03T00:00:00.000Z' });
    expect(note.updated_at).toBe('2026-03-03T00:00:00.000Z');
    expect(note.created_at).toBe('2026-03-03T00:00:00.000Z');
  });

  it('round-trips: toNote → noteContentOf → toNote is stable', () => {
    const src = '---\nauthor: me\ntags:\n  - a\n---\n\nSome **prose**.\n';
    const note = toNote({ path: 'Plan.md', content: src, mtime: '2026-01-01T00:00:00.000Z' });
    const { data } = { data: { author: 'me', tags: ['a'] } };
    const out = noteContentOf(note, data);
    const again = toNote({ path: 'Plan.md', content: out, mtime: '2026-09-09T00:00:00.000Z' });
    expect(again.body_md).toBe(note.body_md);
    expect(again.tags).toEqual(note.tags);
    expect(again.fm).toEqual({ author: 'me' });
  });
});

describe('treeEntries', () => {
  it('folders and notes build one tree via the shared machinery', () => {
    const folders = [
      { id: 'Work', title: 'Work', parent_id: null },
      { id: 'Work/Deep', title: 'Deep', parent_id: 'Work' },
    ];
    const notes = [
      toNote({ path: 'Loose.md', content: '', mtime: '' }),
      toNote({ path: 'Work/Plan.md', content: '', mtime: '' }),
      toNote({ path: 'Work/Deep/Idea.md', content: '', mtime: '' }),
    ];
    const tree = buildTree(treeEntries(folders, notes));
    expect(tree.roots.map((r) => r.id)).toEqual(['Loose.md', 'Work']);
    expect((tree.children.get('Work') ?? []).map((n) => n.id)).toEqual(['Work/Deep', 'Work/Plan.md']);
    expect((tree.children.get('Work/Deep') ?? []).map((n) => n.id)).toEqual(['Work/Deep/Idea.md']);
  });
});
