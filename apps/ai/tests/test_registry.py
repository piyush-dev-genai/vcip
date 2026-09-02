"""Provider selection from configuration."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.providers import (
    DEFAULT_REFERENCE_DIR,
    MODE_ENV_VAR,
    REFERENCE_DIR_ENV_VAR,
    EmptyReferenceStore,
    FaceMatchProvider,
    LivenessProvider,
    LivenessStatus,
    LocalReferenceStore,
    MockFaceMatchProvider,
    MockLivenessProvider,
    MockOCRProvider,
    OCRProvider,
    OcrStatus,
    ProviderMode,
    ReferenceUnavailable,
    build_providers,
    resolve_mode,
)
from tests.helpers import frame, frames, run

SESSION = "11111111-2222-3333-4444-555555555555"


class TestResolveMode:
    def test_unset_means_mock(self) -> None:
        assert resolve_mode(None) is ProviderMode.MOCK
        assert resolve_mode("") is ProviderMode.MOCK

    @pytest.mark.parametrize("raw", ["mock", "MOCK", "  Mock  "])
    def test_accepts_mock_however_it_is_written(self, raw: str) -> None:
        assert resolve_mode(raw) is ProviderMode.MOCK

    def test_accepts_unavailable(self) -> None:
        assert resolve_mode("unavailable") is ProviderMode.UNAVAILABLE

    def test_an_unknown_mode_stops_the_process(self) -> None:
        """A demo that silently ran on mocks because of a typo is the worst outcome."""
        with pytest.raises(ValueError) as caught:
            resolve_mode("mocks")

        assert MODE_ENV_VAR in str(caught.value)
        assert "mock, unavailable" in str(caught.value)


class TestMockMode:
    def test_is_the_default(self) -> None:
        providers = build_providers({})

        assert providers.mode is ProviderMode.MOCK
        assert isinstance(providers.liveness, MockLivenessProvider)
        assert isinstance(providers.face_match, MockFaceMatchProvider)
        assert isinstance(providers.ocr, MockOCRProvider)
        assert isinstance(providers.references, LocalReferenceStore)

    def test_reads_the_shipped_reference_directory(self) -> None:
        providers = build_providers({})

        assert providers.references.directory == DEFAULT_REFERENCE_DIR
        assert run(providers.references.load(session_id=SESSION)).source == "default.ppm"

    def test_the_reference_directory_is_configurable(self, tmp_path: Path) -> None:
        (tmp_path / "default.ppm").write_bytes(b"P3 elsewhere")

        providers = build_providers({REFERENCE_DIR_ENV_VAR: str(tmp_path)})

        assert run(providers.references.load(session_id=SESSION)).data == b"P3 elsewhere"

    def test_model_versions_are_per_provider(self) -> None:
        """The keys `session_ai_summaries.model_versions` stores (§19)."""
        assert build_providers({}).model_versions() == {
            "liveness": "demo-v1",
            "face_match": "demo-v1",
            "ocr": "demo-v1",
        }


class TestUnavailableMode:
    def test_every_check_reports_unavailable(self) -> None:
        """T32: a degraded AI service, not an unplugged one."""
        providers = build_providers({MODE_ENV_VAR: "unavailable"})

        liveness = run(providers.liveness.analyze(session_id=SESSION, frames=frames()))
        ocr = run(providers.ocr.extract(session_id=SESSION, frame=frame()))

        assert liveness.status is LivenessStatus.UNAVAILABLE
        assert ocr.status is OcrStatus.UNAVAILABLE
        assert liveness.reason is not None

    def test_the_reference_store_holds_nothing(self) -> None:
        providers = build_providers({MODE_ENV_VAR: "unavailable"})

        assert isinstance(providers.references, EmptyReferenceStore)
        with pytest.raises(ReferenceUnavailable):
            run(providers.references.load(session_id=SESSION))

    def test_it_does_not_claim_a_model_version_it_has_no_model_for(self) -> None:
        assert build_providers({MODE_ENV_VAR: "unavailable"}).model_versions() == {
            "liveness": "unavailable",
            "face_match": "unavailable",
            "ocr": "unavailable",
        }

    def test_the_degraded_providers_still_satisfy_the_interfaces(self) -> None:
        providers = build_providers({MODE_ENV_VAR: "unavailable"})

        assert isinstance(providers.liveness, LivenessProvider)
        assert isinstance(providers.face_match, FaceMatchProvider)
        assert isinstance(providers.ocr, OCRProvider)

    def test_a_caller_bug_is_still_a_caller_bug(self) -> None:
        """Being degraded does not turn an empty frame list into an AI outage."""
        providers = build_providers({MODE_ENV_VAR: "unavailable"})

        with pytest.raises(ValueError, match="must not be empty"):
            run(providers.liveness.analyze(session_id=SESSION, frames=[]))


class TestEnvironmentSource:
    def test_falls_back_to_the_process_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(MODE_ENV_VAR, "unavailable")

        assert build_providers().mode is ProviderMode.UNAVAILABLE

    def test_an_unset_variable_leaves_the_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(MODE_ENV_VAR, raising=False)

        assert build_providers().mode is ProviderMode.MOCK
