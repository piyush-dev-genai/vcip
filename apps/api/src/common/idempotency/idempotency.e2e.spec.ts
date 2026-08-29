import { Writable } from 'node:stream';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ErrorCode } from '@vcip/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth/auth-context.js';
import { ApiErrorFilter } from '../errors/api-error.filter.js';
import { createLogger } from '../logging/logger.js';
import { LOGGER } from '../logging/logging.tokens.js';
import { LoggingModule } from '../logging/logging.module.js';
import { REDIS } from '../redis/redis.tokens.js';
import { Idempotent } from './idempotency.decorator.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyStore } from './idempotency.store.js';

/**
 * The interceptor through a real Nest application over real HTTP.
 *
 * Handler-execution counting and concurrency only mean something end to end:
 * a unit test can assert an interceptor returned a cached value, but only a
 * real request pair proves the handler did not run twice.
 *
 * `X-Test-Actor` stands in for a T09 guard, which would normally set
 * `request.actor` after verifying a credential. No authentication logic is
 * added or tested here.
 */

/**
 * In-memory Redis with atomic SET NX. Real Redis is exercised separately.
 *
 * Every operation yields to the event loop first, modelling the round trip to a
 * real server. Without that gap an instant-resolving fake serialises operations
 * that genuinely interleave in production, and a non-atomic GET-then-SET claim
 * would pass the concurrency tests.
 */
class FakeRedis {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();
  failing = false;

