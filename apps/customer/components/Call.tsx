'use client';

import { useEffect, useRef } from 'react';
import type { SessionApi } from '@/lib/api';
import { callStatusText, isBusy, isLive } from '@/lib/call-state';
import { livekitUrl } from '@/lib/config';
import { labelFor, CallRole } from '@/lib/participants';
import type { AttachedTrack } from '@/lib/room';
import type { SessionView } from '@/lib/session';
import { useCall } from '@/lib/use-call';

/**
 * Screen 5 — the call (T25).
 *
 * Reached only when the server says `IN_CALL`. That is the whole entry
 * condition: an agent accepted (T19), so both parties belong in the room, and
 * this screen does not decide or assert anything about the session itself.
 *
 * What it deliberately does not have is an "End call" button. Ending a
 * verification is a state transition, and the only one that exists for a
 * customer is the abort T12 already implements — which is the button below,
 * labelled as what it does. The agent's side of ending a call is the verdict,
 * and that is T35.
 *
 * The remote tile is the agent, per design §11.3. Both parties publish camera
 * and microphone; the roles differ in what the screen makes large, not in what
 * the token allows — that is enforced by the SFU from the grant the Control API
 * signed, and no code here could widen it.
 */
export function Call({
  session,
  api,
  busy,
  onAbort,
}: {
  session: SessionView;
  api: SessionApi;
  busy: boolean;
  onAbort: () => void;
}) {
  const call = useCall({
    sessionId: session.session_id,
    api,
    livekitUrl: livekitUrl(),
    enabled: true,
  });

  const live = isLive(call.state);

  return (
    <section className="card call">
      <p className="step">Live verification</p>
      <h1>You are with an agent</h1>

      <div className="stage">
        <RemoteTile track={call.remoteVideo} live={live} />
        <LocalTile track={call.localVideo} />

        {/* On the picture rather than under it. On a phone the stage already
            fills the screen, and a status line below the fold is a status line
            nobody reads. */}
        <p className={live ? 'stage-status is-live' : 'stage-status'} aria-live="polite">
          <span className={live ? 'dot live' : 'dot'} aria-hidden="true" />
          {callStatusText(call.state)}
        </p>
      </div>

      {/* The agent's audio has no tile: it is attached to a hidden element so
          the customer can hear them without a second video frame. */}
      <RemoteAudio track={call.remoteAudio} />

      <p className="muted">
        Please stay on this screen. Show your face and your identity document when the agent asks.
      </p>

      <div className="actions inline">
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
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onAbort();
          }}
        >
          Stop verification
        </button>
      </div>

      {isBusy(call.state) ? (
        <p className="hint" aria-live="polite">
          Keep this page open while the connection is set up.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The agent's video.
 *
 * Attached through an effect rather than at render, because attaching is a
 * side effect on a DOM node and the track can arrive before or after the
 * element exists. The detach in the cleanup is what stops a stale track
 * holding on to an element React has already discarded.
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
      <video ref={ref} autoPlay playsInline aria-label={labelFor(CallRole.AGENT)} />
      {track === null ? (
        <figcaption className="muted">
          {live ? 'Waiting for the agent’s camera…' : 'Connecting…'}
        </figcaption>
      ) : (
        <figcaption>{labelFor(CallRole.AGENT)}</figcaption>
      )}
    </figure>
  );
}

/** The customer's own camera. Muted: a self-preview must never echo. */
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
      <video ref={ref} autoPlay playsInline muted aria-label={labelFor(CallRole.CUSTOMER)} />
      <figcaption>{labelFor(CallRole.CUSTOMER)}</figcaption>
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
