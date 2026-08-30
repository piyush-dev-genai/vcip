/**
 * The queue panel's presentation rules.
 *
 * Plain Node, no DOM. These are formatting decisions, and the point of testing
 * them here is that none of them is allowed to become a *routing* decision —
 * nothing in this file sorts, filters, or derives a wait from a timestamp.
 */

import { describe, expect, it } from 'vitest';
import type { QueuedSession } from './api';
import { formatWait, isStale, QUEUE_REFRESH_INTERVAL_MS, sameOrder, shortId } from './queue';

const session = (id: string, waitSeconds = 0): QueuedSession => ({
  session_id: id,
  language: 'en',
  priority: 0,
  queued_at: '2026-08-31T10:00:00.000Z',
  wait_seconds: waitSeconds,
});

describe('formatWait', () => {
  it('shows seconds below a minute', () => {
    expect(formatWait(0)).toBe('0s');
    expect(formatWait(1)).toBe('1s');
    expect(formatWait(59)).toBe('59s');
  });

  it('switches to minutes at sixty seconds', () => {
    expect(formatWait(60)).toBe('1m');
    expect(formatWait(90)).toBe('1m');
    expect(formatWait(3599)).toBe('59m');
  });

  it('rounds down rather than up, so a wait is never overstated', () => {
    expect(formatWait(119)).toBe('1m');
    expect(formatWait(59.9)).toBe('59s');
  });

  it('shows hours and minutes past an hour', () => {
    expect(formatWait(3600)).toBe('1h');
    expect(formatWait(3660)).toBe('1h 1m');
    expect(formatWait(7380)).toBe('2h 3m');
  });

  it('renders a negative or non-finite value as zero rather than as itself', () => {
    expect(formatWait(-5)).toBe('0s');
    expect(formatWait(Number.NaN)).toBe('0s');
    expect(formatWait(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});

describe('shortId', () => {
  it('takes the first segment of a uuid', () => {
    expect(shortId('7c9e6679-7425-40de-944b-e07fc1f90ae7')).toBe('7c9e6679');
  });

  it('returns the value unchanged when there is no segment to take', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('');
    expect(shortId('-leading')).toBe('-leading');
  });
});

describe('isStale', () => {
  it('is stale before the first successful read', () => {
    expect(isStale(null, 1000, 10_000)).toBe(true);
  });

  it('is fresh immediately after a read', () => {
    expect(isStale(1000, 1000, 10_000)).toBe(false);
  });

  it('becomes stale once the tolerance is exceeded', () => {
    expect(isStale(1000, 11_000, 10_000)).toBe(false);
    expect(isStale(1000, 11_001, 10_000)).toBe(true);
  });
});

describe('sameOrder', () => {
  it('is true for the same ids in the same order', () => {
    expect(sameOrder([session('a'), session('b')], [session('a'), session('b')])).toBe(true);
  });

  it('ignores wait_seconds, which changes on every read', () => {
    expect(sameOrder([session('a', 5)], [session('a', 12)])).toBe(true);
  });

  it('is false when the order changed', () => {
    expect(sameOrder([session('a'), session('b')], [session('b'), session('a')])).toBe(false);
  });

  it('is false when a session joined or left', () => {
    expect(sameOrder([session('a')], [session('a'), session('b')])).toBe(false);
    expect(sameOrder([session('a'), session('b')], [session('a')])).toBe(false);
  });

  it('is true for two empty lists', () => {
    expect(sameOrder([], [])).toBe(true);
  });
});

describe('the refresh cadence', () => {
  it('is a small explicit interval', () => {
    expect(QUEUE_REFRESH_INTERVAL_MS).toBe(5000);
  });
});
