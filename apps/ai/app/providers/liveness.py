"""Liveness: is there a live person in front of the camera?

The interface takes a *sequence* of frames, unlike the other two checks. That
is the whole subject: a single frame cannot distinguish a person from a
photograph of one, and any real implementation reads motion across time. The
signature says so rather than accepting one frame and hoping callers send more.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from .determinism import bucket, score_in, validate_session_id
from .errors import ProviderUnavailable
from .frame import Frame, require_frames
from .results import LivenessResult, LivenessStatus
from .scripting import Script

MOCK_LIVENESS_VERSION = "demo-v1"

#: Below this, the mock reports `UNKNOWN` rather than guessing from a still.
MIN_LIVENESS_FRAMES = 2

_DOMAIN = "liveness"


@runtime_checkable
class LivenessProvider(Protocol):
    """Analyses a sequence of frames for signs of a live person."""

    model_version: str

    async def analyze(self, *, session_id: str, frames: Sequence[Frame]) -> LivenessResult:
        """Return a liveness verdict.

        Expected failures come back as `LivenessStatus.UNAVAILABLE`, never as
        an exception: AI is off the video critical path and its unavailability
        is a HUD state, not an error the caller has to handle (D6).
        """
        ...


class MockLivenessProvider:
    """A deterministic stand-in for a real liveness model.

    Roughly four sessions in five come back `LIVE`, which is what a demo of a
    working verification should look like; the rest split between `NOT_LIVE`
    and `UNKNOWN` so both HUD states are reachable without scripting.
    """

    model_version = MOCK_LIVENESS_VERSION

    def __init__(
        self,
        *,
        overrides: dict[str, LivenessResult | BaseException] | None = None,
    ) -> None:
        self.script: Script[LivenessResult] = Script(overrides)

    async def analyze(self, *, session_id: str, frames: Sequence[Frame]) -> LivenessResult:
        validate_session_id(session_id)
        require_frames(frames)

        try:
            scripted = self.script.resolve(session_id)
            if scripted is not None:
                return scripted
            return self._derive(session_id, frames)
        except ProviderUnavailable as exc:
            return LivenessResult.unavailable(self.model_version, exc.reason)

    def _derive(self, session_id: str, frames: Sequence[Frame]) -> LivenessResult:
        if len(frames) < MIN_LIVENESS_FRAMES:
            return LivenessResult(
                status=LivenessStatus.UNKNOWN, score=None, model_version=self.model_version
            )

        outcome = bucket(_DOMAIN, session_id)
        if outcome < 5:
            return LivenessResult(
                status=LivenessStatus.UNKNOWN, score=None, model_version=self.model_version
            )
        if outcome < 20:
            return LivenessResult(
                status=LivenessStatus.NOT_LIVE,
                score=score_in(_DOMAIN, session_id, 5, 39),
                model_version=self.model_version,
            )
        return LivenessResult(
            status=LivenessStatus.LIVE,
            score=score_in(_DOMAIN, session_id, 70, 99),
            model_version=self.model_version,
        )
