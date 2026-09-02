import { describe, expect, it } from 'vitest';
import { FakeBus, FakeLocks, settle, type ChannelLike } from './fakePlatform';
import { memoryStore } from './memoryStore';
import { OWNER_LOCK, sharedVault, type Change, type SharedVault } from './tabs';
import type { VaultStore } from './types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `cond` holds; the fake's timings are short but not zero. */
async function until(cond: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await settle(1);
  }
}

/**
 * A browser profile in miniature: one lock table, one channel, one
 * database on "disk" that only one open store may hold at a time — the
 * OPFS handles — and which a dead tab lets go of a moment later.
 */
function profile(opts: { slowWriteMs?: number } = {}) {
  const locks = new FakeLocks();
  const bus = new FakeBus();
  const raw = memoryStore();
  /** Every mutation the database really ran, in order — the exactly-once evidence. */
  const calls: string[] = [];
  const db: VaultStore = {
    ...raw,
    async write(file) {
      calls.push('write');
      if (opts.slowWriteMs) await sleep(opts.slowWriteMs);
      return raw.write(file);
    },
    async create(file) {
      calls.push('create');
      return raw.create(file);
    },
    async rename(from, to) {
      calls.push('rename');
      return raw.rename(from, to);
    },
    async remove(path) {
      calls.push('remove');
      return raw.remove(path);
    },
    async mkdir(path) {
      calls.push('mkdir');
      return raw.mkdir(path);
    },
  };
  let openedBy: string | null = null;
  const tabs = new Map<string, { vault: SharedVault; channel: ChannelLike; changes: Change[][] }>();

  const open = (id: string) => async (): Promise<VaultStore> => {
    if (openedBy && openedBy !== id) throw new Error('notey-vault-busy');
    openedBy = id;
    return {
      ...db,
      backend: 'fake-opfs',
      async close() {
        if (openedBy === id) openedBy = null;
      },
    };
  };

  const tab = (
    id: string,
    opts: { requestTimeoutMs?: number; bootTimeoutMs?: number; open?: () => Promise<VaultStore> } = {}
  ) => {
    const channel = bus.connect();
    const vault = sharedVault({
      tabId: id,
      locks: locks.client(id),
      bus: channel,
      open: opts.open ?? open(id),
      retryDelaysMs: [1, 2, 4, 8, 16, 32],
      requestTimeoutMs: opts.requestTimeoutMs ?? 2_000,
      bootTimeoutMs: opts.bootTimeoutMs ?? 2_000,
    });
    const changes: Change[][] = [];
    vault.onChange((c) => changes.push(c));
    tabs.set(id, { vault, channel, changes });
    return vault;
  };

  /** The tab is closed: no pagehide, no goodbye — the crash case. */
  const crash = (id: string): void => {
    const t = tabs.get(id)!;
    t.channel.close();
    locks.unload(id);
    // The dead worker's handles are released a moment after.
    setTimeout(() => {
      if (openedBy === id) openedBy = null;
    }, 20);
  };

  /** The tab still does its work but its answers never arrive (dying mid-reply). */
  const dropReplies = (id: string): void => {
    const channel = tabs.get(id)!.channel;
    const original = channel.postMessage.bind(channel);
    channel.postMessage = (m: unknown) => {
      if ((m as { type: string }).type !== 'res') original(m);
    };
  };

  return { locks, bus, db, calls, tab, crash, dropReplies, tabs, whoHolds: () => openedBy };
}

