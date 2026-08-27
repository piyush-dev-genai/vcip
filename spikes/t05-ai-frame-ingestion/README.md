# T05 — AI frame ingestion spike (decides D23)

**Throwaway.** Delete once T30 lands. This exists to make one decision, not to
become the AI pipeline.

## Verdict

**Preferred path selected: server-side LiveKit subscription in Python.** The
browser-side frame-sampling fallback was **not** required and was not built.

## What it proves

```
Customer browser -> LiveKit -> Python analyzer -> customer video track -> decoded frames
```

`analyzer.py` is the subject under test. `run.mjs` is only a harness: it puts a
real Chromium publisher in the room so the analyzer has genuine WebRTC video to
subscribe to.

Explicitly **not** here, per the T05 brief: liveness, face match, OCR, Redis HUD,
WebSocket, `/internal/ai/result`, or any session logic.

## Run

```bash
cd infra && docker compose up -d          # T03 stack must be running
cd spikes/t05-ai-frame-ingestion
py -3 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
pnpm install --ignore-workspace
pnpm exec playwright install chromium
node run.mjs                              # FRAMES=300 node run.mjs for a longer run
```

`out/result.json` (gitignored) holds the full per-frame record.

## Result

300 consecutive frames, no errors:

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| install        | clean on Python 3.14.3 / Windows; every dep had a `cp314` wheel       |
| frames decoded | 300 / 300                                                             |
| resolution     | `320x180` -> `640x360` -> `1280x720`, steady at 720p                  |
| source format  | I420 -> RGB24 via `frame.convert()`                                   |
| frame rate     | ~20 fps (wall and by frame timestamps)                                |
| decode         | ~22 ms median at 720p, ~47 ms max                                     |
| consumer lag   | 12-15 ms over ~14.9 s of media                                        |
| cost           | ~75% of one core, ~100 MB peak RSS, one stream, every frame converted |

## Findings that constrain T30

### 1. `livekit-rtc` is published as `livekit`

The dev plan calls it `livekit-rtc`. On PyPI the realtime SDK is `livekit`
(v1.1.16), which provides the `livekit.rtc` module; `livekit-rtc` is not the
install name. `livekit-api` is a separate package and is what mints tokens.

### 2. Python 3.14 was not a problem

The risk was the bundled Rust FFI library and native wheels. Neither bit:
`livekit` ships `py3-none-win_amd64` (no CPython ABI pin) and every transitive
dependency resolved to a `cp314` wheel. No compiler, no source build, ~60 s.

### 3. Frame size is not constant

Simulcast starts on a low layer and ramps up, so the first frames are 320x180
and later frames are 1280x720 **on the same track**. Read `width`/`height` per
frame. Code that latches onto the first frame's geometry will silently corrupt
every frame after the ramp.

### 4. Do not convert every frame

I420 -> RGB24 at 720p costs ~23 ms. At 20 fps that consumes essentially a whole
core for a single stream. It keeps up — lag was 15 ms over 15 s, so there is no
backpressure — but there is no headroom either.

Liveness and face match need a few frames per second, not twenty. **T30 should
sample frames**, not consume the stream exhaustively.

Isolated benchmark, for attribution: `convert()` alone is ~7 ms; the `bytes()`
copy adds ~0.8 ms; the numpy mean adds ~2.4 ms. The live 23 ms is higher than
the 7 ms benchmark because Chromium is encoding 720p on the same machine. On a
real deployment the customer's browser does that encoding, so the server-side
figure should be closer to the benchmark.

### 5. Subscribe selectively

The analyzer connects with `auto_subscribe=False` and calls `set_subscribed(True)`
only on the customer's video publication. The customer's audio track is left
unsubscribed and never reaches the process. The AI service has no reason to pull
audio, and not pulling it is bandwidth and CPU it never spends.

### 6. A frame arriving is not a frame containing a picture

Carried over from T04. The analyzer asserts the RGB24 buffer is exactly
`w * h * 3` bytes, that the picture is not black, and that it _changes_ between
frames — a frozen or black buffer would otherwise pass a frame count check.

## Files

| file                   | role                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `analyzer.py`          | the subject: connect, subscribe, decode, report, exit                            |
| `run.mjs`              | harness: static server, Chromium publisher, runs the analyzer, checks the result |
| `public/customer.html` | the customer browser page (publishes camera + mic)                               |
| `requirements.txt`     | `livekit`, `livekit-api`                                                         |

`.venv/`, `node_modules/`, `out/` and `public/vendor/` are gitignored. `spikes/**`
is excluded from ESLint; `public/vendor/` and `out/` from Prettier.
