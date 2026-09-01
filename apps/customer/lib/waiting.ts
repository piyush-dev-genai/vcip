/**
 * Noticing that an agent arrived (T25).
 *
 * Until now the customer app re-read the session only when the customer pressed
 * a button. That was honest for T14 and T15, where nothing could change without
 * the customer doing something — but an agent claiming and accepting is exactly
 * a change the customer causes nothing about, and a call the customer has to
 * discover by clicking Refresh is not a call.
 *
 * So the status screen polls while the session is in a state the *server* can
 * move on its own. This is the fallback the product flow already names —
 * §5.6: "queue and assignment updates over WebSocket, with REST polling as a
 * fallback" — and it stays after T27 for exactly that reason. It is not a
 * second source of truth: every poll is `GET /v1/sessions/{id}`, and the answer
 * replaces what the screen believed rather than being merged into it.
 */

import { SessionStatus } from '@vcip/shared';
import type { SessionView } from './session';

/**
 * How often to ask.
 *
 * Three seconds. The thing being waited for is a human agent pressing Accept,
 * so the customer's tolerable delay is a second or two, not a millisecond —
 * and this is one indexed read per customer per interval, on a screen where
 * the alternative is the customer sitting in front of a stale page. T27's
 * WebSocket makes it a backstop rather than the mechanism.
 */
export const STATUS_POLL_INTERVAL_MS = 3000;

/**
 * Statuses the server can leave without the customer doing anything.
 *
 * `QUEUED` and `OFFERED` are the wait: an agent claims, then accepts, and
 * neither is visible here until someone asks. `IN_CALL` is polled too, because
 * the session can end from the agent's side — a verdict (T35) or a disconnect
 * (T26) — and a customer left looking at a live call screen after the session
 * finished would be the same staleness in the other direction.
 *
 * `CREATED` is absent on purpose. Nothing moves a `CREATED` session but the
 * customer, and polling their own inaction is pure noise.
 */
const SERVER_DRIVEN: readonly SessionStatus[] = Object.freeze([
  SessionStatus.QUEUED,
  SessionStatus.OFFERED,
  SessionStatus.IN_CALL,
]);

/** Should the screen be re-reading this session on a timer? */
export function shouldPoll(session: SessionView | null): boolean {
  if (session === null) return false;
  return SERVER_DRIVEN.includes(session.status);
}

/**
 * Has an agent taken this session into a call?
 *
 * Read from `status`, not from `agent_connected`. The two answer different
 * questions: `status` is the business fact that an agent accepted (T19), while
 * `agent_connected` is derived from LiveKit's webhook (T26) and says whether
 * they are attached to the room *right now*. The customer should join the room
 * as soon as the session is `IN_CALL` — waiting for the agent's own connection
 * would have both parties waiting for the other to arrive.
 */
export function agentHasAccepted(session: SessionView): boolean {
  return session.status === SessionStatus.IN_CALL;
}
