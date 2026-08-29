import { Writable } from 'node:stream';
import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DomainError, ErrorCode } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { runWithRequestContext } from '../logging/request-context.js';
import { ApiErrorFilter } from './api-error.filter.js';

interface Captured {
  status?: number;
  body?: { error: { code: string; message: string; request_id: string } };
  headers: Record<string, string>;
}

const capture = (): { lines: () => string; stream: Writable } => {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return { stream, lines: () => buffer };
};

/** Run one exception through the filter and collect the response. */
const handle = (
  exception: unknown,
  options: { requestId?: string; tenantId?: string; sessionId?: string; url?: string } = {},
): { captured: Captured; logged: string } => {
  const sink = capture();
  const filter = new ApiErrorFilter(createLogger({ level: 'debug', destination: sink.stream }));

  const captured: Captured = { headers: {} };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        url: options.url ?? '/v1/sessions/abc',
        startedAt: Date.now() - 12,
      }),
      getResponse: () => ({
        status: (code: number) => {
          captured.status = code;
        },
        json: (body: unknown) => {
          captured.body = body as Captured['body'];
        },
        setHeader: (name: string, value: string) => {
          captured.headers[name] = value;
        },
      }),
    }),
  } as unknown as ArgumentsHost;

  const context = {
    requestId: options.requestId ?? 'req-fixed-1',
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
  runWithRequestContext(context, () => {
    filter.catch(exception, host);
  });

  return { captured, logged: sink.lines() };
};

describe('the documented response shape', () => {
  it('returns exactly error.code, error.message, error.request_id', () => {
    const { captured } = handle(
      new HttpException(
        {
          code: ErrorCode.SESSION_INVALID_STATE,
          message: 'Session cannot be accepted in its current state.',
        },
        HttpStatus.CONFLICT,
      ),
    );
    expect(captured.body).toEqual({
      error: {
        code: 'SESSION_INVALID_STATE',
        message: 'Session cannot be accepted in its current state.',
        request_id: 'req-fixed-1',
      },
    });
    expect(Object.keys(captured.body?.error ?? {}).sort()).toEqual([
      'code',
      'message',
      'request_id',
    ]);
  });

  it('carries no field beyond the envelope', () => {
    const { captured } = handle(new NotFoundException());
    expect(Object.keys(captured.body ?? {})).toEqual(['error']);
  });
});

describe('status mapping', () => {
  it.each([
    ['400 invalid request', new BadRequestException(), 400, ErrorCode.VALIDATION_ERROR],
    ['401 authentication', new UnauthorizedException(), 401, ErrorCode.UNAUTHENTICATED],
    ['403 forbidden', new ForbiddenException(), 403, ErrorCode.FORBIDDEN],
    ['404 not found', new NotFoundException(), 404, ErrorCode.NOT_FOUND],
    ['409 conflict', new ConflictException(), 409, ErrorCode.CONFLICT],
    ['422 business validation', new UnprocessableEntityException(), 422, ErrorCode.UNPROCESSABLE],
    ['429 rate limited', new HttpException('slow down', 429), 429, ErrorCode.RATE_LIMITED],
    ['500 internal', new HttpException('boom', 500), 500, ErrorCode.INTERNAL_ERROR],
    ['503 unavailable', new ServiceUnavailableException(), 503, ErrorCode.SERVICE_UNAVAILABLE],
  ])('maps %s', (_label, exception, status, code) => {
    const { captured } = handle(exception);
    expect(captured.status).toBe(status);
    expect(captured.body?.error.code).toBe(code);
  });

  it('covers every status in the API contract table', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
      const { captured } = handle(new HttpException('x', status));
      expect(captured.status).toBe(status);
      expect(captured.body?.error.code).not.toBe('');
    }
  });
});

