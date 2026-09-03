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

from app.providers import DocumentCheck, DocumentType, ProviderSet

from .frames import FrameSource
from .publisher import PublishError, ResultPublisher, document_payload
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
class _Live:
    """One analysis in flight: the run to ask, and the source to close."""

    source: FrameSource
    run: AnalysisRun


class NoAnalysisRunning(LookupError):
    """A document check was asked for on a session with no live analysis.

    Not an error in the system: the AI may never have started for this call, or
    may have stopped when the track closed. The Control API answers the agent
    `accepted: false` and the call carries on regardless (D6).
    """

    def __init__(self, session_id: str) -> None:
        super().__init__(f"no analysis running for session {session_id}")
        self.session_id = session_id


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

        # The live analysis per session, so a triggered document check can reach
        # the one already holding this call's frames. Kept beside the task map
        # rather than inside it because a task is opaque: it can be cancelled
        # and awaited, but not asked to do something else.
        #
        # Released by `_release`, which is called from both the supervisor's
        # `finally` and from `stop`. Both are needed: a task cancelled before it
        # first runs never enters its own `try`, so the `finally` alone would
        # leave the entry behind and the source unclosed.
        self._live: dict[str, _Live] = {}

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

        # Built here rather than inside the task, so the run is reachable the
        # moment this returns. A task only begins at the next suspension point,
        # and an agent who pressed the document button in that gap would have
        # been told no analysis was running when one had just been started for
        # their call.
        source = self._source_factory(request)
        run = AnalysisRun(
            session_id=request.session_id,
            providers=self._providers,
            source=source,
            publisher=self._publisher,
            cadence=self._cadence,
        )
        self._live[request.session_id] = _Live(source=source, run=run)

        task = asyncio.create_task(
            self._supervise(request, source, run), name=f"analysis:{request.session_id}"
        )
        self._running[request.session_id] = task
        task.add_done_callback(lambda _: self._running.pop(request.session_id, None))

        logger.info(
            "analysis started for session %s in room %s", request.session_id, request.room_name
        )
        return StartResult(session_id=request.session_id, started=True)

    async def read_document(self, session_id: str, document_type: DocumentType) -> DocumentCheck:
        """Run one triggered document check against a live analysis (§19).

        Raises `NoAnalysisRunning` when this session has none. That is an
        ordinary outcome rather than an error: the AI may never have started for
        this call, or may have stopped when the track closed, and neither is the
        call's problem (D6). The Control API turns it into an accepted-but-not-
        run answer, and the agent decides on what they can see.

        The check is published from here rather than returned to the HTTP
        caller, so it arrives on the socket the HUD already uses — the same path
        every other AI result takes, which is what keeps the agent's panel a
        single source of truth instead of two that can disagree.
        """
        live = self._live.get(session_id)
        if live is None:
            raise NoAnalysisRunning(session_id)

        check = await live.run.read_document(document_type)

        try:
            await self._publisher.publish_document(document_payload(session_id, check))
        except PublishError as exc:
            # Unlike a sampled result there is no next one along in two seconds:
            # an agent pressed a button and is watching a spinner. Logged loudly
            # so the silence has a cause somebody can find.
            logger.warning(
                "could not publish the document check for %s: %s",
                session_id,
                exc,
            )

        return check

    async def stop(self, session_id: str) -> bool:
        """Cancel one analysis. Returns whether there was one to cancel."""
        task = self._running.get(session_id)
        if task is None or task.done():
            return False
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        # Not left to the supervisor's `finally`: a task cancelled before it
        # first ran never entered the body, so nothing there executes. Without
        # this the session stays answerable to a document check that would read
        # a window nothing will ever refill, and its source is never closed.
        await self._release(session_id)
        return True

    async def shutdown(self) -> None:
        """Cancel everything still running, on the way down."""
        tasks = list(self._running.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._running.clear()
        # Same reason `stop` releases explicitly, for every session at once: on
        # the way down some of these tasks were cancelled before they ever ran.
        for session_id in list(self._live):
            await self._release(session_id)
        await self._publisher.aclose()

    async def _release(self, session_id: str) -> None:
        """Forget one analysis and close its source. Safe to call twice."""
        live = self._live.pop(session_id, None)
        if live is None:
            return
        await _close_quietly(live.source)

    async def _supervise(
        self, request: AnalysisRequest, source: FrameSource, run: AnalysisRun
    ) -> AnalysisOutcome | None:
        """Run one analysis under a time limit, and let nothing escape silently.

        Both the source and the run are built by `start`, so this owns their
        lifetime without owning their construction: whatever happens below, the
        `finally` closes the one and unregisters the other.
        """
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
            # Unreachable for a document check the moment the analysis stops, so
            # a button pressed on an ended call is told there is nothing to ask
            # rather than reading a window that will never refill. Closes the
            # source too, which is why `source` is a parameter: `_release` owns
            # both halves and either path may get here first.
            await self._release(request.session_id)

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
