/**
 * The customer session lifecycle.
 *
 * Six operations, all shaped the same way:
 *
 *   1. load the session by id
 *   2. assert it belongs to the authenticated tenant, and to this customer
 *   3. check the current status permits what was asked
 *   4. write PostgreSQL under a guard, appending the event in the same
 *      transaction
 *
 * Step 2 is `TenantScope`, not code here. Step 3 consults `@vcip/shared`'s
 * transition table rather than a local list of statuses, so the API and the
 * domain package cannot disagree about what is legal. Step 4 goes through the
 * repository's guarded update, so two concurrent requests cannot both win.
 *
 * What this service deliberately does not do:
 *
 *   - No billing rows. T35 owns those. `abort` reports the amount the shared
 *     table derives for the outcome, and writes nothing.
 *   - No queue *ordering* decisions. T15 added `queue`, but the Redis
 *     projection lives behind `QueueService`: this service commits the
 *     PostgreSQL transition and then asks the queue to reflect it. Redis is
 *     never consulted to decide whether a transition may happen (D1/D2).
 *   - No status assignment from a client. Every status this service writes is
 *     computed from the operation and the current row.
 */

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ConsentRequest,
  CreateSessionRequest,
  LocationRequest,
  PreflightRequest,
  SessionStatus,
} from '@vcip/shared';
import {
  DomainError,
  ErrorCode,
  SessionEventType,
  SessionStatus as Status,
  canTransition,
  getBillingForOutcome,
} from '@vcip/shared';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import type { Actor, CustomerActor, EnterpriseActor } from '../common/auth/auth-context.js';
// A value import, NOT `import type`: TenantScope is the injection token Nest
// resolves this constructor argument by, so erasing it at compile time makes
// the module unresolvable at boot.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TenantScope } from '../common/auth/tenant-scope.js';
import { signJwt } from '../common/auth/tokens.js';
import { CUSTOMER_ACTOR_CLAIM } from '../common/auth/customer-token.guard.js';
import type { GeoProvider } from '../common/geo/geo.provider.js';
import { InjectGeoProvider } from '../common/geo/geo.provider.js';
import { setContextSession } from '../common/logging/request-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { QueueService } from '../queue/queue.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above
import { TenantsService } from '../tenants/tenants.service.js';
import { evaluateLocation } from './location.js';
import { evaluatePreflight } from './preflight.js';
import type {
  SessionEventInput,
  SessionMutation,
  SessionRepository,
  SessionRow,
} from './session.repository.js';
import { InjectSessionRepository } from './session.repository.js';
import type { SessionView } from './session.view.js';
import { toSessionView } from './session.view.js';

/**
 * The room a session's media will use (R2).
 *
 * Deterministic and assigned at creation, so a customer can obtain a media
 * token while still queued without the room having to be created first.
 */
export function roomNameFor(sessionId: string): string {
  return `vcip_${sessionId}`;
}

export interface CreateSessionResult {
  readonly session_id: string;
  readonly status: string;
  readonly customer_token: string;
  readonly room_name: string;
}

export interface ConsentResult {
  readonly session_id: string;
  readonly consent_ok: boolean;
  readonly status: string;
}

export interface PreflightResultBody {
  readonly session_id: string;
  readonly preflight_ok: boolean;
  readonly status: string;
  readonly failed_checks?: readonly string[];
}

export interface LocationResultBody {
  readonly session_id: string;
  readonly geo_ok: boolean;
  readonly status: string;
  readonly failed_checks?: readonly string[];
}

/**
 * `POST /v1/sessions/{id}/queue` (contract §11).
 *
 * `queue_position` is nullable for one reason only: Redis could not answer. The
 * session is `QUEUED` either way — that is what `status` says, and it comes
 * from a committed PostgreSQL transaction.
 */
export interface QueueResult {
  readonly session_id: string;
  readonly status: string;
  readonly queue_position: number | null;
}

export interface AbortResult {
  readonly session_id: string;
  readonly status: string;
  /** Derived from `@vcip/shared`, not written. The row is T35's. */
  readonly bill_category: string | null;
  readonly bill_amount_paise: number;
}

const invalidState = (message: string): DomainError =>
  new DomainError(ErrorCode.SESSION_INVALID_STATE, message);

