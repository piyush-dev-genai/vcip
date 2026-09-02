/**
 * The pinned checklist: served (T33, D8), then answered (T34).
 *
 * Three operations, and one template read behind all of them — which is the
 * point. The list the agent was shown, the list their submission is checked
 * against, and the list written to `session_checklist_items` all come from the
 * same query against the same pinned row, so they cannot be three lists.
 *
 *   - `read` — what was this agent asked. `GET .../checklist`, and the shape of
 *     every session-scoped agent read here: load tenant-scoped, assert
 *     ownership, assert assignment, validate what the database handed back.
 *   - `validate` — did they answer it. No lock, no write, called before the
 *     verdict's transaction opens.
 *   - `record` — write the answers, inside the transaction the verdict owns.
 *
 * **`read` never writes.** No row is updated and no `session_events` entry is
 * appended: reading what you are about to attest to is not a fact about the
 * verification. Ticking the boxes is, and it is recorded at the verdict (T35,
 * schema §45), where the answers exist and where they commit or roll back with
 * the decision they belong to.
 *
 * **It never invents a checklist.** Both template failure modes answer 500
 * rather than something usable, which is the unusual choice and the deliberate
 * one. An empty or shortened list would let a verdict be submitted against
 * fewer required items than the tenant configured — a verification claiming to
 * have checked something it never displayed. A 500 stops the agent, which is
 * recoverable; a quiet approval is not.
 */

import { Injectable } from '@nestjs/common';
import type {
  ChecklistAnswer,
  ChecklistResult,
  ResolvedChecklistItem,
  SubmissionDecision,
} from '@vcip/shared';
import { DomainError, ErrorCode, validateSubmission } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
import type { DbExecutor } from '../common/events/session-event.writer.js';
import type { ChecklistRepository, ChecklistSessionRow } from './checklist.repository.js';
import { InjectChecklistRepository } from './checklist.repository.js';
import { decideChecklistRead, parseTemplateItems } from './checklist.rules.js';

@Injectable()
export class ChecklistService {
  constructor(
    @InjectChecklistRepository() private readonly repository: ChecklistRepository,
    private readonly scope: TenantScope,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async read(actor: AgentActor, sessionId: string): Promise<ChecklistResult> {
    setContextSession(sessionId);

    const tenantId = this.scope.requireTenant(actor);
    // Tenant-scoped in SQL, then `assertOwnership` on the result: the predicate
    // means another tenant's row is never loaded, the assertion means "missing"
    // and "not yours" are answered identically. A 403 for the second would
    // confirm the id exists somewhere.
    const row = this.scope.assertOwnership(
      actor,
      await this.repository.findForSession(tenantId, sessionId),
    );

    const decision = decideChecklistRead({
      assignedAgentId: row.assignedAgentId,
      requestingAgentId: actor.userId,
    });

    if (decision.kind === 'NOT_ASSIGNED') this.refuse(actor, row);

    return {
      session_id: row.sessionId,
      template_id: this.requireTemplateId(row),
      version: this.requireVersion(row),
      items: this.requireItems(row),
    };
  }

  /**
   * Check a submitted checklist against the template this session is pinned to
   * (T34, schema §45's "validate required checklist items are checked").
   *
   * Split from `record` below, and called *before* the verdict's transaction
   * opens rather than inside it. Nothing here takes a lock or writes anything,
   * so doing it first means a rejected checklist costs the caller a 422 instead
   * of an opened, rolled-back transaction on the row that is also being billed.
   *
   * The template is read through the same query the agent's `GET` used, so the
   * list they were shown and the list this checks against are one list.
   */
  async validate(input: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly answers: readonly ChecklistAnswer[];
    /** True for `APPROVED` only. `SubmissionOptions` says why. */
    readonly requireAllChecked: boolean;
  }): Promise<readonly ResolvedChecklistItem[]> {
    const row = await this.repository.findForSession(input.tenantId, input.sessionId);

    if (row === null) {
      // The caller has already established the session is theirs — the verdict's
      // guarded UPDATE does that — so reaching this means the row vanished
      // between two statements, which is not a thing that happens.
      /* c8 ignore next 4 */
      throw new DomainError(ErrorCode.NOT_FOUND, 'Resource not found.');
    }

    this.requireTemplateId(row);
    const template = this.requireItems(row);

    const decision = validateSubmission(template, input.answers, {
      requireAllChecked: input.requireAllChecked,
    });

    if (decision.kind !== 'ACCEPTED') this.refuseSubmission(row, decision);

    return decision.items;
  }

