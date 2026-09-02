'use client';

import type { AiHudPayload, ChecklistAnswer } from '@vcip/shared';
import { AgentEvent } from '@vcip/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyHudUpdate } from '../lib/ai-hud';
import { createRealtimeSocket } from '../lib/socket';
import type { QueuedSession } from '../lib/api';
import { createAgentApi } from '../lib/api';
import { apiBaseUrl, HEARTBEAT_INTERVAL_MS } from '../lib/config';
import type { AgentMessage } from '../lib/errors';
import { ApiError, toAgentMessage, toLoginMessage } from '../lib/errors';
import { createHeartbeat } from '../lib/heartbeat';
import type { PresenceStatus } from '../lib/presence';
import { OFFER_POLL_INTERVAL_MS, countdownFinished } from '../lib/offer';
import { QUEUE_REFRESH_INTERVAL_MS } from '../lib/queue';
import { browserTokenHost, clearToken, isExpired, readToken, writeToken } from '../lib/token';
import {
  browserWorkHost,
  forgetWork,
  idempotencyKeyFor,
  recallWork,
  rememberWork,
} from '../lib/work';
import type { Work } from '../lib/work-state';
import {
  afterAccept,
  afterClaim,
  afterRead,
  afterWorkRead,
  UNCONFIRMED,
  WorkScreen,
  workScreen,
} from '../lib/work-state';
import { AvailabilityPanel } from './AvailabilityPanel';
import { AiPanel } from './AiPanel';
import { ChecklistPanel, clearChecklist } from './ChecklistPanel';
import { VerdictPanel } from './VerdictPanel';
import { CallPanel } from './CallPanel';
import { LoginForm } from './LoginForm';
import { OfferPanel } from './OfferPanel';
import { QueuePanel } from './QueuePanel';

/**
 * The portal shell: sign in, choose availability, keep the presence alive.
 *
 * The heartbeat rule, which is the part worth reading twice: the loop runs only
 * while the agent holds a token *and* the server's last word was that they are
 * present. It is torn down when the agent goes unavailable, when they sign out,
 * when the token expires, and when this component unmounts — the effect's
 * cleanup covers the last one, so closing the tab stops the beats and the
 * presence simply expires.
 *
 * `BUSY` never starts or stops the loop. An agent in a verification is still
 * present and must keep beating; the status is the server's to set and this
 * component's only to display.
 *
 * The queue poll (T17) is a second, independent loop on the same scheduler.
 * It runs whenever the agent is signed in — availability is not a precondition
 * for *reading* the queue, and an agent deciding whether to go available is
 * exactly the person who wants to see what is waiting. It is a read: nothing it
 * returns changes presence, and nothing it does claims a session. Its failures
 * are kept in their own state so a queue outage cannot clear the availability
 * error the agent is currently looking at.
 *
 * T21 adds the work the agent actually does, and one rule governs all of it:
 * **the server's answer is the state.** A claim response puts the portal on the
 * offer screen; an accept response puts it on the call screen; a re-read of the
 * session moves it anywhere the server says. Nothing here transitions a session
 * locally, and the offer countdown running out changes exactly one thing — it
 * triggers a read. A browser that decided an offer had lapsed would be deciding
 * something only PostgreSQL can (D1).
 *
 * The working session id is remembered in `sessionStorage` because a claimed or
 * accepted session has left the queue view and the contract has no endpoint
 * that answers "what am I working on". Without it a reload would strand an
 * agent — recoverably during an offer, since the sweeper reclaims it, but
 * permanently during a call, where nothing does.
 *
 * State lives here and the screens are presentational, so the lifecycle
 * rules are in one file. The pieces worth testing on their own — the token
 * store, the API client, the scheduler, the countdown arithmetic, the work
 * memory — are in `lib/` and tested there under plain Node.
 */

type Screen = 'login' | 'portal';

