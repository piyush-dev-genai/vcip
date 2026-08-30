'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueuedSession } from '../lib/api';
import { createAgentApi } from '../lib/api';
import { apiBaseUrl, HEARTBEAT_INTERVAL_MS } from '../lib/config';
import type { AgentMessage } from '../lib/errors';
import { toAgentMessage, toLoginMessage } from '../lib/errors';
import { createHeartbeat } from '../lib/heartbeat';
import type { PresenceStatus } from '../lib/presence';
import { QUEUE_REFRESH_INTERVAL_MS } from '../lib/queue';
import { browserTokenHost, clearToken, isExpired, readToken, writeToken } from '../lib/token';
import { AvailabilityPanel } from './AvailabilityPanel';
import { LoginForm } from './LoginForm';
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
 * State lives here and the screens are presentational, so the lifecycle
 * rules are in one file. The pieces worth testing on their own — the token
 * store, the API client, the scheduler, the selectable-status list — are in
 * `lib/` and tested there under plain Node.
 */

type Screen = 'login' | 'portal';

export function AgentPortal() {
  const host = useMemo(() => browserTokenHost(), []);
  const [screen, setScreen] = useState<Screen>('login');
  const [status, setStatus] = useState<PresenceStatus>('UNAVAILABLE');
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AgentMessage | null>(null);
  const [sessions, setSessions] = useState<readonly QueuedSession[]>([]);
  const [queueLoadedAt, setQueueLoadedAt] = useState<number | null>(null);
  const [queueError, setQueueError] = useState<AgentMessage | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * The token in a ref, not in state.
   *
   * The API client reads it at call time through this ref, so a request issued
   * by a timer always sees the current credential rather than the one captured
   * when the effect was created. It is also why signing out takes effect on the
   * very next beat.
   */
  const token = useRef<string | null>(null);

  const api = useMemo(
    () => createAgentApi({ baseUrl: apiBaseUrl(), token: () => token.current }),
    [],
  );

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
  }, [host]);

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
  }, [host]);

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
      } catch (caught) {
        setError(toLoginMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [api, host],
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
          <QueuePanel
            sessions={sessions}
            loadedAt={queueLoadedAt}
            error={queueError}
            onRefresh={refresh}
            refreshing={refreshing}
          />
        </>
      )}
    </main>
  );
}
