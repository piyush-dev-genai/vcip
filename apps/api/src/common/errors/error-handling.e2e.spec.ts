import { Writable } from 'node:stream';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_CONFIG, redactable } from '../auth/auth.config.js';
import { InternalTokenGuard } from '../auth/internal-token.guard.js';
import { createLogger } from '../logging/logger.js';
import { LoggingModule } from '../logging/logging.module.js';
import { ApiErrorFilter } from './api-error.filter.js';

/**
 * End-to-end through a real Nest application over real HTTP.
 *
 * The unit tests drive the filter with a hand-built ArgumentsHost. This runs
 * the whole path a request actually takes — middleware, guard, controller,
 * filter, Express — and inspects what the logger wrote while it happened.
 *
 * The probe controller exists only for this test. It is not application
 * surface: no route here survives outside this file.
 */

const INTERNAL_TOKEN = 'FAKE-INTERNAL-TOKEN-FOR-TESTS-0000';
const FAKE_BEARER = 'Bearer FAKE-CUSTOMER-TOKEN-VALUE-0000';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { data: { status: string } } {
    return { data: { status: 'ok' } };
  }

  @Get('boom')
  boom(): never {
    // Deliberately quotes a credential-shaped string, as a careless driver
    // error might. None of it may reach the client.
    throw new Error('internal failure: connecting with password FAKE-DB-PASSWORD-0000');
  }

  @Get('guarded')
  @UseGuards(InternalTokenGuard)
  guarded(): { data: { ok: boolean } } {
    return { data: { ok: true } };
  }
}

/**
 * A guard named by `@UseGuards` is resolved from the module that declares the
 * controller, not from the root, so its dependencies must be provided here.
 */
@Module({
  imports: [LoggingModule],
  controllers: [ProbeController],
  providers: [
    {
      provide: AUTH_CONFIG,
      useValue: redactable({
        customerTokenSecret: 'c'.repeat(40),
        agentJwtSecret: 'a'.repeat(40),
        internalToken: INTERNAL_TOKEN,
        customerTokenTtlSeconds: 7200,
        agentJwtTtlSeconds: 43200,
      }),
    },
    InternalTokenGuard,
  ],
})
class ProbeModule {}

describe('error handling through a real application', () => {
  let app: INestApplication;
  let written = '';

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        written += String(chunk);
        callback();
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiErrorFilter(createLogger({ level: 'debug', destination: stream })));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a successful request unchanged', async () => {
    const response = await request(app.getHttpServer()).get('/probe/ok').expect(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
  });

  it('gives a successful response a request id header', async () => {
    const response = await request(app.getHttpServer()).get('/probe/ok').expect(200);
    expect(response.headers['x-request-id']).toMatch(/.+/);
  });

  it('reuses a client-supplied request id', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('X-Request-Id', 'client-supplied-id')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('client-supplied-id');
  });

  it('returns the documented envelope for an unexpected failure', async () => {
    const response = await request(app.getHttpServer()).get('/probe/boom').expect(500);
    expect(response.body).toEqual({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        request_id: expect.stringMatching(/.+/) as unknown as string,
      },
    });
  });

  it('never leaks the underlying failure to the client', async () => {
    const response = await request(app.getHttpServer()).get('/probe/boom').expect(500);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('FAKE-DB-PASSWORD-0000');
    expect(body).not.toContain('password');
    expect(body).not.toContain('at ');
  });

  it('correlates the error response with a log line', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/boom')
      .set('X-Request-Id', 'trace-me-123')
      .expect(500);
    expect(response.body.error.request_id).toBe('trace-me-123');
    expect(written).toContain('trace-me-123');
  });

  it('rejects a guarded route without the internal credential', async () => {
    const response = await request(app.getHttpServer()).get('/probe/guarded').expect(401);
    expect(response.body.error.code).toBe(ErrorCode.UNAUTHENTICATED);
    expect(response.body.error.request_id).toMatch(/.+/);
  });

  it('admits a guarded route with the correct credential', async () => {
    await request(app.getHttpServer())
      .get('/probe/guarded')
      .set('X-Internal-Token', INTERNAL_TOKEN)
      .expect(200);
  });

  it('returns the documented envelope for an unmatched route', async () => {
    const response = await request(app.getHttpServer()).get('/probe/nope').expect(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(Object.keys(response.body)).toEqual(['error']);
  });

  it('does not echo a query-string credential in an unmatched-route 404', async () => {
    // D9 puts connection tokens in query parameters, so URLs here carry secrets.
    const response = await request(app.getHttpServer())
      .get('/probe/missing?connection_token=FAKE-QUERY-TOKEN-9999')
      .expect(404);
    expect(JSON.stringify(response.body)).not.toContain('FAKE-QUERY-TOKEN-9999');
    expect(response.body.error.message).toBe('Resource not found.');
  });

  it('writes no secret to the log across every request above', () => {
    // The whole captured log, after a success, two failures, and both guard
    // outcomes - including a request that carried the real internal token.
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain(INTERNAL_TOKEN);
    expect(written).not.toContain(FAKE_BEARER);
    expect(written).not.toContain('FAKE-DB-PASSWORD-0000');
    expect(written).not.toContain('BEGIN PRIVATE KEY');
  });

  it('writes the diagnostic fields that make a failure traceable', () => {
    expect(written).toContain('request.failed');
    expect(written).toContain(ErrorCode.INTERNAL_ERROR);
    expect(written).toContain('"status":500');
  });
});
