/**
 * Agent presence.
 *
 * PostgreSQL says who an agent is and what they are configured for; Redis says
 * whether they are here right now (D1/D2). Nothing in this file writes
 * availability to PostgreSQL, and `agent_profiles` has no column for it — live
 * presence is ephemeral by construction, not by convention.
 *
 * Three rules are enforced here rather than documented:
 *
 *   - **The agent id comes from the JWT.** Every method takes an `AgentActor`
 *     that a guard verified, never an id from a body or a path. There is no
 *     signature in this file that would let agent A address agent B's
 *     presence, which is what makes the isolation structural rather than a
 *     check that could be deleted.
 *   - **Languages come from `agent_profiles`.** The availability request has no
 *     language field, and the value written to Redis is read from PostgreSQL on
 *     every AVAILABLE. A stale snapshot in Redis is refreshed by the next
 *     availability call; a client-chosen one would never be right.
 *   - **UNAVAILABLE deletes the key.** Expiry already means "not present"
 *     (§10), so reusing absence for the deliberate case gives T17 one rule
 *     instead of two: an agent is live and eligible exactly when the key exists
 *     and its status is `AVAILABLE`. The alternative — a key with
 *     `status=UNAVAILABLE` and a TTL — would be a second encoding of the same
 *     fact, and every future reader would have to handle both.
 *
 * `BUSY` appears in this file only as `markBusy`/`markAvailable`, which no HTTP
 * route reaches. T18's claim and T19's accept are the intended callers.
 */

import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentPresence } from '@vcip/shared';
import { AgentPresence as Presence, ErrorCode } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { AgentRepository } from './agent.repository.js';
import { InjectAgentRepository } from './agent.repository.js';
import type { PresenceRepository } from './presence.repository.js';
import { InjectPresenceRepository } from './presence.repository.js';

/** `POST /v1/agent/availability` response body. */
export interface AvailabilityResult {
  readonly agent_id: string;
  readonly status: AgentPresence;
}

/**
 * `POST /v1/agent/heartbeat` response body.
 *
 * `last_seen` is null when there was no presence to refresh. The TTL itself is
 * deliberately absent: it is an implementation detail of the liveness
 * mechanism, and a client that could read it would start making decisions with
 * it.
 */
export interface HeartbeatResult {
  readonly agent_id: string;
  readonly status: AgentPresence;
  readonly last_seen: string | null;
}

/** The clock, injected so TTL and `last_seen` behaviour are testable. */
export type Clock = () => Date;

/**
 * Optional override for the clock.
 *
 * A token rather than a bare optional argument: Nest resolves constructor
 * parameters by their `design:paramtypes` metadata, and a plain function type
 * erases to `Function`, which it then cannot find and refuses to boot on. That
 * failure is invisible to every test that constructs the service by hand —
 * `agents.module.spec.ts` exists because it caught exactly this.
 */
export const PRESENCE_CLOCK = Symbol('PRESENCE_CLOCK');

@Injectable()
export class PresenceService {
  private readonly now: Clock;

  constructor(
    @InjectPresenceRepository() private readonly presence: PresenceRepository,
    @InjectAgentRepository() private readonly agents: AgentRepository,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(PRESENCE_CLOCK) now?: Clock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  /**
   * Set the agent's own availability.
   *
   * Both branches require an agent profile. A `TENANT_ADMIN` holds a valid JWT
   * and passes `AgentJwtGuard`, but has no `agent_profiles` row and is not
   * someone the queue may hand a customer to — so this is authenticated but not
   * permitted, which is a 403 rather than a 401.
   *
   * Repeating the same status is safe by construction: `HSET` overwrites and
   * `DEL` on an absent key is a no-op. Neither branch creates an event, a
   * session, or a row, so there is nothing for an idempotency key to protect.
   */
  async setAvailability(actor: AgentActor, status: AgentPresence): Promise<AvailabilityResult> {
    // Never trusts the token's tenant on its own: the profile lookup is scoped
    // by `(user_id, tenant_id)`, so a token naming a tenant the user does not
    // belong to finds nothing and is refused (I8).
    const profile = await this.agents.findProfile(actor.userId, actor.tenantId);
    if (profile === null) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'This user is not an agent.',
      });
    }

    if (status === Presence.AVAILABLE) {
      await this.presence.set({
        agentId: actor.userId,
        tenantId: actor.tenantId,
        status: Presence.AVAILABLE,
        // From PostgreSQL, on every call. The request has no say.
        languages: profile.languages,
        lastSeen: this.now(),
      });
    } else {
      await this.presence.remove(actor.userId);
    }

    // Safe fields only: no email, no token, no password, no languages. An
    // availability change is worth a line; a heartbeat is not, which is why
    // nothing logs on that path.
    this.logger.info(
      {
        event: 'agent.availability.set',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        status,
      },
      'agent availability changed',
    );

    return { agent_id: actor.userId, status };
  }

  /**
   * Refresh the agent's presence.
   *
   * Redis only. No PostgreSQL read, no write, no session event — this is the
   * one endpoint an agent calls every few seconds, and it must stay a single
   * round trip that cannot alter business state even by accident.
   *
   * When there is no presence the answer is `UNAVAILABLE` with a null
   * `last_seen`, and no key is created. That is what keeps a heartbeat from
   * resurrecting an agent who went unavailable, and what keeps a client from
   * reaching availability through a route that does not accept a status.
   */
  async heartbeat(actor: AgentActor): Promise<HeartbeatResult> {
    const touched = await this.presence.touch(actor.userId, this.now());

    if (touched === null) {
      return { agent_id: actor.userId, status: Presence.UNAVAILABLE, last_seen: null };
    }

    // The status is whatever the presence already held — `AVAILABLE`, or
    // `BUSY` if T18 has claimed for this agent. The heartbeat did not choose
    // it and cannot change it.
    return { agent_id: actor.userId, status: touched.status, last_seen: touched.lastSeen };
  }

  /**
   * Mark an agent busy. Internal — no route reaches this.
   *
   * The mechanism R5 describes, provided now so T18's claim has something to
   * call at the approved point. T16 never invokes it: nothing here assigns a
   * session, so nothing here can know when an agent became busy.
   *
   * Returns false when the agent had no presence to change. The caller decides
   * what that means; this method will not create a presence to make the answer
   * tidy, because a claim succeeding against an agent who is not live is a
   * question for T18 and PostgreSQL remains authoritative for the assignment
   * either way (D1).
   */
  async markBusy(agentId: string): Promise<boolean> {
    return this.presence.setStatus(agentId, Presence.BUSY);
  }

  /** Clear busy, returning the agent to the available pool. Internal. */
  async markAvailable(agentId: string): Promise<boolean> {
    return this.presence.setStatus(agentId, Presence.AVAILABLE);
  }
}
