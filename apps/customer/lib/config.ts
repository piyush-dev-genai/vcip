/**
 * Browser-visible configuration.
 *
 * Exactly one value is public: where the Control API lives. Everything else the
 * customer app needs — the enterprise API key above all — stays on the server
 * (D14), and `NEXT_PUBLIC_` is the boundary that makes the difference visible
 * in the variable's own name.
 *
 * Read through a function rather than a module-level constant because Next
 * inlines `process.env.NEXT_PUBLIC_*` at build time, and a constant evaluated
 * at import would also be evaluated during a test run where nothing is set.
 */

/** Local development default: the Control API's `API_PORT`. */
const DEFAULT_API_BASE_URL = 'http://localhost:3001';

/** A trailing slash makes `${base}/v1/...` produce a double slash. */
const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export function apiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configured === undefined || configured.trim().length === 0) return DEFAULT_API_BASE_URL;
  return trimTrailingSlash(configured.trim());
}

/** The consent text version submitted with an accept or a reject. */
export const CONSENT_VERSION = 'v1';
