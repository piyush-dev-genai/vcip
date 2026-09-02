/**
 * The agent's read-only view of the queue (T17).
 *
 * The shape of the read is the design, and it is deliberately asymmetric:
 *
 *   1. **Redis says which sessions to consider, and in what order.** The head
 *      of each of the agent's language queues, bounded, merged by score.
 *   2. **PostgreSQL says which of those are real.** One statement confirms
 *      tenant and `status = QUEUED`; anything it does not return is dropped.
 *
 * Neither half is sufficient alone, and neither substitutes for the other.
 * Redis membership is not eligibility — T15 permits a member to outlive the
 * status that put it there, so a session claimed, aborted, or dropped can still
 * be in the ZSET, and returning it would show an agent work that is gone.
 * PostgreSQL is not the candidate set either: scanning a tenant's sessions and
 * sorting by `queued_at` would be a full-table read on a request path and would
 * quietly make the queue projection decorative.
 *
 * **Nothing here writes business state.** No claim, no offer, no `BUSY`, no
 * session event, no billing row, no version bump.
 *
 * It does write one thing, and it is not business state: it **prunes the
 * candidates PostgreSQL disowned**. T17 originally wrote nothing at all, on the
 * reasoning that a GET should not carry a Redis write. That was wrong in one
 * direction, and the failure was real — nothing anywhere removed a member when
 * a session left `QUEUED`, so dead members accumulated at the head of the queue
 * until a bounded read returned nothing but corpses and an agent saw an empty
 * queue with a customer waiting in it. Confirming candidates against PostgreSQL
 * and then discarding the answer left the projection to rot.
 *
 * The other direction is unchanged: a session `QUEUED` in PostgreSQL but absent
 * from Redis is still not re-added here. That heal is a `ZADD` with a score
 * this read does not own, and T15 does it inside `QueueService.positionFor` on
 * the customer's own status poll.
 *
 * **The agent is whoever the JWT says.** Every method takes an `AgentActor` a
 * guard verified. There is no parameter here — and no query parameter on the
 * route — through which a caller could name another agent, another tenant, or
 * another language.
 */

