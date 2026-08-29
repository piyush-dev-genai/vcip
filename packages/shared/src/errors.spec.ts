import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  DomainError,
  ErrorCode,
  httpStatusForErrorCode,
  isDomainError,
  isErrorCode,
  toApiErrorBody,
} from './errors.js';

describe('ErrorCode', () => {
  it('defines the three codes named in the API contract', () => {
    expect(ERROR_CODES).toContain(ErrorCode.SESSION_INVALID_STATE);
    expect(ERROR_CODES).toContain(ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE);
    expect(ERROR_CODES).toContain(ErrorCode.SESSION_ALREADY_ASSIGNED);
  });

  it('serialises each member to its own name', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('has no duplicate values', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('ERROR_HTTP_STATUS', () => {
  it('maps every code to a status', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('only uses statuses the API contract documents', () => {
    const documented = [400, 401, 403, 404, 409, 422, 429, 500, 503];
    for (const code of ERROR_CODES) {
      expect(documented).toContain(httpStatusForErrorCode(code));
    }
  });

  it('serves a losing claim as 409, per D5', () => {
    expect(httpStatusForErrorCode(ErrorCode.SESSION_ALREADY_ASSIGNED)).toBe(409);
  });

  it('serves an illegal transition as 409', () => {
    expect(httpStatusForErrorCode(ErrorCode.SESSION_INVALID_STATE)).toBe(409);
  });

  it('serves an unmet queue precondition as 422, not 409', () => {
    expect(httpStatusForErrorCode(ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE)).toBe(422);
  });
});

describe('isErrorCode', () => {
  it('accepts every defined code', () => {
    for (const code of ERROR_CODES) expect(isErrorCode(code)).toBe(true);
  });

  it.each([undefined, null, 0, '', 'session_invalid_state', 'NOPE', {}, []])(
    'rejects %p',
    (value) => {
      expect(isErrorCode(value)).toBe(false);
    },
  );
});

describe('DomainError', () => {
  it('carries its code, message, and derived HTTP status', () => {
    const error = new DomainError(
      ErrorCode.SESSION_INVALID_STATE,
      'Session cannot be accepted in its current state.',
    );
    expect(error.code).toBe(ErrorCode.SESSION_INVALID_STATE);
    expect(error.httpStatus).toBe(409);
    expect(error.message).toBe('Session cannot be accepted in its current state.');
  });

  it('is a real Error, so stack traces and instanceof both work', () => {
    const error = new DomainError(ErrorCode.NOT_FOUND, 'No such session.');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('DomainError');
    expect(isDomainError(error)).toBe(true);
  });

  it('is not confused with a plain Error', () => {
    expect(isDomainError(new Error('boom'))).toBe(false);
    expect(isDomainError('boom')).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });

  it('carries optional scalar details and defaults them to undefined', () => {
    expect(new DomainError(ErrorCode.CONFLICT, 'Conflict.').details).toBeUndefined();
    const withDetails = new DomainError(ErrorCode.SESSION_INVALID_STATE, 'Bad transition.', {
      from: 'QUEUED',
      to: 'APPROVED',
    });
    expect(withDetails.details).toEqual({ from: 'QUEUED', to: 'APPROVED' });
  });

  it('derives the status for every code without exception', () => {
    for (const code of ERROR_CODES) {
      expect(new DomainError(code, 'x').httpStatus).toBe(ERROR_HTTP_STATUS[code]);
    }
  });
});

describe('toApiErrorBody', () => {
  it('builds the documented envelope exactly', () => {
    expect(
      toApiErrorBody(
        ErrorCode.SESSION_INVALID_STATE,
        'Session cannot be accepted in its current state.',
        'req-123',
      ),
    ).toEqual({
      error: {
        code: 'SESSION_INVALID_STATE',
        message: 'Session cannot be accepted in its current state.',
        request_id: 'req-123',
      },
    });
  });

  it('uses snake_case request_id, matching the JSON contract', () => {
    const body = toApiErrorBody(ErrorCode.NOT_FOUND, 'Not found.', 'req-1');
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
  });

  it('is pure - it invents no request id of its own', () => {
    const first = toApiErrorBody(ErrorCode.INTERNAL_ERROR, 'Boom.', 'req-a');
    const second = toApiErrorBody(ErrorCode.INTERNAL_ERROR, 'Boom.', 'req-a');
    expect(first).toEqual(second);
  });
});
