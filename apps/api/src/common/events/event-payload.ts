/**
 * The `session_events.payload` boundary.
 *
 * `docs/06-database-schema.md` §15 says payloads carry "flags and metadata
 * only", and §39/§40 name what must never be persisted. T12 enforced that
 * structurally where it mattered most — `evaluateLocation` returns a `persist`
 * shape that has no room for a coordinate — and this is the backstop for
 * everything written later by callers that have not been reviewed yet.
 *
 * **What this is not.** It is a key-name denylist, not data-loss prevention. It
 * cannot notice a latitude stored under `note`, and it is not meant to: a real
 * classifier would be far more machinery than the MVP justifies, and would
 * invite the belief that anything passing it is safe. Structural exclusion at
 * the call site is the real defence; this catches the obvious mistake.
 *
 * **Exact keys, never substrings.** This matters more than it looks. T12
 * legitimately persists `gps_accuracy_m` and `ip_country` — an accuracy radius
 * and a two-letter country, both explicitly allowed. A substring rule on "gps"
 * or "ip" would reject the very payloads the approved design specifies. So the
 * comparison is against whole normalised key names.
 *
 * **It throws.** A prohibited key is a programming error, not a client error:
 * something upstream put a credential or a coordinate where it can never go.
 * Stripping it silently would hide exactly the bug worth finding.
 */

/**
 * A JSON value, which is all JSONB can hold.
 *
 * The array member is `readonly` so a caller can pass the frozen or
 * `readonly`-typed collections the domain layer produces — `failed_checks`
 * comes straight from `evaluatePreflight` as a `readonly` array — without
 * copying them purely to satisfy a type.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type EventPayload = Readonly<Record<string, JsonValue>>;

/**
 * Keys that may never appear in an event payload, at any depth.
 *
 * Normalised form: lowercased with `_`, `-`, and spaces removed. So `ipAddress`,
 * `ip_address`, and `IP-Address` all collapse to `ipaddress` and are rejected
 * together, while `ip_country` collapses to `ipcountry` and is not in this set.
 */
const PROHIBITED_KEYS: ReadonlySet<string> = new Set([
  // credentials and secrets (§40)
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'token',
  'accesstoken',
  'customertoken',
  'agenttoken',
  'internaltoken',
  'connectiontoken',
  'jwt',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'privatekey',
  'signingkey',
  'keyhash',
  'passwordhash',
  'databaseurl',

  // precise location (§39). `gpsaccuracym` and `ipcountry` are deliberately
  // absent: both are approved columns on `sessions`.
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'coordinates',
  'coords',
  'geolocation',

  // network identity (§39)
  'ip',
  'ipaddress',
  'clientip',
  'remoteaddr',

  // identity documents (§39)
  'aadhaar',
  'aadhar',
  'pan',
  'pannumber',
  'idnumber',
  'documentnumber',

  // extracted and captured content (§39)
  'ocrtext',
  'ocrraw',
  'fulltext',
  'rawtext',
  'faceimage',
  'facedescriptor',
  'embedding',
  'image',
  'photo',
  'selfie',
  'frame',
  'frames',
  'video',
]);

/** Deep enough for any real payload; a guard against a pathological structure. */
const MAX_DEPTH = 8;

/** Lowercase, and drop the separators that distinguish naming conventions. */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

export function isProhibitedKey(key: string): boolean {
  return PROHIBITED_KEYS.has(normaliseKey(key));
}

/**
 * A payload carrying something that must never be persisted.
 *
 * Names the offending key path — a key name is safe to surface, and it is the
 * only thing that makes the failure actionable — and never the value, which is
 * by definition the sensitive part.
 */
export class ProhibitedEventPayloadError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`event payload may not contain '${key}'`);
    this.name = 'ProhibitedEventPayloadError';
    this.key = key;
  }
}

/** A payload that is not storable as JSONB. */
export class InvalidEventPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventPayloadError';
  }
}

/**
 * Reject a payload carrying a prohibited key, or a value JSONB cannot hold.
 *
 * Walks objects and arrays. Returns nothing — the payload is used as given, not
 * rewritten, so what a caller passed and what is stored are the same object.
 */
export function assertPayloadAllowed(payload: EventPayload): void {
  walk(payload, '', 0);
}

function walk(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new InvalidEventPayloadError('event payload is nested too deeply');
  }

  if (value === null) return;

  if (Array.isArray(value)) {
    // The index is not part of the reported path: it is noise, and an array of
    // prohibited values is a prohibited key one level up.
    for (const entry of value) walk(entry, path, depth + 1);
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const keyPath = path === '' ? key : `${path}.${key}`;
      if (isProhibitedKey(key)) throw new ProhibitedEventPayloadError(keyPath);
      walk(entry, keyPath, depth + 1);
    }
    return;
  }

  if (typeof value === 'string' || typeof value === 'boolean') return;

  if (typeof value === 'number') {
    // NaN and Infinity have no JSON representation; they would serialise to
    // `null` and silently corrupt the record.
    if (!Number.isFinite(value)) {
      throw new InvalidEventPayloadError(`event payload value at '${path}' is not a finite number`);
    }
    return;
  }

  throw new InvalidEventPayloadError(
    `event payload value at '${path}' is not JSON (${typeof value})`,
  );
}