describe('domain errors from @vcip/shared', () => {
  it.each([
    [ErrorCode.SESSION_INVALID_STATE, 409],
    [ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE, 422],
    [ErrorCode.SESSION_ALREADY_ASSIGNED, 409],
    [ErrorCode.NOT_FOUND, 404],
    [ErrorCode.FORBIDDEN, 403],
  ])('maps %s to %i using the shared status table', (code, status) => {
    const { captured } = handle(new DomainError(code, 'Something specific happened.'));
    expect(captured.status).toBe(status);
    expect(captured.body?.error.code).toBe(code);
    expect(captured.body?.error.message).toBe('Something specific happened.');
  });

  it('reuses the shared codes rather than a parallel enum', () => {
    const { captured } = handle(new DomainError(ErrorCode.SESSION_ALREADY_ASSIGNED, 'Claimed.'));
    expect(captured.body?.error.code).toBe(ErrorCode.SESSION_ALREADY_ASSIGNED);
  });
});

describe('guard rejections from T09', () => {
  it('preserves the code and message a guard threw', () => {
    const { captured } = handle(
      new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'Invalid or missing API key.',
      }),
    );
    expect(captured.status).toBe(401);
    expect(captured.body?.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Invalid or missing API key.',
    });
  });

  it('preserves a tenant mismatch as 403', () => {
    const { captured } = handle(
      new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'Tenant mismatch.' }),
    );
    expect(captured.status).toBe(403);
    expect(captured.body?.error.code).toBe('FORBIDDEN');
  });
});

