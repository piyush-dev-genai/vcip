/**
 * The WebSocket event vocabulary (T27, R3).
 *
 * R3 is the decision and this file is its expression: one shared enum, so the
 * server that publishes a name and the client that switches on it cannot
 * disagree. Where `docs/03-system-design.md` §10.2 and the older half of
 * `05-api-contract.md` §19 list different names — `agent.assigned`,
 * `call.started`, `call.ended` — they predate R3 and are stale.
 *
 * **These are not `SessionEventType`.** That is the append-only audit
 * vocabulary in `events.ts`: what happened to a session, written inside the
 * transaction that made it happen, kept forever. This is a notification
 * vocabulary: what a connected client should be told, delivered best-effort,
 * and authoritative for nothing. `CALL_STARTED` and `agent.joined` describe
 * neighbouring facts and are deliberately separate names in separate enums,
 * because conflating an audit record with a push notification would let one
 * change for the other's reasons.
 *
 * The governing rule, from `05-api-contract.md` §33.11 and
 * `03-system-design.md` §10.3: **WebSocket events are notifications, not the
 * source of truth.** A client that misses one is not wrong, only late; REST is
 * the recovery path. That is why every payload here is minimal — identifiers
 * and statuses the client uses to decide whether to go and read — and why none
 * of them carries customer data.
 */

import type { SessionStatus } from './enums.js';

/**
 * Events a customer connection may receive (R3).
 *
 * Six, and the two that look similar are not. `session.assigned` is the
 * business fact that an agent accepted, which is what moves the customer to the
 * call screen; `agent.joined` is the later fact that the agent's participant is
 * actually in the room, which T26 learns from LiveKit. A customer can be
 * assigned for several seconds before anyone joins.
 */
export const CustomerEvent = {
  /** Where this customer stands in the queue. */
  QUEUE_POSITION: 'queue.position',
  /** An agent has been offered this session and is deciding (`OFFERED`). */
  SESSION_OFFERED: 'session.offered',
  /** An agent accepted (`IN_CALL`). */
  SESSION_ASSIGNED: 'session.assigned',
  /** The agent's participant is in the room. */
  AGENT_JOINED: 'agent.joined',
  /** The session's status changed. The generic one. */
  SESSION_UPDATED: 'session.updated',
  /** The session reached a terminal status. */
  SESSION_COMPLETED: 'session.completed',
} as const;

export type CustomerEvent = (typeof CustomerEvent)[keyof typeof CustomerEvent];

export const CUSTOMER_EVENTS: readonly CustomerEvent[] = Object.freeze(
  Object.values(CustomerEvent),
);

/**
 * Events an agent connection may receive (R3).
 *
 * `ai.updated` is named here because R3 names it; T31 is what publishes it.
 * Declaring it now costs nothing and stops T31 inventing a spelling.
 */
export const AgentEvent = {
  /** A session this agent could work has joined the queue. */
  QUEUE_NEW_SESSION: 'queue.new_session',
  /** A session this agent was looking at went to somebody else. */
  SESSION_CLAIMED_ELSEWHERE: 'session.claimed_elsewhere',
  /** An offer this agent held lapsed and returned to the queue. */
  SESSION_OFFER_EXPIRED: 'session.offer_expired',
  /** New AI signals for the session this agent is working (T31). */
  AI_UPDATED: 'ai.updated',
  /** The status of a session this agent holds changed. */
  SESSION_UPDATED: 'session.updated',
  /** A session this agent holds was ended by the customer or the system. */
  SESSION_CANCELLED: 'session.cancelled',
} as const;

export type AgentEvent = (typeof AgentEvent)[keyof typeof AgentEvent];

export const AGENT_EVENTS: readonly AgentEvent[] = Object.freeze(Object.values(AgentEvent));

/** Every name the transport may carry, for validation at the boundary. */
export const REALTIME_EVENTS: readonly string[] = Object.freeze([
  ...CUSTOMER_EVENTS,
  ...AGENT_EVENTS,
]);

/**
 * Who a connection belongs to.
 *
 * The audience is decided from the verified connection token and never from
 * anything the client sends, which is what makes "a customer can never receive
 * an agent event" a property of the transport rather than of good behaviour.
 */
export const RealtimeAudience = {
  CUSTOMER: 'customer',
  AGENT: 'agent',
} as const;

export type RealtimeAudience = (typeof RealtimeAudience)[keyof typeof RealtimeAudience];

export function isCustomerEvent(value: unknown): value is CustomerEvent {
  return typeof value === 'string' && (CUSTOMER_EVENTS as readonly string[]).includes(value);
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  return typeof value === 'string' && (AGENT_EVENTS as readonly string[]).includes(value);
}

/**
 * May this audience be sent this event?
 *
 * `session.updated` is the one name both lists share, and it is the same name
 * on purpose: the fact is identical and only the recipient differs. Everything
 * else belongs to exactly one audience, and this function is what the gateway
 * asks before writing to a socket.
 */
export function mayReceive(audience: RealtimeAudience, event: string): boolean {
  return audience === RealtimeAudience.CUSTOMER ? isCustomerEvent(event) : isAgentEvent(event);
}

// ----------------------------------------------------------------- payloads

/**
 * Every payload names its session.
 *
 * A client holds one connection and may be told about a session it is not
 * currently looking at, so a notification without an id is a notification
 * nobody can act on.
 */
export interface RealtimePayloadBase {
  readonly session_id: string;
}

export interface QueuePositionPayload extends RealtimePayloadBase {
  /** 1-based. Null when Redis could not answer — never zero, never a guess. */
  readonly position: number | null;
}

export interface SessionStatusPayload extends RealtimePayloadBase {
  readonly status: SessionStatus;
}

export interface SessionCompletedPayload extends RealtimePayloadBase {
  readonly status: SessionStatus;
  /** `APPROVED` or `REJECTED`, or null for a session that ended without one. */
  readonly verdict: string | null;
}

/**
 * `queue.new_session`.
 *
 * The language is included because it is what made this agent eligible, and
 * seeing it is how an operator confirms the targeting is working. Nothing about
 * the customer travels with it.
 */
export interface QueueNewSessionPayload extends RealtimePayloadBase {
  readonly language: string;
}

/**
 * The envelope every message uses (contract §19).
 *
 * `{ event, data }` — the client can switch on one field and hand the other to
 * a typed handler.
 */
export interface RealtimeMessage<TData = unknown> {
  readonly event: string;
  readonly data: TData;
}

export function realtimeMessage<TData>(event: string, data: TData): RealtimeMessage<TData> {
  return { event, data };
}
