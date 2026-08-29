/**
 * Establishes the request context at the edge.
 *
 * Runs before guards, so every log line and every error envelope from that
 * point on carries the same `request_id` — including failures thrown by the
 * T09 authentication guards, which run inside this scope.
 *
 * The id is echoed back in `X-Request-Id` so a caller can quote it in a support
 * request and have it match a log line exactly.
 */

import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { REQUEST_ID_HEADER, normaliseRequestId, runWithRequestContext } from './request-context.js';

interface EdgeRequest {
  headers: Record<string, string | string[] | undefined>;
  startedAt?: number;
}

interface EdgeResponse {
  setHeader?: (name: string, value: string) => unknown;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: EdgeRequest, response: EdgeResponse, next: () => void): void {
    const requestId = normaliseRequestId(request.headers[REQUEST_ID_HEADER]);

    // Used by the error filter to report latency without a second clock.
    request.startedAt = Date.now();
    response.setHeader?.(REQUEST_ID_HEADER, requestId);

    runWithRequestContext({ requestId }, next);
  }
}
