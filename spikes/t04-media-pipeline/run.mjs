// T04 — THROWAWAY Day-0 spike.
//
// Proves: Browser A + Browser B -> LiveKit room -> room-composite Egress
//         -> MP4 in MinIO -> FFmpeg watermark -> playable watermarked MP4.
//
// No business logic, no abstractions meant to survive. Delete after T04.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccessToken,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from 'livekit-server-sdk';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const ROOM = 't04-spike';
const RECORD_SECONDS = 20;
const PAGE_PORT = 8899;

const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const FFMPEG_IMAGE = 'jrottenberg/ffmpeg:7.1-alpine';
const DOCKER_NET = 'vcip_default';

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- env
const env = Object.fromEntries(
  readFileSync(path.join(HERE, '..', '..', 'infra', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const LK_KEY = env.LIVEKIT_API_KEY;
const LK_SECRET = env.LIVEKIT_API_SECRET;
const LK_WS = 'ws://127.0.0.1:' + (env.LIVEKIT_PORT ?? 7880);
const LK_HTTP = 'http://127.0.0.1:' + (env.LIVEKIT_PORT ?? 7880);
const BUCKET = env.S3_BUCKET_TEMP ?? 'vcip-temp';

const step = (n, m) => console.log('\n[' + n + '] ' + m);
const ok = (m) => console.log('   PASS  ' + m);
const info = (m) => console.log('   ..    ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dockerPath = (p) => path.resolve(p).replace(/\\/g, '/');

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts });
}

// mc runs inside the compose network so it can reach minio by service name.
function mc(script, extraArgs = []) {
  return docker([
    'run',
    '--rm',
    '--network',
    DOCKER_NET,
    '-e',
    'MC_HOST_local=http://' + env.MINIO_ROOT_USER + ':' + env.MINIO_ROOT_PASSWORD + '@minio:9000',
    ...extraArgs,
    '--entrypoint',
    '/bin/sh',
    MINIO_IMAGE,
    '-c',
    script,
  ]);
}

function ffmpegRun(args) {
  return docker(
    [
      'run',
      '--rm',
      '-v',
      dockerPath(OUT) + ':/work',
      '-w',
      '/work',
      '--entrypoint',
      'ffmpeg',
      FFMPEG_IMAGE,
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

// volumedetect reports on stderr, which execFileSync does not hand back.
function ffmpegStderr(args) {
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      dockerPath(OUT) + ':/work',
      '-w',
      '/work',
      '--entrypoint',
      'ffmpeg',
      FFMPEG_IMAGE,
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return (r.stderr || '') + (r.stdout || '');
}

// Mean level of a file in dBFS, optionally through a filter. Digital silence
// reports around -91 dB.
function meanDb(file, filter) {
  const af = filter ? filter + ',volumedetect' : 'volumedetect';
  const out = ffmpegStderr(['-i', file, '-af', af, '-f', 'null', '-']);
  const m = out.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  return m ? Number(m[1]) : NaN;
}

const band = (hz) => 'bandpass=f=' + hz + ':width_type=h:w=40';

function ffprobeJson(file) {
  const out = docker([
    'run',
    '--rm',
    '-v',
    dockerPath(OUT) + ':/work',
    '-w',
    '/work',
    '--entrypoint',
    'ffprobe',
    FFMPEG_IMAGE,
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(out);
}

const failures = [];
const check = (cond, msg) => {
  if (cond) {
    ok(msg);
  } else {
    failures.push(msg);
    console.log('   FAIL  ' + msg);
  }
};

// ---------------------------------------------------------------- 1. page server
step(1, 'Serving the participant page on 127.0.0.1:' + PAGE_PORT);
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const serveFile = (res, file) => {
  res.writeHead(200, {
    'content-type': types[path.extname(file)] ?? 'application/octet-stream',
  });
  res.end(readFileSync(file));
};
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  // Egress gives Chrome console output nowhere, so the composite template
  // beacons its progress here instead.
  if (p === '/report') {
    console.log('   [composite] ' + u.searchParams.get('msg'));
    res.writeHead(204).end();
    return;
  }
  if (p.startsWith('/vendor/')) {
    const f = path.join(HERE, 'public', p);
    if (existsSync(f)) return serveFile(res, f);
    res.writeHead(404).end('not found');
    return;
  }
  // /participant -> the two browsers. Anything else -> the composite layout,
  // because the exact URL shape egress builds for a custom template is not
  // guaranteed.
  serveFile(res, path.join(HERE, 'public', p === '/participant' ? 'index.html' : 'composite.html'));
});
await new Promise((r) => server.listen(PAGE_PORT, '0.0.0.0', r));
ok('static server up');

// ---------------------------------------------------------------- 2. tokens
step(2, 'Minting LiveKit access tokens');
async function tokenFor(identity) {
  const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '20m' });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
const tokenA = await tokenFor('customer-A');
const tokenB = await tokenFor('agent-B');
ok('two tokens for room "' + ROOM + '" (key ' + LK_KEY + ')');

// ---------------------------------------------------------------- 3. browsers
step(3, 'Launching two Chromium browsers with fake camera + microphone');
// Chrome's fake microphone emits brief clicks, which record correctly but are
// nearly inaudible on playback — not a convincing proof that audio survives the
// pipeline. Feed each browser a distinct steady tone instead, so the recorded
// audio can be checked for a specific frequency. The flag is per browser
// process, so each participant needs its own browser.
const TONE_A_HZ = 440;
const TONE_B_HZ = 880;
const FIXTURES = path.join(HERE, 'fixtures');
// Generated on demand rather than committed: they are large, binary and
// perfectly reproducible from this one command.
function ensureTone(name, hz) {
  const file = path.join(FIXTURES, name);
  if (existsSync(file)) return dockerPath(file);
  mkdirSync(FIXTURES, { recursive: true });
  docker(
    [
      'run',
      '--rm',
      '-v',
      dockerPath(FIXTURES) + ':/f',
      '--entrypoint',
      'ffmpeg',
      FFMPEG_IMAGE,
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=' + hz + ':duration=60:sample_rate=48000',
      '-c:a',
      'pcm_s16le',
      '-ac',
      '1',
      '/f/' + name,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  info('generated fixtures/' + name);
  return dockerPath(file);
}
const toneFile = (n) => dockerPath(path.join(FIXTURES, n));
const launch = (wav) =>
  chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--use-file-for-fake-audio-capture=' + wav,
    ],
  });
ensureTone('tone-a-440hz.wav', TONE_A_HZ);
ensureTone('tone-b-880hz.wav', TONE_B_HZ);
const browserA = await launch(toneFile('tone-a-440hz.wav'));
const browserB = await launch(toneFile('tone-b-880hz.wav'));
const open = async (browser, identity, token) => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.text().includes('ERROR')) console.log('   [browser] ' + m.text());
  });
  const url =
    'http://127.0.0.1:' +
    PAGE_PORT +
    '/participant?identity=' +
    identity +
    '&token=' +
    encodeURIComponent(token) +
    '&url=' +
    encodeURIComponent(LK_WS);
  await page.goto(url);
  return page;
};
const pageA = await open(browserA, 'customer-A', tokenA);
const pageB = await open(browserB, 'agent-B', tokenB);
ok('two browsers opened, each with its own tone as the microphone');

