"""Cadence, in media time."""

from __future__ import annotations

import pytest

from app.analysis import Cadence, Schedule

SECOND = 1_000_000

CADENCE = Cadence(
    sample_interval_us=250_000, check_interval_us=2 * SECOND, ocr_interval_us=5 * SECOND
)


def schedule() -> Schedule:
    return Schedule(CADENCE)


class TestSampling:
    def test_the_first_frame_is_always_wanted(self) -> None:
        assert schedule().should_sample(0) is True

    def test_nothing_more_until_the_interval_has_passed(self) -> None:
        s = schedule()
        s.sampled(0)

        assert s.should_sample(50_000) is False
        assert s.should_sample(249_999) is False

    def test_the_boundary_frame_is_taken(self) -> None:
        """`>=`, so an interval landing exactly on a frame fires on that one."""
        s = schedule()
        s.sampled(0)

        assert s.should_sample(250_000) is True

    def test_a_20fps_stream_yields_4fps_of_samples(self) -> None:
        s = schedule()
        taken = 0
        for frame in range(200):  # 10 seconds at 20 fps
            ts = frame * 50_000
            if s.should_sample(ts):
                s.sampled(ts)
                taken += 1

        assert taken == 40


class TestChecks:
    def test_the_three_clocks_run_independently(self) -> None:
        s = schedule()
        s.checked(0)
        s.ran_ocr(0)

        # Two seconds on: a check is due, OCR is not.
        assert s.should_check(2 * SECOND) is True
        assert s.should_run_ocr(2 * SECOND) is False
        assert s.should_run_ocr(5 * SECOND) is True

    def test_ocr_runs_on_the_first_cycle(self) -> None:
        """So the first published result carries all three checks."""
        assert schedule().should_run_ocr(0) is True

    def test_a_ten_second_call_runs_five_checks_and_two_ocr_passes(self) -> None:
        s = schedule()
        checks = ocr = 0
        for frame in range(200):
            ts = frame * 50_000
            if not s.should_sample(ts):
                continue
            s.sampled(ts)
            if s.should_check(ts):
                s.checked(ts)
                checks += 1
                if s.should_run_ocr(ts):
                    s.ran_ocr(ts)
                    ocr += 1

        assert (checks, ocr) == (5, 2)


class TestStreamIrregularities:
    def test_a_stalled_stream_produces_no_checks(self) -> None:
        """Cadence follows media time: no frames, nothing new to check."""
        s = schedule()
        s.checked(10 * SECOND)

        assert s.should_check(10 * SECOND) is False

    def test_timestamps_going_backwards_resynchronise(self) -> None:
        """A restarted or wrapped stream must not stall every check forever."""
        s = schedule()
        s.checked(10 * SECOND)

        assert s.should_check(SECOND) is True

    @pytest.mark.parametrize("interval_us", [1, 10 * SECOND])
    def test_any_positive_interval_works(self, interval_us: int) -> None:
        s = Schedule(
            Cadence(
                sample_interval_us=interval_us,
                check_interval_us=interval_us,
                ocr_interval_us=interval_us,
            )
        )

        assert s.should_sample(0) is True
