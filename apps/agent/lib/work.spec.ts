/**
 * Remembering what this agent is working, and the keys for it (T21).
 *
 * Two properties carry the weight here: a reload finds the session again, and
 * a retry presents the *same* idempotency key. The second is what makes
 * pressing Claim twice one operation rather than two — and, since a key is
 * bound to the resource it was first used on, one key per (intent, session) is
 * also the only shape that cannot collide with itself.
 */

import { describe, expect, it } from 'vitest';
import type { StorageLike } from './token';
import type { WorkHost } from './work';
import { forgetWork, idempotencyKeyFor, recallWork, rememberWork } from './work';

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

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

/** Storage that rejects everything, as a private-mode browser can. */
const hostileStorage: StorageLike = {
  getItem() {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('denied');
  },
  removeItem() {
    throw new Error('denied');
  },
};

const hostWith = (storage: StorageLike | null): { host: WorkHost; minted: string[] } => {
  const minted: string[] = [];
  let n = 0;
  return {
    host: {
      storage,
      newKey: () => {
        const key = `key-${(n += 1)}`;
        minted.push(key);
        return key;
      },
    },
    minted,
  };
};

describe('remembering the working session', () => {
  it('recalls what was remembered', () => {
    const { host } = hostWith(new MemoryStorage());
    rememberWork(host, {
      sessionId: SESSION,
      offerExpiresAt: '2026-09-01T10:00:30.000Z',
      roomName: null,
    });

    expect(recallWork(host)).toEqual({
      sessionId: SESSION,
      offerExpiresAt: '2026-09-01T10:00:30.000Z',
      roomName: null,
    });
  });

  it('recalls a session accepted into a call', () => {
    const { host } = hostWith(new MemoryStorage());
    rememberWork(host, { sessionId: SESSION, offerExpiresAt: null, roomName: `vcip_${SESSION}` });

    expect(recallWork(host)?.roomName).toBe(`vcip_${SESSION}`);
  });

  it('recalls nothing when nothing was remembered', () => {
    const { host } = hostWith(new MemoryStorage());
    expect(recallWork(host)).toBeNull();
  });

  it('forgets on request', () => {
    const { host } = hostWith(new MemoryStorage());
    rememberWork(host, { sessionId: SESSION, offerExpiresAt: null, roomName: null });
    forgetWork(host, SESSION);
    expect(recallWork(host)).toBeNull();
  });

  it('refuses a stored id that is not shaped like a session id', () => {
    // A hand-edited or stale entry must not reach a request path.
    const storage = new MemoryStorage();
    const { host } = hostWith(storage);
    storage.setItem('vcip.agent.work', JSON.stringify({ sessionId: '../../etc/passwd' }));
    expect(recallWork(host)).toBeNull();
  });

  it('refuses a stored value that is not an object', () => {
    const storage = new MemoryStorage();
    const { host } = hostWith(storage);
    storage.setItem('vcip.agent.work', '"just a string"');
    expect(recallWork(host)).toBeNull();
  });

  it('survives unparseable stored JSON', () => {
    const storage = new MemoryStorage();
    const { host } = hostWith(storage);
    storage.setItem('vcip.agent.work', '{ not json');
    expect(recallWork(host)).toBeNull();
  });

  it('ignores a non-string expiry rather than carrying it', () => {
    const storage = new MemoryStorage();
    const { host } = hostWith(storage);
    storage.setItem(
      'vcip.agent.work',
      JSON.stringify({ sessionId: SESSION, offerExpiresAt: 12345 }),
    );
    expect(recallWork(host)?.offerExpiresAt).toBeNull();
  });

  it('works when storage is unavailable', () => {
    const { host } = hostWith(null);
    rememberWork(host, { sessionId: SESSION, offerExpiresAt: null, roomName: null });
    expect(recallWork(host)).toBeNull();
  });

  it('does not throw when storage rejects every call', () => {
    const { host } = hostWith(hostileStorage);
    expect(() => {
      rememberWork(host, { sessionId: SESSION, offerExpiresAt: null, roomName: null });
    }).not.toThrow();
    expect(recallWork(host)).toBeNull();
    expect(() => {
      forgetWork(host, SESSION);
    }).not.toThrow();
  });
});

describe('idempotency keys', () => {
  it('mints a key on first use', () => {
    const { host, minted } = hostWith(new MemoryStorage());
    expect(idempotencyKeyFor(host, 'claim', SESSION)).toBe('key-1');
    expect(minted).toHaveLength(1);
  });

  it('reuses the same key for a retry of the same claim', () => {
    // The property the whole module exists for: pressing Claim twice is one
    // operation, and the second call replays the first response.
    const { host, minted } = hostWith(new MemoryStorage());
    const first = idempotencyKeyFor(host, 'claim', SESSION);
    const second = idempotencyKeyFor(host, 'claim', SESSION);

    expect(second).toBe(first);
    expect(minted).toHaveLength(1);
  });

  it('reuses the same key for a retry of the same accept', () => {
    const { host } = hostWith(new MemoryStorage());
    expect(idempotencyKeyFor(host, 'accept', SESSION)).toBe(
      idempotencyKeyFor(host, 'accept', SESSION),
    );
  });

  it('uses a different key for the accept than for the claim', () => {
    // Same session, different operation. Sharing one key would make the accept
    // replay the claim's stored response.
    const { host } = hostWith(new MemoryStorage());
    expect(idempotencyKeyFor(host, 'accept', SESSION)).not.toBe(
      idempotencyKeyFor(host, 'claim', SESSION),
    );
  });

  it('uses a different key for a different session', () => {
    // Reusing one across sessions is a 409 by design, so the portal must never
    // produce that request in the first place.
    const { host } = hostWith(new MemoryStorage());
    expect(idempotencyKeyFor(host, 'claim', OTHER)).not.toBe(
      idempotencyKeyFor(host, 'claim', SESSION),
    );
  });

  it('survives a reload: the key outlives the page', () => {
    // Same storage, fresh host — which is what a reload is.
    const storage = new MemoryStorage();
    const first = idempotencyKeyFor(hostWith(storage).host, 'claim', SESSION);
    const afterReload = idempotencyKeyFor(hostWith(storage).host, 'claim', SESSION);
    expect(afterReload).toBe(first);
  });

  it('forgets a session keys along with the session', () => {
    const storage = new MemoryStorage();
    const { host } = hostWith(storage);
    idempotencyKeyFor(host, 'claim', SESSION);
    idempotencyKeyFor(host, 'accept', SESSION);
    forgetWork(host, SESSION);

    expect([...storage.items.keys()]).toEqual([]);
  });

  it('mints a fresh key when storage is unavailable', () => {
    // Replay protection is lost for that one request, and the portal keeps
    // working. The server's conditional updates are what prevent a duplicate
    // outcome regardless.
    const { host } = hostWith(null);
    expect(idempotencyKeyFor(host, 'claim', SESSION)).not.toBe(
      idempotencyKeyFor(host, 'claim', SESSION),
    );
  });
});
