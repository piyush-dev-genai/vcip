// T05 — THROWAWAY Day-0 spike. Harness only; analyzer.py is the subject.
//
// Proves: Customer browser -> LiveKit -> Python analyzer -> customer video
//         track -> decoded frames.
//
// This file exists only to put a real browser publisher in the room. All the
// claims being tested are made by analyzer.py. Delete after T05.

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken } from 'livekit-server-sdk';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const ROOM = 't05-spike';
const PAGE_PORT = 8901;
const CUSTOMER = 'customer-A';
const FRAMES = Number(process.env.FRAMES ?? 60);

mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(path.join(HERE, '..', '..', 'infra', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const LK_WS = 'ws://127.0.0.1:' + (env.LIVEKIT_PORT ?? 7880);
const step = (n, m) => console.log('\n[' + n + '] ' + m);
const ok = (m) => console.log('   PASS  ' + m);
const info = (m) => console.log('   ..    ' + m);

const PYTHON = path.join(HERE, '.venv', 'Scripts', 'python.exe');
const PYTHON_POSIX = path.join(HERE, '.venv', 'bin', 'python');
const python = existsSync(PYTHON) ? PYTHON : PYTHON_POSIX;
if (!existsSync(python)) {
  console.error(
    'No spike venv. Run:  py -3 -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt',
  );
  process.exit(1);
}

let browser;
let server;
const shutdown = async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
};

try {
  // ------------------------------------------------------------ 1. vendor
  step(1, 'Vendoring the livekit-client bundle for the customer page');
  const vendorDir = path.join(HERE, 'public', 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const bundle = path.join(HERE, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
  if (!existsSync(bundle))
    throw new Error('livekit-client not installed. Run: pnpm install --ignore-workspace');
  copyFileSync(bundle, path.join(vendorDir, 'livekit-client.umd.js'));
  ok('public/vendor/livekit-client.umd.js');

  // ------------------------------------------------------------ 2. server
  step(2, 'Serving the customer page on 127.0.0.1:' + PAGE_PORT);
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = p.startsWith('/vendor/')
      ? path.join(HERE, 'public', p)
      : path.join(HERE, 'public', 'customer.html');
    if (!existsSync(file)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(PAGE_PORT, '127.0.0.1', r));
  ok('static server up');

  // ------------------------------------------------------------ 3. browser
  step(3, 'Launching the customer browser (fake camera + microphone)');
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: CUSTOMER,
    ttl: '20m',
  });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();

  browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.text().includes('ERROR')) console.log('   [browser] ' + m.text());
  });
  await page.goto(
    'http://127.0.0.1:' +
      PAGE_PORT +
      '/?identity=' +
      CUSTOMER +
      '&token=' +
      encodeURIComponent(token) +
      '&url=' +
      encodeURIComponent(LK_WS),
  );

  await page.waitForFunction(
    () => window.__state && window.__state.connected && window.__state.published.video,
    null,
    { timeout: 30_000 },
  );
  ok(CUSTOMER + ' is connected and publishing camera + microphone');

  // ------------------------------------------------------------ 4. analyzer
  step(4, 'Running the Python analyzer (the actual test)');
  info(python);
  const code = await new Promise((resolve) => {
    const child = spawn(
      python,
      [
        'analyzer.py',
        '--url',
        LK_WS,
        '--room',
        ROOM,
        '--customer',
        CUSTOMER,
        '--frames',
        String(FRAMES),
      ],
      { cwd: HERE, stdio: 'inherit' },
    );
    child.on('exit', resolve);
  });

  if (code !== 0) throw new Error('analyzer.py exited with code ' + code);

  // ------------------------------------------------------------ 5. verdict
  step(5, 'Checking the analyzer result against the acceptance criteria');
  const r = JSON.parse(readFileSync(path.join(OUT, 'result.json'), 'utf8'));
  if (r.frames_decoded < 30)
    throw new Error('only ' + r.frames_decoded + ' frames decoded, need >= 30');
  if (r.subscribed.length !== 1 || !r.subscribed[0].endsWith('/video')) {
    throw new Error(
      'expected exactly one subscription, the customer video track: ' +
        JSON.stringify(r.subscribed),
    );
  }
  ok(r.frames_decoded + ' frames decoded (acceptance criterion A: >= 30)');
  ok(
    'subscribed only to ' +
      r.subscribed.join(', ') +
      '; skipped ' +
      (r.left_unsubscribed.join(', ') || 'nothing'),
  );
  ok(
    'source ' +
      r.buffer_type +
      ' -> RGB24; resolution ' +
      JSON.stringify(r.resolution_histogram) +
      ', steady at ' +
      r.steady_resolution,
  );
  ok('~' + r.fps_wall + ' fps wall / ' + r.fps_timestamps + ' fps by frame timestamps');
  ok(
    'decode median ' +
      r.decode_ms_median +
      'ms (max ' +
      r.decode_ms_max +
      'ms, median at ' +
      r.steady_resolution +
      ' = ' +
      r.decode_ms_median_at_steady +
      'ms)',
  );
  ok(
    'consumer lag ' +
      r.consumer_lag_ms +
      'ms over ' +
      r.media_span_ms +
      'ms of media (wall ' +
      r.wall_span_ms +
      'ms)',
  );
  ok(
    'cpu ' +
      r.cpu_seconds +
      's over ' +
      r.wall_seconds +
      's (' +
      r.cpu_percent_of_one_core +
      '% of one core), peak rss ' +
      r.peak_rss_mb +
      ' MB',
  );
  ok(
    'luma range ' +
      JSON.stringify(r.mean_luma_range) +
      ', max interframe delta ' +
      r.max_interframe_delta +
      ' (live picture, not black or frozen)',
  );

  console.log('\nALL CHECKS PASSED — preferred native Python path works. Fallback not required.');
  await shutdown();
  process.exit(0);
} catch (e) {
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  await shutdown();
  process.exit(1);
}