/**
 * Lost a guarded update.
 *
 * The session moved between the read and the write. `409` is the documented
 * answer (D17): the first valid terminal transition wins and the loser is told
 * so, rather than being allowed to overwrite it.
 */
const raceLost = (): DomainError =>
  invalidState('The session changed while this request was in flight.');

@Injectable()
export class SessionsService {
  constructor(
    @InjectSessionRepository() private readonly repository: SessionRepository,
    private readonly tenants: TenantsService,
    private readonly scope: TenantScope,
    @InjectAuthConfig() private readonly authConfig: AuthConfig,
    @InjectGeoProvider() private readonly geo: GeoProvider,
    // The Redis queue projection (T15). Consulted only after PostgreSQL has
    // answered, and never able to fail an operation PostgreSQL committed.
    private readonly queueProjection: QueueService,
  ) {}

  // ------------------------------------------------------------- create

  /**
   * `POST /v1/sessions` — enterprise, server-side only (D14).
   *
   * The tenant comes from the API key. `external_ref` is stored as given and is
   * not unique (D15); a retry is deduplicated by `Idempotency-Key`, which the
   * interceptor applies before this method is reached.
   */
  async create(actor: EnterpriseActor, input: CreateSessionRequest): Promise<CreateSessionResult> {
    // Generated here rather than by the database default, because `room_name`
    // is derived from it and both must land in the same INSERT.
    const sessionId = randomUUID();
    setContextSession(sessionId);

    const checklistTemplateId = await this.tenants.activeChecklistTemplateId(actor.tenantId);

    const row = await this.repository.create({
      id: sessionId,
      tenantId: actor.tenantId,
      externalRef: input.external_ref,
      language: input.language,
      roomName: roomNameFor(sessionId),
      // Pinned now so a later template change cannot rewrite what this
      // verification was checked against.
      checklistTemplateId,
      event: {
        type: SessionEventType.SESSION_CREATED,
        actorType: 'ENTERPRISE',
        actorId: null,
        // No `external_ref`: it is the enterprise's own identifier — a loan or
        // application number — and the event payload holds flags and metadata,
        // not business references.
        payload: { language: input.language },
      },
    });

    return {
      session_id: row.id,
      status: row.status,
      customer_token: this.issueCustomerToken(row.tenantId, row.id),
      // Non-null by construction: `create` always supplies it.
      room_name: row.roomName ?? roomNameFor(sessionId),
    };
  }

  /**
   * The short-lived, session-scoped customer credential (D14, R8).
   *
   * Two hours, stateless, bound to one tenant and one session. There is no
   * refresh endpoint and no revocation; the expiry is the whole story. Minted
   * with the same `signJwt` the guard verifies with, so a token this service
   * issues and a token that guard accepts cannot drift apart.
   */
  private issueCustomerToken(tenantId: string, sessionId: string): string {
    return signJwt(
      { act: CUSTOMER_ACTOR_CLAIM, tid: tenantId, sid: sessionId },
      {
        secret: this.authConfig.customerTokenSecret,
        ttlSeconds: this.authConfig.customerTokenTtlSeconds,
      },
    );
  }

  // ------------------------------------------------------------ consent

  async consent(
    actor: CustomerActor,
    sessionId: string,
    input: ConsentRequest,
  ): Promise<ConsentResult> {
    const session = await this.load(actor, sessionId);
    this.requireStatus(session, Status.CREATED, 'Consent can only be recorded before queueing.');

    // Already recorded, identically. Return the same answer rather than
    // appending a second event: a retried request must not double the audit
    // trail, and the business state is already what the caller is asking for.
    if (
      session.consentAt !== null &&
      session.consentOk === input.accepted &&
      session.consentVersion === input.consent_version
    ) {
      return {
        session_id: session.id,
        consent_ok: session.consentOk,
        status: session.status,
      };
    }

    // Already recorded, differently. Accepting this would leave the session
    // claiming a consent decision it did not receive, or silently revoke one it
    // did. Neither is a state a KYC audit should have to explain.
    if (session.consentAt !== null) {
      throw invalidState('Consent has already been recorded for this session.');
    }

    const updated = await this.mutate(session, {
      set: {
        consentOk: input.accepted,
        consentVersion: input.consent_version,
        consentAt: new Date(),
      },
      event: {
        type: input.accepted
          ? SessionEventType.CONSENT_ACCEPTED
          : SessionEventType.CONSENT_REJECTED,
        actorType: 'CUSTOMER',
        actorId: null,
        payload: { accepted: input.accepted, consent_version: input.consent_version },
      },
    });

    // The status is untouched. A refusal leaves the session `CREATED` with
    // `consent_ok = false`, which is not queue-eligible; there is no separate
    // "consent refused" state, and D19 keeps an unqueued session unbilled.
    return {
      session_id: updated.id,
      consent_ok: updated.consentOk,
      status: updated.status,
    };
  }

