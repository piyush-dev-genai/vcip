import { describe, expect, it } from 'vitest';
import { TOKEN_MIN_REMAINING_MS, reusableToken, tokenUsable } from './media-token';
import type { MediaToken } from './media-token';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const token = (expiresAt: string): MediaToken => ({
  room_name: 'vcip_11111111-1111-4111-8111-111111111111',
  token: 'FAKE-TOKEN-NOT-A-CREDENTIAL',
  expires_at: expiresAt,
});

describe('tokenUsable', () => {
  it('accepts a token with the full fifteen minutes left', () => {
    expect(tokenUsable(at(15 * 60_000), NOW)).toBe(true);
  });

  it('accepts one exactly at the margin', () => {
    expect(tokenUsable(at(TOKEN_MIN_REMAINING_MS), NOW)).toBe(true);
  });

  it('refuses one just inside the margin', () => {
    expect(tokenUsable(at(TOKEN_MIN_REMAINING_MS - 1), NOW)).toBe(false);
  });

  it('refuses an expired token', () => {
    expect(tokenUsable(at(-1), NOW)).toBe(false);
  });

  /**
   * The safe direction. Refetching is a GET that changes no state, whereas
   * trusting a timestamp nobody could parse means connecting with a credential
   * of unknown age.
   */
  it('refuses a missing or unparseable expiry', () => {
    expect(tokenUsable(null, NOW)).toBe(false);
    expect(tokenUsable('not a timestamp', NOW)).toBe(false);
    expect(tokenUsable('', NOW)).toBe(false);
  });

  it('takes the margin as an argument, so a caller can be stricter', () => {
    const fiveMinutes = at(5 * 60_000);
    expect(tokenUsable(fiveMinutes, NOW, 60_000)).toBe(true);
    expect(tokenUsable(fiveMinutes, NOW, 10 * 60_000)).toBe(false);
  });

  it('defends the whole connect handshake, not just the moment of asking', () => {
    // A minute is the point: a token fetch, an ICE negotiation and a camera
    // prompt can sit between deciding to join and actually joining.
    expect(TOKEN_MIN_REMAINING_MS).toBe(60_000);
  });
});

describe('reusableToken', () => {
  it('returns nothing when none is held', () => {
    expect(reusableToken(null, NOW)).toBeNull();
  });

  it('returns the held token while it has life left', () => {
    const held = token(at(10 * 60_000));
    expect(reusableToken(held, NOW)).toBe(held);
  });

  /**
   * R2 permits a token while `QUEUED`, so one fetched when the customer joined
   * the queue can easily be dead by the time an agent accepts. This is the
   * function that notices.
   */
  it('discards a token that went stale during a long wait', () => {
    const held = token(at(15 * 60_000));
    const twentyMinutesLater = NOW + 20 * 60_000;
    expect(reusableToken(held, twentyMinutesLater)).toBeNull();
  });

  it('discards one that would expire mid-handshake', () => {
    expect(reusableToken(token(at(30_000)), NOW)).toBeNull();
  });
});
