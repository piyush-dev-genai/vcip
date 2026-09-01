/**
 * The offer countdown (T21).
 *
 * The tests that matter here are the ones about what this module refuses to
 * decide. It converts a server timestamp into a number to display; it never
 * concludes that an offer is over. The server's `offer_expires_at > :now` on
 * accept and `<= :now` on the sweep are the only two opinions with authority,
 * and they run against the database's clock.
 */

import { describe, expect, it } from 'vitest';
import { countdownFinished, formatCountdown, remainingSeconds } from './offer';

const AT = (iso: string): number => Date.parse(iso);
const EXPIRES = '2026-09-01T10:00:30.000Z';

describe('remainingSeconds', () => {
  it('counts down to the server expiry', () => {
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T10:00:00.000Z'))).toBe(30);
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T10:00:20.000Z'))).toBe(10);
  });

  it('rounds up, so a partial second still shows as time left', () => {
    // 0.4s left reads as 1, not 0. Showing zero while the offer is still live
    // would send the agent to check for no reason.
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T10:00:29.600Z'))).toBe(1);
  });

  it('is zero at the instant of expiry', () => {
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T10:00:30.000Z'))).toBe(0);
  });

  it('never goes negative', () => {
    // A long-lapsed offer reads as 0, not as a growing negative number.
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T10:05:00.000Z'))).toBe(0);
  });

  it('is zero when the portal does not know the window', () => {
    // A reload that recovered an id but no expiry. Zero sends the portal to
    // the server, which is where the answer lives.
    expect(remainingSeconds(null, AT('2026-09-01T10:00:00.000Z'))).toBe(0);
  });

  it('is zero for an unparseable timestamp rather than NaN', () => {
    expect(remainingSeconds('not a date', AT('2026-09-01T10:00:00.000Z'))).toBe(0);
  });

  it('handles a clock that is behind the server', () => {
    // A slow local clock shows more time than there is. That is safe: the
    // accept simply gets refused and the server says so.
    expect(remainingSeconds(EXPIRES, AT('2026-09-01T09:59:00.000Z'))).toBe(90);
  });
});

describe('countdownFinished', () => {
  it('is false while time remains', () => {
    expect(countdownFinished(EXPIRES, AT('2026-09-01T10:00:29.000Z'))).toBe(false);
  });

  it('is true once the displayed number reaches zero', () => {
    expect(countdownFinished(EXPIRES, AT('2026-09-01T10:00:30.000Z'))).toBe(true);
  });

  it('is true when the window is unknown', () => {
    expect(countdownFinished(null, AT('2026-09-01T10:00:00.000Z'))).toBe(true);
  });

  it('answers about this browser clock, not about the session', () => {
    // A tab whose clock is a minute fast reports the countdown as finished
    // while the offer is still perfectly live on the server. That is exactly
    // why the portal's only response is to re-read the session, and why this
    // function is not called `hasExpired`.
    const fastClock = AT('2026-09-01T10:01:00.000Z');
    expect(countdownFinished(EXPIRES, fastClock)).toBe(true);
  });
});

describe('formatCountdown', () => {
  it('renders minutes and seconds', () => {
    expect(formatCountdown(30)).toBe('0:30');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(75)).toBe('1:15');
  });

  it('renders zero rather than a negative', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('pads the seconds so the width does not jump while counting', () => {
    expect(formatCountdown(5)).toBe('0:05');
    expect(formatCountdown(65)).toBe('1:05');
  });
});
