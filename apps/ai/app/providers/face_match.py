"""Face match: does the live customer match the reference?

One frame, one reference. The reference is passed in rather than looked up
here, because where it comes from is a separate decision with a separate
failure mode (see `reference.py`) — and because a provider that fetched its own
inputs could not be handed a different source without being rewritten.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .determinism import bucket, score_in, validate_session_id
from .errors import ProviderUnavailable
from .frame import Frame, require_frame
from .reference import Reference
from .results import FaceMatchResult, FaceMatchStatus
from .scripting import Script

MOCK_FACE_MATCH_VERSION = "demo-v1"

_DOMAIN = "face_match"


@runtime_checkable
class FaceMatchProvider(Protocol):
    """Compares one live frame against a reference image."""

    model_version: str

    async def compare(
        self, *, session_id: str, frame: Frame, reference: Reference
    ) -> FaceMatchResult:
        """Return a similarity verdict.

        Expected failures come back as `FaceMatchStatus.UNAVAILABLE`. A missing
        reference is one of them, but it is raised by the store before this is
        called; the caller converts it with `FaceMatchResult.unavailable`.
        """
        ...


class MockFaceMatchProvider:
    """A deterministic stand-in for a real face-match model.

    The reference is required and validated but does not steer the score. It
    could not honestly: comparing two images is the part being mocked, and a
    number derived from the reference bytes would be a different lie with more
    moving parts.
    """

    model_version = MOCK_FACE_MATCH_VERSION

    def __init__(
        self,
        *,
        overrides: dict[str, FaceMatchResult | BaseException] | None = None,
    ) -> None:
        self.script: Script[FaceMatchResult] = Script(overrides)

    async def compare(
        self, *, session_id: str, frame: Frame, reference: Reference
    ) -> FaceMatchResult:
        validate_session_id(session_id)
        require_frame(frame)
        if not isinstance(reference, Reference):
            raise TypeError(f"reference must be a Reference, got {type(reference).__name__}")

        try:
            scripted = self.script.resolve(session_id)
            if scripted is not None:
                return scripted
            return self._derive(session_id)
        except ProviderUnavailable as exc:
            return FaceMatchResult.unavailable(self.model_version, exc.reason)

    def _derive(self, session_id: str) -> FaceMatchResult:
        outcome = bucket(_DOMAIN, session_id)
        if outcome < 5:
            return FaceMatchResult(
                status=FaceMatchStatus.UNKNOWN, score=None, model_version=self.model_version
            )
        if outcome < 15:
            return FaceMatchResult(
                status=FaceMatchStatus.NO_MATCH,
                score=score_in(_DOMAIN, session_id, 10, 49),
                model_version=self.model_version,
            )
        return FaceMatchResult(
            status=FaceMatchStatus.MATCH,
            score=score_in(_DOMAIN, session_id, 75, 99),
            model_version=self.model_version,
        )
