/**
 * Error mapping.
 *
 * Two things are being checked: that every documented status produces useful
 * text, and that nothing from the server reaches it.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@vcip/shared';
import { ApiError, NetworkError, toCustomerMessage } from './errors';

const apiError = (status: number, code: string, message = 'server text', requestId = 'req-1') =>
  new ApiError(status, code, message, requestId);

describe('toCustomerMessage', () => {
  it('covers every status the API contract documents', () => {
    const statuses: [number, string][] = [
      [400, ErrorCode.VALIDATION_ERROR],
      [401, ErrorCode.UNAUTHENTICATED],
      [403, ErrorCode.FORBIDDEN],
      [404, ErrorCode.NOT_FOUND],
      [409, ErrorCode.CONFLICT],
      [422, ErrorCode.UNPROCESSABLE],
      [429, ErrorCode.RATE_LIMITED],
      [500, ErrorCode.INTERNAL_ERROR],
      [503, ErrorCode.SERVICE_UNAVAILABLE],
    ];
    for (const [status, code] of statuses) {
      const message = toCustomerMessage(apiError(status, code));
      expect(message.title.length).toBeGreaterThan(0);
      expect(message.detail.length).toBeGreaterThan(0);
    }
  });

  it('tells an expired session to start again, and does not offer a retry', () => {
    // R8: no refresh endpoint and no revocation. Retrying cannot help.
    const message = toCustomerMessage(apiError(401, ErrorCode.UNAUTHENTICATED));
    expect(message.retryable).toBe(false);
    expect(message.detail).toMatch(/start again/i);
  });

  it('tells a 409 to refresh rather than to retry the same action', () => {
    const message = toCustomerMessage(apiError(409, ErrorCode.SESSION_INVALID_STATE));
    expect(message.retryable).toBe(false);
    expect(message.detail).toMatch(/refresh/i);
  });

  it('marks temporary faults retryable', () => {
    expect(toCustomerMessage(apiError(500, ErrorCode.INTERNAL_ERROR)).retryable).toBe(true);
    expect(toCustomerMessage(apiError(503, ErrorCode.SERVICE_UNAVAILABLE)).retryable).toBe(true);
    expect(toCustomerMessage(apiError(429, ErrorCode.RATE_LIMITED)).retryable).toBe(true);
  });

  it('never repeats the server message', () => {
    // The whole reason the table exists. A server string is not written for a
    // customer and may name internals.
    const leaky = apiError(
      500,
      ErrorCode.INTERNAL_ERROR,
      'relation "sessions" does not exist at Object.<anonymous> (/srv/api/dist/db.js:12)',
    );
    const message = toCustomerMessage(leaky);
    expect(message.title).not.toContain('relation');
    expect(message.detail).not.toContain('relation');
    expect(JSON.stringify(message)).not.toContain('dist/db.js');
    expect(JSON.stringify(message)).not.toContain('sessions');
  });

  it('keeps the request id, which is the only thing worth quoting to support', () => {
    expect(toCustomerMessage(apiError(500, ErrorCode.INTERNAL_ERROR)).requestId).toBe('req-1');
  });

  it('falls back on status when the code is unknown', () => {
    const message = toCustomerMessage(apiError(404, 'SOME_FUTURE_CODE'));
    expect(message.title).toBe(toCustomerMessage(apiError(404, ErrorCode.NOT_FOUND)).title);
  });

  it('falls back to a generic retryable message for an unmapped 5xx', () => {
    const message = toCustomerMessage(apiError(504, 'SOME_FUTURE_CODE'));
    expect(message.retryable).toBe(true);
    expect(message.title.length).toBeGreaterThan(0);
  });

  it('explains a transport failure without naming a host', () => {
    const message = toCustomerMessage(new NetworkError('connect ECONNREFUSED 10.0.0.4:3001'));
    expect(message.detail).toMatch(/connection/i);
    expect(JSON.stringify(message)).not.toContain('10.0.0.4');
  });

  it('is total: anything thrown at all becomes a message', () => {
    for (const thrown of [undefined, null, 'a string', 42, new Error('raw'), { code: 'x' }]) {
      const message = toCustomerMessage(thrown);
      expect(message.title.length).toBeGreaterThan(0);
      expect(message.requestId).toBeNull();
    }
    expect(JSON.stringify(toCustomerMessage(new Error('raw')))).not.toContain('raw');
  });
});