  // ---------------------------------------------------------- preflight

  /**
   * `POST /v1/sessions/{id}/preflight` — D11.
   *
   * The client sends measurements. The server compares them against this
   * tenant's thresholds and decides. A pass leaves the session `CREATED`; a
   * failure is terminal at `PREFLIGHT_FAILED`, billed nothing (invariant I5).
   */
  async preflight(
    actor: CustomerActor,
    sessionId: string,
    input: PreflightRequest,
  ): Promise<PreflightResultBody> {
    const session = await this.load(actor, sessionId);
    this.requireStatus(session, Status.CREATED, 'Preflight can only be submitted before queueing.');

    const config = await this.tenants.requireConfig(session.tenantId);
    const result = evaluatePreflight(input, config);

    const measurements = { ...input };
    const thresholds = {
      min_video_px: config.minVideoPx,
      min_mic_level: config.minMicLevel,
      max_rtt_ms: config.maxRttMs,
      min_downlink_kbps: config.minDownlinkKbps,
      min_lighting_score: config.minLightingScore,
      min_stability_score: config.minStabilityScore,
    };

    if (result.ok) {
      const updated = await this.mutate(session, {
        set: { preflightOk: true, preflightAt: new Date() },
        event: {
          type: SessionEventType.PREFLIGHT_PASSED,
          actorType: 'CUSTOMER',
          actorId: null,
          // Measurements and the thresholds they were judged against. Device
          // capability figures, not customer data — and recording the
          // thresholds makes the decision reconstructable after a tenant
          // reconfigures them.
          payload: { measurements, thresholds },
        },
      });
      return { session_id: updated.id, preflight_ok: true, status: updated.status };
    }

    const updated = await this.mutate(session, {
      to: Status.PREFLIGHT_FAILED,
      set: { preflightOk: false, preflightAt: new Date(), endedAt: new Date() },
      event: {
        type: SessionEventType.PREFLIGHT_FAILED,
        actorType: 'CUSTOMER',
        actorId: null,
        payload: { measurements, thresholds, failed_checks: result.failedChecks },
      },
    });

    return {
      session_id: updated.id,
      preflight_ok: false,
      status: updated.status,
      failed_checks: result.failedChecks,
    };
  }

  // ----------------------------------------------------------- location

  /**
   * `POST /v1/sessions/{id}/location`.
   *
   * `clientIp` is passed in from the controller, used to resolve a country, and
   * discarded. It is never stored and never logged: §39 classes a raw address
   * as sensitive, and only the two-letter country reaches PostgreSQL.
   *
   * The coordinates are validated by the schema, used for nothing else, and
   * likewise never persisted.
   */
  async location(
    actor: CustomerActor,
    sessionId: string,
    input: LocationRequest,
    clientIp: string | null,
  ): Promise<LocationResultBody> {
    const session = await this.load(actor, sessionId);
    this.requireStatus(session, Status.CREATED, 'Location can only be submitted before queueing.');

    const config = await this.tenants.requireConfig(session.tenantId);
    const geo = await this.geo.resolve(clientIp);
    const result = evaluateLocation({ accuracyM: input.accuracy_m }, geo, config);

    const persist: SessionMutation = {
      geoOk: result.persist.geoOk,
      gpsAccuracyM: result.persist.gpsAccuracyM,
      geoCheckedAt: new Date(),
      ipCountry: result.persist.ipCountry,
    };

    // No coordinates in the payload either. The event records the decision and
    // the inputs to the decision, which the accuracy and the country are; the
    // position itself is not one of them.
    const payload = {
      gps_accuracy_m: result.persist.gpsAccuracyM,
      gps_max_accuracy_m: config.gpsMaxAccuracyM,
      ip_country: result.persist.ipCountry,
    };

    if (result.ok) {
      const updated = await this.mutate(session, {
        set: persist,
        event: {
          type: SessionEventType.LOCATION_PASSED,
          actorType: 'CUSTOMER',
          actorId: null,
          payload,
        },
      });
      return { session_id: updated.id, geo_ok: true, status: updated.status };
    }

    const updated = await this.mutate(session, {
      to: Status.PREFLIGHT_FAILED,
      set: { ...persist, endedAt: new Date() },
      event: {
        type: SessionEventType.LOCATION_FAILED,
        actorType: 'CUSTOMER',
        actorId: null,
        payload: { ...payload, failed_checks: result.failedChecks },
      },
    });

    return {
      session_id: updated.id,
      geo_ok: false,
      status: updated.status,
      failed_checks: result.failedChecks,
    };
  }

