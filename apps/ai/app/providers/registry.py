"""Choosing the providers, once, from configuration.

`AI_PROVIDER_MODE` selects an implementation set. Everything downstream —
T30's sampling loop, the `/internal/ai/result` payload, the HUD — is written
against the interfaces and does not learn which set it got.

An unrecognised mode is a startup error, not a silent fall back to mocks. A
demo that quietly ran on mock data because a value was misspelled is the one
failure this layer must never produce.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from .degraded import (
    UnavailableFaceMatchProvider,
    UnavailableLivenessProvider,
    UnavailableOCRProvider,
)
from .face_match import FaceMatchProvider, MockFaceMatchProvider
from .liveness import LivenessProvider, MockLivenessProvider
from .ocr import MockOCRProvider, OCRProvider
from .reference import EmptyReferenceStore, LocalReferenceStore, ReferenceStore

MODE_ENV_VAR = "AI_PROVIDER_MODE"
REFERENCE_DIR_ENV_VAR = "AI_REFERENCE_DIR"

#: The keys of `session_ai_summaries.model_versions` (`06-database-schema.md` §19).
LIVENESS_KEY = "liveness"
FACE_MATCH_KEY = "face_match"
OCR_KEY = "ocr"

DEFAULT_REFERENCE_DIR = Path(__file__).resolve().parent.parent / "reference_data"


class ProviderMode(StrEnum):
    """Which implementation set to build."""

    MOCK = "mock"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True, slots=True)
class ProviderSet:
    """The three checks and the reference store, chosen together."""

    mode: ProviderMode
    liveness: LivenessProvider
    face_match: FaceMatchProvider
    ocr: OCRProvider
    references: ReferenceStore

    def model_versions(self) -> dict[str, str]:
        """The versions to record on the session's AI summary.

        Read from the provider instances rather than from a constant, so a
        summary can never name a model that did not produce the result. Per
        check, because the three are separate models and will not move
        together.
        """
        return {
            LIVENESS_KEY: self.liveness.model_version,
            FACE_MATCH_KEY: self.face_match.model_version,
            OCR_KEY: self.ocr.model_version,
        }


def resolve_mode(raw: str | None) -> ProviderMode:
    """Parse an `AI_PROVIDER_MODE` value. Unset means `mock`."""
    if raw is None or not raw.strip():
        return ProviderMode.MOCK
    try:
        return ProviderMode(raw.strip().lower())
    except ValueError:
        accepted = ", ".join(mode.value for mode in ProviderMode)
        raise ValueError(f"{MODE_ENV_VAR} must be one of: {accepted}; got {raw!r}") from None


def build_providers(env: Mapping[str, str] | None = None) -> ProviderSet:
    """Build the provider set named by the environment."""
    environment = os.environ if env is None else env
    mode = resolve_mode(environment.get(MODE_ENV_VAR))
    reference_dir = Path(environment.get(REFERENCE_DIR_ENV_VAR) or DEFAULT_REFERENCE_DIR)

    if mode is ProviderMode.UNAVAILABLE:
        return ProviderSet(
            mode=mode,
            liveness=UnavailableLivenessProvider(),
            face_match=UnavailableFaceMatchProvider(),
            ocr=UnavailableOCRProvider(),
            references=EmptyReferenceStore(),
        )

    return ProviderSet(
        mode=mode,
        liveness=MockLivenessProvider(),
        face_match=MockFaceMatchProvider(),
        ocr=MockOCRProvider(),
        references=LocalReferenceStore(reference_dir),
    )
