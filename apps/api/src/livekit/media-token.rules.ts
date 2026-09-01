/**
 * The decisions a media token makes that need no I/O (T24).
 *
 * Same split as `agent-claim.rules.ts`: everything here is a pure function of
 * values already fetched, so the authorization matrix can be tested
 * exhaustively without a database, a LiveKit key, or a Nest container — and so
 * the service reads as a sequence of named decisions rather than a wall of
 * conditionals.
 *
 * What is deliberately **not** here: the grants. A role is a fact about this
 * product ("the customer", "the agent on the call"); a `VideoGrant` is LiveKit
 * vocabulary. Mapping one to the other lives in the minter, so this file has no
 * dependency on the SDK and swapping the SFU would not touch the rules.
 */

import type { SessionStatus } from '@vcip/shared';
import { SessionStatus as Status } from '@vcip/shared';

/**
 * Who a participant is in the room (design §11.2).
 *
 * The values double as LiveKit participant identities. One session is one room,
 * so "customer" and "agent" are unique within it, and the LiveKit webhook (T26)
 * can read a participant's role off the identity without a lookup.
 *
 * `analyzer` is design §11.3's third role and is absent on purpose: nothing
 * mints one until T30 gives the AI service a reason to join, and a role no
 * endpoint issues is a grant nobody reviews.
 */
export const MediaRole = {
  CUSTOMER: 'customer',
  AGENT: 'agent',
} as const;

export type MediaRole = (typeof MediaRole)[keyof typeof MediaRole];

/**
 * Statuses in which the customer may hold room credentials (contract §13).
 *
 * `QUEUED` is here because of R2: `room_name` is assigned at creation, so the
 * room is nameable before an agent exists and the customer can be holding
 * credentials by the time one accepts. Joining early costs nothing — an empty
 * room is empty.
 *
 * Everything else is excluded, and `CREATED` most pointedly: a session that has
 * not passed consent, preflight, and location has no business publishing a
 * camera anywhere.
 */
export const CUSTOMER_MEDIA_STATUSES: readonly SessionStatus[] = Object.freeze([
  Status.QUEUED,
  Status.IN_CALL,
]);

/**
 * Statuses in which the assigned agent may hold room credentials.
 *
 * `IN_CALL` only, per contract §13 — not `OFFERED`. An offer is an exclusive
 * window to decide, not the call itself, and an agent who let one lapse (T20)
 * would otherwise walk away holding live publish rights to a room the next
 * agent is about to be given.
 */
export const AGENT_MEDIA_STATUSES: readonly SessionStatus[] = Object.freeze([Status.IN_CALL]);

/** What the decision is made from. Values only — no rows, no actors, no I/O. */
export interface MediaTokenRequest {
  /** Derived from the credential, never from the URL or the body. */
  readonly role: MediaRole;
  /** `sessions.status`, from PostgreSQL (D1). */
  readonly status: SessionStatus;
  /** `sessions.agent_id`. Null until an agent accepts (T19). */
  readonly assignedAgentId: string | null;
  /** The authenticated agent's user id, or null when the caller is a customer. */
  readonly requestingAgentId: string | null;
}

/**
 * Why a media token was or was not issued.
 *
 * Three outcomes rather than a boolean, because the two refusals are genuinely
 * different answers that the service maps to different error codes. Collapsing
 * them would tell an agent who wandered into a colleague's call that the
 * session was in the wrong state, which is both false and unhelpful.
 */
export type MediaTokenDecision =
  | { readonly kind: 'ALLOWED'; readonly role: MediaRole }
  /** The session's status does not permit this role to hold credentials. */
  | { readonly kind: 'WRONG_STATE' }
  /** The session is in call, but with a different agent. */
  | { readonly kind: 'NOT_ASSIGNED' };

/**
 * May this caller hold room credentials for this session?
 *
 * Status first, assignment second, and the order is deliberate. An agent asking
 * about a `QUEUED` session is told the state is wrong — which is true and
 * reveals nothing — rather than being told it is assigned to somebody else,
 * which would be a statement about a session they have no relationship with.
 *
 * The assignment check is the one this task exists to get right. Tenant
 * ownership is necessary and nowhere near sufficient: every agent in a tenant
 * can already read every session through `GET /v1/sessions/:id`, and reading a
 * status is not the same permission as publishing video into a live identity
 * verification. `sessions.agent_id` is the only column that says which agent is
 * on this call, and it is checked against the JWT's subject and nothing else.
 */
export function decideMediaToken(request: MediaTokenRequest): MediaTokenDecision {
  const { role, status, assignedAgentId, requestingAgentId } = request;

  if (role === MediaRole.CUSTOMER) {
    return CUSTOMER_MEDIA_STATUSES.includes(status)
      ? { kind: 'ALLOWED', role }
      : { kind: 'WRONG_STATE' };
  }

  if (!AGENT_MEDIA_STATUSES.includes(status)) return { kind: 'WRONG_STATE' };

  // Null on either side is a refusal, never a match. An `IN_CALL` row with no
  // `agent_id` should not exist — T19 writes both in one statement — and if one
  // ever did, "nobody is assigned" must not read as "you are assigned".
  if (
    requestingAgentId === null ||
    assignedAgentId === null ||
    assignedAgentId !== requestingAgentId
  ) {
    return { kind: 'NOT_ASSIGNED' };
  }

  return { kind: 'ALLOWED', role };
}

/**
 * When a token minted now stops being usable.
 *
 * Computed from one clock reading passed in by the caller, so the value the
 * client is told and the value baked into the JWT cannot come from two
 * different instants.
 */
export function mediaTokenExpiresAt(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}
