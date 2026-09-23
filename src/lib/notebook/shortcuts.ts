/**
 * The editor's four tools, the keys that open them, and how a key is read.
 *
 * Everything on the toolbar has to be reachable without it: a formula, a
 * drawing, a diagram and a footnote each have a shortcut, each appears in the
 * command palette, and each shortcut can be changed in Settings.
 *
 * **Keys are matched on `event.code`, not `event.key`**, with `key` only as a
 * fallback. That is not a preference — Alt+F on macOS reports `key: 'ƒ'` and
 * Alt+0 reports `'º'`, so a `key` comparison silently stops working the
 * moment somebody holds Option. The physical code says which key was hit
 * whatever the layout and whatever the modifiers do to it. (The footnote
 * shortcut already did this for `Digit0`; the rest of the toolbar now does
 * too.)
 *
 * Pure: no DOM beyond the `KeyboardEvent` fields it is handed, so the rules
 * are unit-tested rather than clicked through.
 */

export type ToolId = 'formula' | 'drawing' | 'diagram' | 'footnotes';

export interface Tool {
  id: ToolId;
  /** On the toolbar button. */
  glyph: string;
  label: string;
  /** The row in the command palette. */
  command: string;
  /** What that row says on the right. */
  hint: string;
}

/** Toolbar order, palette order, Settings order — one list, so they agree. */
export const TOOLS: readonly Tool[] = [
  {
    id: 'formula',
    glyph: '∑',
    label: 'Formula',
    command: 'Insert a formula',
    hint: 'maths, written as it looks',
  },
  {
    id: 'diagram',
    glyph: '◇',
    label: 'Diagram',
    command: 'Insert a diagram',
    hint: 'mermaid, with templates',
  },
  {
    id: 'drawing',
    glyph: '✏',
    label: 'Draw',
    command: 'Insert a drawing',
    hint: 'an Excalidraw canvas',
  },
  {
    id: 'footnotes',
    glyph: '⁋',
    label: 'Footnotes',
    command: 'Insert a footnote',
    hint: 'cites at the cursor',
  },
];

export type Shortcuts = Record<ToolId, string>;

/**
 * Alt and the initial, except for footnotes, which had Alt+0 before any of
 * this and keeps it — a shortcut people already have in their fingers is not
 * worth tidying. (Alt+D would have been the drawing's initial and is the
 * browser's own address-bar key on Windows, so drawings get Alt+E.)
 */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  formula: 'Alt+F',
  diagram: 'Alt+M',
  drawing: 'Alt+E',
  footnotes: 'Alt+0',
};

/**
 * Keys this app needs for itself. Rebinding a tool onto one of these would
 * take it away wherever the editor has focus, which is most of the time.
 */
export const RESERVED: Readonly<Record<string, string>> = {
  'Ctrl+K': 'the command palette',
  'Meta+K': 'the command palette',
};

/** The modifier order every bind is written in. */
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

interface Parsed {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** `A`–`Z`, `0`–`9`, `F1`–`F12`: what a bind's last part may be. */
const KEY_NAME = /^(?:[A-Z0-9]|F[1-9]|F1[0-2])$/;

/** `KeyF` → `F`, `Digit0` and `Numpad0` → `0`, `F5` → `F5`. */
function nameOfCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  return /^F(?:[1-9]|1[0-2])$/.test(code) ? code : null;
}

/**
 * The bind a keypress would set, or null if it could not be one.
 *
 * Null for a modifier on its own (there is nothing to bind yet), for a plain
 * or Shift-only key — a tool that opened on `F` would open every time you
 * typed the word "off" — and for anything that is not a letter, a digit or a
 * function key.
 */
export function bindOf(event: KeyboardEvent): string | null {
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return null;
  const name = nameOfCode(event.code) ?? upperSingle(event.key);
  if (!name || !KEY_NAME.test(name)) return null;
  return format({
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: name,
  });
}

function upperSingle(key: string): string | null {
  return key.length === 1 ? key.toUpperCase() : null;
}

