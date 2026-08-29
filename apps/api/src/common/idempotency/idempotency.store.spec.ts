import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  CLAIM_TTL_SECONDS,
  IdempotencyStore,
  IdempotencyUnavailableError,
  RECORD_TTL_SECONDS,
  fingerprintRequest,
  idempotencyKey,
} from './idempotency.store.js';

/**
 * A minimal Redis that models the one property under test: `SET NX` is atomic.
 *
 * Real Redis is exercised separately against the local instance; this makes the
 * store's logic testable without a server, and makes the concurrency assertions
 * deterministic rather than timing-dependent.
 */
class FakeRedis {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();
  failing = false;
  setCalls = 0;

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX'): Promise<string | null> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    this.setCalls += 1;
    const existing = this.live(key);
    if (nx === 'NX' && existing !== undefined) return Promise.resolve(null);
    this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  del(key: string): Promise<number> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(this.data.delete(key) ? 1 : 0);
  }

  ttl(key: string): Promise<number> {
    if (this.failing) return Promise.reject(new Error('connection refused'));
    const entry = this.live(key);
    if (entry === undefined) return Promise.resolve(-2);
    return Promise.resolve(Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  /** Force a record to look expired, without waiting. */
  expire(key: string): void {
    const entry = this.data.get(key);
    if (entry !== undefined) entry.expiresAt = Date.now() - 1;
  }

  raw(key: string): string | undefined {
    return this.live(key)?.value;
  }
}

const makeStore = (): { store: IdempotencyStore; redis: FakeRedis } => {
  const redis = new FakeRedis();
  return { store: new IdempotencyStore(redis as unknown as Redis), redis };
};

describe('key construction', () => {
  it('uses the documented shape', () => {
    expect(idempotencyKey('agent-t1-u1', 'POST /v1/sessions', 'key-1')).toBe(
      'idem:agent-t1-u1:POST /v1/sessions:key-1',
    );
  });

  it('starts every key with the idem: namespace', () => {
    expect(idempotencyKey('a', 'b', 'c').startsWith('idem:')).toBe(true);
  });

  it('separates actors, endpoints, and keys', () => {
    const base = idempotencyKey('actor-1', 'POST /v1/sessions', 'k');
    expect(idempotencyKey('actor-2', 'POST /v1/sessions', 'k')).not.toBe(base);
    expect(idempotencyKey('actor-1', 'POST /v1/other', 'k')).not.toBe(base);
    expect(idempotencyKey('actor-1', 'POST /v1/sessions', 'k2')).not.toBe(base);
  });
});

describe('request fingerprinting', () => {
  it('matches for an identical request', () => {
    const a = fingerprintRequest('POST', '/v1/sessions', { external_ref: 'r1', language: 'en' });
    const b = fingerprintRequest('POST', '/v1/sessions', { external_ref: 'r1', language: 'en' });
    expect(a).toBe(b);
  });

  it('ignores key order, so a reserialised retry is not a conflict', () => {
    const a = fingerprintRequest('POST', '/v1/sessions', { a: 1, b: { c: 2, d: 3 } });
    const b = fingerprintRequest('POST', '/v1/sessions', { b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('differs when the body differs', () => {
    const a = fingerprintRequest('POST', '/v1/sessions', { external_ref: 'r1' });
    const b = fingerprintRequest('POST', '/v1/sessions', { external_ref: 'r2' });
    expect(a).not.toBe(b);
  });

  it('differs when the endpoint or method differs', () => {
    expect(fingerprintRequest('POST', '/a', {})).not.toBe(fingerprintRequest('POST', '/b', {}));
    expect(fingerprintRequest('POST', '/a', {})).not.toBe(fingerprintRequest('PUT', '/a', {}));
  });

  it('is a hex digest that discloses nothing about the body', () => {
    const secret = 'customer-name-Rakesh-and-pan-ABCDE1234F';
    const digest = fingerprintRequest('POST', '/v1/sessions', { note: secret });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('Rakesh');
    expect(digest).not.toContain('ABCDE1234F');
  });

  it('treats an absent body and an empty object as distinct', () => {
    expect(fingerprintRequest('POST', '/a', undefined)).not.toBe(
      fingerprintRequest('POST', '/a', {}),
    );
  });
});

describe('atomic claim', () => {
  it('grants the first claim', async () => {
    const { store } = makeStore();
    const outcome = await store.claim('idem:a:e:k', 'fp');
    expect(outcome.kind).toBe('claimed');
  });

  it('refuses a second claim on the same key', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    const second = await store.claim('idem:a:e:k', 'fp');
    expect(second.kind).toBe('existing');
  });

  it('grants exactly one claim when many arrive together', async () => {
    const { store } = makeStore();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.claim('idem:a:e:k', 'fp')),
    );
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'existing')).toHaveLength(24);
  });

  it('claims different keys independently', async () => {
    const { store } = makeStore();
    expect((await store.claim('idem:a:e:k1', 'fp')).kind).toBe('claimed');
    expect((await store.claim('idem:a:e:k2', 'fp')).kind).toBe('claimed');
  });

  it('reports the existing record so the caller can compare fingerprints', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fingerprint-one');
    const second = await store.claim('idem:a:e:k', 'fingerprint-two');
    expect(second.kind).toBe('existing');
    if (second.kind === 'existing') {
      expect(second.record.fingerprint).toBe('fingerprint-one');
      expect(second.record.state).toBe('pending');
    }
  });
});

