import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger } from './logger.js';
import { runWithRequestContext } from './request-context.js';

/**
 * Redaction is asserted against real pino output.
 *
 * Every test here serialises through an actual pino instance into a stream and
 * parses the NDJSON that comes out. A helper that returns a redacted object
 * proves nothing about what the logger writes; this proves what would land in
 * the log file.
 *
 * The fixtures are obviously fake strings. No real credential appears in this
 * file, and nothing here is logged to the test runner's stdout.
 */

/** Capture what pino actually writes. */
const capture = (): { lines: () => unknown[]; raw: () => string; stream: Writable } => {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return {
    stream,
    raw: () => buffer,
    lines: () =>
      buffer
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
};

const logOnce = (
  payload: Record<string, unknown>,
): { line: Record<string, unknown>; raw: string } => {
  const sink = capture();
  const log = createLogger({ level: 'debug', destination: sink.stream });
  log.info(payload, 'test');
  const [line] = sink.lines() as Record<string, unknown>[];
  return { line: line ?? {}, raw: sink.raw() };
};

// Recognisable placeholders. None is a real credential.
const FAKE = {
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.FAKEPAYLOAD.FAKESIGNATURE',
  apiKey: 'vcip_demo_FAKEKEYVALUE0000000000',
  internal: 'FAKE-INTERNAL-TOKEN-VALUE-0000',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.FAKEAGENT.FAKESIG',
  password: 'FAKE-PASSWORD-VALUE',
  privateKey: '-----BEGIN PRIVATE KEY-----FAKE-----END PRIVATE KEY-----',
  databaseUrl: 'postgresql://user:FAKE-DB-PASSWORD@localhost:5432/db',
  secret: 'FAKE-SECRET-VALUE-0000',
} as const;

describe('credentials are redacted in real pino output', () => {
  it.each([
    ['authorization header', { authorization: FAKE.bearer }, FAKE.bearer],
    ['Authorization capitalised', { Authorization: FAKE.bearer }, FAKE.bearer],
    ['cookie', { cookie: 'session=FAKE-COOKIE-VALUE' }, 'FAKE-COOKIE-VALUE'],
    ['x-internal-token', { 'x-internal-token': FAKE.internal }, FAKE.internal],
    ['apiKey', { apiKey: FAKE.apiKey }, FAKE.apiKey],
    ['api_key', { api_key: FAKE.apiKey }, FAKE.apiKey],
    ['tenant_api_key', { tenant_api_key: FAKE.apiKey }, FAKE.apiKey],
    ['customerToken', { customerToken: FAKE.jwt }, FAKE.jwt],
    ['customer_token', { customer_token: FAKE.jwt }, FAKE.jwt],
    ['agentJwt', { agentJwt: FAKE.jwt }, FAKE.jwt],
    ['jwt', { jwt: FAKE.jwt }, FAKE.jwt],
    ['internalToken', { internalToken: FAKE.internal }, FAKE.internal],
    ['token', { token: FAKE.jwt }, FAKE.jwt],
    ['password', { password: FAKE.password }, FAKE.password],
    ['password_hash', { password_hash: 'FAKE-HASH-VALUE' }, 'FAKE-HASH-VALUE'],
    ['key_hash', { key_hash: 'FAKE-KEY-HASH' }, 'FAKE-KEY-HASH'],
    ['privateKey', { privateKey: FAKE.privateKey }, 'BEGIN PRIVATE KEY'],
    ['signing_key', { signing_key: FAKE.privateKey }, 'BEGIN PRIVATE KEY'],
    ['secret', { secret: FAKE.secret }, FAKE.secret],
    ['secret_ref', { secret_ref: FAKE.secret }, FAKE.secret],
    ['DATABASE_URL', { DATABASE_URL: FAKE.databaseUrl }, 'FAKE-DB-PASSWORD'],
    ['databaseUrl', { databaseUrl: FAKE.databaseUrl }, 'FAKE-DB-PASSWORD'],
    ['connectionString', { connectionString: FAKE.databaseUrl }, 'FAKE-DB-PASSWORD'],
    ['VCIP_INTERNAL_TOKEN', { VCIP_INTERNAL_TOKEN: FAKE.internal }, FAKE.internal],
    ['LIVEKIT_API_SECRET', { LIVEKIT_API_SECRET: FAKE.secret }, FAKE.secret],
  ])('redacts %s', (_label, payload, leaked) => {
    const { raw } = logOnce(payload);
    expect(raw).not.toContain(leaked);
    expect(raw).toContain(REDACTED);
  });
});

describe('nested credentials are redacted', () => {
  it('redacts a whole logged request object', () => {
    // The realistic accident: someone logs `req` to debug something.
    const { raw } = logOnce({
      req: {
        method: 'POST',
        url: '/v1/sessions',
        headers: {
          authorization: FAKE.bearer,
          'x-internal-token': FAKE.internal,
          cookie: 'a=FAKE-COOKIE-VALUE',
          'content-type': 'application/json',
        },
      },
    });
    expect(raw).not.toContain(FAKE.bearer);
    expect(raw).not.toContain(FAKE.internal);
    expect(raw).not.toContain('FAKE-COOKIE-VALUE');
    // Non-sensitive header survives, so the log is still useful.
    expect(raw).toContain('application/json');
  });

  it('redacts one level deep', () => {
    const { raw } = logOnce({ auth: { apiKey: FAKE.apiKey, tenant_id: 't-1' } });
    expect(raw).not.toContain(FAKE.apiKey);
    expect(raw).toContain('t-1');
  });

  it('redacts two levels deep', () => {
    const { raw } = logOnce({ outer: { inner: { password: FAKE.password } } });
    expect(raw).not.toContain(FAKE.password);
  });

  it('redacts inside a logged config object', () => {
    const { raw } = logOnce({
      config: { internalToken: FAKE.internal, customerTokenTtlSeconds: 7200 },
    });
    expect(raw).not.toContain(FAKE.internal);
    expect(raw).toContain('7200');
  });

  it('redacts inside a logged body', () => {
    const { raw } = logOnce({ body: { password: FAKE.password, email: 'a@demo.local' } });
    expect(raw).not.toContain(FAKE.password);
    expect(raw).toContain('a@demo.local');
  });
});

describe('sensitive customer data is dropped, not marked', () => {
  it.each([
    ['gps', { gps: { latitude: 12.97, longitude: 77.59 } }],
    ['latitude', { latitude: 12.9716 }],
    ['pan', { pan: 'FAKEPAN123X' }],
    ['aadhaar', { aadhaar: '0000-0000-0000' }],
    ['ocrText', { ocrText: 'FAKE OCR CONTENT' }],
    ['faceImage', { faceImage: 'data:image/png;base64,FAKE' }],
    ['frames', { frames: [1, 2, 3] }],
  ])('drops %s entirely', (key, payload) => {
    const { raw, line } = logOnce(payload);
    expect(line[key]).toBeUndefined();
    // Not even a marker: unlike a credential, its presence is not worth noting.
    expect(raw).not.toContain('12.97');
    expect(raw).not.toContain('FAKEPAN123X');
    expect(raw).not.toContain('FAKE OCR CONTENT');
  });
});

describe('safe fields survive redaction', () => {
  it('keeps the identifiers section 40 says logs should prefer', () => {
    const { line } = logOnce({
      request_id: 'req-1',
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      event: 'session.queued',
      status: 'QUEUED',
      error_code: 'SESSION_INVALID_STATE',
      duration_ms: 42,
    });
    expect(line['request_id']).toBe('req-1');
    expect(line['tenant_id']).toBe('tenant-1');
    expect(line['session_id']).toBe('session-1');
    expect(line['event']).toBe('session.queued');
    expect(line['status']).toBe('QUEUED');
    expect(line['error_code']).toBe('SESSION_INVALID_STATE');
    expect(line['duration_ms']).toBe(42);
  });

  it('stamps the service name', () => {
    expect(logOnce({}).line['service']).toBe('api');
  });
});

describe('request context is stamped on every line', () => {
  it('adds the request id without the caller passing it', () => {
    const sink = capture();
    const log = createLogger({ level: 'debug', destination: sink.stream });
    runWithRequestContext({ requestId: 'req-abc' }, () => {
      log.info({ event: 'something.happened' }, 'test');
    });
    const [line] = sink.lines() as Record<string, unknown>[];
    expect(line?.['request_id']).toBe('req-abc');
  });

  it('adds tenant and session when the context carries them', () => {
    const sink = capture();
    const log = createLogger({ level: 'debug', destination: sink.stream });
    runWithRequestContext({ requestId: 'r1', tenantId: 't1', sessionId: 's1' }, () => {
      log.info({ event: 'x' }, 'test');
    });
    const [line] = sink.lines() as Record<string, unknown>[];
    expect(line?.['tenant_id']).toBe('t1');
    expect(line?.['session_id']).toBe('s1');
  });

  it('omits them outside a request rather than inventing values', () => {
    const { line } = logOnce({ event: 'startup' });
    expect(line['tenant_id']).toBeUndefined();
    expect(line['session_id']).toBeUndefined();
  });
});

describe('errors are logged without a stack', () => {
  it('records the type and message but never the stack', () => {
    const sink = capture();
    const log = createLogger({ level: 'debug', destination: sink.stream });
    const error = new Error('boom at /srv/app/src/secret-path.ts');
    log.error({ err: error }, 'failed');
    const raw = sink.raw();
    expect(raw).toContain('Error');
    expect(raw).not.toContain('at Object');
    expect(raw).not.toContain('node_modules');
    const [line] = sink.lines() as Array<{ err?: Record<string, unknown> }>;
    expect(line?.err?.['stack']).toBeUndefined();
  });
});
