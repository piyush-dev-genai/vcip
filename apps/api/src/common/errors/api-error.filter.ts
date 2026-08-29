/**
 * The global error filter.
 *
 * One shape leaves this API on every failure (`docs/05-api-contract.md` §6):
 *
 *   { "error": { "code": ..., "message": ..., "request_id": ... } }
 *
 * Two responsibilities, deliberately asymmetric:
 *
 *   OUT — a stable code, a safe message, and the request id. Never a stack,
 *         never a driver message, never anything quoted back from the request.
 *   LOG — the diagnostic detail: code, status, error class, request/tenant/
 *         session ids, and latency. The line and the response share a
 *         `request_id`, which is what makes a support ticket answerable.
 *
 * The error codes come from `@vcip/shared`; nothing is redeclared here.
 */

import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@vcip/shared';
import { DomainError, ErrorCode as Code, isErrorCode } from '@vcip/shared';
import type { Logger } from 'pino';
import { logger as defaultLogger } from '../logging/logger.js';
import {
  REQUEST_ID_HEADER,
  currentRequestContext,
  currentRequestId,
} from '../logging/request-context.js';

/**
 * The generic code for a status that arrives without one.
 *
 * Every status in the §6 table is represented, so a bare `NotFoundException`
 * from anywhere in Nest still produces a documented code rather than a blank.
 */
const CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: Code.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: Code.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: Code.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: Code.NOT_FOUND,
  [HttpStatus.CONFLICT]: Code.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: Code.UNPROCESSABLE,
  [HttpStatus.TOO_MANY_REQUESTS]: Code.RATE_LIMITED,
  [HttpStatus.INTERNAL_SERVER_ERROR]: Code.INTERNAL_ERROR,
  [HttpStatus.SERVICE_UNAVAILABLE]: Code.SERVICE_UNAVAILABLE,
});

/**
 * What a client is told when something unexpected broke.
 *
 * Fixed text. The actual cause is in the log line under the same request id —
 * an unhandled error's message may quote a query, a header, or a row.
 */
const GENERIC_MESSAGE = 'An unexpected error occurred.';

/** Safe default messages, so a bare Nest exception still reads sensibly. */
const MESSAGE_FOR_STATUS: Readonly<Record<number, string>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: 'The request is invalid.',
  [HttpStatus.UNAUTHORIZED]: 'Authentication is required.',
  [HttpStatus.FORBIDDEN]: 'Not authorized.',
  [HttpStatus.NOT_FOUND]: 'Resource not found.',
  [HttpStatus.CONFLICT]: 'The request conflicts with the current state.',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'The request failed business validation.',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests.',
  [HttpStatus.INTERNAL_SERVER_ERROR]: GENERIC_MESSAGE,
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable.',
});

interface Normalised {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  /** Never sent. Logged, so a 500 is still diagnosable. */
  readonly internal?: string;
}

/**
 * A message is only echoed to the client when it came from our own code.
 *
 * Guards and services phrase their own messages; a message from a driver or a
 * third-party library has not been reviewed for what it might quote.
 */
const safeMessage = (value: unknown, fallback: string, url?: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return fallback;
  return echoesRequestUrl(value, url) ? fallback : value;
};

/**
 * Would this message hand the request's own URL back to the caller?
 *
 * Nest's default 404 is `Cannot GET /some/path?token=...`, which reflects the
 * full URL including its query string. That matters here specifically: D9 puts
 * WebSocket connection tokens in a query parameter, so URLs in this system do
 * carry credentials. Any message echoing the URL is replaced with the safe
 * default rather than trusted.
 */
const echoesRequestUrl = (message: string, url: string | undefined): boolean => {
  if (url === undefined || url.length === 0) return false;
  const path = url.split('?')[0] ?? url;
  return message.includes(url) || (path.length > 1 && message.includes(path));
};

function normalise(exception: unknown, url?: string): Normalised {
  // ---------------------------------------------- our own domain errors
  if (exception instanceof DomainError) {
    return {
      status: exception.httpStatus,
      code: exception.code,
      message: safeMessage(
        exception.message,
        MESSAGE_FOR_STATUS[exception.httpStatus] ?? GENERIC_MESSAGE,
        url,
      ),
    };
  }

  // --------------------------------------------------- Nest exceptions
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const fallbackCode = CODE_FOR_STATUS[status] ?? Code.INTERNAL_ERROR;
    const fallbackMessage = MESSAGE_FOR_STATUS[status] ?? GENERIC_MESSAGE;
    const response = exception.getResponse();

    // Guards and services throw `{ code, message }` — the shape T09 established.
    if (typeof response === 'object' && response !== null) {
      const body = response as Record<string, unknown>;
      const code = isErrorCode(body['code']) ? body['code'] : fallbackCode;

      // A ValidationPipe failure arrives as `message: string[]`. The array
      // names the offending fields and can quote submitted values, so the
      // count is reported and the detail stays in the log.
      if (Array.isArray(body['message'])) {
        return {
          status,
          code,
          message: fallbackMessage,
          internal: `${body['message'].length} validation error(s)`,
        };
      }

      return { status, code, message: safeMessage(body['message'], fallbackMessage, url) };
    }

    return { status, code: fallbackCode, message: safeMessage(response, fallbackMessage, url) };
  }

  // ------------------------------------------------- anything unexpected
  // A thrown string, a driver error, a TypeError. The client gets a fixed
  // message; the class name goes to the log, but never the message, which
  // could carry a query fragment or a credential.
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: Code.INTERNAL_ERROR,
    message: GENERIC_MESSAGE,
    internal: exception instanceof Error ? exception.name : typeof exception,
  };
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly log: Logger = defaultLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{
      method?: string;
      url?: string;
      startedAt?: number;
    }>();
    const response = http.getResponse<{
      status: (code: number) => unknown;
      json: (body: unknown) => unknown;
      setHeader?: (name: string, value: string) => unknown;
    }>();

    const { status, code, message, internal } = normalise(exception, request?.url);
    const requestId = currentRequestId();
    const context = currentRequestContext();

    // Diagnostics. Identifiers and classifications only — §40's "logs should
    // prefer" list. The exception object itself is not passed: its stack and
    // message are exactly what must not be recorded.
    const details = {
      event: 'request.failed',
      error_code: code,
      status,
      error_type: exception instanceof Error ? exception.constructor.name : typeof exception,
      method: request?.method,
      // The path only. A query string can carry a token in a badly built client.
      path: typeof request?.url === 'string' ? request.url.split('?')[0] : undefined,
      ...(internal === undefined ? {} : { detail: internal }),
      ...(typeof request?.startedAt === 'number'
        ? { duration_ms: Date.now() - request.startedAt }
        : {}),
      ...(context?.tenantId === undefined ? {} : { tenant_id: context.tenantId }),
      ...(context?.sessionId === undefined ? {} : { session_id: context.sessionId }),
    };

    // 5xx is ours to fix; 4xx is the caller's to correct.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) this.log.error(details, 'request failed');
    else this.log.warn(details, 'request rejected');

    response.setHeader?.(REQUEST_ID_HEADER, requestId);
    response.status(status);
    response.json({ error: { code, message, request_id: requestId } });
  }
}
