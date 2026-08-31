/**
 * The claim's pure rules (T18).
 *
 * Both functions are small enough to test exhaustively, which is the reason
 * they are separate from the service at all: presence eligibility has exactly
 * four inputs, and every one of them is asserted here rather than sampled
 * through an HTTP test.
 */

import { AgentPresence } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import { offerExpiresAt, presenceAllowsClaim } from './agent-claim.rules.js';

describe('presenceAllowsClaim', () => {
  it('permits an AVAILABLE agent', () => {
    expect(presenceAllowsClaim(AgentPresence.AVAILABLE)).toBe(true);
  });

  it('refuses a BUSY agent', () => {
    expect(presenceAllowsClaim(AgentPresence.BUSY)).toBe(false);
  });

  it('refuses an UNAVAILABLE agent', () => {
    expect(presenceAllowsClaim(AgentPresence.UNAVAILABLE)).toBe(false);
  });

  it('refuses an agent with no presence at all', () => {
    // Never went available, or the TTL lapsed. The same fact either way.
    expect(presenceAllowsClaim(null)).toBe(false);
  });

  it('permits exactly one of the presence values', () => {
    const permitted = [
      AgentPresence.AVAILABLE,
      AgentPresence.BUSY,
      AgentPresence.UNAVAILABLE,
    ].filter(presenceAllowsClaim);

    expect(permitted).toEqual([AgentPresence.AVAILABLE]);
  });
});

describe('offerExpiresAt', () => {
  const offeredAt = new Date('2026-08-31T10:00:00.000Z');

  it('adds the tenant timeout to the offer time', () => {
    expect(offerExpiresAt(offeredAt, 30).toISOString()).toBe('2026-08-31T10:00:30.000Z');
  });

  it('reads the timeout in seconds, not milliseconds', () => {
    // A regression guard: `+ timeout` instead of `+ timeout * 1000` would make
    // every offer expire 30 milliseconds after it was made.
    expect(offerExpiresAt(offeredAt, 30).getTime() - offeredAt.getTime()).toBe(30_000);
  });

  it('honours a tenant-specific timeout', () => {
    expect(offerExpiresAt(offeredAt, 120).toISOString()).toBe('2026-08-31T10:02:00.000Z');
  });

  it('does not mutate the date it was given', () => {
    const original = offeredAt.getTime();
    offerExpiresAt(offeredAt, 45);
    expect(offeredAt.getTime()).toBe(original);
  });

  it('crosses a minute, hour, and day boundary correctly', () => {
    const late = new Date('2026-08-31T23:59:50.000Z');
    expect(offerExpiresAt(late, 30).toISOString()).toBe('2026-09-01T00:00:20.000Z');
  });
});
