/**
 * Preferences — small, local, and per-browser (or per-machine under Tauri).
 * localStorage on purpose: preferences are about THIS device (which face
 * you like, what was open here, what your desk looks like), not vault data,
 * so they stay out of the vault and out of exports.
 */

export type EditorMode = 'wysiwyg' | 'source' | 'preview';
export type StartupMode = 'last' | 'blank';

/** The paper: what the page itself is made of. */
export type PageTheme = 'system' | 'light' | 'dark';

/**
 * The desk the page lies on — independent of the paper, so a dark desk can
 * hold a light page. `system` follows the page theme with a plain desk.
 */
export type DeskStyle =
  | 'system'
  | 'plain-light'
  | 'plain-dark'
  | 'wood-mahogany'
  | 'wood-oak'
  | 'wood-birch'
  | 'leather-black'
  | 'leather-rich'
  | 'leather-tan'
  | 'leather-cream';

/** The ink your buttons and links are written in. */
export type AccentName =
  | 'ink'
  | 'oxblood'
  | 'forest'
  | 'teal'
  | 'aubergine'
  | 'rust'
  | 'slate'
  | 'moss';

export interface AccentSwatch {
  id: AccentName;
  label: string;
  /** The colour the swatch shows — the light-page value. */
  sample: string;
}

export const ACCENTS: readonly AccentSwatch[] = [
  { id: 'ink', label: 'Ink', sample: '#28439c' },
  { id: 'oxblood', label: 'Oxblood', sample: '#8c2f39' },
  { id: 'forest', label: 'Forest', sample: '#1f5c3d' },
  { id: 'teal', label: 'Teal', sample: '#136b73' },
  { id: 'aubergine', label: 'Aubergine', sample: '#5b2a6b' },
  { id: 'rust', label: 'Rust', sample: '#9c4a16' },
  { id: 'slate', label: 'Slate', sample: '#42546b' },
  { id: 'moss', label: 'Moss', sample: '#5d6b21' },
];

export interface DeskOption {
  id: DeskStyle;
  group: 'Plain' | 'Wood' | 'Leather';
  label: string;
  /** A flat colour for the swatch — the texture is CSS. */
  sample: string;
}

export const DESKS: readonly DeskOption[] = [
  { id: 'plain-light', group: 'Plain', label: 'Paper', sample: '#e7dec6' },
  { id: 'plain-dark', group: 'Plain', label: 'Lamplight', sample: '#23201a' },
  { id: 'wood-mahogany', group: 'Wood', label: 'Mahogany', sample: '#4a2016' },
  { id: 'wood-oak', group: 'Wood', label: 'Oak', sample: '#9a6b38' },
  { id: 'wood-birch', group: 'Wood', label: 'Birch', sample: '#d8c39a' },
  { id: 'leather-black', group: 'Leather', label: 'Black', sample: '#211d1b' },
  { id: 'leather-rich', group: 'Leather', label: 'Rich brown', sample: '#3d2317' },
  { id: 'leather-tan', group: 'Leather', label: 'Tan', sample: '#8a5a33' },
  { id: 'leather-cream', group: 'Leather', label: 'Cream', sample: '#c9a678' },
];

export interface Prefs {
  /** Open to the last note, or to a blank unfiled document. */
  startup: StartupMode;
  /** The editor face you left the editor in. */
  mode: EditorMode;
  /** The note that was open (a vault path). */
  lastNote: string | null;
  /** The paper. */
  page: PageTheme;
  /** The desk under it. */
  desk: DeskStyle;
  accent: AccentName;
}

const DEFAULTS: Prefs = {
  // Blank by default: notey opens as a page you can write on, not as a
  // file manager. The last note is one Ctrl+K away.
  startup: 'blank',
  mode: 'wysiwyg',
  lastNote: null,
  page: 'system',
  desk: 'system',
  accent: 'ink',
};

const KEY = 'notey-prefs';
/** The blank-startup scratch buffer rides along here, not in the vault. */
const SCRATCH_KEY = 'notey-scratch';
/*
 * Layout.astro's pre-paint script reads these three, before any bundle has
 * loaded. They are mirrors of the fields above, kept as bare strings so
 * that script stays three lines and cannot throw on a half-written blob.
 */
const LOOK_KEYS = {
  page: 'notey-page',
  desk: 'notey-desk',
  accent: 'notey-accent',
} as const;

const isDesk = (v: unknown): v is DeskStyle =>
  v === 'system' || DESKS.some((d) => d.id === v);
const isAccent = (v: unknown): v is AccentName => ACCENTS.some((a) => a.id === v);

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs> & { theme?: string };
    return {
      startup: parsed.startup === 'last' ? 'last' : 'blank',
      mode: parsed.mode === 'source' || parsed.mode === 'preview' ? parsed.mode : 'wysiwyg',
      lastNote: typeof parsed.lastNote === 'string' ? parsed.lastNote : null,
      // `theme` was this field's name before the desk and the page could
      // differ; a stored one still says what the paper should be.
      page:
        parsed.page === 'light' || parsed.page === 'dark'
          ? parsed.page
          : parsed.theme === 'light' || parsed.theme === 'dark'
            ? parsed.theme
            : 'system',
      desk: isDesk(parsed.desk) ? parsed.desk : 'system',
      accent: isAccent(parsed.accent) ? parsed.accent : 'ink',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(changes: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...changes };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    // Mirror the look where the pre-paint script looks for it.
    localStorage.setItem(LOOK_KEYS.page, next.page);
    localStorage.setItem(LOOK_KEYS.desk, next.desk);
    localStorage.setItem(LOOK_KEYS.accent, next.accent);
  } catch {
    // Storage refused (private window at quota) — the session still works.
  }
  return next;
}

/** What `system` means right now, for the paper. */
export function resolvePage(page: PageTheme): 'light' | 'dark' {
  if (page === 'light' || page === 'dark') return page;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** What `system` means right now, for the desk: a plain one, matching. */
export function resolveDesk(desk: DeskStyle, page: 'light' | 'dark'): Exclude<DeskStyle, 'system'> {
  return desk === 'system' ? (page === 'dark' ? 'plain-dark' : 'plain-light') : desk;
}

/**
 * Paint the look onto the document. Same three attributes the pre-paint
 * script sets, so applying a change mid-session and reloading agree.
 */
export function applyLook(prefs: Pick<Prefs, 'page' | 'desk' | 'accent'>): void {
  const page = resolvePage(prefs.page);
  const root = document.documentElement;
  root.dataset['page'] = page;
  root.dataset['desk'] = resolveDesk(prefs.desk, page);
  root.dataset['accent'] = prefs.accent;
  // Native controls (selects, checkboxes) follow the paper, not the desk.
  root.style.colorScheme = page;
}

/** The unfiled page: a title and a body, kept only in this browser. */
export interface Scratch {
  title: string;
  body: string;
}

export function loadScratch(): Scratch {
  try {
    const raw = localStorage.getItem(SCRATCH_KEY);
    if (!raw) return { title: '', body: '' };
    // Pre-0.1.0 scratches were a bare body string.
    if (!raw.startsWith('{')) return { title: '', body: raw };
    const parsed = JSON.parse(raw) as Partial<Scratch>;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    };
  } catch {
    return { title: '', body: '' };
  }
}

export function saveScratch(scratch: Scratch): void {
  try {
    if (scratch.title === '' && scratch.body === '') localStorage.removeItem(SCRATCH_KEY);
    else localStorage.setItem(SCRATCH_KEY, JSON.stringify(scratch));
  } catch {
    // Best-effort; the scratch buffer is a convenience, not vault data.
  }
}
