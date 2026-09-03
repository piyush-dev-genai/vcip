"""Providers that answer `UNAVAILABLE` to everything.

Selected by `AI_PROVIDER_MODE=unavailable`. T32 has to show that killing AI
mid-call leaves the call intact, the HUD reading "AI unavailable", and the
verdict still submittable — and the honest way to demonstrate that is to
degrade the AI service, not to unplug it, because an unreachable service and a
service reporting failure are different code paths in the Control API and both
have to work (D6).

These report their own `model_version`. Claiming `demo-v1` would put a model
name on `session_ai_summaries.model_versions` for a check that never ran.
"""

from __future__ import annotations

from collections.abc import Sequence

from .determinism import validate_session_id
from .document import DocumentFields, DocumentType
from .errors import ProviderUnavailable
from .frame import Frame, require_frame, require_frames
from .reference import Reference
from .results import FaceMatchResult, LivenessResult, OcrResult

UNAVAILABLE_VERSION = "unavailable"

_REASON = "provider mode is 'unavailable'"


class UnavailableLivenessProvider:
    """Liveness, switched off."""

    model_version = UNAVAILABLE_VERSION

    async def analyze(self, *, session_id: str, frames: Sequence[Frame]) -> LivenessResult:
        validate_session_id(session_id)
        require_frames(frames)
        return LivenessResult.unavailable(self.model_version, _REASON)


class UnavailableFaceMatchProvider:
    """Face match, switched off."""

    model_version = UNAVAILABLE_VERSION

    async def compare(
        self, *, session_id: str, frame: Frame, reference: Reference
    ) -> FaceMatchResult:
        validate_session_id(session_id)
        require_frame(frame)
        return FaceMatchResult.unavailable(self.model_version, _REASON)


class UnavailableOCRProvider:
    """OCR, switched off."""

    model_version = UNAVAILABLE_VERSION

    async def extract(self, *, session_id: str, frame: Frame) -> OcrResult:
        validate_session_id(session_id)
        require_frame(frame)
        return OcrResult.unavailable(self.model_version, _REASON)


class UnavailableDocumentReader:
    """The document reader, switched off.

    Raises rather than returning `None`, because the two mean different things
    to the agent: `None` is "no document was in the frame, hold it up again",
    and this is "the reader did not run". The caller turns the exception into
    `UNAVAILABLE` and the agent is told not to wait for an answer.
    """

    model_version = UNAVAILABLE_VERSION

    async def read(
        self,
        *,
        session_id: str,
        document_type: DocumentType,
        frames: tuple[Frame, ...],
    ) -> DocumentFields | None:
        validate_session_id(session_id)
        raise ProviderUnavailable(_REASON)


class UnavailableDocumentVerifier:
    """The registry lookup, switched off."""

    model_version = UNAVAILABLE_VERSION

    async def verify(self, *, session_id: str, fields: DocumentFields) -> bool:
        validate_session_id(session_id)
        raise ProviderUnavailable(_REASON)
