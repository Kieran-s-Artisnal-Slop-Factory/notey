import { describe, expect, it } from 'vitest';
import { describeOffline } from './offline';

describe('the offline-copy line', () => {
  it('says so plainly when everything is here', () => {
    expect(describeOffline({ ready: true, missing: 0, total: 374 })).toBe(
      'Ready to work offline — all 374 files are here.'
    );
  });

  it('counts what is left rather than what is done', () => {
    // "12 of 374 downloaded" reads like progress and is not: the worker
    // skips what it already has, so `done` restarts at zero every run.
    expect(describeOffline({ ready: false, missing: 12, total: 374 })).toBe(
      '12 of 374 files still to download.'
    );
  });

  it('does not claim a total it has not got', () => {
    // No manifest yet (a first visit that has not reached the worker's
    // list) is a wait, not a failure.
    expect(describeOffline({ ready: false, missing: 0, total: 0 })).toBe(
      'Working out what this copy needs…'
    );
  });
});
