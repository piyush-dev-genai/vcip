/**
 * Which screen the agent should be on, and what each server answer means.
 *
 * The agent-side counterpart to the customer app's `lib/screen.ts`, and it
 * exists for the same reason: PostgreSQL owns business state (D1), so the
 * browser must not hold a second state machine that can disagree with it. None
 * of these functions *decides* anything about a session. Each reads what the
 * server already decided and says what to show.
 *
 * That is what makes a reload unremarkable. There is no resumption logic and no
 * local progress record — the portal remembers an id, re-reads the session, and
 * asks these functions where it landed.
 *
 * The three "after" functions are deliberately total over the statuses the
 * server can return. A status this file does not recognise sends the agent back
 * to the queue rather than onto a screen built for a different state, because
 * the alternative — showing an offer for a session that is `APPROVED` — is the
 * browser asserting something no response said.
 */

import { SessionStatus } from '@vcip/shared';

export const WorkScreen = {
  /** Holding nothing: the queue is the screen. */
  QUEUE: 'queue',
  /** An id is remembered but the server has not answered yet. */
  CHECKING: 'checking',
  OFFER: 'offer',
  CALL: 'call',
} as const;

export type WorkScreen = (typeof WorkScreen)[keyof typeof WorkScreen];

/**
 * A session this agent is holding.
 *
 * `status` is always the server's last word. `UNKNOWN` is the one value the
 * portal writes itself, and it means exactly "recovered from storage, not yet
 * confirmed" — never a guess about what the session is.
 */
export interface Work {
  readonly sessionId: string;
  readonly status: string;
  /**
   * Server-issued, carried across a reload.
   *
   * `GET /v1/sessions/{id}` does not report the offer window, so a recovered
   * offer keeps the value the claim returned. Null means "not known", and the
   * countdown says so rather than inventing one.
   */
  readonly offerExpiresAt: string | null;
  readonly roomName: string | null;
}

/** The status the portal writes for work it has recovered but not confirmed. */
export const UNCONFIRMED = 'UNKNOWN';

export function workScreen(work: Work | null): WorkScreen {
  if (work === null) return WorkScreen.QUEUE;
  if (work.status === SessionStatus.OFFERED) return WorkScreen.OFFER;
  if (work.status === SessionStatus.IN_CALL) return WorkScreen.CALL;
  // Recovered-but-unconfirmed, or any status this portal has no screen for.
  return WorkScreen.CHECKING;
}

/** A successful claim. The offer window is the server's, reported verbatim. */
export function afterClaim(result: {
  readonly session_id: string;
  readonly status: string;
  readonly offer_expires_at: string;
}): Work {
  return {
    sessionId: result.session_id,
    status: result.status,
    offerExpiresAt: result.offer_expires_at,
    roomName: null,
  };
}

/**
 * A successful accept.
 *
 * The offer window is dropped rather than kept: the offer is over, and a
 * lingering expiry would be a countdown against a call that cannot lapse.
 */
export function afterAccept(result: {
  readonly session_id: string;
  readonly status: string;
  readonly room_name: string | null;
}): Work {
  return {
    sessionId: result.session_id,
    status: result.status,
    offerExpiresAt: null,
    roomName: result.room_name,
  };
}

/**
 * What a read of the held session means.
 *
 * `null` means the session is no longer this agent's business — it went back to
 * the queue because the offer lapsed, or it ended — and the portal returns to
 * the queue screen.
 *
 * The previously known offer window is carried forward only while the session
 * is still `OFFERED`, because the read cannot report it and dropping it would
 * blank a live countdown on every poll.
 */
export function afterRead(
  current: Work,
  server: { readonly status: string; readonly room_name: string | null },
): Work | null {
  if (server.status === SessionStatus.OFFERED) {
    return {
      sessionId: current.sessionId,
      status: SessionStatus.OFFERED,
      offerExpiresAt: current.offerExpiresAt,
      roomName: server.room_name,
    };
  }

  if (server.status === SessionStatus.IN_CALL) {
    return {
      sessionId: current.sessionId,
      status: SessionStatus.IN_CALL,
      offerExpiresAt: null,
      roomName: server.room_name,
    };
  }

  return null;
}
