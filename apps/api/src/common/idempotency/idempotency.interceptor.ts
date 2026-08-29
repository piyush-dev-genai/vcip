/**
 * Idempotency interceptor (D13).
 *
 * Applies only to routes marked `@Idempotent(...)`. The flow:
 *
 *   1. Require an `Idempotency-Key` header.
 *   2. Build `idem:{actor}:{endpoint}:{key}` from the AUTHENTICATED actor.
 *   3. Claim the key atomically with `SET NX`.
 *   4. Won the claim  -> run the handler, then store its response for 24 hours.
 *      Lost the claim -> replay, conflict, or wait, depending on what is there.
 *
 * The actor comes from `request.actor`, which a T09 guard put there after
 * verifying a credential. Nothing in the body, query, or path contributes:
 * otherwise a caller could replay another actor's response by naming them.
 */

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
// Value imports, NOT : Reflector and IdempotencyStore are the
// injection tokens Nest resolves these constructor arguments by. Erasing either
// at compile time makes the module unresolvable at boot - the same failure this
// codebase already hit once in tenant.guard.ts.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@vcip/shared';
import type { Observable } from 'rxjs';
import { firstValueFrom, from } from 'rxjs';
import type { Actor, AuthenticatedRequest } from '../auth/auth-context.js';
import { InjectLogger } from '../logging/logging.tokens.js';
import type { Logger } from 'pino';
import type { IdempotentOptions } from './idempotency.decorator.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_KEY } from './idempotency.decorator.js';
import type { CompletedRecord } from './idempotency.store.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above
import {
  IdempotencyStore,
  IdempotencyUnavailableError,
  fingerprintRequest,
  idempotencyKey,
} from './idempotency.store.js';

/** How long a second concurrent caller waits for the first to finish. */
const WAIT_TIMEOUT_MS = 5_000;
const WAIT_POLL_MS = 25;

/**
 * The actor segment of the key.
 *
 * Derived entirely from the verified credential. Includes the tenant so that
 * two tenants can never collide even if principal ids somehow did, and the
 * principal so two agents in one tenant get separate records.
 *
 * An internal actor has no tenant and no principal; internal routes are not
 * among the six idempotent endpoints, so this is a wiring error rather than a
 * request the caller can provoke.
 */
function actorSegment(actor: Actor | undefined): string | null {
  if (actor === undefined) return null;
  switch (actor.kind) {
    case 'enterprise':
      return `enterprise-${actor.tenantId}-${actor.apiKeyId}`;
    case 'agent':
      return `agent-${actor.tenantId}-${actor.userId}`;
    case 'customer':
      return `customer-${actor.tenantId}-${actor.sessionId}`;
    case 'internal':
      return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: IdempotencyStore,
    @InjectLogger() private readonly log: Logger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Not marked: read endpoints and unprotected mutations pass straight
    // through. Idempotency is never imposed on a route that did not ask.
    if (options === undefined) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { method?: string; url?: string }>();

    const presentedKey = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (typeof presentedKey !== 'string' || presentedKey.trim().length === 0) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Idempotency-Key header is required for this operation.',
      });
    }
    if (presentedKey.length > 255) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Idempotency-Key header is too long.',
      });
    }

    const actor = actorSegment(request.actor);
    if (actor === null) {
      // No verified actor: the route is missing an authentication guard, or an
      // internal caller reached a tenant-scoped mutation. Either way this must
      // not fall back to an unscoped key shared across callers.
      throw new ServiceUnavailableException({
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Idempotency requires an authenticated actor.',
      });
    }

    const key = idempotencyKey(actor, options.endpoint, presentedKey);
    const fingerprint = fingerprintRequest(
      request.method ?? 'POST',
      options.endpoint,
      request.body,
    );

    try {
      const outcome = await this.store.claim(key, fingerprint);

      if (outcome.kind === 'existing') {
        return from(this.resolveExisting(key, fingerprint, outcome.record, options.endpoint));
      }

      // We hold the claim. Run the handler exactly once.
      return from(this.execute(key, fingerprint, next, context));
    } catch (error) {
      if (error instanceof IdempotencyUnavailableError) {
        // Fail closed. Running a protected mutation while unable to record that
        // it ran is precisely the duplicate this layer exists to prevent, so we
        // never pretend the guarantee held. There is no PostgreSQL fallback -
        // D13 forbids one, and the business invariants do not need it.
        this.log.error(
          { event: 'idempotency.unavailable', endpoint: options.endpoint },
          'idempotency store unavailable',
        );
        throw new ServiceUnavailableException({
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'Service temporarily unavailable.',
        });
      }
      throw error;
    }
  }

  /** Run the handler and record its response, or release the claim on failure. */
  private async execute(
    key: string,
    fingerprint: string,
    next: CallHandler,
    context: ExecutionContext,
  ): Promise<unknown> {
    let body: unknown;
    try {
      body = await firstValueFrom(next.handle());
    } catch (error) {
      // A failure is never cached. Dropping the claim lets the caller retry the
      // same key immediately rather than waiting out the claim TTL.
      await this.store.release(key);
      throw error;
    }

    const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const record: CompletedRecord = {
      state: 'completed',
      fingerprint,
      // The status Nest will send: 201 for POST unless the route overrides it.
      status: response?.statusCode ?? 200,
      body,
      completedAt: Date.now(),
    };

    try {
      await this.store.complete(key, record);
    } catch {
      // The handler already committed. Failing the response now would tell the
      // caller a successful operation failed, which is worse than losing replay
      // protection for one request. The claim expires on its own.
      this.log.warn(
        { event: 'idempotency.store_failed' },
        'response not recorded; replay unavailable for this key',
      );
    }

    return body;
  }

  /**
   * Someone else holds or held the key.
   *
   * Completed and matching  -> replay the original response.
   * Completed and differing -> conflict; a key is not reusable for a different
   *                            request, or a caller could overwrite one result
   *                            with another's.
   * Pending and matching    -> a concurrent duplicate. Wait for the winner and
   *                            return its response, so both callers see the
   *                            same thing and only one execution happened.
   * Pending and differing   -> conflict, immediately.
   */
  private async resolveExisting(
    key: string,
    fingerprint: string,
    record: { state: string; fingerprint: string },
    endpoint: string,
  ): Promise<unknown> {
    if (record.fingerprint !== fingerprint) throw this.conflict(endpoint);

    if (record.state === 'completed') {
      return (record as CompletedRecord).body;
    }

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      const current = await this.store.read(key);
      if (current === null) {
        // The winner failed and released the claim. Reporting a conflict is
        // honest: this caller does not know the outcome, and retrying is safe.
        throw this.conflict(endpoint);
      }
      if (current.state === 'completed') {
        if (current.fingerprint !== fingerprint) throw this.conflict(endpoint);
        return current.body;
      }
    }

    throw this.conflict(endpoint);
  }

  private conflict(endpoint: string): ConflictException {
    // The endpoint is logged; the key never is. An idempotency key is chosen by
    // the client and is frequently a session or order identifier.
    this.log.warn({ event: 'idempotency.conflict', endpoint }, 'idempotency key conflict');
    return new ConflictException({
      code: ErrorCode.CONFLICT,
      message: 'This Idempotency-Key was already used for a different request.',
    });
  }
}
