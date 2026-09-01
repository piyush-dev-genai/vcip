/**
 * The queue's addressing rules.
 *
 * Small functions, but the tenant segment in the key is the whole of queue
 * tenant isolation (I8) and the score equality is the whole of FIFO ordering.
 * Both are asserted here rather than only through Redis, so a change to either
 * fails in a test that names the rule it broke.
 */

import { describe, expect, it } from 'vitest';
import { normaliseLanguage, positionFromAhead, queueKey, scoreFor } from './queue.keys.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

describe('queueKey', () => {
  it('is queue:{tenant_id}:{language}, as R13 specifies', () => {
    expect(queueKey(TENANT_A, 'en')).toBe(`queue:${TENANT_A}:en`);
  });

  it('always contains the tenant id', () => {
    // The single most important property in this file. A key without the
    // tenant would put two tenants' customers in one queue.
    expect(queueKey(TENANT_A, 'en')).toContain(TENANT_A);
  });

  it('gives different tenants different keys for the same language', () => {
    expect(queueKey(TENANT_A, 'en')).not.toBe(queueKey(TENANT_B, 'en'));
  });

  it('gives different languages different keys for the same tenant', () => {
    expect(queueKey(TENANT_A, 'en')).not.toBe(queueKey(TENANT_A, 'hi'));
  });

  it('treats language case-insensitively, so one queue does not split in two', () => {
    expect(queueKey(TENANT_A, 'EN')).toBe(queueKey(TENANT_A, 'en'));
    expect(queueKey(TENANT_A, ' en ')).toBe(queueKey(TENANT_A, 'en'));
  });

  it('keeps a regional tag distinct from its base language', () => {
    // `en-IN` is a different queue from `en`; R13 shards on the tag as given.
    expect(queueKey(TENANT_A, 'en-IN')).not.toBe(queueKey(TENANT_A, 'en'));
    expect(queueKey(TENANT_A, 'en-IN')).toBe(`queue:${TENANT_A}:en-in`);
  });

  it('produces exactly three colon-separated segments', () => {
    // The shape the key parser in any future tooling would rely on. A language
    // containing a colon would break it — `createSessionSchema` forbids one.
    expect(queueKey(TENANT_A, 'en').split(':')).toHaveLength(3);
  });
});

describe('normaliseLanguage', () => {
  it('lower-cases and trims', () => {
    expect(normaliseLanguage('  EN-in ')).toBe('en-in');
  });
});

describe('scoreFor', () => {
  it('is queued_at in milliseconds', () => {
    const queuedAt = new Date('2026-08-30T10:00:00.000Z');
    expect(scoreFor(queuedAt)).toBe(queuedAt.getTime());
  });

  it('orders an older queued_at before a newer one', () => {
    const older = scoreFor(new Date('2026-08-30T10:00:00.000Z'));
    const newer = scoreFor(new Date('2026-08-30T10:00:01.000Z'));
    expect(older).toBeLessThan(newer);
  });

  it('is exactly representable as a Redis score', () => {
    // Redis scores are IEEE-754 doubles; integers below 2^53 are exact.
    const score = scoreFor(new Date('2026-08-30T10:00:00.123Z'));
    expect(Number.isSafeInteger(score)).toBe(true);
    expect(score).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('is derived only from its argument, never from the clock', () => {
    // The property mutation B breaks: an enqueue happening now must still
    // score a session that was queued in the past at its original time.
    const historical = new Date(Date.now() - 45 * 60 * 1000);
    expect(scoreFor(historical)).toBe(historical.getTime());
    expect(scoreFor(historical)).toBeLessThan(Date.now() - 1000);
  });
});

describe('positionFromAhead', () => {
  it('turns nobody ahead into position 1', () => {
    expect(positionFromAhead(0)).toBe(1);
  });

  it('turns one waiting ahead into position 2', () => {
    expect(positionFromAhead(1)).toBe(2);
  });

  it('is waiting-ahead + 1 for any count', () => {
    for (const ahead of [0, 1, 2, 17, 999]) {
      expect(positionFromAhead(ahead)).toBe(ahead + 1);
    }
  });

  it('never returns zero', () => {
    // Position zero would be a queue place that does not exist.
    for (const ahead of [0, 1, 5]) {
      expect(positionFromAhead(ahead)).not.toBe(0);
    }
  });

  it('passes null through rather than inventing a position', () => {
    expect(positionFromAhead(null)).toBeNull();
  });
});