// ---------------------------------------------------------------- 4. publish/subscribe
step(4, 'Waiting for both to publish and to subscribe to each other (A/V both ways)');
const readyFor = (page, peer) =>
  page.waitForFunction(
    (p) => {
      const s = window.__state;
      return (
        s &&
        s.connected &&
        s.published.audio &&
        s.published.video &&
        s.subscribed[p] &&
        s.subscribed[p].audio &&
        s.subscribed[p].video
      );
    },
    peer,
    { timeout: 45000 },
  );
await Promise.all([readyFor(pageA, 'agent-B'), readyFor(pageB, 'customer-A')]);
const stateA = await pageA.evaluate(() => window.__state);
const stateB = await pageB.evaluate(() => window.__state);
check(stateA.published.audio && stateA.published.video, 'customer-A published audio + video');
check(stateB.published.audio && stateB.published.video, 'agent-B published audio + video');
check(
  stateA.subscribed['agent-B'] &&
    stateA.subscribed['agent-B'].audio &&
    stateA.subscribed['agent-B'].video,
  'customer-A subscribed to agent-B audio + video',
);
check(
  stateB.subscribed['customer-A'] &&
    stateB.subscribed['customer-A'].audio &&
    stateB.subscribed['customer-A'].video,
  'agent-B subscribed to customer-A audio + video',
);

