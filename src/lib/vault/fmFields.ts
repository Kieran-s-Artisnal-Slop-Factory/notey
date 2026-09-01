/**
 * Frontmatter fields, as the page header edits them.
 *
 * Frontmatter is YAML, so a value can be a string, a number, a list, or a
 * whole nested map. The header offers three shapes rather than pretending
 * everything is a string:
 *
 *   text   a scalar — a string, number, boolean or date
 *   list   a sequence of scalars, edited comma-separated like tags
 *   yaml   anything else (a map, a list of maps, something nested), edited
 *          as the YAML it is
 *
 * A field can be switched between text and list by hand; `yaml` is picked
 * automatically for values the other two cannot hold without losing
 * something, and nothing is ever silently flattened.
 *
 * The rule that matters: a value that is not edited round-trips
 * **unchanged**. The file belongs to whoever wrote it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type FieldKind = 'text' | 'list' | 'yaml';

export interface FmField {
  key: string;
  kind: FieldKind;
  /** What the input shows: the scalar, the comma-joined list, or YAML. */
  value: string;
  /**
   * The value this row was loaded with, so an untouched field keeps its
   * exact type — `port: 8080` stays a number, not the string "8080".
   */
  original?: unknown;
}

/** The keys notey manages itself; they are not free-form fields. */
export const OWNED_KEYS = new Set(['created', 'updated', 'tags', 'aliases']);

const isScalar = (v: unknown): boolean =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Which editor a value needs. */
export function kindOf(value: unknown): FieldKind {
  if (isScalar(value)) return 'text';
  if (Array.isArray(value) && value.every(isScalar)) return 'list';
  return 'yaml';
}

const scalarText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Render a value for its editor. */
export function displayValue(value: unknown, kind: FieldKind): string {
  if (kind === 'list') {
    return Array.isArray(value) ? value.map(scalarText).join(', ') : scalarText(value);
  }
  if (kind === 'yaml') {
    try {
      return stringifyYaml(value, { lineWidth: 0 }).replace(/\n$/, '');
    } catch {
      return '';
    }
  }
  return scalarText(value);
}

/** The free-form fields of a frontmatter map, in file order. */
export function toFields(data: Record<string, unknown>): FmField[] {
  return Object.entries(data)
    .filter(([key]) => !OWNED_KEYS.has(key))
    .map(([key, value]) => {
      const kind = kindOf(value);
      return { key, kind, value: displayValue(value, kind), original: value };
    });
}

/** Split a comma-or-newline separated list the way tags are split. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
    ),
  ];
}

/**
 * A scalar typed into a text field. Numbers and booleans are recognised so
 * `port: 8080` stays a number after an edit, which is what YAML would do
 * with the same text — but a string that merely looks numeric and was
 * quoted in the file stays a string, because `original` says so.
 */
function parseScalar(text: string, original: unknown): unknown {
  const trimmed = text.trim();
  if (typeof original === 'string') return text;
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return text;
}

export interface BuildResult {
  data: Record<string, unknown>;
  /** Keys whose YAML did not parse; their previous value was kept. */
  invalid: string[];
}

/**
 * Fields back to a frontmatter map. A row whose value is untouched keeps
 * its original value object, so ordering, numbers and nested maps survive
 * a save that never looked at them.
 */
export function fromFields(fields: readonly FmField[]): BuildResult {
  const data: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const field of fields) {
    const key = field.key.trim();
    if (key === '' || OWNED_KEYS.has(key)) continue;
    // Untouched? Keep exactly what was read.
    if (field.original !== undefined && displayValue(field.original, field.kind) === field.value) {
      data[key] = field.original;
      continue;
    }
    if (field.kind === 'list') {
      data[key] = parseList(field.value);
    } else if (field.kind === 'yaml') {
      try {
        const parsed = parseYaml(field.value);
        data[key] = parsed === undefined ? null : parsed;
      } catch {
        // Never destroy a value because its replacement does not parse.
        invalid.push(key);
        if (field.original !== undefined) data[key] = field.original;
      }
    } else {
      data[key] = parseScalar(field.value, field.original);
    }
  }
  return { data, invalid };
}

/** Switch a field between text and list, keeping what it holds. */
export function switchKind(field: FmField, kind: FieldKind): FmField {
  if (field.kind === kind) return field;
  if (kind === 'list') {
    const parsed = field.kind === 'yaml' ? safeParse(field.value) : field.value;
    const list = Array.isArray(parsed) ? parsed.map(scalarText) : parseList(String(parsed ?? ''));
    return { ...field, kind, value: list.join(', ') };
  }
  if (kind === 'text') {
    const parsed = field.kind === 'yaml' ? safeParse(field.value) : field.value;
    return {
      ...field,
      kind,
      value: Array.isArray(parsed) ? parsed.map(scalarText).join(', ') : scalarText(parsed),
    };
  }
  // To YAML: show what the field holds now, as YAML.
  const held = field.kind === 'list' ? parseList(field.value) : field.value;
  return { ...field, kind, value: displayValue(held, 'yaml') };
}

function safeParse(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return text;
  }
}
