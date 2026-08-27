"""T05 - THROWAWAY Day-0 spike. The subject under test.

Proves the *preferred* D23 ingest path end to end, in Python only:

    LiveKit room -> subscribe to the customer video track -> decode frames

Deliberately NOT here: liveness, face match, OCR, Redis, WebSocket,
/internal/ai/result, or any session logic. This decides D23 and is then deleted.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from livekit import api, rtc

HERE = Path(__file__).resolve().parent


# --------------------------------------------------------------- reporting
def log(msg: str) -> None:
    print("   [py] " + msg, flush=True)


def peak_rss_mb() -> float:
    """Peak working set of this process, via psapi. No third-party dependency."""
    if os.name != "nt":
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    # GetCurrentProcess returns a HANDLE. ctypes defaults restype to c_int,
    # which truncates it on win64 and makes the call silently report 0.
    kernel32 = ctypes.WinDLL("kernel32")
    psapi = ctypes.WinDLL("psapi")
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(Counters),
        ctypes.c_ulong,
    ]

    c = Counters()
    c.cb = ctypes.sizeof(c)
    if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb):
        return float("nan")
    return c.PeakWorkingSetSize / (1024 * 1024)


def buffer_type_name(value: int) -> str:
    try:
        return rtc.VideoBufferType.Name(value)
    except Exception:
        return str(value)


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


# --------------------------------------------------------------- main
async def run(args: argparse.Namespace) -> dict:
    env = read_env(Path(args.env))
    key, secret = env["LIVEKIT_API_KEY"], env["LIVEKIT_API_SECRET"]

    # 1. Authenticate. The analyzer mints its own subscribe-only token, so this
    #    exercises the real credential path rather than being handed a token.
    token = (
        api.AccessToken(key, secret)
        .with_identity(args.identity)
        .with_name("t05 analyzer")
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=args.room,
                can_subscribe=True,
                can_publish=False,
                can_publish_data=False,
            )
        )
        .to_jwt()
    )
    log("minted subscribe-only token for " + repr(args.identity) + " (key " + key + ")")

    room = rtc.Room()
    track_q: asyncio.Queue = asyncio.Queue()
    subscribed_to: list[str] = []
    skipped: list[str] = []

    def want(pub, ident: str) -> bool:
        """Requirement 3: the CUSTOMER VIDEO track specifically - nothing else."""
        return ident == args.customer and pub.kind == rtc.TrackKind.KIND_VIDEO

    def consider(pub, ident: str) -> None:
        kind = "video" if pub.kind == rtc.TrackKind.KIND_VIDEO else "audio"
        label = ident + "/" + kind
        if want(pub, ident):
            pub.set_subscribed(True)
            subscribed_to.append(label)
            log("subscribing to " + label + "  (sid " + str(pub.sid) + ")")
        else:
            skipped.append(label)
            log("leaving " + label + " unsubscribed")

    @room.on("track_published")
    def _on_published(pub, p) -> None:
        consider(pub, p.identity)

    @room.on("track_subscribed")
    def _on_subscribed(track, pub, p) -> None:
        if isinstance(track, rtc.RemoteVideoTrack) and p.identity == args.customer:
            log("track_subscribed: video from " + p.identity)
            track_q.put_nowait(track)

    # 2. Join. auto_subscribe=False so the selection above is genuinely ours.
    t_connect = time.monotonic()
    await room.connect(args.url, token, rtc.RoomOptions(auto_subscribe=False))
    connect_ms = (time.monotonic() - t_connect) * 1000
    log("connected to room " + repr(room.name) + " in " + str(round(connect_ms)) + "ms")

    # Participants already in the room when we joined.
    for p in room.remote_participants.values():
        for pub in p.track_publications.values():
            consider(pub, p.identity)

    try:
        track = await asyncio.wait_for(track_q.get(), timeout=args.timeout)
    except TimeoutError:
        await room.disconnect()
        raise SystemExit(
            f"FAIL: no video track from {args.customer!r} within {args.timeout}s"
        ) from None

    # 3. Receive + decode.
    stream = rtc.VideoStream(track)
    frames: list[dict] = []
    state = {"prev_mean": None, "first_ts_us": None}
    cpu0 = time.process_time()
    t0 = time.monotonic()

    async def pump() -> None:
        async for ev in stream:
            f = ev.frame
            # The decode under test: native buffer -> RGB24. Timed on its own,
            # so the reported cost is the SDK's and not this spike's numpy work.
            d0 = time.perf_counter()
            rgb = f.convert(rtc.VideoBufferType.RGB24)
            buf = np.frombuffer(bytes(rgb.data), dtype=np.uint8)
            decode_ms = (time.perf_counter() - d0) * 1000
            expected = f.width * f.height * 3
            if buf.size != expected:
                raise SystemExit(
                    "FAIL: RGB24 buffer " + str(buf.size) + " bytes, expected " + str(expected)
                )

            a0 = time.perf_counter()
            mean = float(buf.mean())
            analyse_ms = (time.perf_counter() - a0) * 1000
            prev = state["prev_mean"]
            delta = abs(mean - prev) if prev is not None else 0.0
            state["prev_mean"] = mean
            if state["first_ts_us"] is None:
                state["first_ts_us"] = ev.timestamp_us

            n = len(frames) + 1
            elapsed = time.monotonic() - t0
            rel_ms = round((ev.timestamp_us - state["first_ts_us"]) / 1000, 1)
            fps_so_far = round(n / elapsed, 2) if elapsed > 0 else 0.0
            frames.append(
                {
                    "n": n,
                    "width": f.width,
                    "height": f.height,
                    "buffer_type": buffer_type_name(f.type),
                    "timestamp_us": ev.timestamp_us,
                    "rel_ms": rel_ms,
                    "rel_wall_ms": round(elapsed * 1000, 1),
                    "rgb24_bytes": int(buf.size),
                    "decode_ms": round(decode_ms, 2),
                    "analyse_ms": round(analyse_ms, 2),
                    "mean_luma": round(mean, 2),
                    "delta_vs_prev": round(delta, 3),
                    "fps_so_far": fps_so_far,
                }
            )
            if n <= 5 or n % 10 == 0 or n == args.frames:
                log(
                    f"frame {n:>3}  {f.width}x{f.height}"
                    f"  ts={ev.timestamp_us}us (+{rel_ms}ms)"
                    f"  rgb24={buf.size}B"
                    f"  luma={mean:.1f}"
                    f"  decode={decode_ms:.1f}ms"
                    f"  ~{fps_so_far}fps"
                )
            if n >= args.frames:
                return

    try:
        await asyncio.wait_for(pump(), timeout=args.timeout)
    except TimeoutError:
        raise SystemExit(
            f"FAIL: only {len(frames)}/{args.frames} frames within {args.timeout}s"
        ) from None

    wall = time.monotonic() - t0
    cpu = time.process_time() - cpu0

    # 4. Exit cleanly.
    await stream.aclose()
    await room.disconnect()
    log("stream closed and room disconnected cleanly")

    # A frame arriving is not the same as a frame containing a picture - the
    # T04 lesson. Assert on decoded content, not on the frame count alone.
    means = [x["mean_luma"] for x in frames]
    motion = [x["delta_vs_prev"] for x in frames[1:]]
    if max(means) < 2.0:
        raise SystemExit("FAIL: every frame is black (max mean luma " + str(max(means)) + ")")
    if max(motion) < 0.05:
        raise SystemExit("FAIL: frames never change - a frozen buffer, not live video")

    ts_span_s = (frames[-1]["timestamp_us"] - frames[0]["timestamp_us"]) / 1e6

    # Resolution is NOT constant: simulcast starts at a low layer and ramps up.
    # Reporting only the first frame would misrepresent what a consumer sees.
    resolutions: dict[str, int] = {}
    for x in frames:
        key = str(x["width"]) + "x" + str(x["height"])
        resolutions[key] = resolutions.get(key, 0) + 1
    steady = str(frames[-1]["width"]) + "x" + str(frames[-1]["height"])
    # Does the consumer keep up? Compare elapsed wall time against the media
    # timeline over the same frames. Growing lag means backpressure, and would
    # change how T30 must consume frames.
    wall_span_ms = frames[-1]["rel_wall_ms"] - frames[0]["rel_wall_ms"]
    media_span_ms = frames[-1]["rel_ms"] - frames[0]["rel_ms"]
    lag_ms = round(wall_span_ms - media_span_ms, 1)

    decode_ms = sorted(x["decode_ms"] for x in frames)
    steady_decode = [x["decode_ms"] for x in frames if f"{x['width']}x{x['height']}" == steady]

    return {
        "ok": True,
        "path": "preferred/native-python-livekit-rtc",
        "python": sys.version.split()[0],
        "livekit_rtc": rtc.__version__,
        "room": args.room,
        "customer": args.customer,
        "connect_ms": round(connect_ms, 1),
        "subscribed": subscribed_to,
        "left_unsubscribed": skipped,
        "frames_requested": args.frames,
        "frames_decoded": len(frames),
        "first_resolution": str(frames[0]["width"]) + "x" + str(frames[0]["height"]),
        "steady_resolution": steady,
        "resolution_histogram": resolutions,
        "buffer_type": frames[0]["buffer_type"],
        "decode_ms_median": decode_ms[len(decode_ms) // 2],
        "decode_ms_max": decode_ms[-1],
        "decode_ms_median_at_steady": (
            sorted(steady_decode)[len(steady_decode) // 2] if steady_decode else None
        ),
        "wall_span_ms": round(wall_span_ms, 1),
        "media_span_ms": round(media_span_ms, 1),
        "consumer_lag_ms": lag_ms,
        "wall_seconds": round(wall, 2),
        "fps_wall": round(len(frames) / wall, 2),
        "fps_timestamps": round((len(frames) - 1) / ts_span_s, 2) if ts_span_s > 0 else None,
        "cpu_seconds": round(cpu, 2),
        "cpu_percent_of_one_core": round(100 * cpu / wall, 1),
        "peak_rss_mb": round(peak_rss_mb(), 1),
        "mean_luma_range": [round(min(means), 2), round(max(means), 2)],
        "max_interframe_delta": round(max(motion), 3),
        "frames": frames,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:7880")
    ap.add_argument("--room", default="t05-spike")
    ap.add_argument("--identity", default="ai-analyzer")
    ap.add_argument("--customer", default="customer-A")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--timeout", type=float, default=45.0)
    ap.add_argument("--env", default=str(HERE.parent.parent / "infra" / ".env"))
    ap.add_argument("--out", default=str(HERE / "out" / "result.json"))
    args = ap.parse_args()

    result = asyncio.run(run(args))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf8")
    log("wrote " + str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