  // -------------------------------------------------------------- queue

  /**
   * `POST /v1/sessions/{id}/queue` — the customer joins the queue (T15).
   *
   * The ordering is the whole point, and it is not negotiable:
   *
   *   BEGIN; update to QUEUED; append SESSION_QUEUED; COMMIT
   *   then ZADD
   *
   * Redis is touched only after the transaction commits. A `ZADD` inside the
   * transaction would attach a write that cannot be rolled back to one that
   * can, and a rolled-back queue transition would leave a phantom member that
   * an agent could claim.
   *
   * The converse — committed in PostgreSQL, absent from Redis — is *expected*
   * and safe. `enqueue` never throws, the response reports
   * `queue_position: null`, and the next position lookup reconciles it.
   *
   * An already-`QUEUED` session is not an error. It returns `200` with the
   * existing state, appends no second event, and leaves `queued_at` untouched.
   * That is what makes a retry safe once T11's 24-hour idempotency record has
   * expired, and it matches how `consent` already treats a repeated identical
   * submission. It is a deliberate departure from `abort`, which does answer a
   * wrong state with `409`: aborting twice is a second attempt at a terminal
   * transition, whereas queueing twice is a request for a state the session is
   * already in.
   */
  async queue(actor: CustomerActor, sessionId: string): Promise<QueueResult> {
    const session = await this.load(actor, sessionId);

    // Already queued. Reconcile Redis if it is missing, and report.
    if (session.status === Status.QUEUED) {
      return {
        session_id: session.id,
        status: session.status,
        queue_position: await this.queueProjection.positionFor(session),
      };
    }

    this.requireStatus(session, Status.CREATED, 'This session cannot join the queue.');

    // The three gates, checked against the row rather than against anything the
    // client sent. `422`, not `409`: the request is well formed and the session
    // exists, but a business precondition is unmet (contract §11).
    if (!session.consentOk || !session.preflightOk || !session.geoOk) {
      throw new DomainError(
        ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE,
        'Consent, preflight and location validation are required.',
      );
    }

    const queuedAt = new Date();
    const updated = await this.mutate(session, {
      to: Status.QUEUED,
      set: { queuedAt },
      event: {
        type: SessionEventType.SESSION_QUEUED,
        actorType: 'CUSTOMER',
        actorId: null,
        // Flags and metadata only (§15). The language is the queue partition,
        // which is what makes this event explain the placement it caused.
        payload: { language: session.language },
      },
    });

    // Committed. From here nothing may fail the operation.
    const position = await this.queueProjection.enqueue(updated);

    return {
      session_id: updated.id,
      status: updated.status,
      queue_position: position,
    };
  }

  // ---------------------------------------------------------------- get

  /**
   * `GET /v1/sessions/{id}` — polling fallback for the WebSocket feed.
   *
   * Readable by the customer holding this session's token, or by an agent of
   * the same tenant. PostgreSQL is the answer; Redis contributes nothing, so
   * `queue_position` stays null until T15 exists rather than being invented.
   */
  async get(actor: Actor, sessionId: string): Promise<SessionView> {
    const session = await this.load(actor, sessionId);
    // The queue position is the one field PostgreSQL cannot answer. Asking here
    // is also where a missing member gets reconciled: the moment someone wants
    // to know where a session sits is the moment it is worth making sure it is
    // actually there. Never throws, and never reports a position for a session
    // PostgreSQL does not call `QUEUED`.
    return toSessionView(session, await this.queueProjection.positionFor(session));
  }

  // -------------------------------------------------------------- abort

