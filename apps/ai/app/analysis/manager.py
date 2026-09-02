"""Which calls are being analysed, and for how long (T30).

The Control API asks for an analysis and gets an answer immediately; the work
happens in a task behind it. That is not an optimisation. The request arrives
from `CALL_STARTED`, on the path that also starts the evidence recording, and
an analyzer that made that path wait for a LiveKit join would put AI on the
video critical path by the back door (D6).

Three things this owns that the run itself must not:

  - **One analysis per session.** A duplicate request — a retry, a customer who
    rejoins, a webhook delivered twice — joins the room a second time and
    doubles the frames being decoded for one call.
  - **A ceiling.** A room that never closes would otherwise hold a task, a
    connection and a decode loop forever.
  - **The last line against a bug.** T29's providers raise on programming
    errors by design, and a raised exception in a background task would
    otherwise be swallowed by asyncio and reported nowhere.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.providers import ProviderSet

from .frames import FrameSource
from .publisher import ResultPublisher
from .run import AnalysisOutcome, AnalysisRun
from .schedule import Cadence

logger = logging.getLogger(__name__)

#: Builds the frame source for one session. Injected so tests need no SFU.
SourceFactory = Callable[["AnalysisRequest"], FrameSource]


@dataclass(frozen=True, slots=True)
class AnalysisRequest:
    """What the Control API sends to start an analysis."""

    session_id: str
    room_name: str
    token: str
    livekit_url: str

    def __repr__(self) -> str:
        """Redacted: the token is a join credential for a live call."""
        return f"AnalysisRequest(session_id={self.session_id!r}, room_name={self.room_name!r})"


@dataclass(frozen=True, slots=True)
class StartResult:
    """Whether this request started an analysis or found one running."""

    session_id: str
    started: bool


class AnalysisManager:
    """Starts, tracks, and stops per-session analyses."""

    def __init__(
        self,
        *,
        providers: ProviderSet,
        publisher: ResultPublisher,
        source_factory: SourceFactory,
        cadence: Cadence,
        max_analysis_s: float,
    ) -> None:
        self._providers = providers
        self._publisher = publisher
        self._source_factory = source_factory
        self._cadence = cadence
        self._max_analysis_s = max_analysis_s
        self._running: dict[str, asyncio.Task[AnalysisOutcome | None]] = {}

    @property
    def active_sessions(self) -> frozenset[str]:
        """Sessions currently being analysed. For `/health` and for tests."""
        return frozenset(self._running)

    def start(self, request: AnalysisRequest) -> StartResult:
        """Begin analysing, unless this session already is.

        Returns immediately. The caller is the Control API on the call-start
        path, and it is told the request was accepted, not that a room was
        joined — joining takes a network round trip that the call must not wait
        for.
        """
        existing = self._running.get(request.session_id)
        if existing is not None and not existing.done():
            logger.info("analysis already running for session %s", request.session_id)
            return StartResult(session_id=request.session_id, started=False)

        task = asyncio.create_task(self._supervise(request), name=f"analysis:{request.session_id}")
        self._running[request.session_id] = task
        task.add_done_callback(lambda _: self._running.pop(request.session_id, None))

        logger.info(
            "analysis started for session %s in room %s", request.session_id, request.room_name
        )
        return StartResult(session_id=request.session_id, started=True)

    async def stop(self, session_id: str) -> bool:
        """Cancel one analysis. Returns whether there was one to cancel."""
        task = self._running.get(session_id)
        if task is None or task.done():
            return False
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return True

    async def shutdown(self) -> None:
        """Cancel everything still running, on the way down."""
        tasks = list(self._running.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._running.clear()
        await self._publisher.aclose()

    async def _supervise(self, request: AnalysisRequest) -> AnalysisOutcome | None:
        """Run one analysis under a time limit, and let nothing escape silently."""
        source = self._source_factory(request)
        run = AnalysisRun(
            session_id=request.session_id,
            providers=self._providers,
            source=source,
            publisher=self._publisher,
            cadence=self._cadence,
        )

        try:
            outcome = await _with_timeout(run.run(), self._max_analysis_s)
        except TimeoutError:
            logger.warning(
                "analysis for session %s hit the %ss ceiling and was stopped",
                request.session_id,
                self._max_analysis_s,
            )
            return None
        except asyncio.CancelledError:
            logger.info("analysis for session %s cancelled", request.session_id)
            raise
        except Exception:
            # A provider raised, which T29 reserves for programming errors.
            # Not reported as AI unavailability: that is a message agents learn
            # to ignore, and this one needs somebody to read it.
            logger.exception("analysis for session %s failed", request.session_id)
            return None
        finally:
            await _close_quietly(source)

        logger.info(
            "analysis for session %s ended (%s): %d frames, %d sampled, %d results",
            outcome.session_id,
            outcome.reason,
            outcome.frames_seen,
            outcome.frames_sampled,
            outcome.results_published,
        )
        return outcome


async def _with_timeout(awaitable: Awaitable[AnalysisOutcome], seconds: float) -> AnalysisOutcome:
    return await asyncio.wait_for(awaitable, timeout=seconds)


async def _close_quietly(source: FrameSource) -> None:
    try:
        await source.aclose()
    except Exception as exc:  # noqa: BLE001 - teardown must not mask the outcome
        logger.debug("frame source close failed: %s", exc)
