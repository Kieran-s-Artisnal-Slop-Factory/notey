/**
 * Fulltext search + filtering over the in-memory vault.
 *
 * A JS scan, not FTS5, on purpose: every note body is already in memory
 * (wiki links and backlinks need them all), and scanning megabytes of text
 * is instant at personal-vault scale. Query grammar:
 *
 *   plain words        — every word must appear in title, alias, tag, path
 *                        or body (case-insensitive)
 *   tag:foo            — the note must carry the tag (repeatable, ANDed)
 *   book:Work          — the note must live under that top-level notebook
 *                        (`book:pile` means the root)
 *
 * Ranking: title hits above alias/tag hits above body-only hits, earlier
 * matches above later ones. Body hits carry a snippet.
 */
import type { Note } from './types';

export interface SearchQuery {
  words: string[];
  tags: string[];
  book: string | null;
}

export interface SearchHit {
  note: Note;
  /** Bigger is better; stable for equal scores (title order). */
  score: number;
  /** A body excerpt around the first match, when the body matched. */
  snippet: string | null;
}

export function parseQuery(input: string): SearchQuery {
  const words: string[] = [];
  const tags: string[] = [];
  let book: string | null = null;
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower.startsWith('tag:')) {
      const tag = token.slice(4).trim();
      if (tag) tags.push(tag.toLowerCase());
    } else if (lower.startsWith('book:')) {
      const name = token.slice(5).trim();
      if (name) book = name.toLowerCase();
    } else {
      words.push(lower);
    }
  }
  return { words, tags, book };
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return query.words.length === 0 && query.tags.length === 0 && query.book === null;
}

const SNIPPET_RADIUS = 44;

function snippetAround(body: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(body.length, index + length + SNIPPET_RADIUS);
  const raw = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + raw + (end < body.length ? '…' : '');
}

export function searchNotes(notes: readonly Note[], query: SearchQuery): SearchHit[] {
  if (isEmptyQuery(query)) return [];
  const hits: SearchHit[] = [];

  for (const note of notes) {
    if (query.book !== null) {
      const top = note.id.includes('/') ? note.id.slice(0, note.id.indexOf('/')).toLowerCase() : 'pile';
      if (top !== query.book) continue;
    }
    const tagsLower = note.tags.map((t) => t.toLowerCase());
    if (!query.tags.every((tag) => tagsLower.includes(tag))) continue;

    const title = note.title.toLowerCase();
    const aliases = note.aliases.map((a) => a.toLowerCase());
    const path = note.id.toLowerCase();
    const body = note.body_md;
    const bodyLower = body.toLowerCase();

    let score = 0;
    let snippet: string | null = null;
    let matched = true;

    for (const word of query.words) {
      const inTitle = title.indexOf(word);
      if (inTitle !== -1) {
        score += inTitle === 0 ? 24 : 16;
        continue;
      }
      if (aliases.some((a) => a.includes(word))) {
        score += 10;
        continue;
      }
      if (tagsLower.some((t) => t.includes(word))) {
        score += 10;
        continue;
      }
      if (path.includes(word)) {
        score += 6;
        continue;
      }
      const inBody = bodyLower.indexOf(word);
      if (inBody !== -1) {
        score += 3;
        snippet ??= snippetAround(body, inBody, word.length);
        continue;
      }
      matched = false;
      break;
    }
    if (!matched) continue;
    // A pure filter query (tags/book only) matches with a flat score.
    hits.push({ note, score: score + 1, snippet });
  }

  hits.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title));
  return hits;
}
