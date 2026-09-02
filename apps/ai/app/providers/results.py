"""Result and status types for the three checks.

The field names here are the ones that leave the service: `/internal/ai/result`
carries `liveness_score`, `liveness_status`, `face_match_score` and
`ocr_status`, and `session_ai_summaries` stores exactly those four alongside
`model_versions` (`05-api-contract.md` §23, `06-database-schema.md` §19).

Two shapes deliberately differ from the wire.

`FaceMatchStatus` has no wire field — the contract gives face match a score and
nothing else. It exists anyway because "the model said 43" and "the model never
ran" are different facts, and a bare `None` score cannot tell them apart. It
stays inside this service.

OCR has a status and no score, because a document either read or it did not and
a similarity number would mean nothing.

Scores are integers 0-100. `session_ai_summaries` types the columns
`NUMERIC(5,2)`, which stores such an integer exactly; a percentage carrying two
decimal places would be false precision from a model that does not have it.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

SCORE_MIN = 0
SCORE_MAX = 100


class LivenessStatus(StrEnum):
    """Whether the customer appears to be a live person (`03-system-design.md` §17).

    `UNKNOWN` means the check ran and could not decide. `UNAVAILABLE` means it
    did not run. The agent HUD shows those differently and so must this.
    """

    LIVE = "LIVE"
    NOT_LIVE = "NOT_LIVE"
    UNKNOWN = "UNKNOWN"
    UNAVAILABLE = "UNAVAILABLE"


class FaceMatchStatus(StrEnum):
    """Whether the live face matches the reference. Internal to this service."""

    MATCH = "MATCH"
    NO_MATCH = "NO_MATCH"
    UNKNOWN = "UNKNOWN"
    UNAVAILABLE = "UNAVAILABLE"


class OcrStatus(StrEnum):
    """Outcome of reading a document held up to the camera.

    `NO_DOCUMENT` is not a failure: OCR runs on a frame the customer was asked
    to produce, and "nothing was being shown" is a legitimate answer.
    """

    PASS = "PASS"
    FAIL = "FAIL"
    NO_DOCUMENT = "NO_DOCUMENT"
    UNAVAILABLE = "UNAVAILABLE"


def validate_score(score: int) -> int:
    """Return `score` if it is an integer 0-100, else raise.

    Rejects `bool` explicitly: `True` is an `int` in Python and would sail
    through as a score of 1.
    """
    if not isinstance(score, int) or isinstance(score, bool):
        raise TypeError(f"score must be an int, got {type(score).__name__}")
    if not SCORE_MIN <= score <= SCORE_MAX:
        raise ValueError(f"score must be {SCORE_MIN}-{SCORE_MAX}, got {score}")
    return score


def _validate_model_version(model_version: str) -> None:
    if not isinstance(model_version, str) or not model_version.strip():
        raise ValueError("model_version must be a non-empty string")


def _validate_reason(reason: str | None, *, is_unavailable: bool) -> None:
    if reason is None:
        return
    if not is_unavailable:
        raise ValueError("reason is only meaningful on an UNAVAILABLE result")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("reason must be a non-empty string when present")


@dataclass(frozen=True, slots=True)
class LivenessResult:
    """A liveness verdict over a sequence of frames.

    `score` is present exactly when the check decided (`LIVE` or `NOT_LIVE`).
    An undecided or absent check has no score to report, and inventing a zero
    would read on the HUD as a confident "not a live person".
    """

    status: LivenessStatus
    score: int | None
    model_version: str
    reason: str | None = None

    def __post_init__(self) -> None:
        _validate_model_version(self.model_version)
        decided = self.status in (LivenessStatus.LIVE, LivenessStatus.NOT_LIVE)
        _require_score_matches_decision(self.score, decided=decided, status=self.status)
        _validate_reason(self.reason, is_unavailable=self.is_unavailable)

    @property
    def is_unavailable(self) -> bool:
        return self.status is LivenessStatus.UNAVAILABLE

    @classmethod
    def unavailable(cls, model_version: str, reason: str) -> LivenessResult:
        return cls(
            status=LivenessStatus.UNAVAILABLE,
            score=None,
            model_version=model_version,
            reason=reason,
        )


@dataclass(frozen=True, slots=True)
class FaceMatchResult:
    """A similarity verdict between one live frame and the reference."""

    status: FaceMatchStatus
    score: int | None
    model_version: str
    reason: str | None = None

    def __post_init__(self) -> None:
        _validate_model_version(self.model_version)
        decided = self.status in (FaceMatchStatus.MATCH, FaceMatchStatus.NO_MATCH)
        _require_score_matches_decision(self.score, decided=decided, status=self.status)
        _validate_reason(self.reason, is_unavailable=self.is_unavailable)

    @property
    def is_unavailable(self) -> bool:
        return self.status is FaceMatchStatus.UNAVAILABLE

    @classmethod
    def unavailable(cls, model_version: str, reason: str) -> FaceMatchResult:
        return cls(
            status=FaceMatchStatus.UNAVAILABLE,
            score=None,
            model_version=model_version,
            reason=reason,
        )


@dataclass(frozen=True, slots=True)
class OcrResult:
    """The outcome of reading one document frame.

    Deliberately carries no extracted text. Document contents are sensitive and
    nothing downstream of this layer is allowed to store them
    (`06-database-schema.md` §20); a field that existed would eventually be
    filled in.
    """

    status: OcrStatus
    model_version: str
    reason: str | None = None

    def __post_init__(self) -> None:
        _validate_model_version(self.model_version)
        _validate_reason(self.reason, is_unavailable=self.is_unavailable)

    @property
    def is_unavailable(self) -> bool:
        return self.status is OcrStatus.UNAVAILABLE

    @classmethod
    def unavailable(cls, model_version: str, reason: str) -> OcrResult:
        return cls(status=OcrStatus.UNAVAILABLE, model_version=model_version, reason=reason)


def _require_score_matches_decision(score: int | None, *, decided: bool, status: StrEnum) -> None:
    if decided:
        if score is None:
            raise ValueError(f"{status} is a decision and must carry a score")
        validate_score(score)
    elif score is not None:
        raise ValueError(f"{status} did not decide and must not carry a score, got {score}")
