import { describe, expect, it } from 'vitest';
import {
  baseOf,
  dirOf,
  isPathArg,
  launchTarget,
  rootLabel,
  toSlashes,
  underRoot,
} from './desktopPaths';

describe('dirOf and baseOf', () => {
  it('split a Windows path', () => {
    expect(dirOf('C:\\Users\\me\\notes\\Plan.md')).toBe('C:\\Users\\me\\notes');
    expect(baseOf('C:\\Users\\me\\notes\\Plan.md')).toBe('Plan.md');
  });

  it('split a POSIX path', () => {
    expect(dirOf('/home/me/notes/Plan.md')).toBe('/home/me/notes');
    expect(baseOf('/home/me/notes/Plan.md')).toBe('Plan.md');
  });

  it('ignore a trailing separator, the way a dragged folder arrives', () => {
    expect(baseOf('/home/me/notes/')).toBe('notes');
    expect(dirOf('/home/me/notes/')).toBe('/home/me');
  });

  it('do not eat a drive or a root', () => {
    expect(dirOf('/Plan.md')).toBe('/');
    expect(dirOf('C:\\Plan.md')).toBe('C:/');
    // A drive root has no name of its own; rootLabel falls back to the path.
    expect(baseOf('C:\\')).toBe('');
    expect(rootLabel('C:\\')).toBe('C:');
  });

  it('cope with a bare name', () => {
    expect(dirOf('Plan.md')).toBe('');
    expect(baseOf('Plan.md')).toBe('Plan.md');
  });
});

describe('toSlashes and underRoot', () => {
  it('write one separator, the one every platform takes', () => {
    expect(toSlashes('C:\\Users\\me\\notes\\')).toBe('C:/Users/me/notes');
    expect(underRoot('C:\\Users\\me\\notes', 'Work/Plan.md')).toBe('C:/Users/me/notes/Work/Plan.md');
    // The vault root itself.
    expect(underRoot('/home/me/notes', '')).toBe('/home/me/notes');
  });
});

describe('launchTarget', () => {
  it('a folder becomes the vault', () => {
    expect(launchTarget('C:\\Users\\me\\notes', true)).toEqual({
      root: 'C:/Users/me/notes',
      open: null,
    });
  });

  it('a file mounts its folder and opens it, so saves land back in place', () => {
    expect(launchTarget('C:\\Users\\me\\notes\\Plan.md', false)).toEqual({
      root: 'C:/Users/me/notes',
      open: 'Plan.md',
    });
    expect(launchTarget('/home/me/todo.md', false)).toEqual({
      root: '/home/me',
      open: 'todo.md',
    });
  });
});

describe('isPathArg', () => {
  it('takes a path and refuses a flag or nothing at all', () => {
    expect(isPathArg('/home/me/notes')).toBe(true);
    expect(isPathArg('--version')).toBe(false);
    expect(isPathArg('')).toBe(false);
    expect(isPathArg(null)).toBe(false);
    expect(isPathArg(undefined)).toBe(false);
  });
});

describe('rootLabel', () => {
  it('names a folder by its last segment', () => {
    expect(rootLabel('C:\\Users\\me\\Documents\\Notey')).toBe('Notey');
    expect(rootLabel('/home/me/notes/')).toBe('notes');
  });
});
