"""The frame value object."""

from __future__ import annotations

import dataclasses

import pytest

from app.providers import Frame, require_frame, require_frames
from tests.helpers import frame


def test_holds_geometry_pixels_and_timestamp() -> None:
    f = frame(width=2, height=3, ts_us=1_234_567)

    assert (f.width, f.height, f.ts_us) == (2, 3, 1_234_567)
    assert f.pixel_count == 6
    assert len(f.data) == 2 * 3 * 3


def test_is_immutable_and_comparable_by_value() -> None:
    original = frame()

    with pytest.raises(dataclasses.FrozenInstanceError):
        original.width = 8  # type: ignore[misc]

    assert original == frame()
    assert {original, frame()} == {original}


def test_two_frames_in_one_session_may_differ_in_size() -> None:
    """Simulcast ramps the layer mid-stream, so geometry is per frame (D23)."""
    low = frame(width=320, height=180, ts_us=0)
    high = frame(width=1280, height=720, ts_us=50_000)

    assert low.pixel_count < high.pixel_count


@pytest.mark.parametrize("delta", [-3, 3])
def test_rejects_pixels_that_do_not_match_the_stated_size(delta: int) -> None:
    with pytest.raises(ValueError, match="RGB24"):
        Frame(width=4, height=4, data=b"\x00" * (4 * 4 * 3 + delta), ts_us=0)


@pytest.mark.parametrize("bad", [0, -1])
def test_rejects_non_positive_dimensions(bad: int) -> None:
    with pytest.raises(ValueError, match="must be positive"):
        Frame(width=bad, height=4, data=b"", ts_us=0)


def test_rejects_a_boolean_dimension() -> None:
    """`True` is an `int` in Python; a 1-pixel-wide frame is not what was meant."""
    with pytest.raises(TypeError, match="width must be an int"):
        Frame(width=True, height=4, data=b"\x00" * 12, ts_us=0)  # type: ignore[arg-type]


def test_rejects_a_negative_timestamp() -> None:
    with pytest.raises(ValueError, match="ts_us must not be negative"):
        Frame(width=1, height=1, data=b"\x00" * 3, ts_us=-1)


def test_rejects_seconds_where_microseconds_belong() -> None:
    """A float timestamp is the 1000x unit bug arriving; refuse it outright."""
    with pytest.raises(TypeError, match="ts_us must be an int"):
        Frame(width=1, height=1, data=b"\x00" * 3, ts_us=1.5)  # type: ignore[arg-type]


def test_rejects_pixels_that_are_not_bytes() -> None:
    with pytest.raises(TypeError, match="data must be bytes"):
        Frame(width=1, height=1, data=[0, 0, 0], ts_us=0)  # type: ignore[arg-type]


@pytest.mark.parametrize("buffer", [bytearray(12), memoryview(bytes(12))])
def test_rejects_an_sdk_buffer_and_says_how_to_convert_it(buffer: object) -> None:
    """What LiveKit actually hands over; the T05 spike had to write bytes(rgb.data)."""
    with pytest.raises(TypeError, match=r"copy the SDK buffer with bytes\(\.\.\.\)"):
        Frame(width=2, height=2, data=buffer, ts_us=0)  # type: ignore[arg-type]


def test_a_frame_does_not_alias_a_buffer_the_sdk_may_reuse() -> None:
    source = bytearray(12)
    held = Frame(width=2, height=2, data=bytes(source), ts_us=0)

    source[0] = 255

    assert held.data[0] == 0


class TestRequireFrames:
    def test_returns_a_valid_sequence(self) -> None:
        sequence = [frame(), frame(ts_us=1)]

        assert require_frames(sequence) is sequence

    def test_rejects_an_empty_sequence(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            require_frames([])

    def test_rejects_a_non_frame_element(self) -> None:
        with pytest.raises(TypeError, match=r"frames\[1\] must be a Frame"):
            require_frames([frame(), "not a frame"])  # type: ignore[list-item]

    def test_rejects_bytes_masquerading_as_a_sequence(self) -> None:
        with pytest.raises(TypeError, match="must be a sequence of Frame"):
            require_frames(b"\x00\x01")  # type: ignore[arg-type]


def test_require_frame_rejects_a_non_frame() -> None:
    with pytest.raises(TypeError, match="frame must be a Frame"):
        require_frame(None)  # type: ignore[arg-type]
