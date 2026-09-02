"""Starting, tracking and stopping per-session analyses."""

from __future__ import annotations

import asyncio

from app.analysis import AnalysisManager, AnalysisRequest, Cadence
from app.providers import MockLivenessProvider, ProviderSet, build_providers
from tests.fakes import FailingFrameSource, FakeFrameSource, RecordingPublisher, handles
from tests.helpers import run

SESSION = "11111111-2222-3333-4444-555555555555"
OTHER = "22222222-3333-4444-5555-666666666666"

CADENCE = Cadence(
    sample_interval_us=250_000, check_interval_us=2_000_000, ocr_interval_us=5_000_000
)


def request(session_id: str = SESSION) -> AnalysisRequest:
    return AnalysisRequest(
        session_id=session_id,
        room_name=f"vcip_{session_id}",
        token="a.livekit.jwt",
        livekit_url="ws://localhost:7880",
    )


def build(
    *,
    publisher: RecordingPublisher | None = None,
    providers: ProviderSet | None = None,
    frames: int = 200,
    max_analysis_s: float = 30.0,
    source: object = None,
) -> tuple[AnalysisManager, RecordingPublisher, list[object]]:
    made: list[object] = []
    sink = publisher or RecordingPublisher()

    def factory(req: AnalysisRequest) -> object:
        built = source if source is not None else FakeFrameSource(handles(frames))
        made.append(built)
        return built

    manager = AnalysisManager(
        providers=providers or build_providers({}),
        publisher=sink,
        source_factory=factory,  # type: ignore[arg-type]
        cadence=CADENCE,
        max_analysis_s=max_analysis_s,
    )
    return manager, sink, made


async def drain(manager: AnalysisManager) -> None:
    """Let every started analysis finish."""
    while manager.active_sessions:
        await asyncio.sleep(0)


class TestStarting:
    def test_returns_before_the_analysis_finishes(self) -> None:
        """The caller is on the call-start path and must not wait for a join."""

        async def scenario() -> None:
            manager, publisher, _ = build()

            started = manager.start(request())

            assert started.started is True
            assert publisher.published == []
            assert manager.active_sessions == frozenset({SESSION})
            await drain(manager)

        run(scenario())

    def test_the_analysis_runs_and_publishes(self) -> None:
        async def scenario() -> None:
            manager, publisher, _ = build()
            manager.start(request())

            await drain(manager)

            assert len(publisher.published) == 5

        run(scenario())

    def test_a_finished_analysis_is_forgotten(self) -> None:
        async def scenario() -> None:
            manager, _, _ = build()
            manager.start(request())

            await drain(manager)

            assert manager.active_sessions == frozenset()

        run(scenario())

    def test_several_sessions_run_at_once(self) -> None:
        async def scenario() -> None:
            manager, publisher, _ = build()

            manager.start(request(SESSION))
            manager.start(request(OTHER))

            assert manager.active_sessions == frozenset({SESSION, OTHER})
            await drain(manager)
            assert {payload["session_id"] for payload in publisher.published} == {SESSION, OTHER}

        run(scenario())


class TestDuplicateRequests:
    def test_a_second_request_does_not_start_a_second_analysis(self) -> None:
        """A retry or a redelivered webhook must not double the decoding."""

        async def scenario() -> None:
            manager, _, made = build()

            first = manager.start(request())
            second = manager.start(request())

            assert (first.started, second.started) == (True, False)
            await drain(manager)
            # One source built, so one room joined and one stream decoded.
            assert len(made) == 1

        run(scenario())

    def test_a_session_can_be_analysed_again_after_its_call_ends(self) -> None:
        async def scenario() -> None:
            manager, _, made = build()
            manager.start(request())
            await drain(manager)

            again = manager.start(request())

            assert again.started is True
            await drain(manager)
            assert len(made) == 2

        run(scenario())


class TestStopping:
    def test_stop_cancels_a_running_analysis(self) -> None:
        async def scenario() -> None:
            manager, _, _ = build(frames=100_000)
            manager.start(request())

            stopped = await manager.stop(SESSION)

            assert stopped is True
            assert manager.active_sessions == frozenset()

        run(scenario())

    def test_stopping_an_unknown_session_is_not_an_error(self) -> None:
        async def scenario() -> None:
            manager, _, _ = build()

            assert await manager.stop("33333333-4444-5555-6666-777777777777") is False

        run(scenario())

    def test_shutdown_cancels_everything_and_closes_the_publisher(self) -> None:
        async def scenario() -> None:
            manager, publisher, _ = build(frames=100_000)
            manager.start(request(SESSION))
            manager.start(request(OTHER))

            await manager.shutdown()

            assert manager.active_sessions == frozenset()
            assert publisher.closed == 1

        run(scenario())

    def test_the_source_is_closed_when_the_analysis_ends(self) -> None:
        """Every analysis is a room join; leaking one leaks a connection."""

        async def scenario() -> None:
            source = FakeFrameSource(handles(60))
            manager, _, _ = build(source=source)
            manager.start(request())

            await drain(manager)

            assert source.closed == 1

        run(scenario())


class TestFailureContainment:
    def test_a_provider_bug_does_not_take_the_service_down(self) -> None:
        """It is logged as the bug it is, and the process keeps serving."""

        async def scenario() -> None:
            healthy = build_providers({})
            providers = ProviderSet(
                mode=healthy.mode,
                liveness=MockLivenessProvider(overrides={SESSION: RuntimeError("a bug")}),
                face_match=healthy.face_match,
                ocr=healthy.ocr,
                references=healthy.references,
            )
            manager, _, _ = build(providers=providers)

            manager.start(request())
            await drain(manager)

            assert manager.active_sessions == frozenset()
            # The service is still able to start another analysis.
            assert manager.start(request(OTHER)).started is True
            await drain(manager)

        run(scenario())

    def test_a_source_failure_still_reports_to_the_hud(self) -> None:
        async def scenario() -> None:
            manager, publisher, _ = build(source=FailingFrameSource())
            manager.start(request())

            await drain(manager)

            assert publisher.published[0]["liveness_status"] == "UNAVAILABLE"

        run(scenario())

    def test_an_analysis_cannot_outlive_its_ceiling(self) -> None:
        """A room that never closes must not hold a task forever."""

        class NeverEnding:
            closed = 0

            async def frames(self):  # type: ignore[no-untyped-def]
                while True:
                    await asyncio.sleep(0.01)
                    yield  # pragma: no cover

            async def aclose(self) -> None:
                type(self).closed += 1

        async def scenario() -> None:
            manager, _, _ = build(source=NeverEnding(), max_analysis_s=0.05)
            manager.start(request())

            await asyncio.sleep(0.2)

            assert manager.active_sessions == frozenset()

        run(scenario())


class TestRequest:
    def test_does_not_print_the_join_token(self) -> None:
        """A LiveKit token is a live credential for somebody's call."""
        printed = repr(request())

        assert "a.livekit.jwt" not in printed
        assert SESSION in printed
