/**
 * The decisions a checklist read makes that need no I/O (T33).
 *
 * Same split as `media-token.rules.ts` and `agent-claim.rules.ts`: everything
 * here is a pure function of values already fetched, so the authorization
 * matrix and the template parsing can be tested exhaustively without a
 * database or a Nest container, and the service reads as a sequence of named
 * decisions.
 *
 * Two decisions live here, and they refuse for opposite reasons. One is about
 * the caller — may this agent read this session's checklist. The other is
 * about the data — is what PostgreSQL handed back actually a checklist. The
 * first produces a 403 and is an ordinary answer; the second produces a 500
 * and means something is wrong with the deployment.
 */

import type { ChecklistItem } from '@vcip/shared';
import { checklistItemsSchema } from '@vcip/shared';

/** What the authorization decision is made from. Values only — no rows. */
export interface ChecklistReadRequest {
  /** `sessions.agent_id`. Null until an agent accepts (T19). */
  readonly assignedAgentId: string | null;
  /** The authenticated agent's user id, from the JWT subject. */
  readonly requestingAgentId: string;
}

export type ChecklistReadDecision =
  | { readonly kind: 'ALLOWED' }
  /** Some other agent holds this session, or nobody does yet. */
  | { readonly kind: 'NOT_ASSIGNED' };

/**
 * May this agent read this session's checklist?
 *
 * The assigned agent, in any status. Tenant ownership is checked before this
 * is reached and is necessary but not sufficient — every agent in a tenant can
 * already read every session's status through the queue, and this is one step
 * further in: it is the list of things a named agent is about to attest to.
 *
 * **Any status**, unlike the media token, and the difference is what the two
 * answers are. A media token is a live credential to publish video into a
 * verification, so it is confined to `IN_CALL`. A checklist is tenant
 * configuration the agent is being held to; there is no moment at which the
 * agent who ran a verification should be unable to see what they were asked.
 * That includes after the verdict, when the question being asked is usually
 * "what exactly did I confirm".
 *
 * Null on either side is a refusal, never a match. A session before accept has
 * no `agent_id`, and "nobody is assigned" must not read as "you are assigned".
 */
export function decideChecklistRead(request: ChecklistReadRequest): ChecklistReadDecision {
  const { assignedAgentId, requestingAgentId } = request;

  if (assignedAgentId === null || assignedAgentId !== requestingAgentId) {
    return { kind: 'NOT_ASSIGNED' };
  }

  return { kind: 'ALLOWED' };
}

/**
 * What the pinned template turned out to be.
 *
 * A result rather than a throw, for the reason `decideMediaToken` returns one:
 * the caller maps outcomes to errors and logs, and a pure function that threw
 * a transport error would put HTTP vocabulary in a file that has none.
 */
export type TemplateParse =
  | { readonly kind: 'OK'; readonly items: readonly ChecklistItem[] }
  /** `checklist_templates.items` is not a checklist. `reason` is for the log. */
  | { readonly kind: 'MALFORMED'; readonly reason: string };

/**
 * Read `checklist_templates.items`, which is `jsonb` and therefore anything.
 *
 * There is no shape constraint on that column and no admin API that writes it
 * (R9 — the seed provisions templates), so this is the only validation between
 * whatever is in the row and what an agent is shown.
 *
 * It never degrades. A template that fails to parse is not silently reduced to
 * the items that happen to be well-formed, because the items most likely to be
 * dropped are the ones nobody notices are missing — and a verdict submitted
 * against a checklist quietly shorter than the tenant configured is a
 * verification that claims to have checked something it never displayed.
 */
export function parseTemplateItems(value: unknown): TemplateParse {
  const parsed = checklistItemsSchema.safeParse(value);

  if (!parsed.success) {
    // The message, not the value. A malformed template is quoted back by zod
    // in full, and a template is tenant configuration that has no business
    // being reproduced in a log line.
    return { kind: 'MALFORMED', reason: parsed.error.issues[0]?.message ?? 'invalid' };
  }

  return { kind: 'OK', items: parsed.data };
}