describe('validation failures', () => {
  it('returns 400 without echoing the offending values', () => {
    // What a ValidationPipe produces: an array naming fields and often quoting
    // what was submitted.
    const { captured } = handle(
      new BadRequestException({
        message: ['email must be an email', 'password should not be empty'],
        error: 'Bad Request',
        statusCode: 400,
      }),
    );
    expect(captured.status).toBe(400);
    expect(captured.body?.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(captured.body?.error.message).toBe('The request is invalid.');
    expect(JSON.stringify(captured.body)).not.toContain('password');
  });

  it('records the count in the log so the failure is still diagnosable', () => {
    const { logged } = handle(
      new BadRequestException({ message: ['a is required', 'b is required'] }),
    );
    expect(logged).toContain('2 validation error(s)');
  });

  it('keeps 422 for a business validation failure', () => {
    const { captured } = handle(
      new DomainError(ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE, 'Preflight has not passed.'),
    );
    expect(captured.status).toBe(422);
  });
});

describe('unknown errors', () => {
  it('becomes a 500 with a fixed generic message', () => {
    const { captured } = handle(
      new Error('connection to 10.0.0.5 failed: password authentication'),
    );
    expect(captured.status).toBe(500);
    expect(captured.body?.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(captured.body?.error.message).toBe('An unexpected error occurred.');
  });

  it('never leaks the underlying message', () => {
    const { captured } = handle(new Error('password authentication failed for user "vcip"'));
    const serialised = JSON.stringify(captured.body);
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('vcip');
  });

  it('handles a thrown non-Error without crashing', () => {
    for (const thrown of ['a string', 42, null, undefined, { odd: true }]) {
      const { captured } = handle(thrown);
      expect(captured.status).toBe(500);
      expect(captured.body?.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    }
  });

  it('logs the error class so a 500 is still diagnosable', () => {
    const { logged } = handle(new TypeError('bad'));
    expect(logged).toContain('TypeError');
  });
});

describe('nothing internal reaches the response', () => {
  it('never includes a stack trace', () => {
    const error = new Error('boom');
    const { captured } = handle(error);
    const serialised = JSON.stringify(captured.body);
    expect(serialised).not.toContain('at ');
    expect(serialised).not.toContain('.ts:');
    expect(serialised).not.toContain('node_modules');
    expect(captured.body).not.toHaveProperty('stack');
    expect(captured.body?.error).not.toHaveProperty('stack');
  });

  it('drops an over-long message rather than echoing it', () => {
    const { captured } = handle(new HttpException({ message: 'x'.repeat(5000) }, 409));
    expect(captured.body?.error.message.length).toBeLessThan(300);
  });

  it('does not echo a credential embedded in a raw exception message', () => {
    const leaked = 'Bearer FAKE-TOKEN-VALUE-0000';
    const { captured } = handle(new Error(`request failed with ${leaked}`));
    expect(JSON.stringify(captured.body)).not.toContain('FAKE-TOKEN-VALUE-0000');
  });

  it('logs no secret when the failing path carried one in the query string', () => {
    const { logged } = handle(new UnauthorizedException(), {
      url: '/v1/sessions?token=FAKE-QUERY-TOKEN-0000',
    });
    expect(logged).not.toContain('FAKE-QUERY-TOKEN-0000');
    expect(logged).toContain('/v1/sessions');
  });
});

describe('request id propagation', () => {
  it('reuses the id already established for the request', () => {
    const { captured } = handle(new NotFoundException(), { requestId: 'req-from-header' });
    expect(captured.body?.error.request_id).toBe('req-from-header');
  });

  it('echoes the same id in the response header', () => {
    const { captured } = handle(new NotFoundException(), { requestId: 'req-echo' });
    expect(captured.headers['x-request-id']).toBe('req-echo');
  });

  it('uses the same id in the log line and the response', () => {
    const { captured, logged } = handle(new ConflictException(), { requestId: 'req-shared' });
    expect(captured.body?.error.request_id).toBe('req-shared');
    expect(logged).toContain('req-shared');
  });

  it('still returns an id when there is no context at all', () => {
    const sink = capture();
    const filter = new ApiErrorFilter(createLogger({ level: 'debug', destination: sink.stream }));
    const captured: Captured = { headers: {} };
    filter.catch(new NotFoundException(), {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({
          status: (c: number) => {
            captured.status = c;
          },
          json: (b: unknown) => {
            captured.body = b as Captured['body'];
          },
        }),
      }),
    } as unknown as ArgumentsHost);
    // A response nobody can correlate to a log line defeats the purpose.
    expect(captured.body?.error.request_id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('logging alongside the response', () => {
  it('logs the diagnostic metadata section 40 asks for', () => {
    const { logged } = handle(new ConflictException(), {
      tenantId: 'tenant-1',
      sessionId: 'session-1',
    });
    const line = JSON.parse(logged.trim().split('\n')[0] ?? '{}') as Record<string, unknown>;
    expect(line['error_code']).toBe(ErrorCode.CONFLICT);
    expect(line['status']).toBe(409);
    expect(line['tenant_id']).toBe('tenant-1');
    expect(line['session_id']).toBe('session-1');
    expect(line['error_type']).toBe('ConflictException');
    expect(typeof line['duration_ms']).toBe('number');
    expect(line['event']).toBe('request.failed');
  });

  it('logs 5xx at error and 4xx at warn', () => {
    const server = JSON.parse(handle(new Error('x')).logged.trim().split('\n')[0] ?? '{}') as {
      level: number;
    };
    const client = JSON.parse(
      handle(new NotFoundException()).logged.trim().split('\n')[0] ?? '{}',
    ) as { level: number };
    expect(server.level).toBe(50);
    expect(client.level).toBe(40);
  });
});

describe('a message must never echo the request URL', () => {
  it('replaces Nest\u0027s default 404, which reflects the whole URL', () => {
    // The real shape: Express/Nest produce `Cannot GET <url>` for an unmatched
    // route, query string included.
    const { captured } = handle(new NotFoundException('Cannot GET /v1/nope?token=LEAKY-0000'), {
      url: '/v1/nope?token=LEAKY-0000',
    });
    expect(captured.body?.error.message).toBe('Resource not found.');
    expect(JSON.stringify(captured.body)).not.toContain('LEAKY-0000');
  });

  it('matters because D9 puts connection tokens in a query parameter', () => {
    const { captured } = handle(
      new NotFoundException('Cannot GET /v1/ws?connection_token=LEAKY-WS-TOKEN'),
      { url: '/v1/ws?connection_token=LEAKY-WS-TOKEN' },
    );
    expect(JSON.stringify(captured.body)).not.toContain('LEAKY-WS-TOKEN');
  });

  it('replaces a message echoing only the path', () => {
    const { captured } = handle(new NotFoundException('Cannot GET /v1/secret-path'), {
      url: '/v1/secret-path',
    });
    expect(captured.body?.error.message).toBe('Resource not found.');
  });

  it('still returns messages our own code phrased', () => {
    const { captured } = handle(
      new ConflictException({
        code: ErrorCode.SESSION_INVALID_STATE,
        message: 'Session cannot be accepted in its current state.',
      }),
      { url: '/v1/sessions/abc/accept' },
    );
    expect(captured.body?.error.message).toBe('Session cannot be accepted in its current state.');
  });
});
