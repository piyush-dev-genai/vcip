/**
 * What may and may not appear in the customer application source.
 *
 * These read the files rather than the behaviour. Every other spec proves a
 * function behaves; these prove that no *other* code in the app quietly does the
 * opposite — a second module reaching for `localStorage`, a credential moved
 * into a query string, a server-only variable exposed through `NEXT_PUBLIC_`.
 *
 * The distinction that does the work here is client versus server. Everything
 * under `app/api/` is a Next route handler that runs on the server and never
 * ships to a browser; that is where the D14 bootstrap holds the enterprise API
 * key. Everything else is code that can reach a browser bundle, and it is held
 * to a much narrower rule.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];

interface SourceFile {
  readonly path: string;
  readonly text: string;
  /** True for Next route handlers under `app/api/`, which never reach a browser. */
  readonly serverOnly: boolean;
}

/**
 * Remove comments before scanning.
 *
 * Without this the checks below fail on their own subject matter: the comment
 * in `lib/token.ts` explaining that `localStorage` is never used contains the
 * word `localStorage`, and the note in `lib/measure.ts` explaining that no
 * threshold lives there names one. Prose about a rule is not a violation of it.
 *
 * Only block comments and whole-line `//` comments are removed. A trailing
 * comment is left alone, because stripping it would mean parsing strings to
 * avoid mangling every `http://` in the file.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function collect(dir: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      collect(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || entry.endsWith('.spec.ts') || entry.endsWith('.spec.tsx')) {
      continue;
    }
    const rel = relative(APP_ROOT, full).split(sep).join('/');
    out.push({
      path: rel,
      text: stripComments(readFileSync(full, 'utf8')),
      serverOnly: rel.startsWith('app/api/'),
    });
  }
}

const sources: SourceFile[] = [];
for (const dir of SOURCE_DIRS) collect(join(APP_ROOT, dir), sources);

const clientSources = sources.filter((file) => !file.serverOnly);

/** Report the offending paths, not just a count: a failure has to be findable. */
const offenders = (files: readonly SourceFile[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

describe('the source set under test', () => {
  it('found the app, component, and lib files', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((file) => file.path.startsWith('components/'))).toBe(true);
    expect(sources.some((file) => file.serverOnly)).toBe(true);
  });
});

// ------------------------------------------------------------- secrets

describe('no server credential reaches the browser', () => {
  const SERVER_ONLY_NAMES = [
    'VCIP_DEMO_API_KEY',
    'VCIP_CUSTOMER_TOKEN_SECRET',
    'VCIP_AGENT_JWT_SECRET',
    'VCIP_INTERNAL_TOKEN',
    'LIVEKIT_API_SECRET',
    'AWS_SECRET_ACCESS_KEY',
    'MINIO_ROOT_PASSWORD',
    'WEBHOOK_HMAC_SECRET',
    'SIGNING_KEY_ED25519_PRIVATE',
    'POSTGRES_PASSWORD',
    'DATABASE_URL',
    'REDIS_URL',
  ];

  it('names no server-only variable in code that can reach a bundle', () => {
    for (const name of SERVER_ONLY_NAMES) {
      expect(offenders(clientSources, new RegExp(name))).toEqual([]);
    }
  });

  it('keeps the enterprise API key to the D14 bootstrap route handler', () => {
    // It is read there, in a `runtime = 'nodejs'` route handler, and nowhere
    // else. That single location is the whole of D14's "the key stays on the
    // server".
    const holders = offenders(sources, /VCIP_DEMO_API_KEY/);
    expect(holders).toEqual(['app/api/demo/session/route.ts']);
  });

  it('never returns or echoes the API key from the bootstrap route', () => {
    const route = sources.find((file) => file.path === 'app/api/demo/session/route.ts');
    expect(route).toBeDefined();
    const text = route?.text ?? '';
    // The only use is the outbound Authorization header.
    const uses = text.match(/apiKey/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/json\([^)]*apiKey/);
    expect(text).toMatch(/Authorization: `Bearer \$\{apiKey\}`/);
  });

  it('contains no literal that looks like a seeded API key', () => {
    expect(offenders(sources, /vcip_demo_[A-Za-z0-9_-]{8,}/)).toEqual([]);
  });
});

describe('NEXT_PUBLIC_ exposes exactly one value', () => {
  it('is only ever the API base URL', () => {
    const found = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) found.add(match[0]);
    }
    expect([...found]).toEqual(['NEXT_PUBLIC_API_BASE_URL']);
  });

  it('is nearly the only environment variable client code reads', () => {
    // A `process.env.X` in a client component is either inlined at build time
    // or undefined at runtime. Neither is a place for anything but public
    // configuration.
    //
    // `npm_package_version` is the second and last: the package manager sets
    // it, T02's health payload reports it, and a version number is not a
    // secret. Every other name would be.
    const reads = new Set<string>();
    for (const file of clientSources) {
      for (const match of file.text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
        reads.add(match[1] ?? '');
      }
    }
    expect([...reads].sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'npm_package_version']);
  });
});