  private async hop(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  private live(key: string) {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(
    key: string,
    value: string,
    _ex: 'EX',
    seconds: number,
    nx?: 'NX',
  ): Promise<string | null> {
    await this.hop();
    if (this.failing) throw new Error('connection refused');
    // The NX check and the write are one indivisible step, as in real Redis.
    if (nx === 'NX' && this.live(key) !== undefined) return null;
    this.data.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    await this.hop();
    if (this.failing) throw new Error('connection refused');
    return this.live(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    await this.hop();
    if (this.failing) throw new Error('connection refused');
    return this.data.delete(key) ? 1 : 0;
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    return Promise.resolve(
      entry === undefined ? -2 : Math.ceil((entry.expiresAt - Date.now()) / 1000),
    );
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

/** Stands in for a T09 guard: puts a verified actor on the request. */
const actorFrom = (header: string | undefined): Actor | undefined => {
  if (header === undefined) return undefined;
  const [kind, tenantId, id] = header.split('|') as [string, string, string];
  if (kind === 'agent') return { kind: 'agent', tenantId, userId: id, role: 'AGENT' };
  if (kind === 'enterprise') return { kind: 'enterprise', tenantId, apiKeyId: id, scopes: [] };
  return { kind: 'internal', service: 'internal' };
};

let handlerCalls = 0;
let shouldFail = false;
let handlerDelayMs = 0;

@Controller('probe')
class ProbeController {
  /** Stands in for POST /v1/sessions. */
  @Post('sessions')
  @Idempotent('POST /v1/sessions')
  async createSession(@Body() body: { external_ref?: string }): Promise<unknown> {
    handlerCalls += 1;
    if (handlerDelayMs > 0) await new Promise((r) => setTimeout(r, handlerDelayMs));
    if (shouldFail) throw new Error('handler failed');
    return { data: { session_id: 'session-1', external_ref: body?.external_ref ?? null } };
  }

  /** A second idempotent endpoint, to prove endpoint scoping. */
  @Post('queue')
  @Idempotent('POST /v1/sessions/{id}/queue')
  queue(): unknown {
    handlerCalls += 1;
    return { data: { queued: true } };
  }

  /** Not marked: a read endpoint must not be forced to carry a key. */
  @Get('read')
  read(): unknown {
    handlerCalls += 1;
    return { data: { ok: true } };
  }

  /** A mutation deliberately left unprotected. */
  @Post('unprotected')
  unprotected(): unknown {
    handlerCalls += 1;
    return { data: { ok: true } };
  }
}

const redis = new FakeRedis();

@Module({
  imports: [LoggingModule],
  controllers: [ProbeController],
  providers: [
    { provide: REDIS, useValue: redis },
    IdempotencyStore,
    IdempotencyInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },
  ],
})
class ProbeModule {}

describe('idempotency through a real application', () => {
  let app: INestApplication;
  let logged = '';

  beforeEach(async () => {
    handlerCalls = 0;
    shouldFail = false;
    handlerDelayMs = 0;
    logged = '';
    for (const key of redis.keys()) await redis.del(key);
    redis.failing = false;

    const stream = new Writable({
      write(chunk, _e, cb) {
        logged += String(chunk);
        cb();
      },
    });
    const logger = createLogger({ level: 'debug', destination: stream });

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] })
      .overrideProvider(LOGGER)
      .useValue(logger)
      .compile();

    app = moduleRef.createNestApplication();
    // A real guard would do this; here it makes the actor explicit per request.
    app.use(
      (
        req: { headers: Record<string, string>; actor?: Actor },
        _res: unknown,
        next: () => void,
      ) => {
        const actor = actorFrom(req.headers['x-test-actor']);
        if (actor !== undefined) req.actor = actor;
        next();
      },
    );
    app.useGlobalFilters(new ApiErrorFilter(logger));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const AGENT_A = 'agent|tenant-1|user-1';
  const AGENT_B = 'agent|tenant-1|user-2';
  const OTHER_TENANT = 'agent|tenant-2|user-1';

  const post = (path: string, key: string | null, body: unknown, actor = AGENT_A) => {
    const req = request(app.getHttpServer()).post(path).set('X-Test-Actor', actor);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };

  // ------------------------------------------------------------ basic

  it('executes the handler on the first request', async () => {
    const response = await post('/probe/sessions', 'k-1', { external_ref: 'r1' }).expect(201);
    expect(handlerCalls).toBe(1);
    expect(response.body).toEqual({ data: { session_id: 'session-1', external_ref: 'r1' } });
  });

  it('returns the stored response on an identical repeat', async () => {
    const first = await post('/probe/sessions', 'k-1', { external_ref: 'r1' }).expect(201);
    const second = await post('/probe/sessions', 'k-1', { external_ref: 'r1' }).expect(201);
    expect(second.body).toEqual(first.body);
  });

  it('executes the handler exactly once across repeats', async () => {
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' });
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' });
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' });
    expect(handlerCalls).toBe(1);
  });

  it('preserves the original status code', async () => {
    const first = await post('/probe/sessions', 'k-1', {});
    const second = await post('/probe/sessions', 'k-1', {});
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('is unaffected by key order in the body', async () => {
    await post('/probe/sessions', 'k-1', { a: 1, b: 2 }).expect(201);
    await post('/probe/sessions', 'k-1', { b: 2, a: 1 }).expect(201);
    expect(handlerCalls).toBe(1);
  });

  it('stores the record under the documented key shape', async () => {
    await post('/probe/sessions', 'k-1', {});
    const keys = redis.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('idem:agent-tenant-1-user-1:POST /v1/sessions:k-1');
  });

  it('gives the completed record a 24-hour TTL', async () => {
    await post('/probe/sessions', 'k-1', {});
    const ttl = await redis.ttl(redis.keys()[0] ?? '');
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  // ------------------------------------------------------------ scoping

  it('scopes records to the actor', async () => {
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' }, AGENT_A).expect(201);
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' }, AGENT_B).expect(201);
    // A different agent with the same key runs their own request.
    expect(handlerCalls).toBe(2);
    expect(redis.keys()).toHaveLength(2);
  });

  it('scopes records to the tenant', async () => {
    await post('/probe/sessions', 'k-1', {}, AGENT_A).expect(201);
    await post('/probe/sessions', 'k-1', {}, OTHER_TENANT).expect(201);
    expect(handlerCalls).toBe(2);
  });

  it('scopes records to the endpoint', async () => {
    await post('/probe/sessions', 'k-1', {}).expect(201);
    await post('/probe/queue', 'k-1', {}).expect(201);
    expect(handlerCalls).toBe(2);
  });

  it('shares one record for the same actor, endpoint, and key', async () => {
    await post('/probe/sessions', 'k-1', {});
    await post('/probe/sessions', 'k-1', {});
    expect(redis.keys()).toHaveLength(1);
    expect(handlerCalls).toBe(1);
  });

  // ------------------------------------------------------------ conflict

  it('rejects the same key reused for a different body', async () => {
    await post('/probe/sessions', 'k-1', { external_ref: 'r1' }).expect(201);
    const conflict = await post('/probe/sessions', 'k-1', { external_ref: 'DIFFERENT' }).expect(
      409,
    );
    expect(conflict.body.error.code).toBe(ErrorCode.CONFLICT);
    // The handler did not run for the conflicting request.
    expect(handlerCalls).toBe(1);
  });

  it('never returns the first response for a semantically different request', async () => {
    const first = await post('/probe/sessions', 'k-1', { external_ref: 'r1' });
    const conflict = await post('/probe/sessions', 'k-1', { external_ref: 'r2' });
    expect(conflict.body).not.toEqual(first.body);
    expect(conflict.status).toBe(409);
  });

  it('does not conflict across endpoints', async () => {
    await post('/probe/sessions', 'k-1', { a: 1 }).expect(201);
    await post('/probe/queue', 'k-1', { b: 2 }).expect(201);
  });

  it('does not conflict across actors', async () => {
    await post('/probe/sessions', 'k-1', { a: 1 }, AGENT_A).expect(201);
    await post('/probe/sessions', 'k-1', { b: 2 }, AGENT_B).expect(201);
  });

  // ------------------------------------------------------- missing key

  it('rejects a protected mutation with no Idempotency-Key', async () => {
    const response = await post('/probe/sessions', null, {}).expect(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a blank Idempotency-Key', async () => {
    await post('/probe/sessions', '   ', {}).expect(400);
    expect(handlerCalls).toBe(0);
  });

  it('does not require a key on a read endpoint', async () => {
    await request(app.getHttpServer()).get('/probe/read').set('X-Test-Actor', AGENT_A).expect(200);
    expect(handlerCalls).toBe(1);
  });

  it('does not require a key on an unmarked mutation', async () => {
    await post('/probe/unprotected', null, {}).expect(201);
    expect(handlerCalls).toBe(1);
  });

  it('leaves no record for an unmarked route', async () => {
    await post('/probe/unprotected', null, {});
    expect(redis.keys()).toHaveLength(0);
  });

  // ----------------------------------------------------------- concurrency

  it('runs the handler once for two concurrent identical requests', async () => {
    handlerDelayMs = 120;
    const [a, b] = await Promise.all([
      post('/probe/sessions', 'k-conc', { external_ref: 'r1' }),
      post('/probe/sessions', 'k-conc', { external_ref: 'r1' }),
    ]);
    expect(handlerCalls).toBe(1);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('gives both concurrent callers the same response', async () => {
    handlerDelayMs = 120;
    const [a, b] = await Promise.all([
      post('/probe/sessions', 'k-conc', { external_ref: 'r1' }),
      post('/probe/sessions', 'k-conc', { external_ref: 'r1' }),
    ]);
    expect(b.body).toEqual(a.body);
    expect(a.body).toEqual({ data: { session_id: 'session-1', external_ref: 'r1' } });
  });

  it('runs the handler once for five concurrent identical requests', async () => {
    handlerDelayMs = 150;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post('/probe/sessions', 'k-five', { external_ref: 'r1' })),
    );
    expect(handlerCalls).toBe(1);
    for (const response of responses) {
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ data: { session_id: 'session-1', external_ref: 'r1' } });
    }
  });

  // -------------------------------------------------------------- failure

  it('does not cache a failed execution as a success', async () => {
    shouldFail = true;
    await post('/probe/sessions', 'k-fail', {}).expect(500);
    // No completed record: the claim was released.
    expect(redis.keys()).toHaveLength(0);
  });

  it('allows a successful retry after a handler failure', async () => {
    shouldFail = true;
    await post('/probe/sessions', 'k-retry', { external_ref: 'r1' }).expect(500);

    shouldFail = false;
    const retry = await post('/probe/sessions', 'k-retry', { external_ref: 'r1' }).expect(201);
    expect(retry.body).toEqual({ data: { session_id: 'session-1', external_ref: 'r1' } });
    expect(handlerCalls).toBe(2);
  });

  it('the retry is then itself idempotent', async () => {
    shouldFail = true;
    await post('/probe/sessions', 'k-r2', {}).expect(500);
    shouldFail = false;
    await post('/probe/sessions', 'k-r2', {}).expect(201);
    await post('/probe/sessions', 'k-r2', {}).expect(201);
    expect(handlerCalls).toBe(2);
  });

  // ---------------------------------------------------------- redis down

  it('fails closed when Redis cannot answer', async () => {
    redis.failing = true;
    const response = await post('/probe/sessions', 'k-down', {}).expect(503);
    expect(response.body.error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    // The protected handler never ran: executing without being able to record
    // that it ran is exactly the duplicate this layer prevents.
    expect(handlerCalls).toBe(0);
  });

  it('leaves unprotected routes working when Redis is down', async () => {
    redis.failing = true;
    await post('/probe/unprotected', null, {}).expect(201);
    expect(handlerCalls).toBe(1);
  });

  // ------------------------------------------------------------ security

  it('never writes the idempotency key to the log', async () => {
    const secretish = 'idem-key-that-looks-like-an-order-id-9999';
    await post('/probe/sessions', secretish, { external_ref: 'r1' }).expect(201);
    await post('/probe/sessions', secretish, { external_ref: 'CHANGED' }).expect(409);
    expect(logged).not.toContain(secretish);
    // The endpoint is logged, so a conflict is still diagnosable.
    expect(logged).toContain('idempotency.conflict');
  });

  it('never writes the request payload to the log or to Redis', async () => {
    await post('/probe/sessions', 'k-sec', {
      external_ref: 'r1',
      password: 'FAKE-PASSWORD-VALUE',
      pan: 'FAKEPAN123X',
    }).expect(201);
    const stored = (await redis.get(redis.keys()[0] ?? '')) ?? '';
    expect(stored).not.toContain('FAKE-PASSWORD-VALUE');
    expect(stored).not.toContain('FAKEPAN123X');
    expect(logged).not.toContain('FAKE-PASSWORD-VALUE');
    expect(logged).not.toContain('FAKEPAN123X');
  });

  it('stores no authorization material', async () => {
    await request(app.getHttpServer())
      .post('/probe/sessions')
      .set('X-Test-Actor', AGENT_A)
      .set('Idempotency-Key', 'k-auth')
      .set('Authorization', 'Bearer FAKE-BEARER-TOKEN-0000')
      .send({ external_ref: 'r1' })
      .expect(201);
    const stored = (await redis.get(redis.keys()[0] ?? '')) ?? '';
    expect(stored).not.toContain('FAKE-BEARER-TOKEN-0000');
    expect(stored).not.toContain('Bearer');
    expect(logged).not.toContain('FAKE-BEARER-TOKEN-0000');
  });
});
