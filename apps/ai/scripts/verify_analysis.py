"""T30 verification against a real LiveKit server.

Everything in `tests/` runs against a fake frame source, because a test that
needs an SFU is a test that stops being run. This script is the other half:
it puts real video on a real room and drives the real ingest path, which is
the one part of T30 no unit test can reach.

    publisher (identity "customer")  ->  LiveKit  ->  LiveKitFrameSource
                                                   ->  sample / decode
                                                   ->  providers
                                                   ->  result payloads

What it asserts, in order of how much it would hurt to get wrong:

  1. Frames arrive, decode to RGB24, and produce results on the cadence
     configured — not on every frame (the T05 spike's fourth finding).
  2. The analyzer is **hidden**: the publisher never sees it in the room. If
     this regressed, a customer would see a silent third participant watching
     their identity verification, and T28's grid composite would record it.
  3. The analyzer **leaves when the customer does**. `infra/livekit.yaml`
     closes an empty room, and that is what stops the recording (T28 has no
     stop call), so an analyzer that lingered would hold the evidence file
     open.

Run with the T03 stack up:

    cd infra && docker compose up -d
    pnpm --filter @vcip/ai run verify:analysis
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from livekit import api, rtc  # noqa: E402

from app.analysis import (  # noqa: E402
    AnalysisManager,
    AnalysisRequest,
    Cadence,
)
from app.analysis.livekit_source import LiveKitFrameSource  # noqa: E402
from app.providers import build_providers  # noqa: E402

ROOM = "vcip_t30-verify"
SESSION = "t30-verify-0000-0000-000000000001"
WIDTH, HEIGHT = 320, 240
PUBLISH_FPS = 15
RUN_SECONDS = 8.0

CADENCE = Cadence(
    sample_interval_us=250_000,  # 4 fps sampled
    check_interval_us=2_000_000,  # a result every 2 s
    ocr_interval_us=5_000_000,
)


def env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def i420(width: int, height: int, phase: float) -> bytes:
    """A moving pattern, in the format a camera actually delivers.

    Deliberately not a solid colour: the T05 spike's sixth finding is that a
    frame arriving is not a frame containing a picture, and a static buffer
    would pass a frame count while proving nothing about the decode.
    """
    luma = bytearray(width * height)
    for y in range(height):
        row = y * width
        for x in range(width):
            luma[row + x] = int(128 + 100 * math.sin((x + phase * 40) / 18.0 + y / 30.0)) & 0xFF

    chroma_size = (width // 2) * (height // 2)
    u = bytes([int(128 + 60 * math.sin(phase)) & 0xFF]) * chroma_size
    v = bytes([int(128 + 60 * math.cos(phase)) & 0xFF]) * chroma_size
    return bytes(luma) + u + v


class Results:
    """Collects what the analysis publishes, instead of a Control API."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    async def publish(self, payload: dict[str, object]) -> None:
        self.payloads.append(payload)
        print(
            f"   result {len(self.payloads)}: "
            f"liveness={payload['liveness_status']}({payload['liveness_score']}) "
            f"face_match={payload['face_match_score']} "
            f"ocr={payload['ocr_status']}"
        )

    async def aclose(self) -> None:
        return None


async def publish_video(url: str, token: str, stop: asyncio.Event) -> rtc.Room:
    """Join as the customer and publish a synthetic camera."""
    room = rtc.Room()
    await room.connect(url, token)

    source = rtc.VideoSource(WIDTH, HEIGHT)
    track = rtc.LocalVideoTrack.create_video_track("camera", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA)
    )

    async def pump() -> None:
        frame_number = 0
        while not stop.is_set():
            source.capture_frame(
                rtc.VideoFrame(
                    WIDTH,
                    HEIGHT,
                    rtc.VideoBufferType.I420,
                    i420(WIDTH, HEIGHT, frame_number / 8.0),
                )
            )
            frame_number += 1
            await asyncio.sleep(1 / PUBLISH_FPS)

    room.pump_task = asyncio.create_task(pump())  # type: ignore[attr-defined]
    return room


def token_for(key: str, secret: str, identity: str, *, publish: bool, hidden: bool) -> str:
    grants = api.VideoGrants(
        room_join=True,
        room=ROOM,
        can_publish=publish,
        can_subscribe=True,
        can_publish_data=False,
        hidden=hidden,
    )
    return api.AccessToken(key, secret).with_identity(identity).with_grants(grants).to_jwt()


def check(passed: bool, message: str) -> bool:
    print(f"   {'PASS' if passed else 'FAIL'}  {message}")
    return passed


async def main() -> int:
    root = Path(__file__).resolve().parent.parent.parent.parent
    values = env(root / "infra" / ".env")
    url = "ws://127.0.0.1:" + values.get("LIVEKIT_PORT", "7880")
    key = values["LIVEKIT_API_KEY"]
    secret = values["LIVEKIT_API_SECRET"]

    print(f"\n[1] Publishing a synthetic camera into {ROOM} at {url}")
    stop = asyncio.Event()
    publisher = await publish_video(
        url, token_for(key, secret, "customer", publish=True, hidden=False), stop
    )
    print("   PASS  customer connected and publishing")

    print("\n[2] Starting the analysis through the real LiveKit source")
    results = Results()
    manager = AnalysisManager(
        providers=build_providers({}),
        publisher=results,  # type: ignore[arg-type]
        source_factory=lambda request: LiveKitFrameSource(
            url=request.livekit_url,
            token=request.token,
            room_name=request.room_name,
            track_timeout_s=15.0,
        ),
        cadence=CADENCE,
        max_analysis_s=60.0,
    )
    manager.start(
        AnalysisRequest(
            session_id=SESSION,
            room_name=ROOM,
            token=token_for(key, secret, "analyzer", publish=False, hidden=True),
            livekit_url=url,
        )
    )

    await asyncio.sleep(RUN_SECONDS)

    print(f"\n[3] After {RUN_SECONDS:.0f}s of real video")
    ok = True
    ok &= check(len(results.payloads) >= 3, f"published {len(results.payloads)} results (>= 3)")
    ok &= check(
        all(p["liveness_status"] in {"LIVE", "NOT_LIVE", "UNKNOWN"} for p in results.payloads),
        "every liveness status is a real answer, not UNAVAILABLE",
    )
    ok &= check(
        all(p["ocr_status"] != "UNAVAILABLE" for p in results.payloads),
        "OCR ran against decoded frames",
    )
    ok &= check(
        all(p["model_versions"]["liveness"] == "demo-v1" for p in results.payloads),
        "results name the model that produced them",
    )

    print("\n[4] The analyzer is invisible to the customer")
    seen = [p.identity for p in publisher.remote_participants.values()]
    ok &= check(
        "analyzer" not in seen,
        f"the publisher sees {seen or 'nobody'}, not the analyzer",
    )

    print("\n[5] The analyzer leaves when the customer does")
    stop.set()
    with contextlib.suppress(Exception):
        publisher.pump_task.cancel()  # type: ignore[attr-defined]
    await publisher.disconnect()

    left_by = time.monotonic() + 10.0
    while manager.active_sessions and time.monotonic() < left_by:
        await asyncio.sleep(0.1)
    ok &= check(
        not manager.active_sessions,
        "the analysis ended, so the room can empty and the recording can stop",
    )

    await manager.shutdown()
    print("\n" + ("RESULT: all checks passed" if ok else "RESULT: FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
