/**
 * What may and may not appear in the agent portal's source.
 *
 * Same instrument as the customer app's `security.spec.ts`, aimed at this app's
 * risks. Every other spec proves a function behaves; these prove that no
 * *other* module quietly does the opposite — a component caching the token, a
 * credential in a URL, a hand-written BUSY control, a `fetch` that skipped the
 * client.
 *
 * The agent app has no server-only surface at all: it holds no enterprise API
 * key and has no D14 bootstrap route, because an agent authenticates as
 * themselves. So every file here is client code and is held to the narrow rule.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'components', 'lib'];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Remove comments before scanning: prose about a rule is not a violation of it.
 * `lib/token.ts` explains why `localStorage` is never used, and that
 * explanation names it.
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
    out.push({
      path: relative(APP_ROOT, full).split(sep).join('/'),
      text: stripComments(readFileSync(full, 'utf8')),
    });
  }
}

const sources: SourceFile[] = [];
for (const dir of SOURCE_DIRS) collect(join(APP_ROOT, dir), sources);

/** Report the offending paths, not just a count: a failure has to be findable. */
const offenders = (pattern: RegExp, files: readonly SourceFile[] = sources): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);

describe('the source set under test', () => {
  it('found the app, component, and lib files', () => {
    expect(sources.length).toBeGreaterThan(8);
    expect(sources.some((file) => file.path.startsWith('components/'))).toBe(true);
    expect(sources.some((file) => file.path.startsWith('lib/'))).toBe(true);
  });
});

// ------------------------------------------------------------- secrets

describe('no server credential reaches this app', () => {
  const SERVER_ONLY_NAMES = [
    'VCIP_DEMO_API_KEY',
    'VCIP_DEMO_AGENT_PASSWORD',
    'VCIP_CUSTOMER_TOKEN_SECRET',
    'VCIP_AGENT_JWT_SECRET',
    'VCIP_INTERNAL_TOKEN',
    'LIVEKIT_API_SECRET',
    'AWS_SECRET_ACCESS_KEY',
    'WEBHOOK_HMAC_SECRET',
    'SIGNING_KEY_ED25519_PRIVATE',
    'POSTGRES_PASSWORD',
    'DATABASE_URL',
    'REDIS_URL',
  ];

  it('names no server-only variable anywhere', () => {
    for (const name of SERVER_ONLY_NAMES) {
      expect(offenders(new RegExp(name))).toEqual([]);
    }
  });

  it('exposes exactly one NEXT_PUBLIC_ value', () => {
    const found = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) found.add(match[0]);
    }
    expect([...found]).toEqual(['NEXT_PUBLIC_API_BASE_URL']);
  });

  it('reads almost no environment variable', () => {
    // A `process.env.X` in client code is either inlined at build time or
    // undefined at runtime. Neither is a place for anything but public
    // configuration. `npm_package_version` is the second and last: the package
    // manager sets it, T02's health payload reports it, and a version number
    // is not a secret. Every other name would be.
    const reads = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
        reads.add(match[1] ?? '');
      }
    }
    expect([...reads].sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'npm_package_version']);
  });

  it('contains no literal that looks like a seeded credential', () => {
    expect(offenders(/vcip_demo_[A-Za-z0-9_-]{8,}/)).toEqual([]);
    expect(offenders(/scrypt\$/)).toEqual([]);
  });
});

// --------------------------------------------------------------- token

