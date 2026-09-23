import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  TOOLS,
  bindOf,
  bindRefusal,
  matches,
  parseBind,
  readShortcuts,
  toolFor,
} from './shortcuts';

/** Just the fields the rules read, so no DOM is needed. */
const press = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    code: '',
    key: '',
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...over,
  }) as KeyboardEvent;

describe('reading a keypress', () => {
  it('matches on the physical key, not the character it produced', () => {
    // macOS turns Alt+F into "ƒ" and Alt+0 into "º". A `key` comparison is
    // what quietly stops working the moment somebody holds Option.
    expect(matches(press({ code: 'KeyF', key: 'ƒ', altKey: true }), 'Alt+F')).toBe(true);
    expect(matches(press({ code: 'Digit0', key: 'º', altKey: true }), 'Alt+0')).toBe(true);
  });

  it('falls back to the character when there is no useful code', () => {
    // Some remote and on-screen keyboards report no code at all.
    expect(matches(press({ code: '', key: 'f', altKey: true }), 'Alt+F')).toBe(true);
  });

  it('takes the numeric keypad for the digit it is', () => {
    expect(matches(press({ code: 'Numpad0', key: '0', altKey: true }), 'Alt+0')).toBe(true);
  });

  it('will not fire on extra modifiers', () => {
    // Ctrl+Alt+F belongs to whoever bound it, not to Alt+F.
    expect(matches(press({ code: 'KeyF', altKey: true, ctrlKey: true }), 'Alt+F')).toBe(false);
    expect(matches(press({ code: 'KeyF', altKey: true, shiftKey: true }), 'Alt+F')).toBe(false);
  });

  it('will not fire on the bare key', () => {
    expect(matches(press({ code: 'KeyF', key: 'f' }), 'Alt+F')).toBe(false);
  });

  it('is false for a bind it cannot read, rather than throwing', () => {
    expect(matches(press({ code: 'KeyF', altKey: true }), '')).toBe(false);
    expect(matches(press({ code: 'KeyF', altKey: true }), 'nonsense')).toBe(false);
  });
});

describe('which tool a keypress opens', () => {
  it('finds each of the four defaults', () => {
    const got = (code: string) => toolFor(press({ code, altKey: true }), DEFAULT_SHORTCUTS);
    expect(got('KeyF')).toBe('formula');
    expect(got('KeyM')).toBe('diagram');
    expect(got('KeyE')).toBe('drawing');
    expect(got('Digit0')).toBe('footnotes');
  });

  it('is null for anything else', () => {
    expect(toolFor(press({ code: 'KeyQ', altKey: true }), DEFAULT_SHORTCUTS)).toBeNull();
    expect(toolFor(press({ code: 'KeyF' }), DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('follows a rebind rather than the default', () => {
    const mine = { ...DEFAULT_SHORTCUTS, formula: 'Ctrl+Shift+2' };
    expect(toolFor(press({ code: 'Digit2', ctrlKey: true, shiftKey: true }), mine)).toBe('formula');
    expect(toolFor(press({ code: 'KeyF', altKey: true }), mine)).toBeNull();
  });
});

describe('setting a bind from a keypress', () => {
  it('writes the modifiers in one order, whatever order they were pressed', () => {
    expect(bindOf(press({ code: 'KeyF', altKey: true, ctrlKey: true, shiftKey: true }))).toBe(
      'Ctrl+Alt+Shift+F'
    );
  });

  it('refuses a key with no modifier, so typing cannot set one off', () => {
    expect(bindOf(press({ code: 'KeyF', key: 'f' }))).toBeNull();
    expect(bindOf(press({ code: 'KeyF', key: 'F', shiftKey: true }))).toBeNull();
  });

  it('refuses a modifier on its own: there is nothing to bind yet', () => {
    expect(bindOf(press({ code: 'AltLeft', key: 'Alt', altKey: true }))).toBeNull();
  });

  it('takes letters, digits and function keys, and nothing else', () => {
    expect(bindOf(press({ code: 'KeyZ', altKey: true }))).toBe('Alt+Z');
    expect(bindOf(press({ code: 'Digit7', altKey: true }))).toBe('Alt+7');
    expect(bindOf(press({ code: 'F5', key: 'F5', altKey: true }))).toBe('Alt+F5');
    expect(bindOf(press({ code: 'BracketLeft', key: '[', altKey: true }))).toBeNull();
  });
});

describe('tidying a written bind', () => {
  it('accepts the spellings a person types', () => {
    expect(parseBind('alt+f')).toBe('Alt+F');
    expect(parseBind(' Shift + Ctrl + k ')).toBe('Ctrl+Shift+K');
  });

  it('rejects what could not be a shortcut', () => {
    for (const bad of ['', 'F', 'Shift+F', 'Hyper+F', 'Alt', 'Alt+[', null, 7]) {
      expect(parseBind(bad as never)).toBeNull();
    }
  });
});

describe('refusing a bind', () => {
  it('explains a key another tool already has', () => {
    expect(bindRefusal('Alt+M', 'formula', DEFAULT_SHORTCUTS)).toBe('Alt+M already opens diagram.');
  });

  it('lets a tool keep the key it already has', () => {
    expect(bindRefusal('Alt+F', 'formula', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('keeps the palette to itself', () => {
    expect(bindRefusal('Ctrl+K', 'formula', DEFAULT_SHORTCUTS)).toBe(
      'Ctrl+K is the command palette.'
    );
  });

  it('says what a usable bind looks like', () => {
    expect(bindRefusal('F', 'formula', DEFAULT_SHORTCUTS)).toContain('Ctrl, Alt or Cmd');
  });

  it('allows a free key', () => {
    expect(bindRefusal('Ctrl+Alt+1', 'formula', DEFAULT_SHORTCUTS)).toBeNull();
  });
});

describe('reading stored shortcuts', () => {
  it('fills in everything that was never set', () => {
    expect(readShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
    expect(readShortcuts({ formula: 'Ctrl+1' })).toEqual({ ...DEFAULT_SHORTCUTS, formula: 'Ctrl+1' });
  });

  it('drops a stored value it cannot read', () => {
    expect(readShortcuts({ formula: 'Shift+F' }).formula).toBe('Alt+F');
  });

  it('never lets two tools end up on one key', () => {
    // Hand-edited storage, or a default that a rebind has since taken.
    const out = readShortcuts({ formula: 'Alt+M' });
    expect(out.formula).toBe('Alt+M');
    expect(out.diagram).not.toBe('Alt+M');
    const binds = TOOLS.map((tool) => out[tool.id]).filter(Boolean);
    expect(new Set(binds).size).toBe(binds.length);
  });

  it('will not hand over a key the app keeps for itself', () => {
    expect(readShortcuts({ formula: 'Ctrl+K' }).formula).toBe('Alt+F');
  });
});
