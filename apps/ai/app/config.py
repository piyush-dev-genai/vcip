"""What the analyzer is configured with (T30).

Two credentials and a handful of intervals. The intervals are configuration
rather than constants because the right sampling rate depends on the machine
the demo runs on, and the T05 spike's headline finding is that this is the
number that decides whether the service keeps up.

Nothing here is a secret except `internal_token`, and nothing here is a LiveKit
credential: the Control API mints the analyzer's join token per call and sends
it with the request. A compromised AI service can read the rooms it was handed
and cannot mint itself another.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

CONTROL_API_URL_ENV_VAR = "AI_CONTROL_API_URL"
INTERNAL_TOKEN_ENV_VAR = "VCIP_INTERNAL_TOKEN"

DEFAULT_CONTROL_API_URL = "http://localhost:3001"

#: How often a frame is decoded and kept. 4 fps, not the stream's ~20.
#:
#: The spike measured I420 -> RGB24 at 720p costing ~23 ms, which at 20 fps is
#: essentially a whole core for one call. Liveness needs a few frames per
#: second to see movement; it does not need every frame, and the frames it
#: skips are never converted at all.
DEFAULT_SAMPLE_INTERVAL_MS = 250

#: How often liveness and face match run, and a result is published.
DEFAULT_CHECK_INTERVAL_MS = 2_000

#: How often OCR runs.
#:
#: Slower than the other two because `03-system-design.md` §19 says OCR is
#: triggered by a document being presented rather than run continuously, and
#: the MVP has no trigger API for the customer or agent to call. A slow cadence
#: is the closest honest approximation: the document gets read within a few
#: seconds of being held up, and the expensive check does not run on every
#: cycle. When a real trigger exists it replaces this interval and nothing else.
DEFAULT_OCR_INTERVAL_MS = 5_000

#: How long to wait for the customer's video track before giving up.
#:
#: Reaching this is not an error in this service: it means the customer's
#: camera never published. One UNAVAILABLE result is reported so the agent's
#: HUD says something rather than staying blank forever.
DEFAULT_TRACK_TIMEOUT_S = 30.0

#: A ceiling on one analysis, so a room that never closes cannot leak a task.
DEFAULT_MAX_ANALYSIS_S = 7_200.0

#: How long to wait on the Control API when publishing a result.
#:
#: Short. The result is a HUD update that will be superseded in two seconds;
#: waiting on it would delay the analysis of a live call for a value already
#: stale by the time it arrived.
DEFAULT_PUBLISH_TIMEOUT_S = 5.0

#: Which simulcast layer to ask the server for, or nothing at all.
#:
#: A browser publishes one video track as several layers and LiveKit sends the
#: highest by default, so an unset value is the behaviour this service has
#: always had and stays the local default.
#:
#: It is worth naming because the layer decides what this service costs. The
#: T05 spike measured full-frame I420 -> RGB24 at 720p at ~23 ms; the same
#: conversion at 320x180 is under 2 ms, and the decode behind it falls by
#: roughly the same factor. On a host with a fraction of a core that difference
#: is between keeping up and falling behind.
#:
#: What it does *not* affect is any answer. The providers are seeded from the
#: session id (`providers/determinism.py`), so in `mock` mode a frame's pixels
#: reach no decision at all — and a real provider would be given its own
#: resolution requirement rather than inheriting this one.
VIDEO_QUALITIES = ("low", "medium", "high")


@dataclass(frozen=True, slots=True)
class AnalyzerConfig:
    """Everything the analysis loop needs that is not per session."""

    control_api_url: str
    internal_token: str
    sample_interval_us: int
    check_interval_us: int
    ocr_interval_us: int
    track_timeout_s: float
    max_analysis_s: float
    publish_timeout_s: float
    #: One of `VIDEO_QUALITIES`, or None to express no preference.
    video_quality: str | None

    def __post_init__(self) -> None:
        if not self.control_api_url.strip():
            raise ValueError(f"{CONTROL_API_URL_ENV_VAR} must not be empty")
        if not self.internal_token.strip():
            raise ValueError(f"{INTERNAL_TOKEN_ENV_VAR} is not set")
        for name in ("sample_interval_us", "check_interval_us", "ocr_interval_us"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive, got {getattr(self, name)}")
        if self.video_quality is not None and self.video_quality not in VIDEO_QUALITIES:
            raise ValueError(
                f"AI_VIDEO_QUALITY must be one of {', '.join(VIDEO_QUALITIES)} "
                f"or unset, got {self.video_quality!r}"
            )
        if self.sample_interval_us > self.check_interval_us:
            # Liveness reads a window of sampled frames. Sampling more slowly
            # than the check runs would hand it one frame, and one frame is a
            # photograph — the provider would answer UNKNOWN every cycle.
            raise ValueError("sample_interval_us must not exceed check_interval_us")

    def __repr__(self) -> str:
        """Redacted. A config object reaches a log through more routes than one."""
        return "AnalyzerConfig(redacted)"


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None
    if value <= 0:
        raise ValueError(f"{name} must be positive, got {value}")
    return value


def _positive_float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if value <= 0:
        raise ValueError(f"{name} must be positive, got {value}")
    return value


def analyzer_config_from_env(env: Mapping[str, str] | None = None) -> AnalyzerConfig:
    """Build it from the environment, failing fast.

    Called at startup so a deployment missing the internal token stops there,
    rather than on the first call — by which point two people are already
    talking and the failure is invisible to whoever deployed it.
    """
    environment = os.environ if env is None else env

    return AnalyzerConfig(
        control_api_url=(
            environment.get(CONTROL_API_URL_ENV_VAR) or DEFAULT_CONTROL_API_URL
        ).rstrip("/"),
        internal_token=environment.get(INTERNAL_TOKEN_ENV_VAR, ""),
        sample_interval_us=_positive_int(
            environment, "AI_SAMPLE_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS
        )
        * 1000,
        check_interval_us=_positive_int(
            environment, "AI_CHECK_INTERVAL_MS", DEFAULT_CHECK_INTERVAL_MS
        )
        * 1000,
        ocr_interval_us=_positive_int(environment, "AI_OCR_INTERVAL_MS", DEFAULT_OCR_INTERVAL_MS)
        * 1000,
        track_timeout_s=_positive_float(environment, "AI_TRACK_TIMEOUT_S", DEFAULT_TRACK_TIMEOUT_S),
        max_analysis_s=_positive_float(environment, "AI_MAX_ANALYSIS_S", DEFAULT_MAX_ANALYSIS_S),
        publish_timeout_s=_positive_float(
            environment, "AI_PUBLISH_TIMEOUT_S", DEFAULT_PUBLISH_TIMEOUT_S
        ),
        # Unset means unset, not a default layer: expressing no preference and
        # asking for the highest one are different requests, and only the first
        # is what this service did before the variable existed.
        video_quality=(environment.get("AI_VIDEO_QUALITY") or "").strip().lower() or None,
    )
