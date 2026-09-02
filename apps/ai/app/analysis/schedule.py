"""When to sample, when to check, when to read a document (T30).

Pure, and driven by the frames' own timestamps rather than by a wall clock.

That choice is deliberate. Cadence expressed in media time means the loop
advances only when media does: a stalled stream produces no checks, which is
correct, because there is nothing new to check. It also makes every decision in
this file testable by handing it numbers, with no clock to freeze, no sleeps,
and no flakiness on a loaded machine — the same reason the rules files in the
Control API are separated from the services that use them.

LiveKit's `timestamp_us` has an arbitrary origin but advances with the media,
which is why everything here is relative to the first frame seen.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Cadence:
    """The three intervals, in microseconds of media time."""

    sample_interval_us: int
    check_interval_us: int
    ocr_interval_us: int


class Schedule:
    """Decides what a given frame is for.

    Three independent clocks rather than one counter, because the checks run at
    genuinely different rates and a shared tick would force the slowest to
    divide evenly into the fastest.
    """

    def __init__(self, cadence: Cadence) -> None:
        self._cadence = cadence
        self._last_sample_us: int | None = None
        self._last_check_us: int | None = None
        self._last_ocr_us: int | None = None

    def should_sample(self, ts_us: int) -> bool:
        """Whether this frame is worth decoding.

        The first frame always is: a call should not wait a sampling interval
        to have anything at all in the window.
        """
        return self._due(self._last_sample_us, ts_us, self._cadence.sample_interval_us)

    def sampled(self, ts_us: int) -> None:
        self._last_sample_us = ts_us

    def should_check(self, ts_us: int) -> bool:
        """Whether liveness and face match are due."""
        return self._due(self._last_check_us, ts_us, self._cadence.check_interval_us)

    def checked(self, ts_us: int) -> None:
        self._last_check_us = ts_us

    def should_run_ocr(self, ts_us: int) -> bool:
        """Whether OCR is due.

        True on the first cycle, so the very first result published carries a
        value for all three checks rather than a hole the HUD has to render as
        "not yet". After that it falls to its own slower interval.
        """
        return self._due(self._last_ocr_us, ts_us, self._cadence.ocr_interval_us)

    def ran_ocr(self, ts_us: int) -> None:
        self._last_ocr_us = ts_us

    @staticmethod
    def _due(last_us: int | None, now_us: int, interval_us: int) -> bool:
        if last_us is None:
            return True
        # `>=` so an interval that lands exactly on a frame boundary fires on
        # that frame rather than the next one.
        if now_us >= last_us + interval_us:
            return True
        # A stream whose timestamps go backwards has restarted or wrapped.
        # Treating that as due resynchronises rather than stalling every check
        # for the rest of the call.
        return now_us < last_us
