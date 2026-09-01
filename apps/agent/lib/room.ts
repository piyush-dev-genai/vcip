/**
 * The LiveKit room, behind a port (T25).
 *
 * The seam exists for the reason the Control API's `MediaTokenMinter` does: the
 * logic above it — when to fetch a token, what phase the call is in, which tile
 * is large — is worth testing without a camera, an SFU, or a browser, and none
 * of it should have to import a WebRTC SDK to be exercised.
 *
 * `livekit-client` is imported exactly once, here. Everything else in this app
 * talks to `RoomPort`, so swapping the SFU or stubbing it in a test is a change
 * to this file and to nothing else.
 *
 * What this file does *not* do: decide anything. It cannot widen a permission —
 * the grants are in the token the server signed (T24) and are enforced by the
 * SFU — and it does not know what a session is, what a status means, or when a
 * verification is over.
 */

import { Room, RoomEvent, Track } from 'livekit-client';
import type {
  LocalTrackPublication,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

/** A video or audio track attached to a participant, as the screen needs it. */
export interface AttachedTrack {
  readonly identity: string;
  readonly kind: 'video' | 'audio';
  /** Attaches the track to a media element. The SDK owns the element's source. */
  attach(element: HTMLMediaElement): void;
  detach(element: HTMLMediaElement): void;
}

/** What the room reports upward. Deliberately small. */
export interface RoomCallbacks {
  onConnected(): void;
  onDisconnected(): void;
  onReconnecting(): void;
  onReconnected(): void;
  /** A remote track arrived and can be attached. */
  onTrackAttached(track: AttachedTrack): void;
  /** A remote track went away and must be detached. */
  onTrackDetached(track: AttachedTrack): void;
  /**
   * This participant's own camera was published and can be previewed.
   *
   * Reported through a callback rather than fetched on demand, because
   * publishing happens after `join()` resolves: a caller that asked for the
   * camera at mount would get nothing and never be told otherwise. That was a
   * real defect — the self-preview stayed black while the call was live.
   */
  onLocalVideo(track: AttachedTrack | null): void;
}

export interface RoomPort {
  /**
   * Join the room and publish this role's own camera and microphone.
   *
   * One call rather than connect-then-publish, because a connected participant
   * publishing nothing is not a state this product has any use for: both roles
   * in a V-CIP call are two-way by design (§11.3).
   */
  join(url: string, token: string): Promise<void>;
  leave(): Promise<void>;
  /** Local mute control. The customer may silence themselves; nobody else can. */
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
}

/** Anything the SDK can attach to a media element: local or remote. */
interface Attachable {
  attach(element: HTMLMediaElement): void;
  detach(element: HTMLMediaElement): void;
}

const kindOf = (track: RemoteTrack): 'video' | 'audio' | null => {
  if (track.kind === Track.Kind.Video) return 'video';
  if (track.kind === Track.Kind.Audio) return 'audio';
  return null;
};

const wrap = (track: Attachable, identity: string, kind: 'video' | 'audio'): AttachedTrack => ({
  identity,
  kind,
  attach: (element) => {
    track.attach(element);
  },
  detach: (element) => {
    track.detach(element);
  },
});

/**
 * The real room.
 *
 * `adaptiveStream` and `dynacast` are on: an agent may hold several tabs on
 * one workstation, and sending layers nobody is rendering wastes bandwidth the
 * customer's own connection is usually the scarcer half of.
 */
export function createRoom(callbacks: RoomCallbacks): RoomPort {
  const room = new Room({ adaptiveStream: true, dynacast: true });

  room
    .on(RoomEvent.Connected, () => {
      callbacks.onConnected();
    })
    .on(RoomEvent.Disconnected, () => {
      callbacks.onDisconnected();
    })
    .on(RoomEvent.Reconnecting, () => {
      callbacks.onReconnecting();
    })
    .on(RoomEvent.Reconnected, () => {
      callbacks.onReconnected();
    })
    .on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        _publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        const kind = kindOf(track);
        if (kind === null) return;
        callbacks.onTrackAttached(wrap(track, participant.identity, kind));
      },
    )
    .on(
      RoomEvent.TrackUnsubscribed,
      (
        track: RemoteTrack,
        _publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        const kind = kindOf(track);
        if (kind === null) return;
        callbacks.onTrackDetached(wrap(track, participant.identity, kind));
      },
    )
    .on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.Camera) return;
      const track = publication.videoTrack;
      if (track === undefined) return;
      callbacks.onLocalVideo(wrap(track, room.localParticipant.identity, 'video'));
    })
    .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.Camera) return;
      callbacks.onLocalVideo(null);
    });

  return {
    async join(url, token) {
      await room.connect(url, token);
      // The grant already says this participant may publish (T24). Asking the
      // browser for the devices is a separate permission, from the person.
      await room.localParticipant.enableCameraAndMicrophone();
    },

    async setMicrophoneEnabled(enabled) {
      await room.localParticipant.setMicrophoneEnabled(enabled);
    },

    async leave() {
      // Stops the camera and microphone as well as closing the connection.
      // Leaving a screen must not leave a capture light on.
      await room.disconnect();
    },
  };
}