describe('sharedVault', () => {
  it('the first tab owns the database and a second one goes through it', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    expect(a.role).toBe('owner');
    const b = p.tab('B');
    await b.init();
    expect(b.role).toBe('follower');
    expect(b.backend).toContain('via another tab');

    await b.write({ path: 'From B.md', kind: 'note', content: 'hello' });
    expect((await p.db.read('From B.md'))?.content).toBe('hello');
    // Both tabs see it, and A can read it back through its own store.
    expect((await a.read('From B.md'))?.content).toBe('hello');
    await settle();
    expect(p.tabs.get('A')!.changes.flat()).toEqual([{ op: 'write', path: 'From B.md' }]);
    expect(p.tabs.get('B')!.changes.flat()).toEqual([{ op: 'write', path: 'From B.md' }]);

    await a.write({ path: 'From A.md', kind: 'note', content: 'hi' });
    await settle();
    expect((await b.loadAll()).map((r) => r.path)).toEqual(['From A.md', 'From B.md']);
    expect(p.tabs.get('B')!.changes.flat()).toContainEqual({ op: 'write', path: 'From A.md' });
  });

  it('a third tab is told who owns the vault without waiting for anything', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    const c = p.tab('C');
    await c.init();
    expect([a.role, b.role, c.role]).toEqual(['owner', 'follower', 'follower']);
    await c.mkdir('Work');
    await settle();
    expect((await b.loadAll()).map((r) => r.path)).toEqual(['Work']);
  });

  it('two tabs booting at once end up as one owner and one follower', async () => {
    const p = profile();
    const a = p.tab('A');
    const b = p.tab('B');
    await Promise.all([a.init(), b.init()]);
    expect([a.role, b.role].sort()).toEqual(['follower', 'owner']);
    await b.write({ path: 'x.md', kind: 'note', content: 'x' });
    expect((await a.read('x.md'))?.content).toBe('x');
  });

  it('when the owner is closed a follower takes over and in-flight writes land once', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    // A stops answering (frozen), then is closed; B's write is in flight.
    p.bus.freeze(p.tabs.get('A')!.channel);
    const inFlight = b.write({ path: 'Late.md', kind: 'note', content: 'late' });
    await settle();
    p.crash('A');
    await inFlight;
    expect(b.role).toBe('owner');
    expect((await p.db.read('Late.md'))?.content).toBe('late');
    expect(p.calls.filter((c) => c === 'write')).toHaveLength(1);
    expect(p.whoHolds()).toBe('B');
    // And a later tab finds the new owner.
    const c = p.tab('C');
    await c.init();
    expect(c.role).toBe('follower');
    await c.write({ path: 'From C.md', kind: 'note', content: 'c' });
    expect((await p.db.read('From C.md'))?.content).toBe('c');
  });

  it('rename A→B then write B stay ordered across a crash', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await b.write({ path: 'Old.md', kind: 'note', content: 'v1' });
    p.bus.freeze(p.tabs.get('A')!.channel);
    const renamed = b.rename('Old.md', 'New.md');
    const written = b.write({ path: 'New.md', kind: 'note', content: 'v2' });
    await settle();
    p.crash('A');
    await Promise.all([renamed, written]);
    expect(await p.db.read('Old.md')).toBeNull();
    expect((await p.db.read('New.md'))?.content).toBe('v2');
  });

  it('a third follower writing during a hand-over is served by the new owner', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    const c = p.tab('C');
    await c.init();
    await a.shutdown();
    // B has the lock but has not opened the database yet: C has nobody to ask.
    const written = c.write({ path: 'Gap.md', kind: 'note', content: 'gap' });
    await written;
    expect(b.role).toBe('owner');
    expect((await p.db.read('Gap.md'))?.content).toBe('gap');
  });

  it('a tab promoted while its re-drive waits on the old owner finishes the re-drive', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const c = p.tab('C'); // next in the lock queue
    await c.init();
    const b = p.tab('B');
    await b.init();
    p.bus.freeze(p.tabs.get('A')!.channel);
    const one = b.write({ path: 'One.md', kind: 'note', content: '1' });
    const two = b.write({ path: 'Two.md', kind: 'note', content: '2' });
    await settle();
    // C will be the next owner; B re-drives One.md against it, C does it,
    // but its answer is lost — and then C dies with B parked on that answer.
    p.dropReplies('C');
    p.crash('A');
    await until(() => c.role === 'owner');
    await until(() => p.calls.includes('write'));
    await settle();
    p.crash('C');
    await Promise.all([one, two]);
    expect(b.role).toBe('owner');
    expect((await p.db.read('One.md'))?.content).toBe('1');
    expect((await p.db.read('Two.md'))?.content).toBe('2');
  });

  it('a rename the dead owner already did is not done twice', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await b.write({ path: 'Old.md', kind: 'note', content: 'x' });
    await b.write({ path: 'Blocker.md', kind: 'note', content: 'y' });
    // A performs the rename but its answer is lost, then A is closed.
    const aChannel = p.tabs.get('A')!.channel;
    const original = aChannel.postMessage.bind(aChannel);
    let dropped = 0;
    aChannel.postMessage = (m: unknown) => {
      const msg = m as { type: string; to?: string };
      if (msg.type === 'res' && dropped === 0) {
        dropped++;
        return; // the reply that never made it
      }
      original(m);
    };
    const renamed = b.rename('Old.md', 'New.md');
    await settle();
    expect((await p.db.read('New.md'))?.content).toBe('x'); // A did it
    p.crash('A');
    await expect(renamed).resolves.toBeUndefined(); // not "target exists"
    expect(b.role).toBe('owner');
    expect((await p.db.read('Old.md'))).toBeNull();
    expect((await p.db.read('New.md'))?.content).toBe('x');
    expect(p.calls.filter((c) => c === 'rename')).toHaveLength(1);
  });

  it('a rename that really did not happen is re-driven', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await b.write({ path: 'Old.md', kind: 'note', content: 'x' });
    p.bus.freeze(p.tabs.get('A')!.channel); // A never sees the request
    const renamed = b.rename('Old.md', 'New.md');
    await settle();
    p.crash('A');
    await renamed;
    expect((await p.db.read('Old.md'))).toBeNull();
    expect((await p.db.read('New.md'))?.content).toBe('x');
  });

  it('a re-driven rename whose check reads were lost with the next owner is re-checked, not hung', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const c = p.tab('C'); // lock queue: C, then D, then B
    await c.init();
    const d = p.tab('D');
    await d.init();
    const b = p.tab('B');
    await b.init();
    await b.write({ path: 'Old.md', kind: 'note', content: 'x' });
    p.bus.freeze(p.tabs.get('A')!.channel);
    const renamed = b.rename('Old.md', 'New.md');
    await settle();
    // B's "did it already happen?" reads go to the next owner, C, and are
    // lost with it; D, the owner after that, is alive and answering.
    p.dropReplies('C');
    p.crash('A');
    await until(() => c.role === 'owner');
    await settle();
    p.crash('C');
    await until(() => d.role === 'owner');
    await renamed; // not hung, not "exists"
    expect(await p.db.read('Old.md')).toBeNull();
    expect((await p.db.read('New.md'))?.content).toBe('x');
    // And B is still a working follower of D.
    expect((await b.read('New.md'))?.content).toBe('x');
  });

  it('a create the dead owner already did is not reported as a clash', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    p.dropReplies('A'); // A's answers are lost
    const created = b.create({ path: 'New.md', kind: 'note', content: 'x' });
    await settle();
    expect((await p.db.read('New.md'))?.content).toBe('x'); // A did it
    p.crash('A');
    await expect(created).resolves.toMatchObject({ path: 'New.md', content: 'x' });
    expect((await p.db.loadAll()).filter((r) => r.path === 'New.md')).toHaveLength(1);
    expect(p.calls.filter((c) => c === 'create')).toHaveLength(1);
  });

  it('a create the dead owner did with other content still reports the clash', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await a.write({ path: 'Taken.md', kind: 'note', content: 'theirs' });
    p.bus.freeze(p.tabs.get('A')!.channel);
    const created = b.create({ path: 'Taken.md', kind: 'note', content: 'mine' });
    await settle();
    p.crash('A');
    await expect(created).rejects.toThrow(/exists/);
    expect((await p.db.read('Taken.md'))?.content).toBe('theirs');
  });

  it('a follower whose owner will not answer gets an error, not silence', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B', { requestTimeoutMs: 30 });
    await b.init();
    p.bus.freeze(p.tabs.get('A')!.channel);
    await expect(b.write({ path: 'x.md', kind: 'note', content: '' })).rejects.toThrow(/not answering/);
  });

  it('a follower whose next owner never speaks gets an error, not silence', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    // Z is next in the lock queue and will hold it without ever announcing.
    void p.locks.client('Z').request(OWNER_LOCK, () => new Promise(() => {}));
    await settle();
    const b = p.tab('B', { requestTimeoutMs: 100 });
    await b.init();
    await a.shutdown();
    await settle();
    await expect(b.write({ path: 'x.md', kind: 'note', content: '' })).rejects.toThrow(/not answering/);
  });

  it('a write in flight when the owner leaves is not left without a clock', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    void p.locks.client('Z').request(OWNER_LOCK, () => new Promise(() => {}));
    await settle();
    const b = p.tab('B', { requestTimeoutMs: 100 });
    await b.init();
    p.dropReplies('A');
    const written = b.write({ path: 'x.md', kind: 'note', content: '' });
    await settle();
    await a.shutdown();
    await expect(written).rejects.toThrow(/not answering/);
  });

  it('the timeout does not fire while the owner is busy answering others', async () => {
    const p = profile({ slowWriteMs: 100 });
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B', { requestTimeoutMs: 30 });
    await b.init();
    const c = p.tab('C');
    await c.init();
    const written = b.write({ path: 'Slow.md', kind: 'note', content: 'slow' });
    const reads = setInterval(() => void c.read('Slow.md'), 10);
    try {
      await expect(written).resolves.toMatchObject({ path: 'Slow.md' });
    } finally {
      clearInterval(reads);
    }
  });

  it('a tab that can never learn the owner gives up with a clear error', async () => {
    const p = profile();
    // Something holds the owner lock and never announces (a frozen tab).
    void p.locks.client('Z').request(OWNER_LOCK, () => new Promise(() => {}));
    await settle();
    const b = p.tab('B', { bootTimeoutMs: 30 });
    await expect(b.init()).rejects.toThrow(/not answering/);
  });

  it('a database that will not open for a real reason fails the tab, not the vault', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = sharedVault({
      tabId: 'A',
      locks: locks.client('A'),
      bus: bus.connect(),
      open: async () => {
        throw new Error('worker script failed');
      },
      retryDelaysMs: [1],
    });
    await expect(a.init()).rejects.toThrow(/worker script failed/);
    await settle();
    expect(locks.heldNames()).toEqual([]); // the lock went back
  });

  it("one tab's failure to open is not another's: the next tab tries for itself", async () => {
    const p = profile();
    const a = p.tab('A', {
      open: async () => {
        throw new Error('worker script failed');
      },
    });
    const b = p.tab('B');
    const [aOutcome] = await Promise.all([a.init().catch((e: unknown) => e), b.init()]);
    expect(aOutcome).toBeInstanceOf(Error);
    expect(b.role).toBe('owner');
    await b.write({ path: 'x.md', kind: 'note', content: 'x' });
    expect((await p.db.read('x.md'))?.content).toBe('x');
  });

  it('shutdown hands the database to the next tab straight away', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await a.shutdown();
    await settle(20);
    expect(b.role).toBe('owner');
    await b.write({ path: 'After.md', kind: 'note', content: 'z' });
    expect((await p.db.read('After.md'))?.content).toBe('z');
  });

  it('errors from the database come back as errors', async () => {
    const p = profile();
    const a = p.tab('A');
    await a.init();
    const b = p.tab('B');
    await b.init();
    await b.write({ path: 'A.md', kind: 'note', content: '' });
    await b.write({ path: 'B.md', kind: 'note', content: '' });
    await expect(b.rename('A.md', 'B.md')).rejects.toThrow(/exists/);
  });
});
