/**
 * Token handling.
 *
 * These are the security tests of the customer app. The token is the only
 * credential the browser holds, and every rule about where it may and may not
 * go is checked here rather than left to review.
 *
 * No token value in this file resembles a real one, and none is printed.
 */

import { describe, expect, it, vi } from 'vitest';
import type { StorageLike, TokenHost } from './token';
import { clearToken, consumeToken, readToken, storageKey, tokenFromHash } from './token';

const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'FAKE-TOKEN-VALUE';

/** An in-memory `Storage`, so a test can inspect exactly what was written. */
class FakeStorage implements StorageLike {
  readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

interface Harness {
  host: TokenHost;
  storage: FakeStorage;
  /** Every URL passed to `replaceUrl`, in order. */
  replaced: string[];
}

function harness(hash: string, pathWithSearch = `/session/${SESSION}`): Harness {
  const storage = new FakeStorage();
  const replaced: string[] = [];
  return {
    storage,
    replaced,
    host: {
      hash,
      pathWithSearch,
      storage,
      replaceUrl(url) {
        replaced.push(url);
      },
    },
  };
}

// ------------------------------------------------------------ parsing

describe('tokenFromHash', () => {
  it('reads the token from a fragment', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  it('works without the leading hash', () => {
    expect(tokenFromHash(`token=${TOKEN}`)).toBe(TOKEN);
  });

  it('reads it alongside other fragment keys', () => {
    expect(tokenFromHash(`#lang=en&token=${TOKEN}&x=1`)).toBe(TOKEN);
  });

  it('decodes percent-encoding', () => {
    expect(tokenFromHash('#token=a%2Bb')).toBe('a+b');
  });

  it('is null when there is no fragment or no token key', () => {
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#')).toBeNull();
    expect(tokenFromHash('#lang=en')).toBeNull();
    expect(tokenFromHash('#token=')).toBeNull();
    expect(tokenFromHash('#token=%20%20')).toBeNull();
  });
});

// ----------------------------------------------------------- consuming

describe('consumeToken', () => {
  it('stores the token from the fragment in sessionStorage', () => {
    const { host, storage } = harness(`#token=${TOKEN}`);
    expect(consumeToken(SESSION, host)).toBe(TOKEN);
    expect(storage.getItem(storageKey(SESSION))).toBe(TOKEN);
  });

  it('removes the fragment from the visible URL', () => {
    const { host, replaced } = harness(`#token=${TOKEN}`, '/session/abc');
    consumeToken(SESSION, host);
    expect(replaced).toEqual(['/session/abc']);
    expect(replaced[0]).not.toContain('token');
    expect(replaced[0]).not.toContain('#');
  });

  it('never writes the token back into a query string', () => {
    const { host, replaced } = harness(`#token=${TOKEN}`);
    consumeToken(SESSION, host);
    for (const url of replaced) {
      expect(url).not.toContain('?token=');
      expect(url).not.toContain(TOKEN);
    }
  });

  it('stores before it strips, so a reload mid-way cannot lose the token', () => {
    // Ordering is the whole property: stripping first leaves a window in which
    // the fragment is gone and nothing has been saved.
    const storage = new FakeStorage();
    const order: string[] = [];
    const host: TokenHost = {
      hash: `#token=${TOKEN}`,
      pathWithSearch: '/session/abc',
      storage: {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => {
          order.push('store');
          storage.setItem(key, value);
        },
        removeItem: (key) => {
          storage.removeItem(key);
        },
      },
      replaceUrl: () => {
        order.push('strip');
      },
    };
    consumeToken(SESSION, host);
    expect(order).toEqual(['store', 'strip']);
  });

  it('falls back to the stored token when the fragment is gone', () => {
    // This is what makes a refresh work: the fragment survives exactly one load.
    const { host, storage } = harness('');
    storage.setItem(storageKey(SESSION), TOKEN);
    expect(consumeToken(SESSION, host)).toBe(TOKEN);
  });

  it('does not touch the URL when there is nothing to consume', () => {
    const { host, replaced } = harness('');
    consumeToken(SESSION, host);
    expect(replaced).toEqual([]);
  });

  it('is null when neither the fragment nor storage has a token', () => {
    const { host } = harness('');
    expect(consumeToken(SESSION, host)).toBeNull();
  });

  it('keys storage by session, so one session cannot use another token', () => {
    const { host, storage } = harness(`#token=${TOKEN}`);
    consumeToken(SESSION, host);
    expect(readToken(OTHER_SESSION, host)).toBeNull();
    expect([...storage.entries.keys()]).toEqual([storageKey(SESSION)]);
  });

  it('overwrites a stored token when a new fragment arrives', () => {
    const { host, storage } = harness('#token=SECOND-FAKE-TOKEN');
    storage.setItem(storageKey(SESSION), TOKEN);
    expect(consumeToken(SESSION, host)).toBe('SECOND-FAKE-TOKEN');
  });
});

describe('clearToken', () => {
  it('removes only this session key', () => {
    const { host, storage } = harness('');
    storage.setItem(storageKey(SESSION), TOKEN);
    storage.setItem(storageKey(OTHER_SESSION), TOKEN);
    clearToken(SESSION, host);
    expect(readToken(SESSION, host)).toBeNull();
    expect(storage.getItem(storageKey(OTHER_SESSION))).toBe(TOKEN);
  });
});

// ------------------------------------------------------------- storage

describe('the storage it uses', () => {
  it('never reaches for localStorage', () => {
    // Structural: the host it is given exposes only the three Storage methods
    // it needs. A module reaching for a global store would have to name one,
    // and `no-local-storage.spec.ts` proves none is named anywhere in the app.
    const { host } = harness(`#token=${TOKEN}`);
    const localStorageSpy = vi.fn();
    const previous = Reflect.get(globalThis, 'localStorage') as unknown;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: localStorageSpy,
    });
    try {
      consumeToken(SESSION, host);
      expect(localStorageSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, 'localStorage');
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: previous,
        });
      }
    }
  });

  it('namespaces its key, so it cannot collide with another app on the origin', () => {
    expect(storageKey(SESSION)).toBe(`vcip.customer_token.${SESSION}`);
  });
});
