/**
 * Preferences — small, local, and per-browser (or per-machine under Tauri).
 * localStorage on purpose: preferences are about THIS device (which face
 * you like, what was open here), not vault data, so they stay out of the
 * vault and out of exports.
 */

export type EditorMode = 'wysiwyg' | 'source' | 'preview';
export type StartupMode = 'last' | 'blank';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Prefs {
  /** Open to the last note, or to a blank unfiled document. */
  startup: StartupMode;
  /** The editor face you left the editor in. */
  mode: EditorMode;
  /** The note that was open (a vault path). */
  lastNote: string | null;
  theme: ThemeChoice;
  sidebarOpen: boolean;
}

const DEFAULTS: Prefs = {
  // Blank by default: notey opens as a page you can write on, not as a
  // file manager. The last note is one Ctrl+K away.
  startup: 'blank',
  mode: 'wysiwyg',
  lastNote: null,
  theme: 'system',
  sidebarOpen: true,
};

const KEY = 'notey-prefs';
/** The blank-startup scratch buffer rides along here, not in the vault. */
const SCRATCH_KEY = 'notey-scratch';
/** Layout.astro reads this one pre-paint; kept as its own key on purpose. */
const THEME_KEY = 'notey-theme';

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      startup: parsed.startup === 'last' ? 'last' : 'blank',
      mode: parsed.mode === 'source' || parsed.mode === 'preview' ? parsed.mode : 'wysiwyg',
      lastNote: typeof parsed.lastNote === 'string' ? parsed.lastNote : null,
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      sidebarOpen: parsed.sidebarOpen !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(changes: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...changes };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    // Mirror the theme where the pre-paint script looks for it.
    if (next.theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next.theme);
  } catch {
    // Storage refused (private window at quota) — the session still works.
  }
  return next;
}

/** Apply the theme choice to the document right now. */
export function applyTheme(theme: ThemeChoice): void {
  document.documentElement.style.colorScheme = theme === 'system' ? '' : theme;
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
