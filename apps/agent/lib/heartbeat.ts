/**
 * The heartbeat loop, as a plain object with no React in it.
 *
 * The portal's rule is narrow and easy to get wrong: beat *only* while the
 * agent is authenticated and intends to hold a presence, and stop the moment
 * either stops being true — going unavailable, signing out, or the component
 * unmounting. A timer that outlives the intent is the bug this file exists to
 * make impossible, because a stray beat would keep re-arming a TTL for an agent
 * who is no longer there. (The server refuses to *resurrect* a deleted
 * presence, so a stray beat cannot make an unavailable agent available — but
 * "the server would catch it" is not a reason for the client to be wrong.)
 *
 * Written against injected timer functions rather than the globals, so the
 * whole lifecycle is testable under plain Node with no fake clock library and
 * no DOM. The React component owns *when* to start and stop; this owns what
 * starting and stopping mean.
 */

/** The timer surface used here. Satisfied by `window`, and by a test double. */
export interface TimerHost {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HeartbeatDeps {
  readonly timers: TimerHost;
  readonly intervalMs: number;
  /** One beat. Rejections are reported, never thrown into the timer. */
  readonly beat: () => Promise<void>;
  /** Called when a beat fails, so the portal can decide to stop or re-auth. */
  readonly onError?: (error: unknown) => void;
}

export interface Heartbeat {
  /** Begin beating. Calling it while already running is a no-op, not a second timer. */
  start(): void;
  /** Stop beating. Safe to call when not running, and safe to call twice. */
  stop(): void;
  readonly running: boolean;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  let handle: unknown = null;
  /**
   * Guards against overlapping beats.
   *
   * If a request takes longer than the interval — a slow network, a suspended
   * laptop waking up — the naive loop stacks requests and every one of them
   * arrives at once. Skipping a tick while one is still in flight keeps the
   * portal to one outstanding heartbeat, which is all the server needs.
   */
  let inFlight = false;

  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    deps
      .beat()
      .catch((error: unknown) => {
        // A rejection inside a timer callback is an unhandled rejection, which
        // in a browser is a console entry nobody sees and in a test is a
        // process-level warning. It is handed to the portal instead.
        deps.onError?.(error);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    start(): void {
      // Idempotent by design. React strict mode runs effects twice in
      // development, and a second timer would double the traffic silently.
      if (handle !== null) return;
      handle = deps.timers.setInterval(tick, deps.intervalMs);
    },

    stop(): void {
      if (handle === null) return;
      deps.timers.clearInterval(handle);
      handle = null;
    },

    get running(): boolean {
      return handle !== null;
    },
  };
}
