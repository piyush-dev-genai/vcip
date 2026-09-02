"""The deterministic mock providers."""

from __future__ import annotations

import pytest

from app.providers import (
    MIN_LIVENESS_FRAMES,
    FaceMatchProvider,
    FaceMatchResult,
    FaceMatchStatus,
    LivenessProvider,
    LivenessResult,
    LivenessStatus,
    MockFaceMatchProvider,
    MockLivenessProvider,
    MockOCRProvider,
    OCRProvider,
    OcrResult,
    OcrStatus,
    ProviderUnavailable,
    Reference,
    validate_score,
)
from tests.helpers import frame, frames, run

SESSION = "11111111-2222-3333-4444-555555555555"
OTHER_SESSION = "a0000000-0000-4000-8000-000000000001"
REFERENCE = Reference(data=b"P3 demo", source="default.ppm")


def liveness_of(session_id: str, provider: MockLivenessProvider | None = None) -> LivenessResult:
    return run((provider or MockLivenessProvider()).analyze(session_id=session_id, frames=frames()))


def face_match_of(
    session_id: str, provider: MockFaceMatchProvider | None = None
) -> FaceMatchResult:
    return run(
        (provider or MockFaceMatchProvider()).compare(
            session_id=session_id, frame=frame(), reference=REFERENCE
        )
    )


def ocr_of(session_id: str, provider: MockOCRProvider | None = None) -> OcrResult:
    return run((provider or MockOCRProvider()).extract(session_id=session_id, frame=frame()))


class TestInterfaces:
    """The mocks are what the interfaces describe, and the signatures differ."""

    def test_each_mock_satisfies_its_protocol(self) -> None:
        assert isinstance(MockLivenessProvider(), LivenessProvider)
        assert isinstance(MockFaceMatchProvider(), FaceMatchProvider)
        assert isinstance(MockOCRProvider(), OCRProvider)

    def test_the_three_are_not_interchangeable(self) -> None:
        """Liveness needs a sequence, face match needs a reference, OCR needs neither."""
        assert not isinstance(MockOCRProvider(), LivenessProvider)
        assert not isinstance(MockLivenessProvider(), OCRProvider)

    def test_each_names_its_own_model_version(self) -> None:
        assert MockLivenessProvider().model_version == "demo-v1"
        assert MockFaceMatchProvider().model_version == "demo-v1"
        assert MockOCRProvider().model_version == "demo-v1"

    def test_the_version_travels_on_the_result(self) -> None:
        assert liveness_of(SESSION).model_version == "demo-v1"
        assert face_match_of(SESSION).model_version == "demo-v1"
        assert ocr_of(SESSION).model_version == "demo-v1"


class TestDeterminism:
    def test_the_same_session_gives_the_same_answer(self) -> None:
        assert liveness_of(SESSION) == liveness_of(SESSION)
        assert face_match_of(SESSION) == face_match_of(SESSION)
        assert ocr_of(SESSION) == ocr_of(SESSION)

    def test_a_fresh_provider_gives_the_same_answer(self) -> None:
        """Reproducible across process restarts, not just within one instance."""
        assert liveness_of(SESSION, MockLivenessProvider()) == liveness_of(
            SESSION, MockLivenessProvider()
        )

    def test_the_frames_do_not_change_the_answer(self) -> None:
        """Derived from the session id alone; a mock that read pixels would drift."""
        provider = MockLivenessProvider()
        few = run(provider.analyze(session_id=SESSION, frames=frames(2, width=320, height=180)))
        many = run(provider.analyze(session_id=SESSION, frames=frames(9, width=1280, height=720)))

        assert few == many

    def test_different_sessions_differ(self) -> None:
        assert liveness_of(SESSION) != liveness_of(OTHER_SESSION)
        assert ocr_of(SESSION) != ocr_of(OTHER_SESSION)

    def test_a_demo_run_produces_a_spread_of_scores(self) -> None:
        scores = {liveness_of(f"session-{n:04d}").score for n in range(40)}

        assert len(scores) > 10

    def test_the_three_checks_are_independent(self) -> None:
        """One session may be LIVE and NO_MATCH - the case the agent must see."""
        pairs = {
            (liveness_of(f"session-{n:04d}").status, face_match_of(f"session-{n:04d}").status)
            for n in range(60)
        }

        assert len({liveness for liveness, _ in pairs}) > 1
        assert len({(a, b) for a, b in pairs if a is LivenessStatus.LIVE}) > 1

    @pytest.mark.parametrize(
        ("session_id", "expected"),
        [
            (SESSION, (LivenessStatus.LIVE, 96, FaceMatchStatus.MATCH, 86, OcrStatus.PASS)),
            (
                OTHER_SESSION,
                (LivenessStatus.LIVE, 77, FaceMatchStatus.MATCH, 82, OcrStatus.NO_DOCUMENT),
            ),
            (
                "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
                (LivenessStatus.LIVE, 76, FaceMatchStatus.UNKNOWN, None, OcrStatus.PASS),
            ),
        ],
    )
    def test_known_sessions_keep_their_known_results(
        self,
        session_id: str,
        expected: tuple[LivenessStatus, int, FaceMatchStatus, int | None, OcrStatus],
    ) -> None:
        """A golden table.

        Reproducibility is the point of the mock: a demo re-run after a code
        change must show the same numbers. Changing the derivation is allowed,
        but it is a decision, and this table is where it has to be made.
        """
        liveness, face_match, ocr = (
            liveness_of(session_id),
            face_match_of(session_id),
            ocr_of(session_id),
        )

        assert (
            liveness.status,
            liveness.score,
            face_match.status,
            face_match.score,
            ocr.status,
        ) == expected


