"""Getting frames without paying for the ones we discard (T30).

The T05 spike's fourth finding is the shape of this file. Converting I420 to
RGB24 costs ~23 ms at 720p; at the ~20 fps a real call delivers, converting
every frame spends a whole core on one customer. Liveness and face match need
a few frames per second, so the rest must never be converted at all.

That is why a source yields **handles** rather than frames. A handle is what
arrived — geometry and a timestamp, both free — and `decode()` is the
expensive part, called only for the frames the schedule actually keeps. A
source that returned `Frame` objects would have done the work before anyone
could decline it.

The window is what liveness reads. It holds decoded frames because they have
already been paid for, and it is small: a couple of seconds of samples, not a
recording. `03-system-design.md` §16 — frames stay in memory and none of them
are persisted.
"""

from __future__ import annotations

from collections import deque
from collections.abc import AsyncIterator, Sequence
from typing import Protocol, runtime_checkable

from app.providers import Frame


@runtime_checkable
class FrameHandle(Protocol):
    """One frame that has arrived, not yet decoded.

    Geometry is read per handle rather than latched from the first one:
    simulcast starts on a low layer and ramps up, so a call's frames change
    size mid-stream (D23).
    """

    @property
    def width(self) -> int: ...

    @property
    def height(self) -> int: ...

    @property
    def ts_us(self) -> int:
        """Media timestamp in microseconds, as the SDK reports it."""
        ...

    def decode(self) -> Frame:
        """Convert to packed RGB24. The expensive call this file exists to ration.

        Raises:
            FrameDecodeError: The buffer could not be converted.
        """
        ...


class FrameDecodeError(Exception):
    """A frame arrived but could not be turned into pixels.

    Expected, not exceptional: a truncated buffer or a codec hiccup is one bad
    frame in a stream of thousands. The loop drops it and reads the next one.
    """


@runtime_checkable
class FrameSource(Protocol):
    """Where an analysis gets its frames.

    One method, and it is an async iterator, because that is what both a
    LiveKit video stream and a test list are. The loop above it never learns
    which it got.
    """

    def frames(self) -> AsyncIterator[FrameHandle]:
        """Yield handles until the track ends."""
        ...

    async def aclose(self) -> None:
        """Release the stream and any connection behind it."""
        ...


class FrameWindow:
    """The recent decoded frames liveness reads.

    A bounded deque, so the memory a call holds does not grow with its length.
    Frames are evidence of movement over a few seconds, and a longer history
    would answer a question nobody asks while costing memory per concurrent
    call.
    """

    def __init__(self, capacity: int) -> None:
        if capacity < 2:
            # Liveness over one frame is liveness over a photograph. A window
            # that cannot hold two would make every check UNKNOWN.
            raise ValueError(f"capacity must be at least 2, got {capacity}")
        self._frames: deque[Frame] = deque(maxlen=capacity)

    @property
    def capacity(self) -> int:
        return self._frames.maxlen or 0

    def add(self, frame: Frame) -> None:
        self._frames.append(frame)

    def newest(self) -> Frame | None:
        """The most recent frame, for the single-frame checks."""
        return self._frames[-1] if self._frames else None

    def snapshot(self) -> Sequence[Frame]:
        """The window as a sequence, for the checks that read a span of time."""
        return tuple(self._frames)

    def __len__(self) -> int:
        return len(self._frames)


class FrameSourceError(Exception):
    """Frames could not be obtained at all.

    The room could not be joined, or the customer's video never arrived. Unlike
    `FrameDecodeError` this ends the analysis: there is no next frame to try.
    It is still not an error the call should feel (D6) — the agent is told the
    AI has nothing and carries on.
    """
