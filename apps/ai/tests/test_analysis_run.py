"""One call's analysis loop."""

from __future__ import annotations

from dataclasses import replace

import pytest

from app.analysis import (
    ENDED_SOURCE_FAILED,
    ENDED_TRACK_CLOSED,
    AnalysisRun,
    Cadence,
    NullResultPublisher,
)
from app.providers import (
    LivenessStatus,
    MockLivenessProvider,
    OcrStatus,
    ProviderMode,
    ProviderSet,
    build_providers,
)
from tests.fakes import (
    FailingFrameSource,
    FakeFrameSource,
    RecordingPublisher,
    handles,
)
from tests.helpers import run

SESSION = "11111111-2222-3333-4444-555555555555"

#: 20 fps in, 4 fps sampled, a check every 2 s, OCR every 5 s — the defaults.
CADENCE = Cadence(
    sample_interval_us=250_000, check_interval_us=2_000_000, ocr_interval_us=5_000_000
)


def analysis(
    source: FakeFrameSource | FailingFrameSource,
    publisher: RecordingPublisher | NullResultPublisher,
    *,
    providers: ProviderSet | None = None,
    cadence: Cadence = CADENCE,
) -> AnalysisRun:
    return AnalysisRun(
        session_id=SESSION,
        providers=providers or build_providers({}),
        source=source,
        publisher=publisher,
        cadence=cadence,
    )


class TestSampling:
    """The spike's fourth finding: do not convert every frame."""

    def test_decodes_only_the_sampled_frames(self) -> None:
        # 200 frames at 20 fps is 10 seconds; at 4 fps only 40 are wanted.
        source = FakeFrameSource(handles(200))

        outcome = run(analysis(source, RecordingPublisher()).run())

        assert outcome.frames_seen == 200
        assert outcome.frames_sampled == 40

    def test_the_frames_it_skips_are_never_decoded(self) -> None:
        """Skipping after decoding would spend the CPU this rations."""
        source = FakeFrameSource(handles(200))

        run(analysis(source, RecordingPublisher()).run())

        decoded = sum(handle.decoded for handle in source.handles)
        assert decoded == 40
        assert sum(1 for handle in source.handles if handle.decoded == 0) == 160

    def test_samples_the_very_first_frame(self) -> None:
        """A call should not wait a sampling interval to have anything at all."""
        source = FakeFrameSource(handles(1))

        run(analysis(source, RecordingPublisher()).run())

        assert source.handles[0].decoded == 1

    def test_a_slower_stream_still_samples_every_frame(self) -> None:
        # Simulcast ramping, a weak uplink: fewer frames than the sample rate.
        source = FakeFrameSource(handles(10, interval_us=500_000))

        outcome = run(analysis(source, RecordingPublisher()).run())

        assert outcome.frames_sampled == 10


class TestCadence:
    def test_publishes_once_per_check_interval(self) -> None:
        # 10 seconds of media at 20 fps: checks at 0, 2, 4, 6, 8 s.
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(200)), publisher).run())

        assert len(publisher.published) == 5

    def test_runs_ocr_on_its_own_slower_clock(self) -> None:
        """§19: do not run expensive OCR on every frame."""
        publisher = RecordingPublisher()
        providers = build_providers({})
        extracted: list[str] = []
        original = providers.ocr.extract

        async def counting(*, session_id: str, frame: object) -> object:
            extracted.append(session_id)
            return await original(session_id=session_id, frame=frame)  # type: ignore[arg-type]

        providers.ocr.extract = counting  # type: ignore[method-assign]

        run(analysis(FakeFrameSource(handles(200)), publisher, providers=providers).run())

        # Five checks over ten seconds, but OCR every five: at 0 s and 5 s.
        assert len(extracted) == 2
        assert len(publisher.published) == 5

    def test_every_published_result_carries_an_ocr_status(self) -> None:
        """OCR is slower than the cycle, so cycles in between repeat its answer
        rather than leaving a hole that blinks on the HUD."""
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(200)), publisher).run())

        statuses = {payload["ocr_status"] for payload in publisher.published}
        assert statuses == {OcrStatus.PASS.value}


class TestPayload:
    def test_publishes_the_contract_fields_and_nothing_else(self) -> None:
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(60)), publisher).run())

        assert set(publisher.published[0]) == {
            "session_id",
            "liveness_score",
            "liveness_status",
            "face_match_score",
            "ocr_status",
            "model_versions",
        }

    def test_reports_the_session_it_was_told_to_analyse(self) -> None:
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(60)), publisher).run())

        assert publisher.published[0]["session_id"] == SESSION

    def test_carries_json_safe_values(self) -> None:
        """The statuses cross a wire as strings, not as Python enums."""
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(60)), publisher).run())

        payload = publisher.published[0]
        assert isinstance(payload["liveness_status"], str)
        assert isinstance(payload["ocr_status"], str)
        assert type(payload["liveness_status"]) is str

    def test_names_the_model_behind_each_check(self) -> None:
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(60)), publisher).run())

        assert publisher.published[0]["model_versions"] == {
            "liveness": "demo-v1",
            "face_match": "demo-v1",
            "ocr": "demo-v1",
        }


