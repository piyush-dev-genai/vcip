"""Result and status types, and the score rules they enforce."""

from __future__ import annotations

import pytest

from app.providers import (
    FaceMatchResult,
    FaceMatchStatus,
    LivenessResult,
    LivenessStatus,
    OcrResult,
    OcrStatus,
    validate_score,
)


class TestStatusVocabulary:
    """The wire vocabulary, pinned.

    `05-api-contract.md` §23 and `06-database-schema.md` §19 are what the
    Control API stores and the HUD renders. Transcribed here rather than read
    out of the enum, so a rename cannot quietly agree with itself.
    """

    def test_liveness_statuses(self) -> None:
        assert {s.value for s in LivenessStatus} == {
            "LIVE",
            "NOT_LIVE",
            "UNKNOWN",
            "UNAVAILABLE",
        }

    def test_ocr_statuses(self) -> None:
        assert {s.value for s in OcrStatus} == {
            "PASS",
            "FAIL",
            "NO_DOCUMENT",
            "UNAVAILABLE",
        }

    def test_face_match_statuses(self) -> None:
        assert {s.value for s in FaceMatchStatus} == {
            "MATCH",
            "NO_MATCH",
            "UNKNOWN",
            "UNAVAILABLE",
        }


class TestValidateScore:
    @pytest.mark.parametrize("score", [0, 1, 50, 99, 100])
    def test_accepts_the_whole_range(self, score: int) -> None:
        assert validate_score(score) == score

    @pytest.mark.parametrize("score", [-1, 101, 1000])
    def test_rejects_values_outside_it(self, score: int) -> None:
        with pytest.raises(ValueError, match="score must be 0-100"):
            validate_score(score)

    def test_rejects_a_float(self) -> None:
        with pytest.raises(TypeError, match="score must be an int"):
            validate_score(96.5)  # type: ignore[arg-type]

    def test_rejects_a_boolean(self) -> None:
        """`True` would otherwise pass as a score of 1."""
        with pytest.raises(TypeError, match="score must be an int"):
            validate_score(True)  # type: ignore[arg-type]


class TestLivenessResult:
    def test_a_decision_carries_a_score(self) -> None:
        result = LivenessResult(status=LivenessStatus.LIVE, score=97, model_version="demo-v1")

        assert (result.status, result.score) == (LivenessStatus.LIVE, 97)
        assert result.is_unavailable is False
        assert result.reason is None

    def test_a_decision_without_a_score_is_refused(self) -> None:
        with pytest.raises(ValueError, match="must carry a score"):
            LivenessResult(status=LivenessStatus.NOT_LIVE, score=None, model_version="demo-v1")

    @pytest.mark.parametrize("status", [LivenessStatus.UNKNOWN, LivenessStatus.UNAVAILABLE])
    def test_a_non_decision_must_not_carry_a_score(self, status: LivenessStatus) -> None:
        """A zero here would read on the HUD as a confident 'not a live person'."""
        with pytest.raises(ValueError, match="must not carry a score"):
            LivenessResult(status=status, score=0, model_version="demo-v1")

    def test_unavailable_names_the_model_and_the_reason(self) -> None:
        result = LivenessResult.unavailable("demo-v1", "model host timed out")

        assert result.status is LivenessStatus.UNAVAILABLE
        assert result.score is None
        assert result.is_unavailable is True
        assert result.reason == "model host timed out"

    def test_a_reason_on_a_result_that_worked_is_refused(self) -> None:
        with pytest.raises(ValueError, match="only meaningful on an UNAVAILABLE"):
            LivenessResult(
                status=LivenessStatus.LIVE,
                score=97,
                model_version="demo-v1",
                reason="nothing went wrong",
            )

    def test_the_model_version_is_required(self) -> None:
        with pytest.raises(ValueError, match="model_version"):
            LivenessResult(status=LivenessStatus.LIVE, score=97, model_version="")


class TestFaceMatchResult:
    def test_a_decision_carries_a_score(self) -> None:
        result = FaceMatchResult(status=FaceMatchStatus.MATCH, score=95, model_version="demo-v1")

        assert result.score == 95
        assert result.is_unavailable is False

    def test_an_out_of_range_score_is_refused(self) -> None:
        with pytest.raises(ValueError, match="score must be 0-100"):
            FaceMatchResult(status=FaceMatchStatus.MATCH, score=101, model_version="demo-v1")

    def test_unknown_is_not_a_score_of_zero(self) -> None:
        result = FaceMatchResult(
            status=FaceMatchStatus.UNKNOWN, score=None, model_version="demo-v1"
        )

        assert result.score is None
        assert result.is_unavailable is False

    def test_unavailable_is_distinguishable_from_unknown(self) -> None:
        """Both have no score; only one means the model never ran."""
        unavailable = FaceMatchResult.unavailable("demo-v1", "reference missing")
        unknown = FaceMatchResult(
            status=FaceMatchStatus.UNKNOWN, score=None, model_version="demo-v1"
        )

        assert unavailable.score is unknown.score is None
        assert unavailable.is_unavailable and not unknown.is_unavailable


class TestOcrResult:
    def test_carries_a_status_and_no_score(self) -> None:
        result = OcrResult(status=OcrStatus.PASS, model_version="demo-v1")

        assert result.status is OcrStatus.PASS
        assert not hasattr(result, "score")

    def test_carries_no_extracted_text(self) -> None:
        """Document contents are sensitive and stop at this layer."""
        assert not hasattr(OcrResult(status=OcrStatus.PASS, model_version="demo-v1"), "text")

    def test_no_document_is_an_answer_not_a_failure(self) -> None:
        result = OcrResult(status=OcrStatus.NO_DOCUMENT, model_version="demo-v1")

        assert result.is_unavailable is False

    def test_unavailable_names_the_reason(self) -> None:
        result = OcrResult.unavailable("demo-v1", "engine not reachable")

        assert result.status is OcrStatus.UNAVAILABLE
        assert result.reason == "engine not reachable"
