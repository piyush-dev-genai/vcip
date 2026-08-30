/**
 * Browser origin policy for the Control API.
 *
 * T14 puts a browser in front of these routes for the first time. The customer
 * app is served from its own origin (`:3000`) and the API from another
 * (`:3001`), so without an explicit policy the browser refuses every request
 * before it is ever sent.
 *
 * Three things this deliberately is not.
 *
 * **Not authentication.** CORS decides which origins a browser may read a
 * response from. It is not a credential and it stops nothing that is not a
 * browser — curl ignores it entirely. The customer token (T09) remains the only
 * thing that authorises a request, and nothing here relaxes it.
 *
 * **Not credentialed.** `credentials` stays off. The customer app authenticates
 * with a `Authorization: Bearer` header it sets itself, not with cookies, so
 * there is no reason to let the browser attach ambient credentials — and
 * refusing to is what keeps a CSRF-shaped request from ever carrying authority.
 *
 * **Not wildcarded.** An unset `CUSTOMER_ORIGIN` yields no allowed origins at
 * all, which means no CORS headers and a browser that refuses. Failing closed
 * costs a developer one line of configuration; failing open costs an allow-list
 * that nobody notices is missing.
 *
 * The value is environment configuration (D24's principle: environments differ
 * by configuration, not by code), so the same build serves local development
 * and the demo deployment.
 */

/** What `main.ts` hands to `app.enableCors`. */
export interface CorsPolicy {
  readonly origin: readonly string[];
  readonly methods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly credentials: false;
  readonly maxAge: number;
}

/**
 * Headers the browser apps actually send.
 *
 * `Idempotency-Key` is here because T11 requires it on `POST .../abort`; a
 * preflight that omitted it would make the abort route unreachable from a
 * browser. `Authorization` and `Content-Type` are the other two, and there is
 * no fourth — an allow-list of everything would defeat the point of having one.
 */
const ALLOWED_HEADERS = Object.freeze(['Authorization', 'Content-Type', 'Idempotency-Key']);

/** The verbs the customer flow uses. No PUT, PATCH, or DELETE exists to reach. */
const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'OPTIONS']);

/** One hour. Long enough to stop preflighting every request, short enough that
 *  a policy change takes effect the same day. */
const PREFLIGHT_MAX_AGE_SECONDS = 3600;

/**
 * Parse a comma-separated origin allow-list.
 *
 * Each entry must be a bare scheme-and-authority origin: `https://app.example`
 * with no path, no query, and no trailing slash, because that is exactly the
 * string a browser puts in the `Origin` header and the comparison is literal.
 * A malformed entry is dropped rather than accepted loosely — a typo should
 * lose access, not widen it.
 */
export function parseOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];

  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const candidate = entry.trim();
    if (candidate.length === 0) continue;
    if (candidate === '*') continue; // never wildcard; see the note above
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // `URL.origin` normalises away a trailing slash, a default port, and case
    // in the host, which is the same normalisation the browser applies.
    if (parsed.origin === 'null') continue;
    if (candidate !== parsed.origin) continue;
    seen.add(parsed.origin);
  }
  return Object.freeze([...seen]);
}

/**
 * Build the policy from the environment.
 *
 * Two variables, each accepting one origin or several separated by commas:
 * `CUSTOMER_ORIGIN` for the customer app and `AGENT_ORIGIN` for the agent
 * portal, which gained its first API routes in T16. They are separate rather
 * than one merged list because the two apps are deployed to different origins
 * and an operator should be able to change one without retyping the other.
 *
 * Both unset still means NO origin is allowed. A missing allow-list stops the
 * browser rather than opening the API, and CORS grants no authority in either
 * case — every route still requires its own credential.
 */
export function corsPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  return Object.freeze({
    origin: parseOrigins(
      [env['CUSTOMER_ORIGIN'], env['AGENT_ORIGIN']]
        .filter((value): value is string => value !== undefined && value.trim().length > 0)
        .join(','),
    ),
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    credentials: false as const,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  });
}
