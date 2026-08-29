/**
 * Routes opt in to idempotency explicitly.
 *
 * Not inferred from the HTTP method: `POST /v1/agent/availability` is a
 * mutation nobody needs replay protection for, while the six operations D13
 * names all create or transition durable state. Guessing from the verb would
 * both over- and under-apply.
 *
 * The documented set (`docs/05-api-contract.md`, D13):
 *
 *   POST /v1/sessions
 *   POST /v1/sessions/{id}/queue
 *   POST /v1/sessions/{id}/abort
 *   POST /v1/agent/sessions/{id}/claim
 *   POST /v1/agent/sessions/{id}/accept
 *   POST /v1/agent/sessions/{id}/verdict
 */

import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'vcip:idempotent';

export interface IdempotentOptions {
  /**
   * Stable identifier for the endpoint, used as the `{endpoint}` segment.
   *
   * Given explicitly rather than taken from the resolved URL: the URL carries
   * the session id, so `/v1/sessions/abc/queue` and `/v1/sessions/def/queue`
   * would otherwise be different endpoints. They are the same endpoint acting
   * on different resources, and the resource id is already part of the request
   * fingerprint.
   */
  readonly endpoint: string;
}

/** Mark a route as idempotent. Requires an `Idempotency-Key` header. */
export const Idempotent = (endpoint: string): MethodDecorator =>
  SetMetadata(IDEMPOTENT_KEY, { endpoint } satisfies IdempotentOptions);

/** The header carrying the client's key (`docs/05-api-contract.md` §4). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
