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

  it('exposes exactly two NEXT_PUBLIC_ values, both addresses', () => {
    // T25 added the second. Both say *where* a server is; neither says who may
    // do anything there. The media token is the credential (T24), it is minted
    // per session and per role, and `LIVEKIT_API_SECRET` — asserted absent
    // above — is what would actually authorise. A third entry here would need
    // the same argument made about it.
    const found = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) found.add(match[0]);
    }
    expect([...found].sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_LIVEKIT_URL']);
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
    expect([...reads].sort()).toEqual([
      'NEXT_PUBLIC_API_BASE_URL',
      'NEXT_PUBLIC_LIVEKIT_URL',
      'npm_package_version',
    ]);
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

  it('touches browser storage in exactly three modules, all in lib', () => {
    // The credential (T16), the session being worked (T21), and the agent's
    // unsubmitted checklist ticks (T34). All three are sessionStorage, all
    // three inject the storage surface as a host so they are testable, and no
    // component reaches for storage directly — which is what keeps the rules
    // about what may be persisted in the files that state them.
    expect(offenders(/sessionStorage|setItem\(|getItem\(/)).toEqual([
      'lib/checklist.ts',
      'lib/token.ts',
      'lib/work.ts',
    ]);
  });

  it('persists no customer data in the checklist ticks', () => {
    // What T34 remembers is item keys and booleans — the tenant's own
    // checklist configuration and the agent's unsubmitted answers to it.
    // Nothing about the customer, and nothing that authenticates.
    const checklist = sources.find((file) => file.path === 'lib/checklist.ts');
    for (const pattern of [/external_ref/, /access_token/, /latitude|longitude/, /password/i]) {
      expect(checklist?.text ?? '').not.toMatch(pattern);
    }
  });

  it('persists no customer data and no credential beside the session id', () => {
    const work = sources.find((file) => file.path === 'lib/work.ts');
    // What T21 remembers is an id, a server-issued expiry, and a room name.
    // Nothing about the customer, and nothing that authenticates.
    for (const pattern of [
      /external_ref/,
      /password/i,
      /access_token/,
      /latitude|longitude/,
      /language/,
    ]) {
      expect(work?.text ?? '').not.toMatch(pattern);
    }
  });

  /**
   * D9's WebSocket connection token is the one sanctioned exception to this
   * rule, and it is not in play yet.
   *
   * A browser cannot set `Authorization` on a WebSocket handshake, so
   * `GET /v1/ws?token=...` carries a short-lived, purpose-bound credential in
   * the query string — five minutes, its own signing secret, and its own
   * `act` claim, so a leak is worth far less than a session token. The API
   * redacts it from every line it logs about a connection.
   *
   * T31 added that WebSocket client, and with it the one exception this
   * comment anticipated: `lib/socket.ts` puts a connection token in a query
   * string, because D9 records that a browser cannot set `Authorization` on a
   * WS handshake. It is a named allowance for that one parameter on that one
   * URL, not a relaxation — the token is short-lived, minted per connection,
   * scoped to tenant and user, names no session, and is redacted from every
   * line the API logs about a connection.
   */
  it('never builds a URL with a token or password parameter', () => {
    expect(offenders(/[?&](token|password|access_token)=/)).toEqual(['lib/socket.ts']);
    // Still exact for the rest: no password anywhere, and the agent's own
    // session JWT never reaches a URL.
    expect(offenders(/[?&](password|access_token)=/)).toEqual([]);
    expect(offenders(/searchParams\.(set|append)\(\s*['"](token|password)/)).toEqual([]);
    expect(offenders(/location\.hash/)).toEqual([]);
  });

  it('sends the credential only as an Authorization header, from the client', () => {
    expect(offenders(/Authorization/)).toEqual(['lib/api.ts']);
  });

  /**
   * Every form that collects a secret declares POST.
   *
   * The rule above proves no *code* builds a credential URL. This proves the
   * browser cannot build one either, which is a different claim and the one
   * that was actually broken: a `<form>` with no method defaults to GET, and a
   * GET submit serialises every named input into the address bar.
   *
   * It only ever fires when the handler is missing — a hydration failure, a
   * stale chunk manifest, JS blocked — which is precisely the moment none of
   * the app's own discipline is running. It happened: a dev server left
   * serving a production `.next` returned 404 for `main-app.js`, nothing
   * hydrated, and a real agent password went into the URL, the history, and
   * the referrer of the next request.
   *
   * So the assertion is on the markup, not on the handler. A native POST
   * leaves nothing behind; a native GET is a credential leak that no amount of
   * correct JavaScript can prevent.
   */
  it('declares POST on any form that collects a credential', () => {
    const forms = sources.filter((file) => /<form\b/.test(file.text));
    expect(forms.map((file) => file.path)).toEqual(['components/LoginForm.tsx']);

    for (const file of forms) {
      for (const tag of file.text.matchAll(/<form\b[^>]*>/g)) {
        expect(tag[0]).toMatch(/method="post"/);
      }
    }
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

  it('names the routes this portal calls, and no others', () => {
    const routes = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/'\/(login|availability|heartbeat|[a-z-]+)'/g)) {
        routes.add(match[0]);
      }
    }
    expect([...routes].sort()).toEqual([
      "'/accept'",
      "'/availability'",
      "'/checklist'",
      "'/claim'",
      "'/document-check'",
      "'/heartbeat'",
      "'/login'",
      "'/media-token'",
      "'/queue'",
      "'/verdict'",
      "'/work'",
    ]);
  });

  it('builds every session path from an encoded id and nothing else', () => {
    const client = sources.find((file) => file.path === 'lib/api.ts');
    // The id is the only caller-chosen value that reaches a URL, and it is
    // encoded rather than interpolated raw — so a stale storage entry produces
    // a 400 from the server rather than a request to a path the client invented.
    expect(client?.text).toMatch(/encodeURIComponent\(sessionId\)/);
    // No agent id, tenant id, or status has ever been part of a path or query.
    expect(offenders(/[?&](agent_id|tenant_id|status)=/)).toEqual([]);
  });

  it('reads with GET and acts with POST, and never the other way round', () => {
    const client = sources.find((file) => file.path === 'lib/api.ts');
    // Five GETs: the queue, one session, the media token, the agent's own work,
    // and the pinned checklist. All five are reads in the API contract too, so
    // no mutation can be smuggled onto the read verb. The media token is a read
    // in the strongest sense — T24 mints it without writing a row, an event, or
    // a billing entry — and so is the checklist, which T33 serves without
    // appending anything to the session.
    const gets = [...(client?.text.matchAll(/method: 'GET'/g) ?? [])];
    expect(gets).toHaveLength(5);
    // And a GET never carries a body: the client only attaches one for POST.
    expect(client?.text).toMatch(/method === 'POST' \? \{ body:/);
  });

  it('sends an Idempotency-Key on exactly the two operations that need one', () => {
    const client = sources.find((file) => file.path === 'lib/api.ts');
    // D13 protects claim, accept and the verdict. Login, availability,
    // heartbeat and the reads carry no key, so the header cannot drift into a
    // transport default. The verdict is the one that matters most: a retry that
    // presented a fresh key would be answered by the single-winner guard, which
    // would tell an agent their verdict failed when it had committed.
    const uses = [...(client?.text.matchAll(/idempotencyKey,/g) ?? [])];
    expect(uses).toHaveLength(3);
  });

  it('never mints an idempotency key inside the API client', () => {
    const client = sources.find((file) => file.path === 'lib/api.ts');
    // The key is a parameter. Minting it here would produce a fresh key per
    // call, which turns every retry into a second operation.
    expect(client?.text ?? '').not.toMatch(/randomUUID|Math\.random/);
  });

  it('calls none of the endpoints later tasks add', () => {
    // Claim and accept left this list with T21; the media token with T25; the
    // WebSocket connection token with T31; the checklist with T33; the verdict
    // with T35. What remains is the internal surface, which is not routed
    // publicly at all (D10) and which no browser may ever reach.
    expect(offenders(/\/internal\//)).toEqual([]);
  });

  it('submits a verdict only through the API client', () => {
    // The one request this portal makes that charges money. A component
    // building that URL itself would bypass the idempotency key `lib/work.ts`
    // owns, and a retried verdict without the original key is answered by the
    // single-winner guard — telling an agent their verdict failed when it had
    // in fact committed.
    expect(offenders(/'\/verdict'/)).toEqual(['lib/api.ts']);
  });

  it('reaches the checklist only through the API client', () => {
    // T33's read is on the allowlist above. What is asserted here is that it
    // goes through the one client like everything else: a component fetching
    // it directly would bypass the credential handling and the error mapping
    // that client owns.
    // The quoted route literal, not the bare word: `lib/checklist.ts` is a
    // module path, and matching that would make this guard about imports
    // rather than about who builds a URL.
    expect(offenders(/'\/checklist'/)).toEqual(['lib/api.ts']);
  });

  it('asks for a connection token through the API client and nowhere else', () => {
    // The socket mints none of its own and never reaches for `fetch`: it is
    // handed a function, so the credential path stays the one audited above.
    expect(offenders(/\/ws-token\b/)).toEqual(['lib/api.ts']);
  });

  it('contains no webhook code', () => {
    // Webhooks are the enterprise's channel and never the portal's.
    expect(offenders(/webhook/i)).toEqual([]);
  });

  it('reads AI results in the two modules T31 added, and nowhere else', () => {
    // The panel renders and `ai-hud.ts` decides what it may say. Nothing else
    // in the portal touches a liveness score — and neither of them can act on
    // one: the AI decides nothing (I7) and this app has no verdict path yet.
    expect(offenders(/liveness|face_match|ocr/i).sort()).toEqual([
      'components/AiPanel.tsx',
      'lib/ai-hud.ts',
    ]);
  });

  it('opens a WebSocket in exactly one module (T31)', () => {
    // The SFU connection is not this: it is made by the SDK, from a URL this
    // app only reads, and `lib/room.ts` is the one file that talks to it.
    // `lib/socket.ts` is the Control API's realtime feed, and it is the only
    // other place a socket is constructed.
    expect(offenders(/new WebSocket/)).toEqual(['lib/socket.ts']);
  });

  it('imports the LiveKit SDK in exactly one module', () => {
    // The port. Everything else in the app talks to `RoomPort`, so the SDK is
    // swappable and the logic above it is testable without a browser.
    expect(offenders(/from 'livekit-client'/)).toEqual(['lib/room.ts']);
  });

  it('names an SFU address in exactly one module', () => {
    // `lib/config.ts` reads it; nothing else builds or hardcodes one, so there
    // is no second place a deployment could be pointed at the wrong server.
    expect(offenders(/wss?:\/\//)).toEqual(['lib/config.ts']);
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

  it('claims and accepts only through the API client', () => {
    // T17's queue was read-only and this rule asserted that no word for a
    // control existed anywhere. T21 adds both actions, so the rule becomes
    // where they may live: the client issues them, the portal orchestrates
    // them, and the two panels render them. No other module may act.
    const actors = new Set(
      offenders(/\bclaim\b|\baccept\b(?!:)/i).filter((path) => path !== 'lib/queue.ts'),
    );
    expect([...actors].sort()).toEqual([
      'components/AgentPortal.tsx',
      'components/OfferPanel.tsx',
      'components/QueuePanel.tsx',
      // T35: the verdict panel matches on "accept" only because it renders the
      // word in a button hint. It issues no claim and no accept.
      'components/VerdictPanel.tsx',
      'lib/api.ts',
      'lib/work.ts',
    ]);
  });

  it('assigns nothing, and offers no control that would', () => {
    // Assignment is the server's word for what a claim causes. Nothing in the
    // portal reassigns, transfers, or releases a session — none of those is a
    // transition that exists.
    for (const pattern of [/\bassign/i, /\breassign/i, /\btransfer\b/i, /\brelease\b/i]) {
      expect(offenders(pattern)).toEqual([]);
    }
  });

  it('never sets a session status locally', () => {
    // Every status the portal shows came from a response. A literal assignment
    // to a status here would be the browser deciding something PostgreSQL owns.
    const components = sources.filter((file) => file.path.startsWith('components/'));
    expect(offenders(/status:\s*'(OFFERED|IN_CALL|QUEUED|APPROVED|REJECTED)'/, components)).toEqual(
      [],
    );
  });

  it('treats the offer countdown as a hint and never as an authority', () => {
    const offer = sources.find((file) => file.path === 'lib/offer.ts');
    // The module deliberately has no function that answers "has it expired".
    // It reports what to display, and the portal's only response to zero is to
    // ask the server.
    expect(offer?.text ?? '').not.toMatch(/function hasExpired|isExpired/);
    expect(offer?.text).toMatch(/countdownFinished/);
    // And the panel does not disable Accept when the timer runs out: a fast
    // local clock must not be able to take work away from an agent.
    const panel = sources.find((file) => file.path === 'components/OfferPanel.tsx');
    expect(panel?.text ?? '').not.toMatch(/disabled=\{lapsed/);
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
