"""The frame value object every provider is given.

A `Frame` is decoded pixels and nothing else. It carries no LiveKit object, no
track, no buffer view — T30 owns ingestion and hands this layer plain bytes, so
that swapping the frame source (D23) or the model vendor changes one side of
this seam without touching the other.

Pixels are packed RGB24: three bytes per pixel, rows in order, no padding. That
is what the T05 spike's `frame.convert(RGB24)` produces and what a provider can
read without knowing anything about video.

The geometry is per frame, not per stream. Simulcast starts on a low layer and
ramps up, so a session's frames legitimately change size mid-call (D23). A
`Frame` therefore states its own width and height, and the byte-length check
below is what stops a caller from pairing new pixels with stale dimensions.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

RGB24_BYTES_PER_PIXEL = 3


@dataclass(frozen=True, slots=True)
class Frame:
    """One decoded video frame.

    Attributes:
        width: Pixel width, positive.
        height: Pixel height, positive.
        data: Packed RGB24 pixels, exactly `width * height * 3` bytes.
        ts_us: Media timestamp in microseconds, as LiveKit reports it. Named
            for its unit because the difference between microseconds and
            seconds is a thousandfold bug that no type would catch.
    """

    width: int
    height: int
    data: bytes
    ts_us: int

    def __post_init__(self) -> None:
        _require_positive("width", self.width)
        _require_positive("height", self.height)

        if not isinstance(self.ts_us, int) or isinstance(self.ts_us, bool):
            raise TypeError(f"ts_us must be an int, got {type(self.ts_us).__name__}")
        if self.ts_us < 0:
            raise ValueError(f"ts_us must not be negative, got {self.ts_us}")

        if not isinstance(self.data, bytes):
            # The LiveKit SDK hands out a buffer, not bytes, and the T05 spike
            # already had to write bytes(rgb.data). Copying stays the caller's
            # job: a frame holding a view of a buffer the SDK reuses is not a
            # value, and this object promises to be one.
            raise TypeError(
                f"data must be bytes, got {type(self.data).__name__}"
                " - copy the SDK buffer with bytes(...)"
            )

        expected = self.width * self.height * RGB24_BYTES_PER_PIXEL
        if len(self.data) != expected:
            raise ValueError(
                f"data is {len(self.data)} bytes; {self.width}x{self.height} RGB24 "
                f"needs exactly {expected}"
            )

    @property
    def pixel_count(self) -> int:
        """Pixels in the frame. Providers use it to compare frame sizes."""
        return self.width * self.height


def _require_positive(name: str, value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    if value <= 0:
        raise ValueError(f"{name} must be positive, got {value}")


def require_frames(frames: Sequence[Frame]) -> Sequence[Frame]:
    """Reject a frame sequence no provider could have been meant to receive.

    This raises rather than returning `UNAVAILABLE`. Being handed nothing to
    look at is a fault in the caller, and an AI service that answered "model
    unavailable" would send the agent chasing an outage that does not exist.
    """
    if isinstance(frames, (str, bytes)) or not isinstance(frames, Sequence):
        raise TypeError(f"frames must be a sequence of Frame, got {type(frames).__name__}")
    if not frames:
        raise ValueError("frames must not be empty")
    for index, frame in enumerate(frames):
        if not isinstance(frame, Frame):
            raise TypeError(f"frames[{index}] must be a Frame, got {type(frame).__name__}")
    return frames


def require_frame(frame: Frame) -> Frame:
    """Reject anything that is not a single decoded frame."""
    if not isinstance(frame, Frame):
        raise TypeError(f"frame must be a Frame, got {type(frame).__name__}")
    return frame
