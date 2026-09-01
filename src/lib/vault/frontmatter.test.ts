import { describe, expect, it } from 'vitest';
import { buildNoteContent, noteFields, parseNoteContent } from './frontmatter';

describe('parseNoteContent', () => {
  it('splits a frontmatter block from the body', () => {
    const { data, body, hadFrontmatter } = parseNoteContent(
      '---\ntags:\n  - a\n  - b\ncreated: 2026-08-31\n---\n\n# Hello\n'
    );
    expect(hadFrontmatter).toBe(true);
    expect(data['tags']).toEqual(['a', 'b']);
    expect(data['created']).toBe('2026-08-31');
    expect(body).toBe('# Hello\n');
  });

  it('treats a file without a fence as pure body', () => {
    const { data, body, hadFrontmatter } = parseNoteContent('# Just prose\n');
    expect(hadFrontmatter).toBe(false);
    expect(data).toEqual({});
    expect(body).toBe('# Just prose\n');
  });

  it('a --- ruler mid-document is not frontmatter', () => {
    const src = 'intro\n\n---\n\nmore\n';
    expect(parseNoteContent(src).hadFrontmatter).toBe(false);
    expect(parseNoteContent(src).body).toBe(src);
  });

  it('an unclosed fence is body, not metadata', () => {
    const src = '---\ntags: [a]\nno closing fence\n';
    expect(parseNoteContent(src).hadFrontmatter).toBe(false);
    expect(parseNoteContent(src).body).toBe(src);
  });

  it('broken YAML never destroys the file — the whole thing stays body', () => {
    const src = '---\n: : : nope [\n---\n\ntext\n';
    const parsed = parseNoteContent(src);
    expect(parsed.hadFrontmatter).toBe(false);
    expect(parsed.body).toBe(src);
  });

  it('non-map YAML (a bare scalar or list) is not frontmatter', () => {
    expect(parseNoteContent('---\n3\n---\nbody\n').hadFrontmatter).toBe(false);
    expect(parseNoteContent('---\n- a\n- b\n---\nbody\n').hadFrontmatter).toBe(false);
  });

  it('an empty block parses as an empty map', () => {
    const parsed = parseNoteContent('---\n---\nbody\n');
    expect(parsed.hadFrontmatter).toBe(true);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('body\n');
  });

  it('dates stay strings (YAML 1.2 core schema)', () => {
    const { data } = parseNoteContent('---\ncreated: 2026-08-31\n---\nx');
    expect(typeof data['created']).toBe('string');
  });
});

describe('noteFields', () => {
  it('tolerates junk in tags and aliases', () => {
    const fields = noteFields({
      tags: ['a', 3, '', ' b ', 'a'] as unknown[],
      aliases: 'Old title, Older title',
      created: 42,
    });
    expect(fields.tags).toEqual(['a', 'b']);
    expect(fields.aliases).toEqual(['Old title', 'Older title']);
    expect(fields.created).toBeNull();
  });

  it('keeps unknown keys as extra', () => {
    const fields = noteFields({ tags: [], author: 'me', rating: 5 });
    expect(fields.extra).toEqual({ author: 'me', rating: 5 });
  });
});

describe('buildNoteContent', () => {
  const base = { tags: [], aliases: [], created: null, updated: null, extra: {} };

  it('emits no frontmatter when there is nothing to say', () => {
    expect(buildNoteContent(base, '# Hi\n')).toBe('# Hi\n');
  });

  it('round-trips a hand-written file, keeping key order and unknown keys', () => {
    const src = '---\nauthor: me\ntags:\n  - a\ncustom: true\n---\n\n# Hi\n';
    const { data, body } = parseNoteContent(src);
    const fields = noteFields(data);
    const out = buildNoteContent(fields, body, data);
    const reparsed = parseNoteContent(out);
    expect(Object.keys(reparsed.data)).toEqual(['author', 'tags', 'custom']);
    expect(reparsed.data).toEqual(data);
    expect(reparsed.body).toBe('# Hi\n');
  });

  it('omits empty tags/aliases and appends new owned keys in canonical order', () => {
    const out = buildNoteContent(
      { ...base, created: '2026-08-31T10:00:00Z', updated: '2026-08-31T11:00:00Z', tags: ['x'] },
      'body'
    );
    expect(parseNoteContent(out).data).toEqual({
      created: '2026-08-31T10:00:00Z',
      updated: '2026-08-31T11:00:00Z',
      tags: ['x'],
    });
    expect(out).not.toContain('aliases');
  });

  it('normalizes the body to end in exactly one newline', () => {
    expect(buildNoteContent(base, 'text\n\n\n')).toBe('text\n');
    expect(buildNoteContent(base, '')).toBe('');
  });

  it('a title-less scalar value with special characters survives', () => {
    const out = buildNoteContent({ ...base, extra: { quote: 'a: b # not a comment' } }, 'x');
    expect(parseNoteContent(out).data['quote']).toBe('a: b # not a comment');
  });
});
