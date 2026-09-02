"""One call's analysis (T30).

```text
frames -> sample -> window -> liveness / face match / OCR -> /internal/ai/result
```

This is the whole of `03-system-design.md` §16, and it is deliberately the only
place that knows the order those things happen in. It holds no LiveKit type, no
HTTP client and no provider implementation — a source, a publisher and a
provider set are handed in — so the loop that decides what a call is worth
analysing can be tested with a list of frames and a list to publish into.

Two rules shape every branch below.

**The call is never affected.** AI sits off the video critical path (D6). A
provider that cannot answer, a frame that will not decode, a Control API that
will not accept a result: each degrades the HUD and nothing else. Nothing here
can end a call, and nothing here is allowed to be slow enough to matter.

**A programming error is not unavailability.** Expected failures are already
results by the time they reach this file — T29's providers convert them — so
anything that still raises here is a bug, and it is left to propagate to the
manager, which logs it as one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.providers import (
    MIN_LIVENESS_FRAMES,
    FaceMatchResult,
    LivenessResult,
    OcrResult,
    ProviderSet,
    ReferenceUnavailable,
)

from .frames import FrameDecodeError, FrameSource, FrameSourceError, FrameWindow
from .publisher import PublishError, ResultPublisher, result_payload
from .schedule import Cadence, Schedule

logger = logging.getLogger(__name__)

#: Why an analysis stopped. Reported, logged, and useful in a test.
EndReason = str

ENDED_TRACK_CLOSED: EndReason = "track_closed"
ENDED_SOURCE_FAILED: EndReason = "source_failed"


@dataclass(frozen=True, slots=True)
class AnalysisOutcome:
    """What one analysis did.

    Counts rather than results: the results went to the Control API, and this
    is the operational record of a call that has already ended.
    """

    session_id: str
    reason: EndReason
    frames_seen: int
    frames_sampled: int
    checks_run: int
    results_published: int
    publish_failures: int


class AnalysisRun:
    """Analyses one session until its video track ends."""

    def __init__(
        self,
        *,
        session_id: str,
        providers: ProviderSet,
        source: FrameSource,
        publisher: ResultPublisher,
        cadence: Cadence,
    ) -> None:
        self._session_id = session_id
        self._providers = providers
        self._source = source
        self._publisher = publisher
        self._cadence = cadence
        self._schedule = Schedule(cadence)
        self._window = FrameWindow(capacity=_window_capacity(cadence))

        self._frames_seen = 0
        self._frames_sampled = 0
        self._checks_run = 0
        self._published = 0
        self._publish_failures = 0

        # The last result of each check. OCR runs more slowly than the other
        # two, so a published result repeats its most recent answer rather than
        # dropping the field — the HUD shows what OCR last said, not a hole
        # that appears and disappears every other cycle.
        self._ocr: OcrResult | None = None

    async def run(self) -> AnalysisOutcome:
        """Consume the track, publishing a result every check interval."""
        reason = ENDED_TRACK_CLOSED
        try:
            await self._consume()
        except FrameSourceError as exc:
            # The track never arrived, or the room could not be joined. Not a
            # bug and not the call's problem: the agent is told the AI has
            # nothing, and the verification carries on without it.
            reason = ENDED_SOURCE_FAILED
            logger.warning("analysis source failed for session %s: %s", self._session_id, exc)

        if self._published == 0:
            # Whatever went wrong, the agent's HUD must say something. A blank
            # panel is indistinguishable from a panel that has not loaded.
            await self._publish_unavailable(reason)

        return AnalysisOutcome(
            session_id=self._session_id,
            reason=reason,
            frames_seen=self._frames_seen,
            frames_sampled=self._frames_sampled,
            checks_run=self._checks_run,
            results_published=self._published,
            publish_failures=self._publish_failures,
        )

    async def _consume(self) -> None:
        async for handle in self._source.frames():
            self._frames_seen += 1

            if not self._schedule.should_sample(handle.ts_us):
                # The frame is dropped before `decode()`, which is the point of
                # the handle: this is the ~80% of frames that cost nothing.
                continue

            try:
                frame = handle.decode()
            except FrameDecodeError as exc:
                # One bad frame in thousands. Take the next one.
                logger.debug("undecodable frame in session %s: %s", self._session_id, exc)
                continue

            self._schedule.sampled(handle.ts_us)
            self._frames_sampled += 1
            self._window.add(frame)

            if not self._ready_to_check():
                # The first check would otherwise fire on the first frame, with
                # a window of one — and liveness over one frame is liveness
                # over a photograph, so every call's first HUD update would
                # read UNKNOWN. Waiting for a second sample costs one sampling
                # interval and makes the first result a real one.
                continue

            if self._schedule.should_check(handle.ts_us):
                self._schedule.checked(handle.ts_us)
                await self._check(handle.ts_us)

    def _ready_to_check(self) -> bool:
        """Whether the window holds enough for liveness to decide anything.

        The threshold is the provider's own, imported rather than restated: if
        a real liveness model ever needs more frames than the mock does, this
        loop follows it instead of drifting.
        """
        return len(self._window) >= MIN_LIVENESS_FRAMES

    async def _check(self, ts_us: int) -> None:
        """Run the checks that are due and publish what is known."""
        self._checks_run += 1

        liveness = await self._providers.liveness.analyze(
            session_id=self._session_id, frames=self._window.snapshot()
        )
        face_match = await self._face_match()

        if self._schedule.should_run_ocr(ts_us):
            self._schedule.ran_ocr(ts_us)
            self._ocr = await self._run_ocr()

        # `should_run_ocr` is true on the first cycle, so this is never None by
        # the time a result is published.
        ocr = self._ocr or OcrResult.unavailable(
            self._providers.ocr.model_version, "OCR has not run yet"
        )

        await self._publish(result_payload(self._session_id, liveness, face_match, ocr))

    async def _face_match(self) -> FaceMatchResult:
        """Compare the newest frame against the reference.

        The reference is fetched every cycle rather than once. `LocalReferenceStore`
        caches the bytes, so a present reference costs a stat; a missing one
        keeps being retried, which is the right behaviour for a store that a
        later implementation will fetch over a network.
        """
        version = self._providers.face_match.model_version

        newest = self._window.newest()
        if newest is None:
            return FaceMatchResult.unavailable(version, "no frame to compare")

        try:
            reference = await self._providers.references.load(session_id=self._session_id)
        except ReferenceUnavailable as exc:
            # R6's seam failing is not the model failing, but from the agent's
            # side both mean the same thing: no face comparison this call.
            return FaceMatchResult.unavailable(version, exc.reason)

        return await self._providers.face_match.compare(
            session_id=self._session_id, frame=newest, reference=reference
        )

    async def _run_ocr(self) -> OcrResult:
        newest = self._window.newest()
        if newest is None:
            return OcrResult.unavailable(self._providers.ocr.model_version, "no frame to read")
        return await self._providers.ocr.extract(session_id=self._session_id, frame=newest)

    async def _publish_unavailable(self, reason: EndReason) -> None:
        """Report that this call has no AI, in the vocabulary the HUD reads."""
        versions = self._providers.model_versions()
        await self._publish(
            result_payload(
                self._session_id,
                LivenessResult.unavailable(versions["liveness"], reason),
                FaceMatchResult.unavailable(versions["face_match"], reason),
                OcrResult.unavailable(versions["ocr"], reason),
            )
        )

    async def _publish(self, payload: dict[str, object]) -> None:
        try:
            await self._publisher.publish(payload)
        except PublishError as exc:
            # The next cycle carries a fresher result two seconds from now, so
            # there is nothing worth retrying and nothing worth queueing.
            self._publish_failures += 1
            logger.warning("could not publish a result for %s: %s", self._session_id, exc)
            return
        self._published += 1


def _window_capacity(cadence: Cadence) -> int:
    """How many sampled frames liveness gets to look at.

    One check interval's worth, so each check reads the movement since the last
    one and not a stale span from earlier in the call. At least two, because
    liveness over a single frame is liveness over a photograph.
    """
    return max(2, cadence.check_interval_us // cadence.sample_interval_us)
