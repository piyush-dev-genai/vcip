'use client';

import { useEffect, useRef } from 'react';
import type { AgentApi } from '../lib/api';
import { callStatusText, isBusy, isLive } from '../lib/call-state';
import { livekitUrl } from '../lib/config';
import { CallRole, labelFor } from '../lib/participants';
import { shortId } from '../lib/queue';
import type { AttachedTrack } from '../lib/room';
import { useCall } from '../lib/use-call';

/**
 * The session this agent has accepted, with the call in it (T25).
 *
 * T21 left this as an honest placeholder: the session was genuinely `IN_CALL`
 * and the room name was genuinely the one the row had carried since creation,
 * but there was no video, because joining a room was a later task. This is that
 * task, and the placeholder's caveat is now only about what remains — the AI
 * panel (T31), the checklist (T33) and the verdict (T35).
 *
 * The customer fills the frame; the agent's own camera is the corner preview.
 * That is a layout decision and nothing more. What each side may publish and
 * subscribe to is enforced by the SFU from the grant the Control API signed
 * (T24, design §11.3), and no code in this app could widen it.
 *
 * There is still no control here that ends the session or hands it to someone
 * else. Every one of those is a state transition, and none of them exists yet —
 * the agent's way of ending a verification is the verdict, which is T35. The
 * microphone toggle is not a transition: it is this participant's own device.
 */
export interface CallPanelProps {
  readonly sessionId: string;
  /** From the server. Null only if the column was somehow unset. */
  readonly roomName: string | null;
  readonly api: AgentApi;
}

export function CallPanel({ sessionId, roomName, api }: CallPanelProps) {
  const call = useCall({ sessionId, api, livekitUrl: livekitUrl(), enabled: true });

  return (
    <section className="card call">
      <h2>In call</h2>

      <div className="stage">
        <RemoteTile track={call.remoteVideo} live={isLive(call.state)} />
        <LocalTile track={call.localVideo} />
      </div>

      {/* The customer's audio has no tile: attached to a hidden element so the
          agent can hear them without a second video frame. */}
      <RemoteAudio track={call.remoteAudio} />

      <p className={isLive(call.state) ? 'notice ok' : 'notice'} aria-live="polite">
        {callStatusText(call.state)}
      </p>

      <dl className="facts">
        <div>
          <dt>Session</dt>
          <dd title={sessionId}>{shortId(sessionId)}</dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd className="room">{roomName ?? 'none'}</dd>
        </div>
      </dl>

      <div className="actions">
        <button
          type="button"
          onClick={() => {
            call.toggleMic();
          }}
          disabled={!isLive(call.state)}
          aria-pressed={!call.micEnabled}
        >
          {call.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        </button>
      </div>

      <p className="muted">
        The AI panel, the checklist and the verdict arrive in later steps. The video above is live.
      </p>

      <p className="ref">
        Reloading this page brings you back here and rejoins the room. The session stays yours until
        it is completed.
      </p>

      {isBusy(call.state) ? (
        <p className="muted" aria-live="polite">
          Keep this tab open while the connection is set up.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The customer's video.
 *
 * Attached through an effect rather than at render, because attaching is a side
 * effect on a DOM node and the track can arrive before or after the element
 * exists. The detach in the cleanup is what stops a stale track holding on to
 * an element React has already discarded.
 */
function RemoteTile({ track, live }: { track: AttachedTrack | null; live: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || track === null) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <figure className="tile remote">
      <video ref={ref} autoPlay playsInline aria-label={labelFor(CallRole.CUSTOMER)} />
      {track === null ? (
        <figcaption className="muted">
          {live ? 'Waiting for the customer’s camera…' : 'Connecting…'}
        </figcaption>
      ) : (
        <figcaption>{labelFor(CallRole.CUSTOMER)}</figcaption>
      )}
    </figure>
  );
}

/** The agent's own camera. Muted: a self-preview must never echo. */
function LocalTile({ track }: { track: AttachedTrack | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || track === null) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <figure className="tile local">
      <video ref={ref} autoPlay playsInline muted aria-label={labelFor(CallRole.AGENT)} />
      <figcaption>{labelFor(CallRole.AGENT)}</figcaption>
    </figure>
  );
}

function RemoteAudio({ track }: { track: AttachedTrack | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || track === null) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return <audio ref={ref} autoPlay />;
}
