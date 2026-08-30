import { describe, expect, it } from 'vitest';
import { browserTokenHost, clearToken, isExpired, readToken, writeToken } from './token';
import type { StorageLike, TokenHost } from './token';

/** Never a real credential. */
const TOKEN = 'FAKE.AGENT.TOKEN.VALUE';
const LATER = '2026-08-31T12:00:00.000Z';
const NOW = new Date('2026-08-31T09:00:00.000Z');

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** Private mode and blocked-cookies settings both throw rather than return null. */
class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('storage disabled');
  }
  setItem(): void {
    throw new Error('storage disabled');
  }
  removeItem(): void {
    throw new Error('storage disabled');
  }
}

const hostWith = (storage: StorageLike | null): TokenHost => ({ storage });

describe('storing and reading the token', () => {
  it('round-trips', () => {
    const storage = new MemoryStorage();
    const host = hostWith(storage);

    writeToken(host, { token: TOKEN, expiresAt: LATER });

    expect(readToken(host)).toEqual({ token: TOKEN, expiresAt: LATER });
  });

  it('uses exactly one key', () => {
    const storage = new MemoryStorage();
    writeToken(hostWith(storage), { token: TOKEN, expiresAt: LATER });
    expect([...storage.items.keys()]).toEqual(['vcip.agent.token']);
  });

  it('clears', () => {
    const storage = new MemoryStorage();
    const host = hostWith(storage);
    writeToken(host, { token: TOKEN, expiresAt: LATER });

    clearToken(host);

    expect(readToken(host)).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('reads nothing when nothing was stored', () => {
    expect(readToken(hostWith(new MemoryStorage()))).toBeNull();
  });

  it('reads nothing when storage is unavailable', () => {
    // Server rendering, where there is no `window` at all.
    expect(readToken(hostWith(null))).toBeNull();
  });

  it('survives storage that throws', () => {
    const host = hostWith(new ThrowingStorage());

    // A portal that white-screens because storage is blocked is worse than one
    // that asks the agent to sign in again.
    expect(() => writeToken(host, { token: TOKEN, expiresAt: LATER })).not.toThrow();
    expect(() => clearToken(host)).not.toThrow();
    expect(readToken(host)).toBeNull();
  });

  it('reads nothing from a corrupt or partial value', () => {
    const storage = new MemoryStorage();
    const host = hostWith(storage);

    for (const raw of [
      'not json',
      'null',
      '[]',
      '"a string"',
      '{}',
      '{"token":""}',
      `{"token":"${TOKEN}"}`,
      '{"expiresAt":"2026-08-31T12:00:00.000Z"}',
      `{"token":123,"expiresAt":"${LATER}"}`,
    ]) {
      storage.items.set('vcip.agent.token', raw);
      expect(readToken(host)).toBeNull();
    }
  });
});

describe('expiry', () => {
  it('accepts a token with time left', () => {
    expect(isExpired({ token: TOKEN, expiresAt: LATER }, NOW)).toBe(false);
  });

  it('rejects one that has passed', () => {
    expect(isExpired({ token: TOKEN, expiresAt: '2026-08-31T08:00:00.000Z' }, NOW)).toBe(true);
  });

  it('rejects one about to pass, ahead of the server', () => {
    // The skew is what turns "the API started refusing me" into "sign in
    // again" before the agent notices.
    expect(isExpired({ token: TOKEN, expiresAt: '2026-08-31T09:00:10.000Z' }, NOW)).toBe(true);
  });

  it('treats an unparseable expiry as expired', () => {
    for (const bad of ['', 'soon', 'not-a-date']) {
      expect(isExpired({ token: TOKEN, expiresAt: bad }, NOW)).toBe(true);
    }
  });
});

describe('browserTokenHost', () => {
  it('yields a null storage where there is no window', () => {
    // The vitest environment here is `node`, so this is the real server-render
    // path rather than a simulation of it.
    expect(browserTokenHost().storage).toBeNull();
  });
});
