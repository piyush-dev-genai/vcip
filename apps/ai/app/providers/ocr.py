"""OCR: is a document being shown, and does it read?

One frame, triggered rather than continuous. `03-system-design.md` §19 is
explicit that OCR runs when a document is presented, not on every frame — it is
the expensive check and the one with the least to gain from repetition.

The result is a status and nothing else. No score, because a document either
read or it did not; no text, because document contents are sensitive and this
layer has no business carrying them (`06-database-schema.md` §20).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .determinism import bucket, validate_session_id
from .errors import ProviderUnavailable
from .frame import Frame, require_frame
from .results import OcrResult, OcrStatus
from .scripting import Script

MOCK_OCR_VERSION = "demo-v1"

_DOMAIN = "ocr"


@runtime_checkable
class OCRProvider(Protocol):
    """Reads a document from one frame."""

    model_version: str

    async def extract(self, *, session_id: str, frame: Frame) -> OcrResult:
        """Return a document-reading outcome.

        Expected failures come back as `OcrStatus.UNAVAILABLE`, which is not
        the same as `NO_DOCUMENT`: one says the check could not run, the other
        says it ran and there was nothing there.
        """
        ...


class MockOCRProvider:
    """A deterministic stand-in for a real OCR engine."""

    model_version = MOCK_OCR_VERSION

    def __init__(
        self,
        *,
        overrides: dict[str, OcrResult | BaseException] | None = None,
    ) -> None:
        self.script: Script[OcrResult] = Script(overrides)

    async def extract(self, *, session_id: str, frame: Frame) -> OcrResult:
        validate_session_id(session_id)
        require_frame(frame)

        try:
            scripted = self.script.resolve(session_id)
            if scripted is not None:
                return scripted
            return self._derive(session_id)
        except ProviderUnavailable as exc:
            return OcrResult.unavailable(self.model_version, exc.reason)

    def _derive(self, session_id: str) -> OcrResult:
        outcome = bucket(_DOMAIN, session_id)
        if outcome < 10:
            return OcrResult(status=OcrStatus.NO_DOCUMENT, model_version=self.model_version)
        if outcome < 20:
            return OcrResult(status=OcrStatus.FAIL, model_version=self.model_version)
        return OcrResult(status=OcrStatus.PASS, model_version=self.model_version)
