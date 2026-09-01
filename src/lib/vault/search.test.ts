import { describe, expect, it } from 'vitest';
import { isEmptyQuery, parseQuery, searchNotes } from './search';
import { toNote } from './model';

const note = (path: string, body: string, tags: string[] = [], aliases: string[] = []) => {
  const fm =
    tags.length || aliases.length
      ? `---\n${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}${aliases.length ? `aliases: [${aliases.join(', ')}]\n` : ''}---\n\n`
      : '';
  return toNote({ path, content: fm + body, mtime: '2026-01-01T00:00:00.000Z' });
};

const vault = [
  note('Recipes/Bread.md', 'Knead the dough, rest an hour.', ['baking']),
  note('Recipes/Soup.md', 'A good broth beats a strong boil.', ['dinner']),
  note('Work/Plan.md', 'Ship the bread-crumb feature.', ['work'], ['Old plan']),
  note('Loose thought.md', 'bread appears mid-body only.'),
];

describe('parseQuery', () => {
  it('splits words, tag: and book: filters', () => {
    const q = parseQuery('tag:baking bread book:Recipes');
    expect(q.words).toEqual(['bread']);
    expect(q.tags).toEqual(['baking']);
    expect(q.book).toBe('recipes');
  });

  it('an all-whitespace query is empty', () => {
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
    expect(isEmptyQuery(parseQuery('tag:x'))).toBe(false);
  });
});

describe('searchNotes', () => {
  it('ranks title hits above body hits and carries a snippet for body-only hits', () => {
    const hits = searchNotes(vault, parseQuery('bread'));
    // Title hit first; the two body-only hits tie and fall back to title order.
    expect(hits.map((h) => h.note.id)).toEqual(['Recipes/Bread.md', 'Loose thought.md', 'Work/Plan.md']);
    expect(hits[0]!.snippet).toBeNull();
    expect(hits[1]!.snippet).toContain('bread appears mid-body');
  });

  it('every word must match somewhere', () => {
    expect(searchNotes(vault, parseQuery('bread dough')).map((h) => h.note.id)).toEqual(['Recipes/Bread.md']);
    expect(searchNotes(vault, parseQuery('bread nowhere-word'))).toEqual([]);
  });

  it('matches aliases', () => {
    expect(searchNotes(vault, parseQuery('old plan')).map((h) => h.note.id)).toEqual(['Work/Plan.md']);
  });

  it('tag: filters, alone or with words', () => {
    expect(searchNotes(vault, parseQuery('tag:baking')).map((h) => h.note.id)).toEqual(['Recipes/Bread.md']);
    expect(searchNotes(vault, parseQuery('tag:dinner bread'))).toEqual([]);
  });

  it('book: scopes to a notebook, with book:pile for root notes', () => {
    expect(searchNotes(vault, parseQuery('book:recipes bread')).map((h) => h.note.id)).toEqual([
      'Recipes/Bread.md',
    ]);
    expect(searchNotes(vault, parseQuery('book:pile bread')).map((h) => h.note.id)).toEqual([
      'Loose thought.md',
    ]);
  });

  it('an empty query returns nothing (the tree, not search, shows everything)', () => {
    expect(searchNotes(vault, parseQuery(''))).toEqual([]);
  });
});
