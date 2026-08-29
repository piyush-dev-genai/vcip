/**
 * Per-request correlation context.
 *
 * One request id, established once at the edge and reused everywhere: in the
 * error envelope's `request_id`, in every log line, and in the `X-Request-Id`
 * response header. There is no second identifier — the API contract §4 already
 * names this header, so it is the correlation mechanism rather than one
 * invented alongside it.
 *
 * `AsyncLocalStorage` rather than threading a context object through every
 * signature: it is built into Node, and it means a log call deep inside a
 * service still carries the request id without the service knowing about HTTP.
 *
 * Only low-sensitivity identifiers live here — request, tenant, session — which
 * is exactly what `docs/03-system-design.md` §40 says logs should prefer.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** The documented correlation header (`docs/05-api-contract.md` §4). */
export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestContext {
  readonly requestId: string;
  /** Set once a guard has authenticated the actor. Never from the payload. */
  tenantId?: string;
  /** Set once a handler is operating on a known session. */
  sessionId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` bound for its whole async subtree. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or undefined outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current request id, or a fresh one.
 *
 * Never returns an empty string: an error response without a correlation id is
 * an error nobody can trace back to a log line, which defeats the point.
 */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? randomUUID();
}

/**
 * Adopt an inbound request id, or mint one.
 *
 * A client-supplied value is accepted so a caller can correlate across systems,
 * but it is constrained: it lands in log lines and in a response header, so an
 * unbounded or control-character-bearing string would be a log-injection and
 * header-splitting vector. Anything failing the shape check is replaced rather
 * than rejected — a malformed correlation id is not worth failing a request over.
 */
export function normaliseRequestId(supplied: unknown): string {
  if (typeof supplied !== 'string') return randomUUID();
  const trimmed = supplied.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return randomUUID();
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return randomUUID();
  return trimmed;
}

/** Attach the authenticated tenant to the current context, if there is one. */
export function setContextTenant(tenantId: string | undefined): void {
  const context = storage.getStore();
  if (context !== undefined && tenantId !== undefined) context.tenantId = tenantId;
}

/** Attach the session under operation to the current context. */
export function setContextSession(sessionId: string | undefined): void {
  const context = storage.getStore();
  if (context !== undefined && sessionId !== undefined) context.sessionId = sessionId;
}