class TestOutcomeCoverage:
    """Every HUD state is reachable without scripting."""

    def test_liveness_reaches_all_three(self) -> None:
        statuses = {liveness_of(f"session-{n:04d}").status for n in range(60)}

        assert statuses == {LivenessStatus.LIVE, LivenessStatus.NOT_LIVE, LivenessStatus.UNKNOWN}

    def test_face_match_reaches_all_three(self) -> None:
        statuses = {face_match_of(f"session-{n:04d}").status for n in range(60)}

        assert statuses == {
            FaceMatchStatus.MATCH,
            FaceMatchStatus.NO_MATCH,
            FaceMatchStatus.UNKNOWN,
        }

    def test_ocr_reaches_all_three(self) -> None:
        statuses = {ocr_of(f"session-{n:04d}").status for n in range(60)}

        assert statuses == {OcrStatus.PASS, OcrStatus.FAIL, OcrStatus.NO_DOCUMENT}

    def test_nothing_is_unavailable_when_the_provider_is_healthy(self) -> None:
        assert not any(liveness_of(f"session-{n:04d}").is_unavailable for n in range(60))

    def test_every_score_is_a_valid_score(self) -> None:
        for n in range(60):
            for score in (liveness_of(f"session-{n:04d}").score, face_match_of(f"s-{n}").score):
                if score is not None:
                    validate_score(score)

    def test_most_sessions_look_like_a_working_verification(self) -> None:
        """A demo of a product that works should mostly show it working."""
        live = sum(liveness_of(f"session-{n:04d}").status is LivenessStatus.LIVE for n in range(60))

        assert live > 40


class TestLivenessInputs:
    def test_a_single_frame_cannot_decide(self) -> None:
        """One frame is a photograph; UNKNOWN is the honest answer, not NOT_LIVE."""
        result = run(MockLivenessProvider().analyze(session_id=SESSION, frames=frames(1)))

        assert result.status is LivenessStatus.UNKNOWN
        assert result.score is None
        assert MIN_LIVENESS_FRAMES == 2

    def test_no_frames_at_all_is_the_caller_bug(self) -> None:
        """Not UNAVAILABLE: that would send the agent chasing an outage."""
        with pytest.raises(ValueError, match="must not be empty"):
            run(MockLivenessProvider().analyze(session_id=SESSION, frames=[]))

    def test_a_non_frame_is_the_caller_bug(self) -> None:
        with pytest.raises(TypeError, match="must be a Frame"):
            run(MockLivenessProvider().analyze(session_id=SESSION, frames=["frame"]))  # type: ignore[list-item]

    def test_a_malformed_session_id_is_the_caller_bug(self) -> None:
        with pytest.raises(ValueError, match="session_id must be"):
            run(MockLivenessProvider().analyze(session_id="", frames=frames()))


