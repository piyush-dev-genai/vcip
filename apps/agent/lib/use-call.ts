'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AgentApi } from './api';
import { callReducer, initialCallState } from './call-state';
import type { CallState } from './call-state';
import { reusableToken } from './media-token';
import type { MediaToken } from './media-token';
import { isRemoteRole } from './participants';
import { createRoom } from './room';
import type { AttachedTrack, RoomPort } from './room';

/**
 * Joining and holding the call (T25).
 *
 * The orchestration the pure modules cannot do: fetch a token, open a
 * connection, keep the reducer fed with what the SDK reports, and tear all of
 * it down when the screen goes away.
 *
 * Three rules shape it.
 *
 * **The camera stops when this unmounts.** The cleanup calls `leave()`
 * unconditionally, so leaving the call screen, signing out, or closing the tab
 * all end the capture. An agent's camera left running between verifications is
 * both a privacy problem and an obvious one to the next person at the desk.
 *
 * **A token is fetched at join time.** T24 issues an agent's token only for an
 * `IN_CALL` session and only to the assigned agent, so it is asked for when
 * the screen opens rather than held from the accept. `reusableToken` decides
 * whether one already in hand is still worth using; the fetch is a GET that
 * changes nothing, so asking again is cheap.
 *
 * **The connection state is not the session state.** Nothing here writes to the
 * Control API, and nothing here releases a session. §6 is explicit: a
 * disconnected agent keeps the session, `AGENT_DISCONNECTED` is appended, and
 * a reconnect window applies — all of which the *server* decides from LiveKit's
 * webhook (T26), never from a claim by this browser.
 */
export interface UseCallOptions {
  readonly sessionId: string;
  readonly api: AgentApi;
  readonly livekitUrl: string;
  /** Join only while the session is genuinely in the call state. */
  readonly enabled: boolean;
}

export interface UseCall {
  readonly state: CallState;
  /** The remote participant's video, or null while nobody has published one. */
  readonly remoteVideo: AttachedTrack | null;
  /** True once the remote participant's audio is attached. */
  readonly remoteAudio: AttachedTrack | null;
  /**
   * This participant's own camera, once it has been published.
   *
   * Null until then, which is most of the connecting phase — publishing
   * happens after the connection is open, so a component that tried to attach
   * a preview at mount would attach nothing.
   */
  readonly localVideo: AttachedTrack | null;
  readonly micEnabled: boolean;
  toggleMic(): void;
}

export function useCall({ sessionId, api, livekitUrl, enabled }: UseCallOptions): UseCall {
  const [state, dispatch] = useReducer(callReducer, initialCallState);
  const [remoteVideo, setRemoteVideo] = useState<AttachedTrack | null>(null);
  const [remoteAudio, setRemoteAudio] = useState<AttachedTrack | null>(null);
  const [localVideo, setLocalVideo] = useState<AttachedTrack | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);

  const roomRef = useRef<RoomPort | null>(null);
  const tokenRef = useRef<MediaToken | null>(null);
  /**
   * Guards against a second join from React's development double-effect, and
   * against a re-render racing the first connection. One tab, one room.
   */
  const joiningRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (joiningRef.current) return;
    joiningRef.current = true;

    let cancelled = false;

    const room = createRoom({
      onConnected: () => {
        if (!cancelled) dispatch({ kind: 'connected' });
      },
      onDisconnected: () => {
        if (!cancelled) dispatch({ kind: 'disconnected' });
      },
      onReconnecting: () => {
        if (!cancelled) dispatch({ kind: 'reconnecting' });
      },
      onReconnected: () => {
        if (!cancelled) dispatch({ kind: 'reconnected' });
      },
      onTrackAttached: (track) => {
        // Only the customer's tracks reach a tile. An identity this app has no
        // tile for — T30's analyzer, which publishes nothing anyway — is
        // ignored rather than rendered as an unexplained box.
        if (cancelled || !isRemoteRole(track.identity)) return;
        if (track.kind === 'video') setRemoteVideo(track);
        else setRemoteAudio(track);
      },
      onTrackDetached: (track) => {
        if (cancelled || !isRemoteRole(track.identity)) return;
        if (track.kind === 'video') setRemoteVideo(null);
        else setRemoteAudio(null);
      },
      onLocalVideo: (track) => {
        if (!cancelled) setLocalVideo(track);
      },
    });
    roomRef.current = room;

    const connect = async (): Promise<void> => {
      dispatch({ kind: 'join' });

      let token = reusableToken(tokenRef.current, Date.now());
      if (token === null) {
        try {
          token = await api.mediaToken(sessionId);
          tokenRef.current = token;
        } catch {
          // A 409 here means the session is no longer this agent's to join —
          // it left `IN_CALL`, or it was never theirs. The portal's own
          // re-read is what will say so; this only reports that the room
          // cannot be entered.
          if (!cancelled) {
            dispatch({
              kind: 'token_failed',
              message:
                'Media credentials for this session were refused. Re-read the session to see where it is.',
            });
          }
          return;
        }
      }
      if (cancelled) return;

      dispatch({ kind: 'token_ready' });

      try {
        await room.join(livekitUrl, token.token);
      } catch {
        if (!cancelled) {
          dispatch({
            kind: 'connect_failed',
            message:
              'The camera and microphone could not be connected. Check that this browser is allowed to use them, then reload the portal.',
          });
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      joiningRef.current = false;
      setRemoteVideo(null);
      setRemoteAudio(null);
      setLocalVideo(null);
      // Unconditional: the camera stops when this screen does.
      void room.leave();
      roomRef.current = null;
    };
  }, [enabled, sessionId, api, livekitUrl]);

  const toggleMic = useCallback((): void => {
    const room = roomRef.current;
    if (room === null) return;
    setMicEnabled((current) => {
      const next = !current;
      // The SDK call is fire-and-forget; the button reflects the intent, and a
      // failure leaves the participant as they were rather than throwing into
      // a click handler.
      void room.setMicrophoneEnabled(next);
      return next;
    });
  }, []);

  return { state, remoteVideo, remoteAudio, localVideo, micEnabled, toggleMic };
}
