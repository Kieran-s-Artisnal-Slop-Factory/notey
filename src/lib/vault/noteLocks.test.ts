import { describe, expect, it } from 'vitest';
import { FakeLocks, settle } from './fakePlatform';
import { holdNote, noteLockName, notesHeldElsewhere } from './noteLocks';

describe('holdNote', () => {
  it('takes a free note at once', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    expect(await a.ready).toBe(true);
    expect(a.status).toBe('held');
    expect(locks.heldNames()).toEqual([noteLockName('Plan.md')]);
    a.release();
    await settle();
    expect(locks.heldNames()).toEqual([]);
  });

  it('a second tab waits, and is promoted when the first lets go', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    await a.ready;
    let promoted = 0;
    const b = holdNote('Plan.md', locks.client('B'), () => promoted++);
    expect(await b.ready).toBe(false);
    expect(b.status).toBe('waiting');
    expect(promoted).toBe(0);
    a.release();
    await settle();
    expect(b.status).toBe('held');
    expect(promoted).toBe(1);
    expect(locks.heldNames()).toEqual([noteLockName('Plan.md')]);
    b.release();
    await settle();
    expect(locks.heldNames()).toEqual([]);
  });

  it('a waiting tab that moves on stops waiting', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    await a.ready;
    let promoted = 0;
    const b = holdNote('Plan.md', locks.client('B'), () => promoted++);
    await b.ready;
    b.release();
    await settle();
    expect((await locks.client('B').query()).pending).toEqual([]);
    a.release();
    await settle();
    expect(promoted).toBe(0);
    expect(b.status).toBe('released');
    expect(locks.heldNames()).toEqual([]);
  });

  it('closing the holding tab promotes the waiter', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    await a.ready;
    const b = holdNote('Plan.md', locks.client('B'));
    await b.ready;
    locks.unload('A');
    await settle();
    expect(b.status).toBe('held');
  });

  it('releasing before the answer arrives holds nothing', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    a.release(); // before the grant callback has run
    expect(await a.ready).toBe(false);
    await settle();
    expect(locks.heldNames()).toEqual([]);
    expect(a.status).toBe('released');
  });

  it('a note reopened straight after its release is held, not waiting', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Plan.md', locks.client('A'));
    await a.ready;
    await a.release();
    const again = holdNote('Plan.md', locks.client('A'));
    expect(await again.ready).toBe(true);
    expect(again.status).toBe('held');
    await again.release();
  });

  it('two different notes never wait on each other', async () => {
    const locks = new FakeLocks();
    const a = holdNote('One.md', locks.client('A'));
    const b = holdNote('Two.md', locks.client('B'));
    expect(await a.ready).toBe(true);
    expect(await b.ready).toBe(true);
  });

  it('with no lock manager the note is simply ours', async () => {
    const a = holdNote('Plan.md', null);
    expect(await a.ready).toBe(true);
    expect(a.status).toBe('held');
    a.release();
  });
});

describe('notesHeldElsewhere', () => {
  it('lists other tabs’ notes, not our own, and ignores other locks', async () => {
    const locks = new FakeLocks();
    const a = holdNote('Mine.md', locks.client('A'));
    const b = holdNote('Work/Theirs.md', locks.client('B'));
    await Promise.all([a.ready, b.ready]);
    // An unrelated lock (the vault owner) is not a note.
    void locks.client('B').request('notey:vault-owner', () => new Promise(() => {}));
    await settle();
    expect(await notesHeldElsewhere(locks.client('A'), 'Mine.md')).toEqual(new Set(['Work/Theirs.md']));
    expect(await notesHeldElsewhere(locks.client('A'), null)).toEqual(
      new Set(['Mine.md', 'Work/Theirs.md'])
    );
    expect(await notesHeldElsewhere(null, null)).toEqual(new Set());
  });
});