class TestDegradation:
    """D6: AI failure degrades the HUD and nothing else."""

    def test_a_source_that_never_yields_reports_unavailable(self) -> None:
        publisher = RecordingPublisher()

        outcome = run(analysis(FailingFrameSource(), publisher).run())

        assert outcome.reason == ENDED_SOURCE_FAILED
        payload = publisher.published[0]
        assert payload["liveness_status"] == LivenessStatus.UNAVAILABLE.value
        assert payload["ocr_status"] == OcrStatus.UNAVAILABLE.value
        assert payload["liveness_score"] is None
        assert payload["face_match_score"] is None

    def test_an_empty_track_still_tells_the_agent_something(self) -> None:
        """A blank HUD is indistinguishable from one that has not loaded."""
        publisher = RecordingPublisher()

        outcome = run(analysis(FakeFrameSource([]), publisher).run())

        assert outcome.reason == ENDED_TRACK_CLOSED
        assert len(publisher.published) == 1
        assert publisher.published[0]["liveness_status"] == LivenessStatus.UNAVAILABLE.value

    def test_a_call_that_produced_results_does_not_append_an_unavailable_one(self) -> None:
        publisher = RecordingPublisher()

        run(analysis(FakeFrameSource(handles(200)), publisher).run())

        assert all(
            payload["liveness_status"] != LivenessStatus.UNAVAILABLE.value
            for payload in publisher.published
        )

    def test_an_undecodable_frame_is_skipped_not_fatal(self) -> None:
        frames = handles(200)
        for index in range(0, 200, 20):
            frames[index] = type(frames[index])(frames[index].decode(), fails=True)
        source = FakeFrameSource(frames)

        outcome = run(analysis(source, RecordingPublisher()).run())

        assert outcome.frames_seen == 200
        assert outcome.checks_run >= 4

    def test_a_publish_failure_does_not_stop_the_analysis(self) -> None:
        """The next cycle carries a fresher result two seconds later."""
        publisher = RecordingPublisher(fail_times=2)

        outcome = run(analysis(FakeFrameSource(handles(200)), publisher).run())

        assert outcome.publish_failures == 2
        assert outcome.results_published == 3
        assert len(publisher.published) == 3

    def test_a_missing_reference_degrades_only_face_match(self, tmp_path: object) -> None:
        publisher = RecordingPublisher()
        providers = build_providers({"AI_REFERENCE_DIR": str(tmp_path)})

        run(analysis(FakeFrameSource(handles(60)), publisher, providers=providers).run())

        payload = publisher.published[0]
        assert payload["face_match_score"] is None
        assert payload["liveness_status"] == LivenessStatus.LIVE.value
        assert payload["ocr_status"] == OcrStatus.PASS.value

    def test_the_unavailable_provider_mode_reaches_the_wire(self) -> None:
        """T32's switch, end to end: a degraded service, not an unplugged one."""
        publisher = RecordingPublisher()
        providers = build_providers({"AI_PROVIDER_MODE": "unavailable"})
        assert providers.mode is ProviderMode.UNAVAILABLE

        run(analysis(FakeFrameSource(handles(60)), publisher, providers=providers).run())

        payload = publisher.published[0]
        assert payload["liveness_status"] == LivenessStatus.UNAVAILABLE.value
        assert payload["model_versions"]["liveness"] == "unavailable"


class TestProgrammingErrors:
    def test_a_provider_bug_is_not_swallowed_as_unavailability(self) -> None:
        """T29 reserves a raise for bugs; this loop must not convert one."""
        providers = replace(
            build_providers({}),
            liveness=MockLivenessProvider(overrides={SESSION: RuntimeError("a bug")}),
        )

        with pytest.raises(RuntimeError, match="a bug"):
            run(
                analysis(
                    FakeFrameSource(handles(60)), RecordingPublisher(), providers=providers
                ).run()
            )


class TestWindow:
    def test_liveness_reads_a_span_of_frames_not_one(self) -> None:
        seen: list[int] = []
        providers = build_providers({})
        original = providers.liveness.analyze

        async def counting(*, session_id: str, frames: object) -> object:
            seen.append(len(frames))  # type: ignore[arg-type]
            return await original(session_id=session_id, frames=frames)  # type: ignore[arg-type]

        providers.liveness.analyze = counting  # type: ignore[method-assign]

        run(
            analysis(FakeFrameSource(handles(200)), RecordingPublisher(), providers=providers).run()
        )

        # One check interval's worth of samples: 2 s at 4 fps.
        assert max(seen) == 8
        assert all(count >= 1 for count in seen)

    def test_the_window_does_not_grow_with_the_call(self) -> None:
        """A long call must not accumulate frames in memory (§16)."""
        widths: list[int] = []
        providers = build_providers({})
        original = providers.liveness.analyze

        async def counting(*, session_id: str, frames: object) -> object:
            widths.append(len(frames))  # type: ignore[arg-type]
            return await original(session_id=session_id, frames=frames)  # type: ignore[arg-type]

        providers.liveness.analyze = counting  # type: ignore[method-assign]

        run(
            analysis(
                FakeFrameSource(handles(2_000)), RecordingPublisher(), providers=providers
            ).run()
        )

        assert max(widths) == 8