// ---------------------------------------------------------------- 5. egress
step(5, 'Starting room-composite egress -> MinIO');
const egressClient = new EgressClient(LK_HTTP, LK_KEY, LK_SECRET);
const fileOutput = new EncodedFileOutput({
  fileType: EncodedFileType.MP4,
  filepath: ROOM + '/{room_name}-{time}.mp4',
  output: {
    case: 's3',
    value: new S3Upload({
      accessKey: env.MINIO_ROOT_USER,
      secret: env.MINIO_ROOT_PASSWORD,
      region: env.S3_REGION ?? 'ap-south-1',
      endpoint: 'http://minio:9000', // resolved from inside the compose network
      bucket: BUCKET,
      forcePathStyle: true,
    }),
  },
});
// host.docker.internal resolves to BOTH an IPv4 and an IPv6 address inside the
// container, but only IPv4 is routable here. Chrome sometimes picks the IPv6
// one and the template never loads ("websocket url timeout reached"), so pin
// the literal IPv4 address.
let hostIp = 'host.docker.internal';
try {
  const line = docker(['exec', 'vcip-egress', 'getent', 'ahostsv4', 'host.docker.internal']);
  const first = line.trim().split(/\s+/)[0];
  if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(first)) hostIp = first;
} catch {
  info('could not resolve host.docker.internal IPv4, falling back to the hostname');
}
const TEMPLATE_URL = 'http://' + hostIp + ':' + PAGE_PORT + '/composite.html';
info('custom template: ' + TEMPLATE_URL);
const started = await egressClient.startRoomCompositeEgress(ROOM, fileOutput, {
  layout: 'grid',
  customBaseUrl: TEMPLATE_URL,
});
info('egressId=' + started.egressId + ' status=' + EgressStatus[started.status]);

info('recording for ' + RECORD_SECONDS + 's ...');
await sleep(RECORD_SECONDS * 1000);

const active = await egressClient.listEgress({ egressId: started.egressId });
info('mid-recording status=' + EgressStatus[active[0] && active[0].status]);
check(active[0] && active[0].status === EgressStatus.EGRESS_ACTIVE, 'egress reached EGRESS_ACTIVE');

step(6, 'Stopping egress and waiting for completion');
await egressClient.stopEgress(started.egressId);
let final;
for (let i = 0; i < 40; i++) {
  const list = await egressClient.listEgress({ egressId: started.egressId });
  final = list[0];
  if (
    final &&
    [
      EgressStatus.EGRESS_COMPLETE,
      EgressStatus.EGRESS_FAILED,
      EgressStatus.EGRESS_ABORTED,
    ].includes(final.status)
  ) {
    break;
  }
  await sleep(1500);
}
info('final status=' + EgressStatus[final.status] + (final.error ? ' error=' + final.error : ''));
check(final.status === EgressStatus.EGRESS_COMPLETE, 'egress finished with EGRESS_COMPLETE');
if (final.status !== EgressStatus.EGRESS_COMPLETE) {
  await browserA.close();
  await browserB.close();
  server.close();
  console.log('\nEgress did not complete. Inspect: docker compose logs egress');
  process.exit(1);
}

await browserA.close();
await browserB.close();
server.close();

const result = final.fileResults && final.fileResults[0];
if (!result) {
  console.log('\nNo file result returned. Aborting.');
  process.exit(1);
}
info('filename=' + result.filename);
info('location=' + result.location);
info('size=' + result.size + ' bytes  duration=' + Number(result.duration) / 1e9 + 's');
check(Number(result.size) > 0, 'egress reported a non-zero file size');

// ---------------------------------------------------------------- 7. minio
step(7, 'Verifying the object exists in MinIO and downloading it');
const key = result.filename;
const listing = mc('mc stat "local/' + BUCKET + '/' + key + '"');
console.log(
  listing
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => '   | ' + l)
    .join('\n'),
);
check(/Size\s*:/.test(listing), 'object present in MinIO bucket "' + BUCKET + '"');

mc('mc cp "local/' + BUCKET + '/' + key + '" /out/recording.mp4', [
  '-v',
  dockerPath(OUT) + ':/out',
]);
const rawPath = path.join(OUT, 'recording.mp4');
check(
  existsSync(rawPath) && statSync(rawPath).size > 0,
  'downloaded to out/recording.mp4 (' +
    (existsSync(rawPath) ? statSync(rawPath).size : 0) +
    ' bytes)',
);

// ---------------------------------------------------------------- 8. probe
step(8, 'Probing the recorded MP4');
const probe = ffprobeJson('recording.mp4');
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
info(
  'format=' +
    probe.format.format_name +
    ' duration=' +
    probe.format.duration +
    's size=' +
    probe.format.size,
);
info(
  'video: ' +
    (v && v.codec_name) +
    ' ' +
    (v && v.width) +
    'x' +
    (v && v.height) +
    ' @ ' +
    (v && v.avg_frame_rate),
);
info('audio: ' + (a && a.codec_name) + ' ' + (a && a.sample_rate) + 'Hz ch=' + (a && a.channels));
check(!!v, 'recording contains a video stream');
check(!!a, 'recording contains an audio stream');
check(Number(probe.format.duration) > 5, 'recording duration > 5s');

