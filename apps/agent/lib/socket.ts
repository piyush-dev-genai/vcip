/**
 * The agent portal's WebSocket connection (T31).
 *
 * T27 built the gateway, the connection tokens and the event vocabulary; this
 * is the first client for any of it. Everything the portal shows still comes
 * from REST — the socket is a way to hear about a change sooner, never the
 * authority for one (contract §33.11). A dropped message costs latency and
 * nothing else, which is what lets this file be as simple as it is.
 *
 * Three things it has to get right:
 *
 *   - **The token is short-lived and minted per connection.** D9 puts it in the
 *     query string because a browser cannot set headers on a WS handshake, so
 *     a fresh one is fetched for every attempt rather than kept.
 *   - **Reconnection is expected, not exceptional.** A laptop lid, a tunnel, a
 *     redeployed API. Backoff so a Control API that is down is not hammered by
 *     every open portal at once.
 *   - **It stops when told.** A socket that outlives the screen keeps a
 *     credential alive and delivers to a component that has gone.
 */

import type { RealtimeMessage } from '@vcip/shared';

/** What the caller does with each message. */
export type MessageHandler = (message: RealtimeMessage) => void;

export interface SocketDeps {
  /** `POST /v1/agent/ws-token`, called before every attempt. */
  readonly mintToken: () => Promise<string>;
  /** The Control API's base URL, http(s). Converted to ws(s) here. */
  readonly baseUrl: string;
  readonly onMessage: MessageHandler;
  /** Injected for tests; the browser's `WebSocket` in the app. */
  readonly socketImpl?: SocketFactory;
  /** Injected for tests, so backoff is not waited on in real time. */
  readonly scheduleImpl?: ScheduleFn;
}

export type SocketFactory = (url: string) => SocketLike;
export type ScheduleFn = (fn: () => void, delayMs: number) => void;

/** The slice of `WebSocket` this client uses. */
export interface SocketLike {
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * Reconnection delays, in milliseconds.
 *
 * Short at first because the common case is a blip worth recovering from
 * immediately, then backing off so a Control API that is genuinely down is not
 * hammered. The last value repeats: a portal left open overnight against a
 * dead API should keep trying, quietly, rather than give up and require a
 * reload nobody knows to do.
 */
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[index] as number;
}

/** `http://host` -> `ws://host/v1/ws`, `https` -> `wss`. */
export function websocketUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${base}/v1/ws?token=${encodeURIComponent(token)}`;
}

export interface RealtimeSocket {
  /** Open, and keep reopening until stopped. */
  start(): void;
  /** Close and stay closed. Safe to call twice, and safe before `start`. */
  stop(): void;
}

export function createRealtimeSocket(deps: SocketDeps): RealtimeSocket {
  const factory: SocketFactory =
    deps.socketImpl ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const schedule: ScheduleFn = deps.scheduleImpl ?? ((fn, ms) => setTimeout(fn, ms));

  let socket: SocketLike | null = null;
  let stopped = false;
  let attempt = 0;

  const retry = (): void => {
    if (stopped) return;
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    schedule(() => {
      if (!stopped) void open();
    }, delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;

    let token: string;
    try {
      token = await deps.mintToken();
    } catch {
      // The token endpoint needs the agent's JWT, so a failure here is
      // usually a session that has ended rather than a network fault. Either
      // way the answer is the same: wait and ask again. Nothing is surfaced
      // to the agent, because REST is still driving every screen.
      retry();
      return;
    }

    // Between minting and opening, the portal may have stopped. Opening now
    // would leave a socket nobody closes.
    if (stopped) return;

    const next = factory(websocketUrl(deps.baseUrl, token));
    socket = next;

    next.onopen = (): void => {
      // Only on a connection that actually opened: resetting when the attempt
      // *starts* would turn a server that accepts and immediately drops into
      // a tight reconnect loop at the shortest delay.
      attempt = 0;
    };

    next.onmessage = (event): void => {
      const message = parseMessage(event.data);
      if (message !== null) deps.onMessage(message);
    };

    const reopen = (): void => {
      if (socket === next) socket = null;
      retry();
    };

    next.onclose = reopen;
    next.onerror = (): void => {
      // `error` is followed by `close` in every browser, so closing here would
      // double the reconnect. Left to `onclose`.
    };
  };

  return {
    start(): void {
      stopped = false;
      void open();
    },
    stop(): void {
      stopped = true;
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}

/**
 * Read one frame, or `null` if it is not a message this app understands.
 *
 * Defensive because this is a network boundary: a proxy that injects a keepalive
 * frame, or a future server that sends a shape this build predates, must not
 * throw inside a socket callback where the error has nowhere to go.
 */
export function parseMessage(raw: unknown): RealtimeMessage | null {
  if (typeof raw !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;

    const candidate = parsed as { event?: unknown; data?: unknown };
    if (typeof candidate.event !== 'string' || candidate.data === undefined) return null;

    return { event: candidate.event, data: candidate.data };
  } catch {
    return null;
  }
}