  /**
   * Write the answers, inside the caller's transaction (T34).
   *
   * `executor` is the verdict's transaction. The answers commit with the
   * verdict or not at all: a checklist recorded beside a verdict that rolled
   * back would be an attestation for a decision that was never made.
   */
  async record(
    sessionId: string,
    items: readonly ResolvedChecklistItem[],
    executor: DbExecutor,
  ): Promise<void> {
    await this.repository.saveAnswers(sessionId, items, executor);
  }

  /**
   * Turn a refused submission into the right error, and say which items.
   *
   * 422 throughout: every one of these is a well-formed request that a business
   * rule refused, and the agent's portal can act on each — re-fetch the
   * checklist, or tick what is missing.
   *
   * The keys are named in the message because they are the tenant's own
   * configuration and the agent is looking at them on screen. Nothing about the
   * customer is in them.
   */
  private refuseSubmission(row: ChecklistSessionRow, decision: SubmissionDecision): never {
    const detail: Record<string, string> = {
      UNKNOWN_ITEMS: 'The checklist contains items this session was not asked.',
      MISSING_ITEMS: 'The checklist does not answer every item.',
      REQUIRED_UNCHECKED: 'Every required checklist item must be checked to approve.',
      /* c8 ignore next -- ACCEPTED never reaches here */
      ACCEPTED: '',
    };

    /* c8 ignore next 3 -- narrowing; ACCEPTED is filtered out by the caller */
    const keys = decision.kind === 'ACCEPTED' ? [] : decision.keys;

    this.logger.warn(
      {
        event: 'checklist.submission_refused',
        tenant_id: row.tenantId,
        session_id: row.sessionId,
        reason: decision.kind,
        item_keys: keys,
      },
      'a submitted checklist did not match the pinned template',
    );

    throw new DomainError(
      ErrorCode.UNPROCESSABLE,
      `${detail[decision.kind] ?? 'The checklist was refused.'} (${keys.join(', ')})`,
    );
  }

  /**
   * An agent reaching for a session they do not hold.
   *
   * 403 rather than the media token's 409. The two refusals are different
   * facts: a media token is refused because of *when* it was asked for, and
   * this is refused because of *who* asked. The session's status is irrelevant
   * here — the assigned agent may read it in any status — so there is no state
   * for a conflict to be about.
   *
   * Logged at warn with both ids, because an agent asking for a colleague's
   * verification checklist is the thing worth finding in a log afterwards.
   */
  private refuse(actor: AgentActor, row: ChecklistSessionRow): never {
    this.logger.warn(
      {
        event: 'checklist.not_assigned',
        tenant_id: row.tenantId,
        session_id: row.sessionId,
        agent_id: actor.userId,
        assigned_agent_id: row.assignedAgentId,
      },
      'an agent asked for a checklist on a session they do not hold',
    );

    throw new DomainError(ErrorCode.FORBIDDEN, 'This session is not assigned to you.');
  }

  /**
   * The pin, which must exist.
   *
   * `sessions.checklist_template_id` is nullable — a session created while the
   * tenant had no active template gets null — but a null here is a tenant that
   * was never configured, not a verification that skips its checklist. The
   * same answer `TenantsService.requireConfig` gives to a missing tenant
   * configuration, for the same reason.
   */
  private requireTemplateId(row: ChecklistSessionRow): string {
    if (row.templateId === null) {
      this.logger.error(
        {
          event: 'checklist.template_missing',
          tenant_id: row.tenantId,
          session_id: row.sessionId,
        },
        'no checklist template is pinned to this session',
      );
      throw new DomainError(
        ErrorCode.INTERNAL_ERROR,
        'The checklist for this session is unavailable.',
      );
    }

    return row.templateId;
  }

  /** Non-null whenever the join matched, and asserted rather than assumed. */
  private requireVersion(row: ChecklistSessionRow): number {
    /* c8 ignore next 3 -- unreachable: `version` is NOT NULL on a matched row */
    if (row.version === null) {
      throw new DomainError(
        ErrorCode.INTERNAL_ERROR,
        'The checklist for this session is unavailable.',
      );
    }

    return row.version;
  }

  private requireItems(row: ChecklistSessionRow) {
    const parsed = parseTemplateItems(row.items);

    if (parsed.kind === 'MALFORMED') {
      this.logger.error(
        {
          event: 'checklist.template_malformed',
          tenant_id: row.tenantId,
          session_id: row.sessionId,
          template_id: row.templateId,
          // Why it failed, never what failed: the template is tenant
          // configuration and does not belong in a log line.
          reason: parsed.reason,
        },
        'the pinned checklist template is not a valid checklist',
      );
      throw new DomainError(
        ErrorCode.INTERNAL_ERROR,
        'The checklist for this session is unavailable.',
      );
    }

    return parsed.items;
  }
}
