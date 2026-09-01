/**
 * YAML frontmatter, parsed the way a file's owner would want: tolerant on
 * the way in, lossless on the way out.
 *
 *  - A note without frontmatter is just a body; notey adds a block when it
 *    first saves (it owns `created`/`updated`, and `tags`/`aliases` when
 *    non-empty).
 *  - Frontmatter that does not parse as YAML is NOT frontmatter — the whole
 *    file is body. Never destroy a user's text because a `---` fence lied.
 *  - Keys notey does not own ride along verbatim, in their original order;
 *    notey's own keys keep their original position when present and are
 *    appended in canonical order when new.
 *
 * The `yaml` package's default schema is YAML 1.2 core, so `2026-08-31`
 * stays a plain string rather than becoming a Date — exactly what a
 * frontmatter block wants.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ParsedNote {
  /** Frontmatter as a plain map ({} when absent/unparseable). */
  data: Record<string, unknown>;
  /** The markdown after the frontmatter block (or the whole file). */
  body: string;
  /** True when a valid frontmatter block was present. */
  hadFrontmatter: boolean;
}

const OPEN = /^---[ \t]*\r?\n/;

/** Split `content` into a frontmatter map and a body. */
export function parseNoteContent(content: string): ParsedNote {
  const none: ParsedNote = { data: {}, body: content, hadFrontmatter: false };
  const open = OPEN.exec(content);
  if (!open) return none;
  // The closing fence: a line that is exactly `---` (or YAML's `...`).
  const rest = content.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return none;
  const yamlText = rest.slice(0, close.index);
  const afterClose = rest.slice(close.index + close[0].length);
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch {
    return none;
  }
  // Frontmatter must be a map; `--- 3 ---` is prose, not metadata.
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) return none;
  // One blank line between the fence and the body is the fence's, not the
  // body's; deeper blank runs belong to the author.
  const body = afterClose.startsWith('\r\n')
    ? afterClose.slice(2)
    : afterClose.startsWith('\n')
      ? afterClose.slice(1)
      : afterClose;
  return { data: data as Record<string, unknown>, body, hadFrontmatter: true };
}

/** The frontmatter keys notey manages itself. */
export const OWNED_KEYS = ['created', 'updated', 'tags', 'aliases'] as const;

export interface NoteFields {
  tags: readonly string[];
  aliases: readonly string[];
  created: string | null;
  updated: string | null;
  /** Everything else, preserved verbatim. */
  extra: Record<string, unknown>;
}

/** Read notey's fields out of a frontmatter map, tolerating junk. */
export function noteFields(data: Record<string, unknown>): NoteFields {
  const strings = (v: unknown): string[] => {
    if (typeof v === 'string') return v.trim() === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))];
  };
  const iso = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(OWNED_KEYS as readonly string[]).includes(key)) extra[key] = value;
  }
  return {
    tags: strings(data['tags']),
    aliases: strings(data['aliases']),
    created: iso(data['created']),
    updated: iso(data['updated']),
    extra,
  };
}

/**
 * Build a note file: frontmatter block + body. Owned keys that were present
 * in `originalData` keep their position; new owned keys append in canonical
 * order; empty `tags`/`aliases` are omitted entirely.
 */
export function buildNoteContent(
  fields: NoteFields,
  body: string,
  originalData: Record<string, unknown> = {}
): string {
  const owned: Record<string, unknown> = {};
  if (fields.created) owned['created'] = fields.created;
  if (fields.updated) owned['updated'] = fields.updated;
  if (fields.tags.length > 0) owned['tags'] = [...fields.tags];
  if (fields.aliases.length > 0) owned['aliases'] = [...fields.aliases];

  const out: Record<string, unknown> = {};
  // Original order first — owned keys take their fresh values, extras ride.
  for (const key of Object.keys(originalData)) {
    if (key in owned) {
      out[key] = owned[key];
      delete owned[key];
    } else if (key in fields.extra) {
      out[key] = fields.extra[key];
    }
  }
  // Extras that never had a position (edited in the header) come next…
  for (const [key, value] of Object.entries(fields.extra)) {
    if (!(key in out)) out[key] = value;
  }
  // …then newly-owned keys in canonical order.
  for (const key of OWNED_KEYS) {
    if (key in owned) out[key] = owned[key];
  }

  const trimmedBody = body.replace(/\s+$/, '');
  const bodyOut = trimmedBody === '' ? '' : trimmedBody + '\n';
  if (Object.keys(out).length === 0) return bodyOut;
  const yamlText = stringifyYaml(out, { lineWidth: 0 }).replace(/\n$/, '');
  return `---\n${yamlText}\n---\n\n${bodyOut}`;
}