  /**
   * `POST /v1/sessions/{id}/abort` — customer-initiated termination.
   *
   * Three source states, from the approved product design:
   *
   *   QUEUED  -> DROPPED_QUEUED
   *   OFFERED -> DROPPED_QUEUED    (R15: an offered session aborts like a queued one)
   *   IN_CALL -> ABORTED           (R4: customer-initiated is ABORTED, not a drop)
   *
   * Everything else is a `409`. `CREATED` in particular: a session that never
   * queued stays `CREATED` and unbilled (D19), so there is nothing to abort.
   *
   * The transition goes through the same guarded update as every other
   * mutation, which is what makes D17 hold — if an agent's verdict commits
   * first, this loses and the customer is told, rather than a terminal status
   * being overwritten (invariant I11).
   */
  async abort(actor: CustomerActor, sessionId: string): Promise<AbortResult> {
    const session = await this.load(actor, sessionId);

    const target = ABORT_TARGET[session.status];
    if (target === undefined) {
      throw invalidState('This session cannot be aborted from its current state.');
    }

    const updated = await this.mutate(session, {
      to: target,
      set: { endedAt: new Date() },
      event: {
        type: SessionEventType.SESSION_ABORTED,
        actorType: 'CUSTOMER',
        actorId: null,
        payload: { from: session.status, to: target, reason: 'CUSTOMER_ABORT' },
      },
    });

    // Derived, never accepted from the caller and never written here. The
    // ledger row is T35's, inside the billing transaction; this only reports
    // what the shared table says the outcome is worth.
    const billing = getBillingForOutcome(target);

    return {
      session_id: updated.id,
      status: updated.status,
      bill_category: billing.billable ? billing.category : null,
      bill_amount_paise: billing.amountPaise,
    };
  }

  // ----------------------------------------------------------- internals

  /**
   * Load a session and prove the caller may touch it.
   *
   * Two checks, both from T09 and neither reimplemented here:
   *
   *   - `assertOwnership` — the row belongs to the authenticated tenant. A row
   *     from another tenant is a 404, identical to a row that does not exist,
   *     so an id cannot be probed across tenants (invariant I8).
   *   - `assertSessionAccess` — a customer token is bound to one session (R8),
   *     so it cannot read a sibling session in its own tenant.
   */
  private async load(actor: Actor, sessionId: string): Promise<SessionRow> {
    setContextSession(sessionId);
    this.scope.assertSessionAccess(actor, sessionId);
    const row = await this.repository.findById(sessionId);
    return this.scope.assertOwnership(actor, row);
  }

  /** Reject an operation the current status does not allow. */
  private requireStatus(session: SessionRow, expected: SessionStatus, message: string): void {
    if (session.status !== expected) throw invalidState(message);
  }

  /**
   * Apply a mutation under the session's observed status and version.
   *
   * When `to` is given the transition is checked against `@vcip/shared` first.
   * That check is not redundant with the guard: the guard proves nothing else
   * moved the row, while `canTransition` proves the edge exists at all. A bug
   * here that tried `CREATED -> APPROVED` would pass the guard happily.
   */
  private async mutate(
    session: SessionRow,
    change: { to?: SessionStatus; set: SessionMutation; event: SessionEventInput },
  ): Promise<SessionRow> {
    if (change.to !== undefined && !canTransition(session.status, change.to)) {
      /* c8 ignore next */
      throw invalidState('That transition is not legal from the current state.');
    }

    const updated = await this.repository.update({
      sessionId: session.id,
      tenantId: session.tenantId,
      expectedStatus: session.status,
      expectedVersion: session.version,
      set: change.to === undefined ? change.set : { ...change.set, status: change.to },
      event: change.event,
    });

    if (updated === null) throw raceLost();
    return updated;
  }
}

/**
 * Where a customer abort takes each abortable status.
 *
 * A lookup rather than a chain of ifs, so the set of abortable states is
 * readable in one place and adding one is a deliberate edit. Every entry is an
 * edge that already exists in `SESSION_TRANSITIONS`.
 */
const ABORT_TARGET: Partial<Record<SessionStatus, SessionStatus>> = Object.freeze({
  [Status.QUEUED]: Status.DROPPED_QUEUED,
  [Status.OFFERED]: Status.DROPPED_QUEUED,
  [Status.IN_CALL]: Status.ABORTED,
});
