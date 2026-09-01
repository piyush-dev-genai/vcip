/**
 * Issuing room credentials (T24, contract §13).
 *
 * One operation, and its shape is the customer lifecycle's:
 *
 *   1. load the session, tenant-scoped in SQL
 *   2. assert it belongs to the authenticated tenant, and to this caller
 *   3. check the status and the assignment permit what was asked
 *   4. mint
 *
 * Step 4 is where it stops resembling the others: **there is no write.** No
 * row is updated, no `session_events` entry is appended, no billing row is
 * created, no presence changes, no idempotency record is kept, no LiveKit room
 * is created, and nothing joins anything. A token is a signed statement about
 * permissions the caller already had; issuing one changes no state, which is
 * why the endpoint is a GET and why asking twice is free.
 *
 * `session_events` in particular is left alone deliberately. The catalogue in
 * `@vcip/shared` is the audit vocabulary, and it has no name for this because
 * holding a credential is not a fact about the verification — joining the room
 * is, and T26 records that from the LiveKit webhook, where the participant
 * actually arrived rather than where they were handed a key.
 *
 * T25 owns the connection. Nothing here reaches the SFU.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, ErrorCode } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor, CustomerActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type { MediaTokenSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
// The one definition of the room name (R2). Imported rather than repeated: a
// second copy would be a second answer, and a token bound to a room the column
// does not name is a token for a room nobody else joins.
import { roomNameFor } from '../sessions/sessions.service.js';
import type { LiveKitConfig } from './livekit.config.js';
import { InjectLiveKitConfig } from './livekit.config.js';
import type { MediaTokenMinter } from './media-token.minter.js';
import { InjectMediaTokenMinter } from './media-token.minter.js';
import type { MediaRole } from './media-token.rules.js';
import { MediaRole as Role, decideMediaToken, mediaTokenExpiresAt } from './media-token.rules.js';

/**
 * `GET /v1/sessions/{id}/media-token` response body (contract §13).
 *
 * Exactly the three documented fields. The SFU URL is not among them and is not
 * added: the contract is the contract, and the deployment's LiveKit address is
 * configuration the client side resolves for itself in T25.
 */
export interface MediaTokenResult {
  readonly room_name: string;
  readonly token: string;
  /** ISO 8601. When the credential stops being usable to join. */
  readonly expires_at: string;
}

/** The two credentials that can reach this endpoint. */
export type MediaTokenActor = CustomerActor | AgentActor;

/** The clock, injected so expiry is assertable. */
export type MediaTokenClock = () => Date;

export const MEDIA_TOKEN_CLOCK = Symbol('MEDIA_TOKEN_CLOCK');

@Injectable()
export class MediaTokenService {
  private readonly now: MediaTokenClock;

  constructor(
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectMediaTokenMinter() private readonly minter: MediaTokenMinter,
    @InjectLiveKitConfig() private readonly config: LiveKitConfig,
    private readonly scope: TenantScope,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(MEDIA_TOKEN_CLOCK) now?: MediaTokenClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  /**
   * Issue a media token for one session.
   *
   * Reached by two routes — `/v1/sessions/:id/media-token` and
   * `/v1/agent/sessions/:id/media-token` — which is R1's duplicate pair. They
   * are two doors onto this one method, and the role comes from `actor.kind`
   * rather than from which door was used. An agent on the customer path still
   * gets an agent-scoped token; there is no URL a caller can pick to change
   * what their credential means.
   */
  async issue(actor: MediaTokenActor, sessionId: string): Promise<MediaTokenResult> {
    setContextSession(sessionId);

    // R8: a customer token is bound to one session. Checked before the read,
    // so a customer probing a sibling id never causes a query.
    this.scope.assertSessionAccess(actor, sessionId);

    const tenantId = this.scope.requireTenant(actor);
    // Tenant-scoped in SQL, and then `assertOwnership` on the result. The
    // predicate means another tenant's row is never loaded; the assertion means
    // "missing" and "not yours" are still decided in one place and answered
    // identically. A 403 here would confirm the id exists somewhere.
    const session = this.scope.assertOwnership(
      actor,
      await this.sessions.findForMediaToken(tenantId, sessionId),
    );

    const role = actor.kind === 'customer' ? Role.CUSTOMER : Role.AGENT;
    const userId = actor.kind === 'agent' ? actor.userId : null;

    const decision = decideMediaToken({
      role,
      status: session.status,
      assignedAgentId: session.agentId,
      requestingAgentId: userId,
    });

    if (decision.kind !== 'ALLOWED') {
      this.refuse(decision.kind, actor, session, role);
    }

    // The column, not the derivation. `roomNameFor` is the fallback for a row
    // written before R2 fixed the name at creation, so the token always names
    // the room the rest of the system will use.
    const roomName = session.roomName ?? roomNameFor(session.id);

    // One clock reading for both jobs: the TTL baked into the JWT and the
    // `expires_at` the client is told. Two readings could disagree, and the
    // client would refetch on the wrong schedule.
    const issuedAt = this.now();
    const expiresAt = mediaTokenExpiresAt(issuedAt, this.config.tokenTtlSeconds);

    const token = await this.minter.mint({
      role,
      roomName,
      sessionId: session.id,
      tenantId: session.tenantId,
      userId,
      ttlSeconds: this.config.tokenTtlSeconds,
    });

    this.logger.info(
      {
        event: 'media.token.issued',
        tenant_id: session.tenantId,
        session_id: session.id,
        role,
        // The agent's id, for audit. Never the token, and never a customer
        // identifier — the redaction list exists, and so does the habit.
        agent_id: userId,
        status: session.status,
        expires_at: expiresAt.toISOString(),
      },
      'issued a media token',
    );

    return {
      room_name: roomName,
      token,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Turn a refusal into the right error, and say why in the log.
   *
   * Both are 409s, and they are different 409s. `WRONG_STATE` is the session
   * being somewhere a token makes no sense from; `NOT_ASSIGNED` is an agent
   * reaching for a colleague's live call, which is the case worth being able to
   * find in a log afterwards.
   */
  private refuse(
    kind: 'WRONG_STATE' | 'NOT_ASSIGNED',
    actor: MediaTokenActor,
    session: MediaTokenSessionRow,
    role: MediaRole,
  ): never {
    const agentId = actor.kind === 'agent' ? actor.userId : null;

    if (kind === 'NOT_ASSIGNED') {
      this.logger.warn(
        {
          event: 'media.token.not_assigned',
          tenant_id: session.tenantId,
          session_id: session.id,
          agent_id: agentId,
          assigned_agent_id: session.agentId,
        },
        'media token refused: the session is another agent’s call',
      );
      throw new DomainError(
        ErrorCode.SESSION_ALREADY_ASSIGNED,
        'This session is assigned to another agent.',
      );
    }

    this.logger.info(
      {
        event: 'media.token.wrong_state',
        tenant_id: session.tenantId,
        session_id: session.id,
        role,
        agent_id: agentId,
        status: session.status,
      },
      'media token refused: the session is not in a state that permits one',
    );
    throw new DomainError(
      ErrorCode.SESSION_INVALID_STATE,
      'This session is not in a state that permits a media token.',
    );
  }
}