import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import type { QueueCandidate, QueueRepository } from '../queue/queue.repository.js';
import { InjectQueueRepository } from '../queue/queue.repository.js';
import type { QueuedSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { InjectSessionRepository } from '../sessions/session.repository.js';
import type { AgentRepository } from './agent.repository.js';
import { InjectAgentRepository } from './agent.repository.js';
import {
  AGENT_QUEUE_LIMIT,
  eligibleLanguages,
  mergeCandidates,
  speaks,
  waitSeconds,
} from './agent-queue.rules.js';

/**
 * One row of the agent queue, exactly as `docs/05-api-contract.md` §16 defines
 * it.
 *
 * Five fields and no sixth. There is no `external_ref`, no customer identifier,
 * no consent or geo state, and no queue position — §16 defines none, and a
 * per-language Redis rank is not a merged-list position, so inventing one would
 * be inventing a wrong number.
 *
 * `priority` is the stored column. It is reported because the contract reports
 * it, and it does **not** order this list: the MVP queue is FIFO on
 * `queued_at`, which is the ZSET score.
 */
export interface QueuedSessionView {
  readonly session_id: string;
  readonly language: string;
  readonly priority: number;
  readonly queued_at: string;
  readonly wait_seconds: number;
}

/** `GET /v1/agent/queue` response body. */
export interface AgentQueueResult {
  readonly sessions: readonly QueuedSessionView[];
}

/**
 * The clock, injected so `wait_seconds` is testable.
 *
 * Named distinctly from `PresenceService`'s `Clock`: both are re-exported
 * through this module's barrel, and two identical names there is an ambiguous
 * export rather than a convenience.
 */
export type QueueClock = () => Date;

/**
 * Optional override for the clock.
 *
 * A token, not a bare optional parameter, for the reason `PRESENCE_CLOCK`
 * documents: a function type erases to `Function` in `design:paramtypes` and
 * Nest cannot resolve it, which fails at boot rather than in a unit test.
 */
export const AGENT_QUEUE_CLOCK = Symbol('AGENT_QUEUE_CLOCK');

@Injectable()
export class AgentQueueService {
  private readonly now: QueueClock;

  constructor(
    @InjectQueueRepository() private readonly queue: QueueRepository,
    @InjectSessionRepository() private readonly sessions: SessionRepository,
    @InjectAgentRepository() private readonly agents: AgentRepository,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(AGENT_QUEUE_CLOCK) now?: QueueClock,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  /**
   * The queued sessions this agent could work, oldest first.
   *
   * Reading the queue does not require the agent to be AVAILABLE. §16 names
   * only the JWT, presence is not authorisation, and an agent deciding whether
   * to go available is exactly the person who wants to see what is waiting.
   * Nothing here reads or writes presence.
   */
  async view(actor: AgentActor): Promise<AgentQueueResult> {
    // Scoped by `(user_id, tenant_id)`, so a token naming a tenant this user
    // does not belong to finds nothing (I8). A `TENANT_ADMIN` holds a valid
    // agent JWT but has no profile, and is not someone the queue is for — the
    // same 403 `setAvailability` gives, rather than an empty list, which would
    // read as "no work waiting".
    const profile = await this.agents.findProfile(actor.userId, actor.tenantId);
    if (profile === null) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'This user is not an agent.',
      });
    }

    const languages = eligibleLanguages(profile.languages);
    if (languages.length === 0) {
      this.log(actor, languages, 0, 0);
      return { sessions: [] };
    }

    const first = await this.read(actor, languages);

    // A page made entirely of members PostgreSQL has disowned is not an empty
    // queue — it is a queue whose head is dead, hiding whatever is behind it.
    // Pruning is what makes the next read see past them, and doing it here
    // rather than on some later request is the difference between an agent
    // seeing a waiting customer now and seeing them after a refresh.
    //
    // Once. The prune removed a whole page of corpses, so a second read is
    // either the live head or a page just as dead — and a request path is not
    // where an unbounded repair loop belongs. Successive requests continue the
    // repair a page at a time.
    const page =
      first.stale > 0 && first.merged.length > first.sessions.length
        ? await this.read(actor, languages)
        : first;

    this.log(actor, languages, page.merged.length, page.sessions.length, first.stale);
    return { sessions: page.sessions };
  }

  /**
   * One pass: read the candidates, confirm them, and drop what is provably dead.
   *
   * The confirmation was always here — T15's projection permits a member to
   * outlive its status, so nothing may be shown without a row behind it. What
   * is new is acting on the answer: an id in a tenant's queue that
   * `findQueued` did not return is a member the database has disowned, because
   * a member is only ever added after the row it names has committed.
   */
  private async read(
    actor: AgentActor,
    languages: readonly string[],
  ): Promise<{
    readonly merged: readonly QueueCandidate[];
    readonly sessions: readonly QueuedSessionView[];
    readonly stale: number;
  }> {
    // One bounded read per language, concurrently. `AGENT_QUEUE_LIMIT` from
    // each rather than a share of it: the merged top-N may come entirely from
    // one queue, so a smaller per-queue bound could drop a session that belongs
    // in the result.
    const lists = await Promise.all(
      languages.map((language) => this.queue.range(actor.tenantId, language, AGENT_QUEUE_LIMIT)),
    );

    const merged = mergeCandidates(lists).slice(0, AGENT_QUEUE_LIMIT);
    if (merged.length === 0) return { merged, sessions: [], stale: 0 };

    // One statement for the whole candidate set. Tenant and status are both
    // predicates inside it, so a stale member or a foreign id yields no row.
    const rows = await this.sessions.findQueued(
      actor.tenantId,
      merged.map((candidate) => candidate.sessionId),
    );
    const byId = new Map<string, QueuedSessionRow>(rows.map((row) => [row.id, row]));

    const stale = await this.pruneStale(actor, languages, lists, byId);

    const nowMs = this.now().getTime();
    return { merged, sessions: this.project(merged, byId, languages, nowMs), stale };
  }

  /**
   * Remove the candidates PostgreSQL did not confirm.
   *
   * Per language, because a member lives in one language's key and that is the
   * key it has to be removed from. Only ids with **no** confirmed row are
   * touched: a row that came back is a live session, and a queue view is not
   * the place to start second-guessing which key it belongs in.
   *
   * Never fails the request. This is a repair, and an agent asking what is
   * waiting should get the answer even when the repair cannot be written —
   * the confirmation against PostgreSQL already makes the response correct.
   */
  private async pruneStale(
    actor: AgentActor,
    languages: readonly string[],
    lists: readonly (readonly QueueCandidate[])[],
    byId: ReadonlyMap<string, QueuedSessionRow>,
  ): Promise<number> {
    let removed = 0;

    await Promise.all(
      languages.map(async (language, index) => {
        const dead = (lists[index] ?? [])
          .map((candidate) => candidate.sessionId)
          .filter((sessionId) => !byId.has(sessionId));
        if (dead.length === 0) return;

        try {
          removed += await this.queue.prune(actor.tenantId, language, dead);
        } catch (error) {
          this.logger.warn(
            {
              event: 'agent.queue.prune_failed',
              tenant_id: actor.tenantId,
              language,
              stale_count: dead.length,
              err: error,
            },
            'could not prune stale queue members; the view is still correct',
          );
        }
      }),
    );

    return removed;
  }

  /**
   * Turn confirmed rows back into the Redis order.
   *
   * Iterating `merged` rather than `rows` is the load-bearing detail: the
   * result keeps the queue projection's ordering, and PostgreSQL contributes
   * only the facts about each session. A loop over the database rows would
   * silently order by whatever the planner returned.
   */
  private project(
    merged: readonly QueueCandidate[],
    byId: ReadonlyMap<string, QueuedSessionRow>,
    languages: readonly string[],
    nowMs: number,
  ): readonly QueuedSessionView[] {
    const out: QueuedSessionView[] = [];
    for (const candidate of merged) {
      const row = byId.get(candidate.sessionId);
      // Absent: stale in Redis, another tenant's, or no longer QUEUED. All
      // three are the same answer — not eligible — and none of them is an
      // error, so none of them is reported to the agent.
      if (row === undefined) continue;
      // A second language check, against what PostgreSQL stored rather than
      // against the key the member was found under. The two agree in normal
      // operation; when they do not, the database is right.
      if (!speaks(languages, row.language)) continue;

      out.push({
        session_id: row.id,
        language: row.language,
        priority: row.priority,
        queued_at: row.queuedAt.toISOString(),
        wait_seconds: waitSeconds(row.queuedAt, nowMs),
      });
    }
    return Object.freeze(out);
  }

  /**
   * One line per view.
   *
   * Identifiers and counts only — no session ids, no external refs, no customer
   * data, and nothing from the credential. `candidate_count` beside
   * `returned_count` is what makes a queue drifting out of sync with
   * PostgreSQL visible in operations rather than only in a bug report.
   */
  private log(
    actor: AgentActor,
    languages: readonly string[],
    candidates: number,
    returned: number,
    pruned = 0,
  ): void {
    this.logger.info(
      {
        event: 'agent.queue.viewed',
        agent_id: actor.userId,
        tenant_id: actor.tenantId,
        languages,
        candidate_count: candidates,
        returned_count: returned,
        // A steadily non-zero count here means something upstream is leaving
        // members behind faster than the head of the queue moves.
        pruned_count: pruned,
      },
      'agent queue viewed',
    );
  }
}