export function AgentPortal() {
  const host = useMemo(() => browserTokenHost(), []);
  const workHost = useMemo(() => browserWorkHost(), []);
  const [screen, setScreen] = useState<Screen>('login');
  const [status, setStatus] = useState<PresenceStatus>('UNAVAILABLE');
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AgentMessage | null>(null);
  const [sessions, setSessions] = useState<readonly QueuedSession[]>([]);
  const [queueLoadedAt, setQueueLoadedAt] = useState<number | null>(null);
  const [queueError, setQueueError] = useState<AgentMessage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [work, setWork] = useState<Work | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [workError, setWorkError] = useState<AgentMessage | null>(null);
  /** Ticks the countdown. A rendering concern; it decides nothing. */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  /**
   * The token in a ref, not in state.
   *
   * The API client reads it at call time through this ref, so a request issued
   * by a timer always sees the current credential rather than the one captured
   * when the effect was created. It is also why signing out takes effect on the
   * very next beat.
   */
  const token = useRef<string | null>(null);

  /**
   * Every AI result this portal has received, keyed by session.
   *
   * Kept by session rather than as one current value, because an agent may be
   * handed a second call and a HUD rendered against the wrong session would be
   * the wrong customer's liveness score on screen. `AiPanel` reads only the
   * key it is showing.
   */
  const [aiUpdates, setAiUpdates] = useState<Record<string, AiHudPayload>>({});

  /**
   * The checklist as the agent has filled it in, lifted out of `ChecklistPanel`.
   *
   * It lives here because two components need it: the panel that collects the
   * ticks, and the verdict that submits them. `ready` is `approvalReady` from
   * `@vcip/shared` — the same rule the Control API applies — so the approve
   * button cannot promise what the server will refuse.
   */
  const [checklist, setChecklist] = useState<{
    readonly answers: readonly ChecklistAnswer[];
    readonly ready: boolean;
  }>({ answers: [], ready: false });

  /**
   * The current work, in a ref as well as in state.
   *
   * A poll started for one session must be able to read what the portal holds
   * *now* without being rebuilt every time it changes — and a decision computed
   * inside a setState updater is a value this code cannot then act on.
   */
  const workRef = useRef<Work | null>(null);

  const api = useMemo(
    () => createAgentApi({ baseUrl: apiBaseUrl(), token: () => token.current }),
    [],
  );

  /**
   * Ask the server what this agent is holding.
   *
   * The authority for the portal's own work, and the fix for a real deadlock:
   * `sessionStorage` is per-tab, so a fresh login — a new tab, another browser,
   * cleared storage, or a deliberate sign-out — used to lose the pointer
   * entirely. The agent then sat on the queue screen while
   * `POST /v1/agent/availability` refused them with a 409 for holding a session
   * no response would name, and nothing frees an `IN_CALL` session: the expiry
   * sweeper only handles `OFFERED`. The agent was stuck until the customer
   * aborted.
   *
   * The server's answer replaces whatever was remembered, never merges with it.
   * Storage stays as a fast path that avoids a flash of the queue screen on
   * reload, and as the home of the idempotency keys a retry needs — but it is
   * no longer the only record, and it no longer decides anything.
   *
   * Failure is not fatal and not an error the agent must act on: the portal
   * simply shows what it already knew. A queue view is a safe thing to be
   * looking at.
   */
  const syncWork = useCallback(async (): Promise<void> => {
    try {
      const result = await api.work();
      const [first] = result.sessions;
      if (first === undefined) {
        // The server says this agent holds nothing. Any remembered pointer is
        // stale — a session that ended while the tab was closed — so it goes,
        // rather than sending the portal to a screen the server disagrees with.
        forgetWork(workHost, workRef.current?.sessionId);
        setWork(null);
        return;
      }
      const confirmed = afterWorkRead(first);
      setWork(confirmed);
      rememberWork(workHost, {
        sessionId: confirmed.sessionId,
        offerExpiresAt: confirmed.offerExpiresAt,
        roomName: confirmed.roomName,
      });
    } catch {
      // Left deliberately silent. This runs on entering the portal, and a
      // failure here must not stand between an agent and their queue.
    }
  }, [api, workHost]);

  /** Restore a session from a previous page load, if it is still usable. */
  useEffect(() => {
    const stored = readToken(host);
    if (stored === null) return;
    if (isExpired(stored)) {
      clearToken(host);
      return;
    }
    token.current = stored.token;
    // Deliberately does NOT restore availability. Presence is server state with
    // a 15-second TTL; after a reload the honest assumption is that it is gone,
    // and the agent chooses again. Guessing AVAILABLE here would be the client
    // asserting a presence it has not established.
    setScreen('portal');
    setStatus('UNAVAILABLE');

    // The work, however, *is* restored — because unlike presence it is durable
    // PostgreSQL state that outlives the tab. What is restored is only the id
    // and the offer window the server previously issued; the status comes from
    // re-reading the session, so a reload cannot resurrect a screen the server
    // no longer agrees with.
    // The remembered id, if there is one, only to avoid a flash of the queue
    // screen while the server is asked. It is unconfirmed and decides nothing.
    const remembered = recallWork(workHost);
    if (remembered !== null) {
      setWork({
        sessionId: remembered.sessionId,
        status: UNCONFIRMED,
        offerExpiresAt: remembered.offerExpiresAt,
        roomName: remembered.roomName,
      });
    }

    // The server is the authority, and it is asked whether or not anything was
    // remembered — which is what lets a tab with no memory at all find its way
    // back to a live call.
    void syncWork();
  }, [host, workHost, syncWork]);

  /**
   * The verification is over: let go of it.
   *
   * The verdict has committed by the time this runs, so nothing here can undo
   * it and nothing here is authoritative. It clears the local traces — the
   * remembered session, its idempotency keys, and the unsubmitted ticks — and
   * asks the server what this agent holds now, which is what actually decides
   * the next screen (D1).
   */
  const finishWork = useCallback(
    (sessionId: string): void => {
      clearChecklist(sessionId);
      setChecklist({ answers: [], ready: false });
      forgetWork(workHost, sessionId);
      setWork(null);
      void syncWork();
    },
    [workHost, syncWork],
  );

  const signOut = useCallback((): void => {
    token.current = null;
    clearToken(host);
    setScreen('login');
    setStatus('UNAVAILABLE');
    setLastSeen(null);
    setError(null);
    setSessions([]);
    setQueueLoadedAt(null);
    setQueueError(null);
    // The remembered session goes with the credential. Leaving it would offer
    // the next person who signs in on this tab a route to someone else's work.
    forgetWork(workHost, work?.sessionId);
    setWork(null);
    setClaiming(null);
    setAccepting(false);
    setWorkError(null);
  }, [host, work?.sessionId, workHost]);

  const signIn = useCallback(
    async (credentials: { tenantSlug: string; email: string; password: string }): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.login({
          tenant_slug: credentials.tenantSlug.trim(),
          email: credentials.email,
          password: credentials.password,
        });
        token.current = result.access_token;
        writeToken(host, { token: result.access_token, expiresAt: result.expires_at });
        setScreen('portal');
        // Logging in does not make an agent available (§17). They choose.
        setStatus('UNAVAILABLE');
        // But it does ask what they are already holding. An agent who logs in
        // mid-call belongs on the call screen, not on the queue.
        void syncWork();
      } catch (caught) {
        setError(toLoginMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [api, host, syncWork],
  );

  const changeAvailability = useCallback(
    async (next: PresenceStatus): Promise<void> => {
      if (next !== 'AVAILABLE' && next !== 'UNAVAILABLE') return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.setAvailability({ status: next });
        setStatus(result.status);
        if (result.status === 'UNAVAILABLE') setLastSeen(null);
      } catch (caught) {
        const message = toAgentMessage(caught);
        setError(message);
        if (message.reauthenticate) signOut();
      } finally {
        setBusy(false);
      }
    },
    [api, signOut],
  );

  /**
   * Re-read the session this agent is holding, and believe the answer.
   *
   * The single place work state changes after a claim. Every screen transition
   * from here is a consequence of what the server said the status is: still
   * `OFFERED`, now `IN_CALL`, or back to `QUEUED` because the offer lapsed and
   * the sweeper took it. The portal never reasons its way to any of those.
   *
   * A session that is no longer this agent's business — back in the queue, or
   * ended — is forgotten, which returns them to the queue screen.
   */
  const readWork = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        const state = await api.session(sessionId);

        // `afterRead` is the whole decision, and it is a pure function of what
        // the server just said. Nothing in this component interprets a status.
        // The current work comes from a ref rather than from the setState
        // updater, so the result is a value this code can act on.
        const base: Work = workRef.current ?? {
          sessionId,
          status: UNCONFIRMED,
          offerExpiresAt: null,
          roomName: null,
        };
        const landed = afterRead(base, state);

        if (landed === null) {
          // Back in the queue because the offer lapsed, or ended. Either way it
          // is not this agent's any more.
          forgetWork(workHost, sessionId);
          setWork(null);
          setWorkError(null);
          void loadQueueRef.current?.();
          return;
        }

        setWork(landed);
        rememberWork(workHost, {
          sessionId,
          offerExpiresAt: landed.offerExpiresAt,
          roomName: landed.roomName,
        });
      } catch (caught) {
        const message = toAgentMessage(caught);
        if (message.reauthenticate) {
          signOut();
          return;
        }
        // A 404 means the id is not this tenant's — a stale or tampered
        // storage entry. Anything else is transient and the next tick retries.
        if (caught instanceof ApiError && caught.status === 404) {
          forgetWork(workHost, sessionId);
          setWork(null);
          return;
        }
        setWorkError(message);
      }
    },
    [api, signOut, workHost],
  );

  /**
   * Claim one queued session.
   *
   * The idempotency key is minted once per (claim, session) and reused on every
   * retry, so pressing twice is one operation rather than two. The response is
   * the state: a 200 puts the agent on the offer screen with the server's own
   * `offer_expires_at`.
   */
  const claimSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (claiming !== null) return;
      setClaiming(sessionId);
      setWorkError(null);
      try {
        const key = idempotencyKeyFor(workHost, 'claim', sessionId);
        const result = await api.claim(sessionId, key);
        const next = afterClaim(result);
        setWork(next);
        rememberWork(workHost, {
          sessionId: next.sessionId,
          offerExpiresAt: next.offerExpiresAt,
          roomName: null,
        });
        // The claimed session has left the queue. Re-reading now rather than
        // waiting five seconds keeps the list from showing work that is gone.
        void loadQueueRef.current?.();
      } catch (caught) {
        const message = toAgentMessage(caught);
        if (message.reauthenticate) {
          signOut();
          return;
        }
        setWorkError(message);
        // Someone else won, or the session moved. The list is stale either way.
        void loadQueueRef.current?.();
      } finally {
        setClaiming(null);
      }
    },
    [api, claiming, signOut, workHost],
  );

  /**
   * Take up the offer.
   *
   * Same key discipline as the claim, and the same rule about the answer: a 200
   * carries the room name and the portal moves to the call screen. A refusal —
   * the offer lapsed, someone else holds it — is not interpreted here; the
   * session is re-read and the server places the agent.
   */
  const acceptSession = useCallback(async (): Promise<void> => {
    const sessionId = work?.sessionId;
    if (sessionId === undefined || accepting) return;
    setAccepting(true);
    setWorkError(null);
    try {
      const key = idempotencyKeyFor(workHost, 'accept', sessionId);
      const result = await api.accept(sessionId, key);
      const next = afterAccept(result);
      setWork(next);
      rememberWork(workHost, {
        sessionId: next.sessionId,
        offerExpiresAt: null,
        roomName: next.roomName,
      });
    } catch (caught) {
      const message = toAgentMessage(caught);
      if (message.reauthenticate) {
        signOut();
        return;
      }
      setWorkError(message);
      // Whatever went wrong, the server knows the truth about this session.
      await readWork(sessionId);
    } finally {
      setAccepting(false);
    }
  }, [accepting, api, readWork, signOut, work?.sessionId, workHost]);

  /**
   * Read the queue once.
   *
   * Shared by the poll and the Refresh button, so both behave identically —
   * including on failure, where an expired token signs the agent out rather
   * than leaving a loop beating against a 401.
   */
  const loadQueue = useCallback(async (): Promise<void> => {
    try {
      const result = await api.queue();
      setSessions(result.sessions);
      setQueueLoadedAt(Date.now());
      setQueueError(null);
    } catch (caught) {
      const message = toAgentMessage(caught);
      if (message.reauthenticate) {
        signOut();
        return;
      }
      // The last good list stays on screen. Blanking it on a transient failure
      // would report an empty queue, which is a claim about the world rather
      // than about the connection.
      setQueueError(message);
    }
  }, [api, signOut]);

  /**
   * A ref to `loadQueue`, so the claim and accept handlers can refresh the list
   * without depending on it.
   *
   * `loadQueue` depends on `signOut`, which depends on the current work — so a
   * direct dependency would rebuild those callbacks on every work change and,
   * through the poll effects, restart their timers. The ref keeps the wiring
   * one-directional.
   */
  const loadQueueRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    loadQueueRef.current = loadQueue;
  }, [loadQueue]);

  useEffect(() => {
    workRef.current = work;
  }, [work]);

  const refresh = useCallback((): void => {
    setRefreshing(true);
    void loadQueue().finally(() => {
      setRefreshing(false);
    });
  }, [loadQueue]);

  /**
   * The queue poll.
   *
   * Runs while signed in, regardless of availability, and stops on unmount and
   * on sign-out. `createHeartbeat` is the scheduler rather than a second
   * implementation of one: it already has the in-flight guard that keeps a slow
   * network from stacking requests, and duplicating that here would mean
   * duplicating the bug it prevents.
   */
  useEffect(() => {
    if (screen !== 'portal') return;

    void loadQueue();

    const poll = createHeartbeat({
      timers: window,
      intervalMs: QUEUE_REFRESH_INTERVAL_MS,
      beat: loadQueue,
      // `loadQueue` already handles its own failures; nothing may escape into
      // the timer.
      onError: () => undefined,
    });

    poll.start();
    return () => {
      poll.stop();
    };
  }, [loadQueue, screen]);

  /**
   * The working-session poll.
   *
   * Runs whenever the agent is holding something, at a faster cadence than the
   * queue: the offer window is short, and this loop is how the portal learns
   * that the sweeper took it, that the accept landed, or that a reload's
   * remembered id is stale.
   *
   * It is also the recovery read. On the first tick after a reload the work has
   * status `UNKNOWN`, and this is what replaces that with the server's answer.
   */
  useEffect(() => {
    const sessionId = work?.sessionId;
    if (screen !== 'portal' || sessionId === undefined) return;

    void readWork(sessionId);

    const poll = createHeartbeat({
      timers: window,
      intervalMs: OFFER_POLL_INTERVAL_MS,
      beat: () => readWork(sessionId),
      onError: () => undefined,
    });

    poll.start();
    return () => {
      poll.stop();
    };
  }, [readWork, screen, work?.sessionId]);

  /**
   * The countdown tick.
   *
   * Purely for rendering: it moves `nowMs` so the displayed number changes. It
   * transitions nothing. When the countdown reaches zero the portal asks the
   * server what happened — the read above is what decides, and this tick is
   * only what makes the question get asked promptly.
   */
  useEffect(() => {
    if (screen !== 'portal' || workScreen(work) !== WorkScreen.OFFER) return;

    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => {
      window.clearInterval(id);
    };
  }, [screen, work?.status]);

  /**
   * When the displayed countdown runs out, go and ask.
   *
   * The one place the timer has any effect, and its effect is a read. The
   * session stays on screen, Accept stays enabled, and the agent keeps their
   * route to work that may well still be theirs — a fast local clock must not
   * be able to take it away.
   */
  useEffect(() => {
    const sessionId = work?.sessionId;
    if (sessionId === undefined || workScreen(work) !== WorkScreen.OFFER) return;
    if (work === null || !countdownFinished(work.offerExpiresAt, nowMs)) return;
    void readWork(sessionId);
  }, [nowMs, readWork, work?.offerExpiresAt, work?.sessionId, work?.status]);

  /**
   * The realtime connection (T31).
   *
   * The portal's first socket. Everything on screen still comes from REST —
   * the poll below is unchanged and remains the authority — so this only makes
   * one thing arrive sooner than a poll could deliver it: what the AI has to
   * say about a call in progress, which changes every couple of seconds and
   * would be absurd to poll for.
   *
   * Opened whenever the agent is signed in, not only during a call, because
   * the gateway hands a connection its current HUD the moment it opens: an
   * agent who reloads mid-call sees the panel populated rather than blank.
   */
  useEffect(() => {
    if (screen !== 'portal') return;

    const socket = createRealtimeSocket({
      baseUrl: apiBaseUrl(),
      mintToken: async () => (await api.wsToken()).token,
      onMessage: (message) => {
        if (message.event !== AgentEvent.AI_UPDATED) return;
        // Every other agent event has a REST reader that already owns it; this
        // one has no other source, so it is the only one this socket acts on.
        setAiUpdates((current) => applyHudUpdate(current, message.data as AiHudPayload));
      },
    });

    socket.start();
    return () => {
      socket.stop();
    };
  }, [api, screen]);

  /**
   * The heartbeat loop.
   *
   * Started only when there is a token and the server's last word was a live
   * presence. The cleanup runs on unmount and on every change to those
   * conditions, so there is exactly one timer and it never outlives the intent.
   */
  useEffect(() => {
    const live = screen === 'portal' && status !== 'UNAVAILABLE';
    if (!live) return;

    const heartbeat = createHeartbeat({
      timers: window,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      beat: async () => {
        const result = await api.heartbeat();
        // The server is authoritative. If the presence expired while the tab
        // was asleep, this reports UNAVAILABLE and the effect tears the loop
        // down on the next render rather than beating into the void.
        setStatus(result.status);
        setLastSeen(result.last_seen);
      },
      onError: (caught: unknown) => {
        const message = toAgentMessage(caught);
        if (message.reauthenticate) {
          signOut();
          return;
        }
        // A transient failure is not a reason to drop the presence: the TTL
        // allows three missed beats, so the loop keeps trying.
        setError(message);
      },
    });

    heartbeat.start();
    return () => {
      heartbeat.stop();
    };
  }, [api, screen, status, signOut]);

  // One place decides which screen the work is on, and it is a pure function
  // in `lib/` tested under plain Node.
  const screenForWork = workScreen(work);

  return (
    <main className="shell">
      {screen === 'login' ? (
        <LoginForm onSubmit={signIn} busy={busy} error={error} />
      ) : (
        <>
          <AvailabilityPanel
            status={status}
            lastSeen={lastSeen}
            busy={busy}
            error={error}
            onChange={changeAvailability}
            onSignOut={signOut}
          />
          {screenForWork === WorkScreen.QUEUE ? (
            <QueuePanel
              sessions={sessions}
              loadedAt={queueLoadedAt}
              error={queueError}
              onRefresh={refresh}
              refreshing={refreshing}
              onClaim={(sessionId) => void claimSession(sessionId)}
              claiming={claiming}
            />
          ) : null}

          {screenForWork === WorkScreen.OFFER && work !== null ? (
            <OfferPanel
              sessionId={work.sessionId}
              offerExpiresAt={work.offerExpiresAt}
              nowMs={nowMs}
              onAccept={() => void acceptSession()}
              accepting={accepting}
              error={workError}
            />
          ) : null}

          {screenForWork === WorkScreen.CALL && work !== null ? (
            <>
              <CallPanel sessionId={work.sessionId} roomName={work.roomName} api={api} />
              <AiPanel sessionId={work.sessionId} updates={aiUpdates} />
              <ChecklistPanel sessionId={work.sessionId} api={api} onChange={setChecklist} />
              <VerdictPanel
                sessionId={work.sessionId}
                api={api}
                answers={checklist.answers}
                approvable={checklist.ready}
                idempotencyKey={idempotencyKeyFor(workHost, 'verdict', work.sessionId)}
                onSubmitted={() => {
                  finishWork(work.sessionId);
                }}
              />
            </>
          ) : null}

          {screenForWork === WorkScreen.CHECKING ? (
            <section className="card">
              <h2>Checking your session</h2>
              <p className="muted">Asking the server what you are holding...</p>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
