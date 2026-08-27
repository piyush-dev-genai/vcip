# T04 — media / evidence pipeline spike

**Throwaway.** Delete once T25 (LiveKit join), T37–T40 (egress worker) land. Nothing
here is meant to survive; it exists to prove the path works on this machine before
any application code depends on it.

## What it proves

```
Browser A + Browser B  ->  LiveKit room  ->  room-composite Egress
   ->  MP4 in MinIO  ->  FFmpeg watermark  ->  playable watermarked MP4
```

## Run

```bash
cd infra && docker compose up -d       # T03 stack must be running
cd spikes/t04-media-pipeline
pnpm install --ignore-workspace
pnpm exec playwright install chromium
node run.mjs
```

Outputs land in `out/` (gitignored): `recording.mp4`, `recording-watermarked.mp4`,
`watermark-proof.png`.

## Findings that constrain later tasks

### 1. LiveKit must advertise two ICE candidates (config change to T03)

Two clients must reach LiveKit and no single advertised address serves both:

| client                      | reaches LiveKit via                          |
| --------------------------- | -------------------------------------------- |
| browser on the Windows host | loopback-published port `127.0.0.1:7882/udp` |
| egress container            | docker bridge address `172.x.x.x`            |

Pinning `rtc.node_ip` to either one breaks the other. `node_ip: 127.0.0.1` gives
working browsers and egress failing with `could not establish pc connection`.

**Resolution:** `rtc.enable_loopback_candidate: true` with no `node_ip`. LiveKit
then gathers the loopback candidate (normally filtered out) _and_ the bridge
address; each client keeps the pair it can reach. Egress went back to its own
network namespace, which is where it belongs.

### 2. Egress start signal is a console token, not a JS binding

A custom room-composite template must emit the literal strings on the console:

```js
console.log('START_RECORDING'); // egress begins encoding
console.log('END_RECORDING'); // egress finalises
```

`window.startRecording` is **not** bound into the page. Without the token, egress
aborts after ~20s with `Start signal not received`. This is what LiveKit's own
bundled template does.

### 3. `host.docker.internal` resolves to an unroutable IPv6 address

Inside containers it resolves to both `192.168.65.254` and `fdc4:f303:9324::254`.
Only IPv4 is routable. Chrome sometimes picks IPv6, and the template silently
never loads — surfacing as `page load error: websocket url timeout reached`.
Resolve the IPv4 literal and use that. This made the spike intermittently fail
until pinned.

### 4. Containers on this machine have no outbound internet

`docker pull` works (daemon-level) but no container can resolve or reach an
external host, including with explicit public DNS. Egress embeds its default
templates so this did not block recording, but **anything on the evidence path
must not depend on an external fetch at runtime.**

### 5. "Audio stream exists" is not "audio is audible"

The first version of this spike asserted only that an AAC stream was present.
It was — but Chrome's default fake microphone emits **short clicks a few times a
second**, not a tone. The recording was correct and essentially inaudible on
casual playback, so the assertion passed while sounding broken.

Now each browser is fed a distinct sine tone as its microphone
(`--use-file-for-fake-audio-capture`, 440Hz for customer-A, 880Hz for agent-B)
and the recording is measured per frequency band:

```
overall mean  -18.1 dB      (digital silence is about -91 dB)
440Hz band    -21.1 dB      customer-A
880Hz band    -21.2 dB      agent-B
3000Hz band   -67.5 dB      control, no tone expected
```

A ~46 dB separation over the control band proves both participants' audio
reached the mix. `out/audio-spectrogram.png` shows two unbroken horizontal
lines for the full duration.

Browser noise suppression and AGC are disabled in the participant page: they
treat a steady tone as stationary noise and attenuate it. Real speech does not
have this problem, so this is a test-fixture concern, not a product one.

**Carry into T37-T40:** any evidence check must assert on audio _level_, never
on stream presence alone. A silent recording is a plausible failure mode and
stream-presence would not catch it.

### 6. Notes for the real implementation

- Recording is 1280x720 h264 + 44100Hz stereo AAC, `EncodedFileType.MP4`.
- The S3 endpoint in the egress request is `http://minio:9000` — resolved from
  inside the compose network, not the host-published address.
- `forcePathStyle: true` is required for MinIO.
- `EgressInfo.duration` is shorter than the container duration ffprobe reports;
  do not treat it as the recording length.
- FFmpeg is not installed on the host. The spike shells out to
  `jrottenberg/ffmpeg:7.1-alpine`. T37–T40 need a real decision on how the egress
  worker gets FFmpeg.

## Files

| file                    | role                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `run.mjs`               | orchestrator: browsers, egress, MinIO, FFmpeg, assertions  |
| `public/index.html`     | participant page (publishes camera + mic, subscribes)      |
| `public/composite.html` | egress room-composite template with beacon instrumentation |
| `public/vendor/`        | vendored `livekit-client` UMD bundle (gitignored)          |

| `fixtures/` | generated tone WAVs used as the fake microphones (gitignored) |

`fixtures/` is created automatically on first run; nothing binary or generated
is committed. `spikes/**` is excluded from ESLint; `public/vendor/` and `out/`
from Prettier.