describe('token handling has one implementation', () => {
  it('uses sessionStorage and never localStorage', () => {
    // The agent portal may be a shared operations machine. The credential dies
    // with the tab.
    expect(offenders(/localStorage/)).toEqual([]);
  });

  it('touches browser storage in exactly one module', () => {
    expect(offenders(/sessionStorage|setItem\(|getItem\(/)).toEqual(['lib/token.ts']);
  });

  it('never builds a URL with a token or password parameter', () => {
    expect(offenders(/[?&](token|password|access_token)=/)).toEqual([]);
    expect(offenders(/searchParams\.(set|append)\(\s*['"](token|password)/)).toEqual([]);
    expect(offenders(/location\.hash/)).toEqual([]);
  });

  it('sends the credential only as an Authorization header, from the client', () => {
    expect(offenders(/Authorization/)).toEqual(['lib/api.ts']);
  });

  it('keeps the password out of storage and out of every module but the form', () => {
    const holders = offenders(/\bpassword\b/);
    // The form collects it, the portal hands it straight to the client, and
    // the error table has a message about it. `lib/api.ts` does not appear:
    // it passes the whole body through the shared schema and never names the
    // field, so there is no line there that could log or copy one.
    expect(holders.sort()).toEqual([
      'components/AgentPortal.tsx',
      'components/LoginForm.tsx',
      'lib/errors.ts',
    ]);
    for (const file of sources.filter((source) => /setItem\(/.test(source.text))) {
      expect(file.text).not.toMatch(/\bpassword\b/);
    }
  });
});

// ------------------------------------------------------------ requests

describe('every request goes through the API client', () => {
  it('holds the only fetch in the app', () => {
    expect(offenders(/\bfetch\s*\(/)).toEqual(['lib/api.ts']);
  });

  it('names the four routes T16 and T17 define, and no others', () => {
    const routes = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/'\/(login|availability|heartbeat|[a-z-]+)'/g)) {
        routes.add(match[0]);
      }
    }
    expect([...routes].sort()).toEqual(["'/availability'", "'/heartbeat'", "'/login'", "'/queue'"]);
  });

  it('reaches the queue with a GET and sends it no body', () => {
    const client = sources.find((file) => file.path === 'lib/api.ts');
    expect(client?.text).toMatch(/method: 'GET'/);
    // The one GET in the app is the queue read, so nothing that mutates can
    // be smuggled onto the read verb.
    expect([...(client?.text.matchAll(/method: '(GET|POST)'/g) ?? [])]).toHaveLength(1);
  });

  it('calls none of the endpoints later tasks add', () => {
    // T18's claim, T19's accept. Scope, asserted rather than promised. The
    // queue is no longer on this list: T17 owns it.
    for (const pattern of [
      /\/claim\b/,
      /\/accept\b/,
      /\/verdict\b/,
      /\/checklist\b/,
      /\/media-token\b/,
      /\/internal\//,
      /\/ws-token\b/,
    ]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });

  it('contains no LiveKit, WebSocket, AI, or webhook code', () => {
    for (const pattern of [/livekit/i, /new WebSocket|ws:\/\/|wss:\/\//, /webhook/i]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });
});

// -------------------------------------------------------------- presence

describe('presence rules live where they can be checked', () => {
  it('has no hand-written BUSY control', () => {
    // BUSY is named in exactly two places, and neither is a component: the
    // client's response type, because the server may report it, and the label
    // table, because the agent must be able to see it. No component names it
    // at all, so no button can be built from it.
    expect(offenders(/\bBUSY\b/).sort()).toEqual(['lib/api.ts', 'lib/presence.ts']);
    expect(
      offenders(
        /\bBUSY\b/,
        sources.filter((file) => file.path.startsWith('components/')),
      ),
    ).toEqual([]);
  });

  it('derives the settable list from the shared package', () => {
    const presence = sources.find((file) => file.path === 'lib/presence.ts');
    expect(presence?.text).toContain('AGENT_AVAILABILITY_VALUES');
    expect(presence?.text).toContain('@vcip/shared');
  });

  it('never names an agent id or tenant id in a request', () => {
    // The server reads both from the credential. A client that could name one
    // would be the whole isolation problem.
    //
    // `lib/api.ts` legitimately *declares* `agent_id` — it is a field of the
    // server's response, which this app reads. The distinction that matters is
    // declaring a response versus building a request, so this asserts every
    // occurrence is a readonly interface field and that no other module names
    // either at all. (`tenant_slug` on login is a different field: it selects a
    // namespace before there is any credential to derive one from.)
    const client = sources.find((file) => file.path === 'lib/api.ts');
    for (const match of client?.text.matchAll(/^.*\bagent_id\b.*$/gm) ?? []) {
      expect(match[0].trim()).toMatch(/^readonly agent_id: string;$/);
    }

    const others = sources.filter((file) => file.path !== 'lib/api.ts');
    expect(offenders(/\bagent_id\b|\buser_id\b/, others)).toEqual([]);
    expect(offenders(/\btenant_id\b/, sources)).toEqual([]);
  });

  it('has no claim, accept, or assignment control', () => {
    // T17's queue is read-only. Not "the button is disabled" - there is no
    // button, no handler, and no word for one anywhere in the app. The
    // lookahead spares the Accept request header, which is not an action,
    // and 'offer' is absent because T16 already tells an unavailable agent
    // they will not be offered work - prose about the server, not a control.
    for (const pattern of [/\bclaim/i, /\baccept\b(?!:)/i, /\bassign/i]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });

  it('does not re-derive the queue order or the wait in the browser', () => {
    // The API returns a merged FIFO list and a server-derived wait. Sorting
    // or ticking a timer here would put a second, disagreeing answer on the
    // screen.
    const queueSide = sources.filter(
      (file) => file.path === 'lib/queue.ts' || file.path === 'components/QueuePanel.tsx',
    );
    expect(offenders(/\.sort\(|\.filter\(/, queueSide)).toEqual([]);
    expect(offenders(/queued_at/, queueSide)).toEqual([]);
  });

  it('hard-codes no TTL of its own', () => {
    // The interval is configuration in one place; the TTL is the server's.
    expect(offenders(/15\s*\*\s*1000|15000/)).toEqual([]);
    expect(offenders(/HEARTBEAT_INTERVAL_MS/).sort()).toEqual([
      'components/AgentPortal.tsx',
      'lib/config.ts',
    ]);
  });
});

// ------------------------------------------------------------- logging

describe('nothing logs', () => {
  it('has no console output anywhere in the app', () => {
    // A token or a password cannot leak through a statement that does not
    // exist.
    expect(offenders(/\bconsole\s*\./)).toEqual([]);
  });
});
