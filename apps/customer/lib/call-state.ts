/**
 * The call's connection lifecycle, as a pure reducer (T25).
 *
 * Same discipline as `lib/screen.ts`: nothing here decides anything about the
 * *session*. PostgreSQL owns that (D1), and a session is `IN_CALL` whether or
 * not this browser has a working WebRTC connection. What this file tracks is
 * narrower and entirely local — whether *this tab* is currently attached to the
 * room — and the distinction matters, because a customer whose Wi-Fi drops has
 * not aborted their verification. The server is told what happened by LiveKit's
 * own webhook (T26), never by this state.
 *
 * It is a reducer rather than a set of `useState` calls so the transitions can
 * be tested exhaustively without a browser, a camera, or a LiveKit server. The
 * component owns a `Room`; this owns what the screen is allowed to say.
 */

/**
 * Where the connection is.
 *
 * `FAILED` is deliberately distinct from `ENDED`. Ending is what happens when
 * the customer leaves or the call finishes; failing is the connection never
 * being established or dying unrecoverably, and only one of the two should put
 * an error in front of a customer.
 */
export const CallPhase = {
  /** Not attempted yet. */
  IDLE: 'idle',
  /** Asking the Control API for a media token. */
  REQUESTING_TOKEN: 'requesting_token',
  /** Holding a token, opening the connection. */
  CONNECTING: 'connecting',
  /** Attached to the room. The only phase in which media is expected. */
  LIVE: 'live',
  /** The SDK is trying to recover a dropped connection by itself. */
  RECONNECTING: 'reconnecting',
  /** Left deliberately, or the room closed. */
  ENDED: 'ended',
  /** Could not connect, or the connection died and did not come back. */
  FAILED: 'failed',
} as const;

export type CallPhase = (typeof CallPhase)[keyof typeof CallPhase];

/**
 * What can happen to a call.
 *
 * Named for the fact, not for the phase it produces — `disconnected` is what
 * LiveKit reports, and whether that means `ENDED` or `FAILED` is this file's
 * decision to make from where the call was.
 */
export type CallEvent =
  | { readonly kind: 'join' }
  | { readonly kind: 'token_ready' }
  | { readonly kind: 'token_failed'; readonly message: string }
  | { readonly kind: 'connected' }
  | { readonly kind: 'connect_failed'; readonly message: string }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'reconnected' }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'leave' };

export interface CallState {
  readonly phase: CallPhase;
  /**
   * Why it failed, for the screen. Null in every phase but `FAILED`.
   *
   * Cleared on every new attempt rather than left to linger: a stale message
   * under a live video is worse than no message.
   */
  readonly error: string | null;
  /**
   * Whether this tab has ever been attached to the room.
   *
   * The reducer needs it to tell "never connected" from "was connected and
   * dropped", which is the difference between `FAILED` and `ENDED` on a
   * `disconnected`. The screen uses it to avoid showing a connecting spinner
   * as though nothing had happened yet.
   */
  readonly hasConnected: boolean;
}

export const initialCallState: CallState = Object.freeze({
  phase: CallPhase.IDLE,
  error: null,
  hasConnected: false,
});

/** Phases from which a fresh join attempt is allowed to start. */
const RETRYABLE: readonly CallPhase[] = Object.freeze([
  CallPhase.IDLE,
  CallPhase.ENDED,
  CallPhase.FAILED,
]);

export function canJoin(state: CallState): boolean {
  return RETRYABLE.includes(state.phase);
}

/**
 * Apply one event.
 *
 * Total: every (phase, event) pair returns a state, and an event that makes no
 * sense where it arrives is ignored rather than throwing. Events genuinely do
 * arrive out of order — LiveKit can report `reconnecting` while a `disconnect`
 * is already in flight — and a reducer that threw on those would turn a
 * recoverable network blip into a crashed screen.
 */
export function callReducer(state: CallState, event: CallEvent): CallState {
  switch (event.kind) {
    case 'join':
      // Ignored unless the call is genuinely idle or finished, so a second
      // click during `CONNECTING` cannot restart a connection in progress.
      if (!canJoin(state)) return state;
      return { phase: CallPhase.REQUESTING_TOKEN, error: null, hasConnected: state.hasConnected };

    case 'token_ready':
      if (state.phase !== CallPhase.REQUESTING_TOKEN) return state;
      return { ...state, phase: CallPhase.CONNECTING };

    case 'token_failed':
      if (state.phase !== CallPhase.REQUESTING_TOKEN) return state;
      return { ...state, phase: CallPhase.FAILED, error: event.message };

    case 'connect_failed':
      if (state.phase !== CallPhase.CONNECTING) return state;
      return { ...state, phase: CallPhase.FAILED, error: event.message };

    case 'connected':
      // Accepted from `RECONNECTING` too: the SDK reports a completed recovery
      // as a fresh connection in some paths.
      if (state.phase !== CallPhase.CONNECTING && state.phase !== CallPhase.RECONNECTING) {
        return state;
      }
      return { phase: CallPhase.LIVE, error: null, hasConnected: true };

    case 'reconnecting':
      // Only from a live call. A `reconnecting` that arrives while connecting
      // for the first time is the SDK retrying internally, and showing
      // "reconnecting" for a call that never connected would be a lie.
      if (state.phase !== CallPhase.LIVE) return state;
      return { ...state, phase: CallPhase.RECONNECTING };

    case 'reconnected':
      if (state.phase !== CallPhase.RECONNECTING) return state;
      return { phase: CallPhase.LIVE, error: null, hasConnected: true };

    case 'disconnected':
      if (state.phase === CallPhase.ENDED || state.phase === CallPhase.FAILED) return state;
      // Never connected, so this is a failure to connect rather than a call
      // that finished. The message is generic because LiveKit's disconnect
      // reasons are not customer-facing text.
      if (!state.hasConnected) {
        return {
          phase: CallPhase.FAILED,
          error: 'The video connection could not be established.',
          hasConnected: false,
        };
      }
      return { phase: CallPhase.ENDED, error: null, hasConnected: true };

    case 'leave':
      return { phase: CallPhase.ENDED, error: null, hasConnected: state.hasConnected };
  }
}

/** Whether the screen should be showing video. */
export function isLive(state: CallState): boolean {
  return state.phase === CallPhase.LIVE;
}

/** Whether the call is working on getting connected, for a spinner. */
export function isBusy(state: CallState): boolean {
  return (
    state.phase === CallPhase.REQUESTING_TOKEN ||
    state.phase === CallPhase.CONNECTING ||
    state.phase === CallPhase.RECONNECTING
  );
}

/**
 * One line describing the connection, for the customer.
 *
 * Plain language, and never a LiveKit term: "reconnecting" is something a
 * person understands, `SignalReconnecting` is not.
 */
export function callStatusText(state: CallState): string {
  switch (state.phase) {
    case CallPhase.IDLE:
      return 'Preparing your call…';
    case CallPhase.REQUESTING_TOKEN:
      return 'Preparing your call…';
    case CallPhase.CONNECTING:
      return 'Connecting to your agent…';
    case CallPhase.LIVE:
      return 'You are connected.';
    case CallPhase.RECONNECTING:
      return 'Connection interrupted — reconnecting…';
    case CallPhase.ENDED:
      return 'The call has ended.';
    case CallPhase.FAILED:
      return state.error ?? 'The video connection could not be established.';
  }
}