function format(bind: Parsed): string {
  const parts: string[] = [];
  if (bind.ctrl) parts.push('Ctrl');
  if (bind.alt) parts.push('Alt');
  if (bind.shift) parts.push('Shift');
  if (bind.meta) parts.push('Meta');
  parts.push(bind.key);
  return parts.join('+');
}

/** The parts of a bind, or null when the text is not one. */
function parse(text: unknown): Parsed | null {
  if (typeof text !== 'string') return null;
  const parts = text
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const bind: Parsed = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: key.toUpperCase(),
  };
  for (const part of parts) {
    const found = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
    if (!found) return null;
    if (found === 'Ctrl') bind.ctrl = true;
    if (found === 'Alt') bind.alt = true;
    if (found === 'Shift') bind.shift = true;
    if (found === 'Meta') bind.meta = true;
  }
  // Shift alone is not a modifier for this purpose: a tool that opened on
  // Shift+F would open while you typed a capital F.
  if (!bind.ctrl && !bind.alt && !bind.meta) return null;
  return KEY_NAME.test(bind.key) ? bind : null;
}

/** Read a stored or typed bind, tidied into the one spelling. Null if unusable. */
export function parseBind(text: unknown): string | null {
  const bind = parse(text);
  return bind ? format(bind) : null;
}

/**
 * Does this keypress ask for this bind?
 *
 * Every modifier is compared, including the ones the bind does not want:
 * Ctrl+Alt+F must not open what Alt+F opens, or a shortcut somebody else
 * defined becomes unusable here.
 */
export function matches(event: KeyboardEvent, bind: string): boolean {
  const wanted = parse(bind);
  if (!wanted) return false;
  if (event.ctrlKey !== wanted.ctrl) return false;
  if (event.altKey !== wanted.alt) return false;
  if (event.shiftKey !== wanted.shift) return false;
  if (event.metaKey !== wanted.meta) return false;
  return nameOfCode(event.code) === wanted.key || upperSingle(event.key) === wanted.key;
}

/** Which tool a keypress opens, or null. */
export function toolFor(event: KeyboardEvent, shortcuts: Shortcuts): ToolId | null {
  for (const tool of TOOLS) {
    if (matches(event, shortcuts[tool.id])) return tool.id;
  }
  return null;
}

/**
 * Why `bind` cannot be given to `id`, in one line for a person, or null when
 * it can.
 */
export function bindRefusal(bind: string, id: ToolId, shortcuts: Shortcuts): string | null {
  const tidy = parseBind(bind);
  if (!tidy) return 'That needs Ctrl, Alt or Cmd and a letter, a digit or an F-key.';
  const reserved = RESERVED[tidy];
  if (reserved) return `${tidy} is ${reserved}.`;
  const taken = TOOLS.find((tool) => tool.id !== id && parseBind(shortcuts[tool.id]) === tidy);
  return taken ? `${tidy} already opens ${taken.label.toLowerCase()}.` : null;
}

/**
 * Stored preferences into a usable set: anything missing, unreadable or
 * clashing falls back to the default for that tool, so a hand-edited value
 * can never leave a tool unreachable.
 */
export function readShortcuts(value: unknown): Shortcuts {
  const stored = (value ?? {}) as Partial<Record<ToolId, unknown>>;
  const out = { ...DEFAULT_SHORTCUTS };
  const used = new Set<string>();
  for (const tool of TOOLS) {
    const wanted = parseBind(stored[tool.id]);
    if (wanted && !RESERVED[wanted] && !used.has(wanted)) {
      out[tool.id] = wanted;
      used.add(wanted);
      continue;
    }
    // The default is only safe if nobody else has taken it.
    out[tool.id] = used.has(DEFAULT_SHORTCUTS[tool.id]) ? '' : DEFAULT_SHORTCUTS[tool.id];
    if (out[tool.id]) used.add(out[tool.id]);
  }
  return out;
}
