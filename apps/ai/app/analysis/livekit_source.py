"""The LiveKit frame source (T30, D23).

The only module in this service that imports `livekit.rtc`. Everything above it
speaks `FrameHandle` and `FrameSource`, so the ingest decision D23 records —
server-side subscription, verified by the T05 spike — is replaceable here
without the analysis loop noticing. That was the point of writing D23 as a
decision about ingest rather than about the pipeline.

Four things the spike established, all of them enforced below:

  1. `auto_subscribe=False`, then subscribe to the customer's **video**
     publication only. The customer's audio is never pulled: the AI has no use
     for it, and not pulling it is bandwidth and CPU never spent.
  2. Geometry is read per frame. Simulcast ramps `320x180 -> 1280x720` on one
     track, so anything latching onto the first frame's size corrupts the rest.
  3. `convert()` is expensive and belongs behind `decode()`, called only for
     sampled frames.
  4. A frame arriving is not a frame containing a picture, so the RGB24 buffer
     is length-checked against the frame's own geometry — which `Frame` does.

A fifth constraint is the host's, not the spike's: which simulcast layer to
ask for. Left alone, LiveKit sends the highest, and finding 3 above is what
that costs. `video_quality` asks for a lower one where the machine cannot
afford it — see `config.VIDEO_QUALITIES` for why this changes no answer.

The analyzer publishes nothing and holds no signing key. Its token is minted by
the Control API, scoped to one room, subscribe-only.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from livekit import rtc

from app.providers import Frame

from .frames import FrameDecodeError, FrameSourceError

logger = logging.getLogger(__name__)

#: The customer's LiveKit identity.
#:
#: `media-token.minter.ts` mints every participant with its role as its
#: identity, so this is a server-derived fact rather than a convention: the
#: analyzer subscribes to the customer because the Control API said which
#: participant is the customer, at mint time, from a verified credential.
CUSTOMER_IDENTITY = "customer"

#: `config.VIDEO_QUALITIES` translated into the SDK's enum.
#:
#: A dictionary rather than a chain of comparisons, so an unrecognised value
#: raises here instead of silently picking a layer. `AnalyzerConfig` has
#: already rejected one at boot; this is the second line of the same defence,
#: because a wrong layer is invisible in a running service.
_VIDEO_QUALITIES = {
    "low": rtc.VideoQuality.VIDEO_QUALITY_LOW,
    "medium": rtc.VideoQuality.VIDEO_QUALITY_MEDIUM,
    "high": rtc.VideoQuality.VIDEO_QUALITY_HIGH,
}


class LiveKitFrameHandle:
    """One frame from LiveKit, undecoded.

    Holds the SDK's frame object. Reading `width`, `height` and `ts_us` costs
    nothing; `decode()` is the ~23 ms the spike measured.
    """

    __slots__ = ("_frame", "_ts_us")

    def __init__(self, frame: rtc.VideoFrame, ts_us: int) -> None:
        self._frame = frame
        self._ts_us = ts_us

    @property
    def width(self) -> int:
        return self._frame.width

    @property
    def height(self) -> int:
        return self._frame.height

    @property
    def ts_us(self) -> int:
        return self._ts_us

    def decode(self) -> Frame:
        """Convert to packed RGB24.

        `bytes(...)` copies the SDK's buffer on purpose. The buffer belongs to
        the SDK and may be reused; `Frame` is a value and must own its pixels.
        """
        try:
            rgb = self._frame.convert(rtc.VideoBufferType.RGB24)
            return Frame(
                width=rgb.width,
                height=rgb.height,
                data=bytes(rgb.data),
                ts_us=self._ts_us,
            )
        except FrameDecodeError:
            raise
        except ValueError as exc:
            # `Frame` refused it — most often a buffer whose length does not
            # match the geometry it claims, which is spike finding 6.
            raise FrameDecodeError(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - the SDK's failure vocabulary is not ours
            raise FrameDecodeError(f"{type(exc).__name__}: {exc}") from exc


class LiveKitFrameSource:
    """Joins one room and yields the customer's video frames."""

    def __init__(
        self,
        *,
        url: str,
        token: str,
        room_name: str,
        track_timeout_s: float,
        video_quality: str | None = None,
        customer_identity: str = CUSTOMER_IDENTITY,
    ) -> None:
        self._url = url
        self._token = token
        self._room_name = room_name
        self._track_timeout_s = track_timeout_s
        self._video_quality = video_quality
        self._customer_identity = customer_identity
        self._room: rtc.Room | None = None
        self._stream: rtc.VideoStream | None = None
        # Set when the customer leaves, or the room drops us. Read by the
        # frame loop, which must not outlive either.
        self._ended = asyncio.Event()

    async def frames(self) -> AsyncIterator[LiveKitFrameHandle]:
        """Connect, subscribe, and yield handles until the track ends.

        Ends on either of two signals: the video stream running out, or the
        customer leaving the room. The second matters more than it looks.

        The analyzer is a participant, and `infra/livekit.yaml` closes a room
        on `empty_timeout`/`departure_timeout` — which is what stops the
        room-composite egress, because T28 deliberately has no stop call. An
        analyzer that lingered after the call would hold the room open and the
        recording with it, so leaving promptly is part of the evidence path,
        not just tidiness.
        """
        track = await self._subscribe()
        self._stream = rtc.VideoStream(track)
        frames = self._stream.__aiter__()

        while True:
            next_frame = asyncio.ensure_future(anext(frames))
            departed = asyncio.ensure_future(self._ended.wait())
            done, _ = await asyncio.wait(
                {next_frame, departed}, return_when=asyncio.FIRST_COMPLETED
            )

            if departed in done:
                next_frame.cancel()
                logger.info("customer left room %s; ending analysis", self._room_name)
                return

            departed.cancel()
            try:
                event = next_frame.result()
            except StopAsyncIteration:
                return

            yield LiveKitFrameHandle(event.frame, event.timestamp_us)

    async def _subscribe(self) -> rtc.RemoteVideoTrack:
        """Join the room and wait for the customer's video track."""
        room = rtc.Room()
        self._room = room
        tracks: asyncio.Queue[rtc.RemoteVideoTrack] = asyncio.Queue()

        def wanted(publication: rtc.RemoteTrackPublication, identity: str) -> bool:
            return identity == self._customer_identity and publication.kind == (
                rtc.TrackKind.KIND_VIDEO
            )

        def consider(publication: rtc.RemoteTrackPublication, identity: str) -> None:
            if wanted(publication, identity):
                publication.set_subscribed(True)
                prefer_quality(publication)

        def prefer_quality(publication: rtc.RemoteTrackPublication) -> None:
            """Ask for a specific simulcast layer, if one was configured.

            Best effort, and deliberately so. `set_video_quality` raises when
            the publication is not simulcasted — a publisher that sent one
            layer, or a track whose layers the server has not reported yet —
            and that is not a reason to abandon the analysis. Getting the
            default layer is slower than asking for a small one; getting no
            frames at all is the outcome this must not cause.
            """
            if self._video_quality is None:
                return
            try:
                publication.set_video_quality(_VIDEO_QUALITIES[self._video_quality])
            except Exception as exc:  # noqa: BLE001 - the SDK raises ValueError, but never fatally here
                logger.warning(
                    "could not request the %s layer in room %s (%s); taking the default",
                    self._video_quality,
                    self._room_name,
                    type(exc).__name__,
                )

        @room.on("track_published")
        def _on_published(publication: rtc.RemoteTrackPublication, participant: object) -> None:
            consider(publication, getattr(participant, "identity", ""))

        @room.on("participant_disconnected")
        def _on_participant_left(participant: object) -> None:
            if getattr(participant, "identity", "") == self._customer_identity:
                self._ended.set()

        @room.on("disconnected")
        def _on_room_disconnected(*_: object) -> None:
            self._ended.set()

        @room.on("track_subscribed")
        def _on_subscribed(
            track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: object
        ) -> None:
            if isinstance(track, rtc.RemoteVideoTrack) and (
                getattr(participant, "identity", "") == self._customer_identity
            ):
                tracks.put_nowait(track)

        try:
            await room.connect(self._url, self._token, rtc.RoomOptions(auto_subscribe=False))
        except Exception as exc:  # noqa: BLE001 - any join failure is the same outcome here
            await self.aclose()
            raise FrameSourceError(
                f"could not join room {self._room_name}: {type(exc).__name__}"
            ) from exc

        # Whoever was already in the room when we arrived. A late analyzer —
        # the Control API calls this after both parties have joined — is the
        # normal case, not the exception, so this is the path that usually
        # finds the track.
        for participant in room.remote_participants.values():
            for publication in participant.track_publications.values():
                consider(publication, participant.identity)

        try:
            return await asyncio.wait_for(tracks.get(), timeout=self._track_timeout_s)
        except TimeoutError:
            await self.aclose()
            raise FrameSourceError(
                f"no customer video in {self._room_name} within {self._track_timeout_s}s"
            ) from None

    async def aclose(self) -> None:
        """Close the stream and leave the room.

        Safe to call twice: the manager closes a finished run, and the failure
        paths above close before raising.
        """
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                await stream.aclose()
            except Exception as exc:  # noqa: BLE001 - teardown must not raise
                logger.debug("video stream close failed: %s", exc)

        room, self._room = self._room, None
        if room is not None:
            try:
                await room.disconnect()
            except Exception as exc:  # noqa: BLE001 - teardown must not raise
                logger.debug("room disconnect failed: %s", exc)