// ------------------------------------------------------- 8b. audio is audible
// An audio *stream* existing is not the same as audio being *there*. Measure
// the level, then confirm both participants' tones actually survived the trip.
step('8b', 'Verifying the recording contains real, audible sound');
const overallDb = meanDb('recording.mp4', null);
const aDb = meanDb('recording.mp4', band(TONE_A_HZ));
const bDb = meanDb('recording.mp4', band(TONE_B_HZ));
const controlDb = meanDb('recording.mp4', band(3000)); // no tone here
info('overall mean ' + overallDb + ' dB (digital silence is about -91 dB)');
info(
  TONE_A_HZ +
    'Hz band ' +
    aDb +
    ' dB | ' +
    TONE_B_HZ +
    'Hz band ' +
    bDb +
    ' dB | 3000Hz control ' +
    controlDb +
    ' dB',
);
check(overallDb > -50, 'recording is not silent');
check(aDb - controlDb > 15, 'customer-A 440Hz tone present, well above the control band');
check(bDb - controlDb > 15, 'agent-B 880Hz tone present, well above the control band');

// Leave artefacts behind so the audio can be inspected by ear and by eye.
ffmpegRun(['-y', '-i', 'recording.mp4', '-vn', '-c:a', 'pcm_s16le', 'audio-only.wav']);
ffmpegRun([
  '-y',
  '-i',
  'recording.mp4',
  '-lavfi',
  'showspectrumpic=s=1000x400:legend=1',
  '-frames:v',
  '1',
  'audio-spectrogram.png',
]);
ok('wrote out/audio-only.wav and out/audio-spectrogram.png');

// ---------------------------------------------------------------- 9. watermark
step(9, 'Burning a visible watermark with FFmpeg');
const FONT = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
const drawtext =
  'drawtext=fontfile=' +
  FONT +
  ":text='V-CIP T04 SPIKE - " +
  ROOM +
  "':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.5:boxborderw=10:x=20:y=20," +
  'drawtext=fontfile=' +
  FONT +
  ":text='%{pts\\:hms}':fontcolor=yellow:fontsize=22:box=1:boxcolor=black@0.5:boxborderw=8:x=20:y=h-th-20";
const ffArgs = [
  '-y',
  '-i',
  'recording.mp4',
  '-vf',
  drawtext,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-c:a',
  'copy',
  '-movflags',
  '+faststart',
  'recording-watermarked.mp4',
];
console.log('   $ ffmpeg ' + ffArgs.join(' '));
ffmpegRun(ffArgs);

const wmPath = path.join(OUT, 'recording-watermarked.mp4');
const wmSize = existsSync(wmPath) ? statSync(wmPath).size : 0;
check(wmSize > 0, 'watermarked MP4 produced (' + wmSize + ' bytes)');

const wmProbe = ffprobeJson('recording-watermarked.mp4');
const wv = wmProbe.streams.find((s) => s.codec_type === 'video');
const wa = wmProbe.streams.find((s) => s.codec_type === 'audio');
info(
  'watermarked: ' +
    wmProbe.format.format_name +
    ' ' +
    (wv && wv.width) +
    'x' +
    (wv && wv.height) +
    ' ' +
    wmProbe.format.duration +
    's v=' +
    (wv && wv.codec_name) +
    ' a=' +
    (wa && wa.codec_name),
);
check(!!wv && !!wa, 'watermarked MP4 has both video and audio streams');
check(
  Math.abs(Number(wmProbe.format.duration) - Number(probe.format.duration)) < 1.5,
  'watermarked duration matches the source',
);

// Decode every frame to prove the file is actually playable, not just parseable.
step(10, 'Full decode pass (playability)');
ffmpegRun(['-v', 'error', '-xerror', '-i', 'recording-watermarked.mp4', '-f', 'null', '-']);
ok('decoded end-to-end with no errors');

// A still frame, so the watermark can be eyeballed.
ffmpegRun([
  '-y',
  '-ss',
  '3',
  '-i',
  'recording-watermarked.mp4',
  '-frames:v',
  '1',
  'watermark-proof.png',
]);
ok('extracted out/watermark-proof.png');

console.log(
  '\n================ ' + (failures.length ? 'FAILED' : 'ALL CHECKS PASSED') + ' ================',
);
if (failures.length) failures.forEach((f) => console.log(' - ' + f));
process.exit(failures.length ? 1 : 0);