// --------------------------------------------------------------- token

describe('token handling has one implementation', () => {
  it('uses sessionStorage and never localStorage', () => {
    expect(offenders(sources, /localStorage/)).toEqual([]);
  });

  it('reads sessionStorage in exactly one module', () => {
    // If a component started caching the token itself, the rules in
    // `lib/token.ts` would stop being the rules.
    expect(offenders(sources, /sessionStorage/)).toEqual(['lib/token.ts']);
  });

  it('never builds a URL with a token query parameter', () => {
    expect(offenders(sources, /[?&]token=/)).toEqual([]);
    expect(offenders(sources, /searchParams\.(set|append)\(\s*['"]token/)).toEqual([]);
  });

  it('reads the fragment only where the token is consumed', () => {
    expect(offenders(clientSources, /location\.hash/)).toEqual(['lib/token.ts']);
  });
});

// ------------------------------------------------------------- logging

describe('nothing logs', () => {
  it('has no console output anywhere in the app', () => {
    // The sensitive-data boundary (§39/§40) is easiest to hold by not having a
    // logging call to review. A token, a coordinate, or a payload cannot leak
    // through a statement that does not exist.
    expect(offenders(sources, /\bconsole\s*\./)).toEqual([]);
  });
});

// ------------------------------------------------------------ location

describe('coordinates are handled in one place and kept out of storage', () => {
  it('names latitude and longitude only where the request body is built', () => {
    expect(offenders(sources, /\blatitude\b/)).toEqual(['lib/geolocation.ts']);
    expect(offenders(sources, /\blongitude\b/)).toEqual(['lib/geolocation.ts']);
  });

  it('never writes a coordinate to browser storage', () => {
    const storageWriters = sources.filter((file) => /setItem\(/.test(file.text));
    for (const file of storageWriters) {
      expect(file.text).not.toMatch(/\blatitude\b/);
      expect(file.text).not.toMatch(/\blongitude\b/);
    }
  });
});

// -------------------------------------------------------------- scope

describe('T14 scope', () => {
  it('calls the queue endpoint from the API client and nowhere else', () => {
    // T15 wires the Join Queue action. The route belongs in `lib/api.ts` with
    // every other request — a component reaching for it directly would be the
    // scattered `fetch` the client exists to prevent.
    expect(offenders(sources, /'\/queue'/)).toEqual(['lib/api.ts']);
  });

  it('calls none of the endpoints later tasks add', () => {
    // Routes, not words. `verdict` appears in `lib/session.ts` because
    // `GET /v1/sessions/{id}` returns one and the status screen renders it —
    // reading an outcome is T14's, submitting one is T35's.
    for (const pattern of [
      /\/verdict\b/,
      /\/checklist\b/,
      /\/media-token\b/,
      /\/agent\//,
      /\/internal\//,
    ]) {
      expect(offenders(sources, pattern)).toEqual([]);
    }
  });

  it('contains no LiveKit, WebSocket, AI, or webhook code', () => {
    for (const pattern of [/livekit/i, /new WebSocket|ws:\/\/|wss:\/\//, /webhook/i]) {
      expect(offenders(sources, pattern)).toEqual([]);
    }
  });

  it('computes no billing amount of its own', () => {
    // The abort response carries a server-derived figure, which is rendered.
    // A number in the client would be a second billing rule.
    expect(offenders(sources, /2500|500\s*\*|paise\s*=/)).toEqual([]);
  });

  it('contains no tenant preflight threshold', () => {
    // D11 keeps the comparison on the server. A copy here would be the exact
    // duplication the decision forbids.
    for (const pattern of [
      /min_video_px|minVideoPx/,
      /max_rtt_ms|maxRttMs/,
      /min_downlink_kbps|minDownlinkKbps/,
      /min_mic_level|minMicLevel/,
      /min_lighting_score|minLightingScore/,
      /min_stability_score|minStabilityScore/,
      /gps_max_accuracy_m|gpsMaxAccuracyM/,
    ]) {
      expect(offenders(sources, pattern)).toEqual([]);
    }
  });

  it('builds no request payload asserting a server verdict', () => {
    // Scoped to the two modules that construct request bodies. `lib/session.ts`
    // legitimately declares `preflight_ok` and `geo_ok` — they are fields of
    // the server's *response*, which this app reads and must never send.
    const builders = sources.filter(
      (file) => file.path === 'lib/measure.ts' || file.path === 'lib/geolocation.ts',
    );
    expect(builders).toHaveLength(2);
    expect(offenders(builders, /preflight_ok/)).toEqual([]);
    expect(offenders(builders, /geo_ok/)).toEqual([]);
  });
});
