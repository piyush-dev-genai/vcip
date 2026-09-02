/**
 * Serving the pinned checklist (T33, D8).
 *
 * The shape of every session-scoped agent read here:
 *
 *   1. load the session, tenant-scoped in SQL
 *   2. assert it belongs to the authenticated tenant
 *   3. assert this agent is the one holding it
 *   4. validate what the database handed back
 *
 * **There is no write.** No row is updated, no `session_events` entry is
 * appended, nothing is created. Reading what you are about to attest to is not
 * a fact about the verification; ticking the boxes is, and that is recorded at
 * the verdict (T34/T35, schema §45) where the answers actually exist. Asking
 * twice is free, which is why this is a GET.
 *
 * **It never invents a checklist.** Both failure modes below answer 500 rather
 * than returning something usable, which is the unusual choice and the
 * deliberate one. An empty or shortened list would let a verdict be submitted
 * against fewer required items than the tenant configured — a verification
 * that claims to have checked something it never displayed. A 500 stops the
 * agent, which is recoverable; a quiet approval is not.
 */

import { Injectable } from '@nestjs/common';
import type { ChecklistResult } from '@vcip/shared';
import { DomainError, ErrorCode } from '@vcip/shared';
import type { Logger } from 'pino';
import type { AgentActor } from '../common/auth/auth-context.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { TenantScope } from '../common/auth/tenant-scope.js';
import { InjectLogger } from '../common/logging/logging.tokens.js';
import { setContextSession } from '../common/logging/request-context.js';
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