describe('TTL behaviour', () => {
  it('gives an in-flight claim a short lifetime', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    const ttl = await store.ttl('idem:a:e:k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(CLAIM_TTL_SECONDS);
  });

  it('gives a completed response exactly 24 hours', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    await store.complete('idem:a:e:k', {
      state: 'completed',
      fingerprint: 'fp',
      status: 201,
      body: { data: { session_id: 's1' } },
      completedAt: Date.now(),
    });
    const ttl = await store.ttl('idem:a:e:k');
    expect(RECORD_TTL_SECONDS).toBe(86_400);
    expect(ttl).toBeGreaterThan(RECORD_TTL_SECONDS - 5);
    expect(ttl).toBeLessThanOrEqual(RECORD_TTL_SECONDS);
  });

  it('lets an abandoned claim expire so the key is not blocked for a day', async () => {
    const { store, redis } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    // A process killed mid-handler leaves this behind.
    redis.expire('idem:a:e:k');
    expect((await store.claim('idem:a:e:k', 'fp')).kind).toBe('claimed');
  });
});

describe('completion and release', () => {
  it('preserves the status and body', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    await store.complete('idem:a:e:k', {
      state: 'completed',
      fingerprint: 'fp',
      status: 201,
      body: { data: { session_id: 's1' }, nested: [1, 2] },
      completedAt: 1,
    });
    const record = await store.read('idem:a:e:k');
    expect(record?.state).toBe('completed');
    if (record?.state === 'completed') {
      expect(record.status).toBe(201);
      expect(record.body).toEqual({ data: { session_id: 's1' }, nested: [1, 2] });
    }
  });

  it('release drops the claim so a retry may proceed', async () => {
    const { store } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    await store.release('idem:a:e:k');
    expect(await store.read('idem:a:e:k')).toBeNull();
    expect((await store.claim('idem:a:e:k', 'fp')).kind).toBe('claimed');
  });

  it('release is quiet when Redis is unreachable', async () => {
    const { store, redis } = makeStore();
    redis.failing = true;
    // The claim expires by itself; a failed delete must not throw over the
    // original handler error.
    await expect(store.release('idem:a:e:k')).resolves.toBeUndefined();
  });

  it('treats a corrupt record as absent rather than crashing', async () => {
    const { store, redis } = makeStore();
    await redis.set('idem:a:e:k', 'not json', 'EX', 60);
    expect(await store.read('idem:a:e:k')).toBeNull();
  });
});

describe('stored records hold no credential material', () => {
  it('stores a fingerprint, never the request body', async () => {
    const { store, redis } = makeStore();
    const key = 'idem:a:e:k';
    const fingerprint = fingerprintRequest('POST', '/v1/sessions', {
      password: 'FAKE-PASSWORD-VALUE',
      pan: 'FAKEPAN123X',
    });
    await store.claim(key, fingerprint);
    const raw = redis.raw(key) ?? '';
    expect(raw).not.toContain('FAKE-PASSWORD-VALUE');
    expect(raw).not.toContain('FAKEPAN123X');
    expect(raw).toContain(fingerprint);
  });

  it('records only what the handler returned, not what it was sent', async () => {
    const { store, redis } = makeStore();
    await store.claim('idem:a:e:k', 'fp');
    await store.complete('idem:a:e:k', {
      state: 'completed',
      fingerprint: 'fp',
      status: 201,
      body: { data: { session_id: 's1' } },
      completedAt: 1,
    });
    const raw = redis.raw('idem:a:e:k') ?? '';
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('authorization');
    expect(JSON.parse(raw)).toEqual({
      state: 'completed',
      fingerprint: 'fp',
      status: 201,
      body: { data: { session_id: 's1' } },
      completedAt: 1,
    });
  });
});

describe('Redis failure is explicit', () => {
  it('claim reports unavailability rather than proceeding', async () => {
    const { store, redis } = makeStore();
    redis.failing = true;
    await expect(store.claim('idem:a:e:k', 'fp')).rejects.toBeInstanceOf(
      IdempotencyUnavailableError,
    );
  });

  it('read and complete report unavailability too', async () => {
    const { store, redis } = makeStore();
    redis.failing = true;
    await expect(store.read('idem:a:e:k')).rejects.toBeInstanceOf(IdempotencyUnavailableError);
    await expect(
      store.complete('idem:a:e:k', {
        state: 'completed',
        fingerprint: 'fp',
        status: 200,
        body: {},
        completedAt: 1,
      }),
    ).rejects.toBeInstanceOf(IdempotencyUnavailableError);
  });

  it('never quotes the key or the failure detail in its message', async () => {
    const { store, redis } = makeStore();
    redis.failing = true;
    try {
      await store.claim('idem:a:e:super-secret-key-value', 'fp');
    } catch (error) {
      expect((error as Error).message).toBe('idempotency store unavailable');
      expect((error as Error).message).not.toContain('super-secret-key-value');
    }
  });
});
