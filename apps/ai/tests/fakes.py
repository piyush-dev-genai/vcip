"""Test doubles for the analysis path.

The seams T30 builds are worth exactly as much as what can be tested through
them, so these are deliberately small: a source that yields frames from a list,
a publisher that keeps what it was given, and a source that fails the way a
real one does.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Sequence

from app.analysis import FrameDecodeError, FrameSourceError
from app.providers import Frame


class FakeFrameHandle:
    """A handle over an already-decoded frame, counting its own decodes."""

    def __init__(self, frame: Frame, *, fails: bool = False) -> None:
        self._frame = frame
        self._fails = fails
        self.decoded = 0

    @property
    def width(self) -> int:
        return self._frame.width

    @property
    def height(self) -> int:
        return self._frame.height

    @property
    def ts_us(self) -> int:
        return self._frame.ts_us

    def decode(self) -> Frame:
        self.decoded += 1
        if self._fails:
            raise FrameDecodeError("synthetic decode failure")
        return self._frame


class FakeFrameSource:
    """Yields a fixed list of handles, then ends — like a track closing."""

    def __init__(self, handles: Iterable[FakeFrameHandle]) -> None:
        self.handles = list(handles)
        self.closed = 0

    async def frames(self) -> AsyncIterator[FakeFrameHandle]:
        for handle in self.handles:
            yield handle

    async def aclose(self) -> None:
        self.closed += 1


class FailingFrameSource:
    """Never yields: the room could not be joined, or no video arrived."""

    def __init__(self, reason: str = "no customer video") -> None:
        self.reason = reason
        self.closed = 0

    async def frames(self) -> AsyncIterator[FakeFrameHandle]:
        raise FrameSourceError(self.reason)
        yield  # pragma: no cover - makes this an async generator

    async def aclose(self) -> None:
        self.closed += 1


class RecordingPublisher:
    """Keeps every payload it is handed."""

    def __init__(self, fail_times: int = 0, document_fail_times: int = 0) -> None:
        self.published: list[dict[str, object]] = []
        # Kept apart from `published` because they go to different routes and
        # update different parts of the HUD. A test asserting a document result
        # must not be satisfied by a sampled one that happens to be nearby.
        self.documents: list[dict[str, object]] = []
        self.closed = 0
        self._fail_times = fail_times
        self._document_fail_times = document_fail_times

    async def publish(self, payload: dict[str, object]) -> None:
        if self._fail_times > 0:
            from app.analysis import PublishError

            self._fail_times -= 1
            raise PublishError("synthetic publish failure")
        self.published.append(payload)

    async def publish_document(self, payload: dict[str, object]) -> None:
        if self._document_fail_times > 0:
            from app.analysis import PublishError

            self._document_fail_times -= 1
            raise PublishError("synthetic document publish failure")
        self.documents.append(payload)

    async def aclose(self) -> None:
        self.closed += 1


def handles(
    count: int,
    *,
    interval_us: int = 50_000,
    width: int = 4,
    height: int = 4,
) -> list[FakeFrameHandle]:
    """A stream of `count` frames, one every `interval_us` of media time.

    50 ms apart by default: 20 fps, which is what the T05 spike measured a real
    browser publisher delivering.
    """
    return [
        FakeFrameHandle(
            Frame(
                width=width,
                height=height,
                data=bytes([index % 256]) * (width * height * 3),
                ts_us=index * interval_us,
            )
        )
        for index in range(count)
    ]


def frames_of(handles_: Sequence[FakeFrameHandle]) -> list[Frame]:
    return [handle.decode() for handle in handles_]