class TestFaceMatchInputs:
    def test_the_reference_is_required(self) -> None:
        with pytest.raises(TypeError, match="must be a Reference"):
            run(
                MockFaceMatchProvider().compare(
                    session_id=SESSION,
                    frame=frame(),
                    reference=b"raw bytes",  # type: ignore[arg-type]
                )
            )

    def test_the_reference_content_does_not_steer_the_score(self) -> None:
        provider = MockFaceMatchProvider()
        one = run(provider.compare(session_id=SESSION, frame=frame(), reference=REFERENCE))
        two = run(
            provider.compare(
                session_id=SESSION,
                frame=frame(fill=200),
                reference=Reference(data=b"P3 something else", source="other.ppm"),
            )
        )

        assert one == two


class TestScriptedOverrides:
    def test_a_scripted_result_pre_empts_the_derived_one(self) -> None:
        scripted = LivenessResult(status=LivenessStatus.NOT_LIVE, score=12, model_version="demo-v1")
        provider = MockLivenessProvider(overrides={SESSION: scripted})

        assert liveness_of(SESSION, provider) == scripted

    def test_other_sessions_are_untouched(self) -> None:
        provider = MockLivenessProvider(
            overrides={SESSION: LivenessResult.unavailable("demo-v1", "scripted")}
        )

        assert liveness_of(OTHER_SESSION, provider) == liveness_of(OTHER_SESSION)

    @pytest.mark.parametrize("scripted", [RuntimeError, ProviderUnavailable])
    def test_scripting_an_exception_class_is_refused(self, scripted: type[Exception]) -> None:
        """Otherwise the class comes back as though it were a result."""
        with pytest.raises(TypeError, match="as an instance, not the class"):
            MockLivenessProvider(overrides={SESSION: scripted})  # type: ignore[dict-item]

        provider = MockOCRProvider()
        with pytest.raises(TypeError, match="as an instance, not the class"):
            provider.script.set(SESSION, scripted)  # type: ignore[arg-type]

    def test_a_script_can_be_set_and_cleared_after_construction(self) -> None:
        provider = MockOCRProvider()
        derived = ocr_of(SESSION, provider)

        provider.script.set(SESSION, OcrResult(status=OcrStatus.FAIL, model_version="demo-v1"))
        assert ocr_of(SESSION, provider).status is OcrStatus.FAIL

        provider.script.clear()
        assert ocr_of(SESSION, provider) == derived


class TestFailureSemantics:
    """An expected failure is a result; a bug is an exception."""

    def test_liveness_unavailability_becomes_a_result(self) -> None:
        provider = MockLivenessProvider(
            overrides={SESSION: ProviderUnavailable("model host timed out")}
        )

        result = liveness_of(SESSION, provider)

        assert result.status is LivenessStatus.UNAVAILABLE
        assert result.score is None
        assert result.reason == "model host timed out"
        assert result.model_version == "demo-v1"

    def test_face_match_unavailability_becomes_a_result(self) -> None:
        provider = MockFaceMatchProvider(overrides={SESSION: ProviderUnavailable("no capacity")})

        result = face_match_of(SESSION, provider)

        assert result.status is FaceMatchStatus.UNAVAILABLE
        assert result.reason == "no capacity"

    def test_ocr_unavailability_becomes_a_result(self) -> None:
        provider = MockOCRProvider(overrides={SESSION: ProviderUnavailable("engine restarting")})

        result = ocr_of(SESSION, provider)

        assert result.status is OcrStatus.UNAVAILABLE
        assert result.reason == "engine restarting"

    def test_unavailable_is_not_no_document(self) -> None:
        """The HUD says 'AI unavailable' for one and 'no document' for the other."""
        provider = MockOCRProvider(overrides={SESSION: ProviderUnavailable("engine restarting")})

        assert ocr_of(SESSION, provider).status is not OcrStatus.NO_DOCUMENT

    @pytest.mark.parametrize(
        "bug", [RuntimeError("a bug"), AttributeError("a typo"), KeyError("missing")]
    )
    def test_a_programming_error_is_not_dressed_up_as_unavailability(self, bug: Exception) -> None:
        """Hiding a bug behind a message agents ignore is how bugs live forever."""
        provider = MockLivenessProvider(overrides={SESSION: bug})

        with pytest.raises(type(bug)):
            liveness_of(SESSION, provider)
