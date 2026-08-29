/**
 * Request schemas for the customer session lifecycle.
 *
 * These live in `@vcip/shared` rather than in the Control API because the
 * customer app validates the same payloads before it sends them. One schema
 * means the browser cannot believe a body is acceptable that the server will
 * reject, and it cannot drift by being retyped in two places.
 *
 * Two things are deliberately absent, and both are the same rule: the client
 * submits **measurements and facts**, never verdicts.
 *
 *   - No `preflight_ok`. D11 puts the threshold comparison on the server.
 *   - No `geo_ok`, no `status`, no `tenant_id`. §2.4 of the API contract: the
 *     server owns session status, and the tenant comes from the credential.
 *
 * `strictObject` throughout: an unknown key is an error, not something to strip
 * silently. A client that misspells `downlink_kbps` should be told, not quietly
 * measured against a default it never sent.
 *
 * Field names are snake_case because this is the JSON wire contract, not
 * internal TypeScript style.
 */

import { z } from 'zod';

/** A percentage-style score. Used by three preflight measurements. */
const score = () => z.number().min(0).max(100);

// ---------------------------------------------------------------- create

/**
 * `POST /v1/sessions` — called by the enterprise backend with its API key
 * (D14). `external_ref` is the enterprise's own identifier and is deliberately
 * non-unique (D15); retry safety comes from `Idempotency-Key`.
 */
export const createSessionSchema = z.strictObject({
  external_ref: z.string().min(1).max(255),
  /** BCP-47-ish tag. Kept permissive: the queue shards on it (R13), and the
   *  MVP does not police the tenant's language vocabulary. */
  language: z
    .string()
    .min(2)
    .max(35)
    .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/, 'must be a language tag'),
});

export type CreateSessionRequest = z.infer<typeof createSessionSchema>;

// --------------------------------------------------------------- consent

/**
 * `POST /v1/sessions/{id}/consent`.
 *
 * `accepted` must be an explicit boolean. No coercion: a missing field or the
 * string `"false"` must not become a recorded consent, and consent is the one
 * field in this API where a permissive parse would be a legal problem rather
 * than a usability one.
 */
export const consentSchema = z.strictObject({
  accepted: z.boolean(),
  consent_version: z.string().min(1).max(64),
});

export type ConsentRequest = z.infer<typeof consentSchema>;

// ------------------------------------------------------------- preflight

/**
 * `POST /v1/sessions/{id}/preflight` — measured values only (D11).
 *
 * The validation rules here are the API contract's §9 table. They constrain the
 * SHAPE of a measurement; whether a measurement is good enough is the tenant's
 * threshold configuration, applied server-side.
 */
export const preflightSchema = z.strictObject({
  camera_width: z.number().int().positive(),
  camera_height: z.number().int().positive(),
  microphone_level: score(),
  network_rtt_ms: z.number().int().min(0),
  downlink_kbps: z.number().int().min(0),
  lighting_score: score(),
  stability_score: score(),
});

export type PreflightRequest = z.infer<typeof preflightSchema>;

/** The measurement names, in the order the contract lists them. */
export const PREFLIGHT_MEASUREMENTS = [
  'camera_width',
  'camera_height',
  'microphone_level',
  'network_rtt_ms',
  'downlink_kbps',
  'lighting_score',
  'stability_score',
] as const;

/**
 * A check name that can appear in `failed_checks`.
 *
 * `camera_width`/`camera_height` are compared jointly as
 * `min(width, height) >= min_video_px`, so the failure is reported against both
 * dimensions rather than against a synthetic name the client never sent.
 */
export type PreflightCheck = (typeof PREFLIGHT_MEASUREMENTS)[number];

// -------------------------------------------------------------- location

/**
 * `POST /v1/sessions/{id}/location`.
 *
 * The coordinates are validated and used, then discarded. Only the eligibility
 * result reaches PostgreSQL: `geo_ok`, `gps_accuracy_m`, `geo_checked_at`, and
 * `ip_country`. Latitude and longitude are sensitive location data (§39) and
 * have no durable column.
 */
export const locationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Radius of uncertainty in metres, as reported by the browser. */
  accuracy_m: z.number().min(0).max(100_000),
  captured_at: z.iso.datetime({ offset: true }),
});

export type LocationRequest = z.infer<typeof locationSchema>;

/** Location check names that can appear in `failed_checks`. */
export const LOCATION_CHECKS = ['gps_accuracy_m', 'ip_country'] as const;

export type LocationCheck = (typeof LOCATION_CHECKS)[number];
