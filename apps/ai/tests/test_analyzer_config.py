"""Analyzer configuration."""

from __future__ import annotations

import pytest

from app.config import (
    DEFAULT_CHECK_INTERVAL_MS,
    DEFAULT_CONTROL_API_URL,
    DEFAULT_OCR_INTERVAL_MS,
    DEFAULT_SAMPLE_INTERVAL_MS,
    VIDEO_QUALITIES,
    AnalyzerConfig,
    analyzer_config_from_env,
)

TOKEN = "an-internal-token-long-enough"


def env(**overrides: str) -> dict[str, str]:
    return {"VCIP_INTERNAL_TOKEN": TOKEN, **overrides}


class TestDefaults:
    def test_uses_the_documented_cadence(self) -> None:
        config = analyzer_config_from_env(env())

        assert config.sample_interval_us == DEFAULT_SAMPLE_INTERVAL_MS * 1000
        assert config.check_interval_us == DEFAULT_CHECK_INTERVAL_MS * 1000
        assert config.ocr_interval_us == DEFAULT_OCR_INTERVAL_MS * 1000

    def test_samples_faster_than_it_checks(self) -> None:
        """Otherwise liveness gets one frame per check, and one frame is a photo."""
        config = analyzer_config_from_env(env())

        assert config.sample_interval_us < config.check_interval_us

    def test_runs_ocr_more_slowly_than_the_other_checks(self) -> None:
        """§19: do not run expensive OCR on every frame."""
        config = analyzer_config_from_env(env())

        assert config.ocr_interval_us > config.check_interval_us

    def test_defaults_to_the_local_control_api(self) -> None:
        assert analyzer_config_from_env(env()).control_api_url == DEFAULT_CONTROL_API_URL


class TestOverrides:
    def test_reads_the_intervals_in_milliseconds(self) -> None:
        config = analyzer_config_from_env(
            env(AI_SAMPLE_INTERVAL_MS="100", AI_CHECK_INTERVAL_MS="1000", AI_OCR_INTERVAL_MS="3000")
        )

        assert (config.sample_interval_us, config.check_interval_us) == (100_000, 1_000_000)
        assert config.ocr_interval_us == 3_000_000

    def test_trims_a_trailing_slash_from_the_api_url(self) -> None:
        """So the joined path is never `//internal/ai/result`."""
        config = analyzer_config_from_env(env(AI_CONTROL_API_URL="http://api:3001/"))

        assert config.control_api_url == "http://api:3001"

    @pytest.mark.parametrize("value", ["nonsense", "-1", "0"])
    def test_rejects_an_unusable_interval(self, value: str) -> None:
        with pytest.raises(ValueError, match="AI_SAMPLE_INTERVAL_MS"):
            analyzer_config_from_env(env(AI_SAMPLE_INTERVAL_MS=value))


class TestVideoQuality:
    """Which simulcast layer the analyzer asks the server for."""

    def test_expresses_no_preference_by_default(self) -> None:
        """Unset is the behaviour this service had before the variable existed."""
        assert analyzer_config_from_env(env()).video_quality is None

    @pytest.mark.parametrize("value", VIDEO_QUALITIES)
    def test_accepts_each_layer(self, value: str) -> None:
        assert analyzer_config_from_env(env(AI_VIDEO_QUALITY=value)).video_quality == value

    def test_is_case_insensitive(self) -> None:
        assert analyzer_config_from_env(env(AI_VIDEO_QUALITY=" LOW ")).video_quality == "low"

    def test_blank_means_unset_rather_than_invalid(self) -> None:
        assert analyzer_config_from_env(env(AI_VIDEO_QUALITY="   ")).video_quality is None

    def test_an_unrecognised_layer_stops_the_process(self) -> None:
        """A wrong layer is invisible in a running service, so it fails at boot."""
        with pytest.raises(ValueError, match="AI_VIDEO_QUALITY"):
            analyzer_config_from_env(env(AI_VIDEO_QUALITY="tiny"))


class TestFailFast:
    def test_a_missing_internal_token_stops_the_process(self) -> None:
        """Found at boot, while somebody is watching — not mid-call."""
        with pytest.raises(ValueError, match="VCIP_INTERNAL_TOKEN"):
            analyzer_config_from_env({})

    def test_sampling_more_slowly_than_checking_is_refused(self) -> None:
        with pytest.raises(ValueError, match="must not exceed"):
            analyzer_config_from_env(env(AI_SAMPLE_INTERVAL_MS="5000", AI_CHECK_INTERVAL_MS="1000"))


def test_the_config_does_not_print_its_token() -> None:
    """A config object reaches a log through more routes than one."""
    config = analyzer_config_from_env(env())

    assert TOKEN not in repr(config)
    assert isinstance(config, AnalyzerConfig)
