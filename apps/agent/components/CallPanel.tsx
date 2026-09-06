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
 * The video, and the controls that belong to this participant's own devices.
 *
 * The customer fills the frame; the agent's own camera is the corner preview.
 * That is a layout decision and nothing more. What each side may publish and
 * subscribe to is enforced by the SFU from the grant the Control API signed
 * (T24, design §11.3), and no code in this app could widen it.
 *
 * It used to carry the session facts, the connection state, and a paragraph
 * apologising for the panels that had not been built yet. The facts moved to
 * the bar underneath, the connection state moved onto the picture it describes,
 * and the apology is obsolete — the AI panel, the document check, the checklist
 * and the verdict all exist and now sit in the rail beside this.
 *
 * There is still no control here that ends the session or hands it to someone
 * else. Every one of those is a state transition, and the agent's way of ending
 * a verification is the verdict. The microphone toggle is not a transition: it
 * is this participant's own device.
 */
export interface CallPanelProps {
  readonly sessionId: string;
  /** From the server. Null only if the column was somehow unset. */
  readonly roomName: string | null;
  readonly api: AgentApi;
}

export function CallPanel({ sessionId, roomName, api }: CallPanelProps) {
  const call = useCall({ sessionId, api, livekitUrl: livekitUrl(), enabled: true });
  const live = isLive(call.state);

  return (
    <>
      <div className="stage">
        <RemoteTile track={call.remoteVideo} live={live} />
        <LocalTile track={call.localVideo} />

        <p className={live ? 'stage-status is-live' : 'stage-status'} aria-live="polite">
          <span className={live ? 'dot live' : 'dot'} aria-hidden="true" />
          {callStatusText(call.state)}
        </p>
      </div>

      {/* The customer's audio has no tile: attached to a hidden element so the
          agent can hear them without a second video frame. */}
      <RemoteAudio track={call.remoteAudio} />

      <div className="callbar">
        <dl className="facts">
          <div>
            <dt>Session</dt>
            <dd title={sessionId}>{shortId(sessionId)}</dd>
          </div>
          <div>
            <dt>Room</dt>
            <dd>{roomName ?? 'none'}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={() => {
            call.toggleMic();
          }}
          disabled={!live}
          aria-pressed={!call.micEnabled}
        >
          {call.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        </button>
      </div>

      {isBusy(call.state) ? (
        <p className="hint" aria-live="polite">
          Keep this tab open while the connection is set up. Reloading brings you back here and
          rejoins the room; the session stays yours until a verdict is in.
        </p>
      ) : null}
    </>
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
