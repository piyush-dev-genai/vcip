/**
 * V-CIP PostgreSQL schema.
 *
 * Implements `docs/06-database-schema.md` and the decisions in
 * `docs/00-decisions.md`. PostgreSQL is authoritative for business state (D1);
 * Redis holds nothing durable (D2).
 *
 * Status and category values come from `@vcip/shared` rather than being retyped
 * here, so a CHECK constraint and the domain code cannot drift apart. The enums
 * are the single source; this file only pins them into the database.
 *
 * Business rules are NOT duplicated in the ORM layer. The constraints below are
 * the ones the database can enforce as data invariants — shapes and identities.
 * Transition legality, billing derivation, and tenant scoping stay in
 * `@vcip/shared` and the Control API; see the invariant notes at the foot of
 * this file for what deliberately remains application-level.
 */

import { AGENT_PRESENCES, BILL_CATEGORIES, EXPORT_STATUSES, SESSION_STATUSES } from '@vcip/shared';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------- helpers

/** Every timestamp is `timestamptz`. Never a naive local time. */
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();

/**
 * A CHECK pinning a column to a set of string values.
 *
 * The list is always spread from a `@vcip/shared` constant, so adding a status
 * there and forgetting it here is impossible: the generated migration changes.
 */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

/** Value sets owned by the database rather than by shared domain code. */
export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const USER_ROLES = ['AGENT', 'TENANT_ADMIN'] as const;
export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const WEBHOOK_EVENT_STATUSES = ['PENDING', 'DELIVERED', 'DEAD'] as const;
export const BYOC_PROVIDERS = ['S3'] as const;
export const ACTOR_TYPES = ['CUSTOMER', 'AGENT', 'SYSTEM', 'ENTERPRISE'] as const;

// ---------------------------------------------------------------- tenants

/**
 * A bank, NBFC, or fintech using V-CIP. The root of every tenant-scoped query
 * (§49) and of the isolation model.
 *
 * The preflight threshold columns are here because D11 moved the pass/fail
 * decision server-side: the client submits measurements and the server compares
 * them against these values. A client cannot assert that preflight passed.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').notNull(),

    // Inert in the MVP: columns exist, behaviour is not implemented (R10).
    routingStrategy: text('routing_strategy').notNull().default('fifo'),
    recordFromQueue: boolean('record_from_queue').notNull().default(false),
    midCallGeoPolicy: text('mid_call_geo_policy').notNull().default('warn'),

    // Preflight thresholds (D11). `minVideoPx` applies to
    // min(camera_width, camera_height).
    minVideoPx: integer('min_video_px').notNull().default(480),
    gpsMaxAccuracyM: integer('gps_max_accuracy_m').notNull().default(100),
    minMicLevel: numeric('min_mic_level', { precision: 5, scale: 2 }).notNull().default('10'),
    maxRttMs: integer('max_rtt_ms').notNull().default(300),
    minDownlinkKbps: integer('min_downlink_kbps').notNull().default(500),
    minLightingScore: numeric('min_lighting_score', { precision: 5, scale: 2 })
      .notNull()
      .default('30'),
    minStabilityScore: numeric('min_stability_score', { precision: 5, scale: 2 })
      .notNull()
      .default('30'),

    aiRequiredForVerdict: boolean('ai_required_for_verdict').notNull().default(false),
    offerTimeoutSeconds: integer('offer_timeout_seconds').notNull().default(30),
    agentReconnectTimeoutSeconds: integer('agent_reconnect_timeout_seconds').notNull().default(60),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tenants_status_check', oneOf('status', TENANT_STATUSES)),
    // A non-positive timeout would make every offer expire instantly, or never.
    check('tenants_offer_timeout_positive', sql`${t.offerTimeoutSeconds} > 0`),
    check('tenants_reconnect_timeout_positive', sql`${t.agentReconnectTimeoutSeconds} > 0`),
  ],
);

// ------------------------------------------------------------------ users

/**
 * Tenant users: agents and tenant admins.
 *
 * `UNIQUE (tenant_id, email)` rather than a global unique email — the same
 * person may exist in two tenants, and an agent from Tenant A must not be able
 * to authenticate into Tenant B.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    passwordHash: text('password_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_tenant_email_unique').on(t.tenantId, t.email),
    index('idx_users_tenant_role').on(t.tenantId, t.role),
    check('users_role_check', oneOf('role', USER_ROLES)),
    check('users_status_check', oneOf('status', USER_STATUSES)),
  ],
);

/**
 * Static agent properties. Live availability is deliberately absent — presence
 * is Redis state (D2), and `AgentPresence` never lands in a column here.
 */
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'`),
    skills: text('skills')
      .array()
      .notNull()
      .default(sql`'{}'`),
    maxConcurrent: integer('max_concurrent').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Enforced at claim time (R5); a zero here would silently bar every claim.
    check('agent_profiles_max_concurrent_positive', sql`${t.maxConcurrent} >= 1`),
  ],
);

/**
 * Enterprise API credentials. Only the hash is stored; the plaintext secret is
 * shown once at creation and never again.
 *
 * `keyPrefix` is the non-secret leading fragment, used to locate the candidate
 * row before verifying the hash.
 */
export const tenantApiKeys = pgTable(
  'tenant_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    index('idx_tenant_api_keys_tenant').on(t.tenantId),
    uniqueIndex('tenant_api_keys_prefix_unique').on(t.keyPrefix),
  ],
);

// ---------------------------------------------------------- checklist

/**
 * The verification checklist for a tenant, versioned.
 *
 * A session pins the template it used (§18), so changing the active template
 * later never rewrites the meaning of a completed verification.
 */
export const checklistTemplates = pgTable(
  'checklist_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: integer('version').notNull(),
    items: jsonb('items').notNull(),
    active: boolean('active').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('checklist_templates_tenant_version_unique').on(t.tenantId, t.version),
    // "At most one active version" per tenant, enforced as data rather than as
    // a convention: a partial unique index over the active rows only.
    uniqueIndex('checklist_templates_one_active_per_tenant')
      .on(t.tenantId)
      .where(sql`${t.active}`),
    check('checklist_templates_version_positive', sql`${t.version} >= 1`),
  ],
);

// --------------------------------------------------------------- sessions

/**
 * The central business table. One row per verification.
 *
 * Two independent status axes (D3): `status` is the business lifecycle and is
 * final once terminal; `export_status` is the evidence lifecycle and moves on
 * its own. Neither column constrains the other, which is the entire point of
 * splitting them.
 *
 * `version` supports optimistic locking (§48). The claim/accept/expiry
 * conditional updates (§44) need no extra structure beyond the columns and the
 * partial offer-expiry index below.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),

    // Non-unique by D15: retry safety comes from Idempotency-Key, not from a
    // uniqueness constraint on the enterprise's own reference.
    externalRef: text('external_ref').notNull(),

    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    language: text('language').notNull(),
    priority: integer('priority').notNull().default(0),

    agentId: uuid('agent_id').references(() => users.id),
    roomName: text('room_name'),

    // Pull-claim offer fields (D4/D5). All three are written on claim (T18) and
    // kept as history on accept (T19); only the expiry sweeper clears them
    // (§17.3, T20). So a non-null value on an `OFFERED` row means an offer is
    // outstanding, while on an `IN_CALL` row it records which agent was offered
    // the session and when.
    offeredToAgentId: uuid('offered_to_agent_id').references(() => users.id),
    offeredAt: tstz('offered_at'),
    offerExpiresAt: tstz('offer_expires_at'),

    checklistTemplateId: uuid('checklist_template_id').references(() => checklistTemplates.id),

    consentOk: boolean('consent_ok').notNull().default(false),
    consentVersion: text('consent_version'),
    consentAt: tstz('consent_at'),

    preflightOk: boolean('preflight_ok').notNull().default(false),
    preflightAt: tstz('preflight_at'),

    geoOk: boolean('geo_ok').notNull().default(false),
    gpsAccuracyM: integer('gps_accuracy_m'),
    geoCheckedAt: tstz('geo_checked_at'),
    ipCountry: char('ip_country', { length: 2 }),

    qualityBelowThreshold: boolean('quality_below_threshold').notNull().default(false),

    queuedAt: tstz('queued_at'),
    connectedAt: tstz('connected_at'),
    endedAt: tstz('ended_at'),
    waitMs: integer('wait_ms'),
    talkMs: integer('talk_ms'),

    verdict: text('verdict'),
    verdictAt: tstz('verdict_at'),

    // Denormalised billing summary. The ledger row in `billing_entries` is
    // authoritative; these mirror it for cheap listing queries.
    billCategory: text('bill_category'),
    billAmountPaise: integer('bill_amount_paise'),

    exportStatus: text('export_status').notNull().default('NOT_STARTED'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_sessions_tenant_created').on(t.tenantId, t.createdAt.desc()),
    index('idx_sessions_tenant_status').on(t.tenantId, t.status),
    index('idx_sessions_tenant_agent_created').on(t.tenantId, t.agentId, t.createdAt.desc()),
    index('idx_sessions_tenant_external_ref').on(t.tenantId, t.externalRef),

    // The offer-expiry sweeper (§44.3) scans only OFFERED rows. A partial index
    // keeps it proportional to outstanding offers rather than to all sessions.
    index('idx_sessions_offer_expiry')
      .on(t.offerExpiresAt)
      .where(sql`${t.status} = 'OFFERED'`),

    // Feeds the webhook delivery-eligibility join (§27), which selects PENDING
    // events whose session's export state has resolved.
    index('idx_sessions_export_status').on(t.exportStatus),

    // Both axes pinned to the shared enums. These are the constraints that stop
    // status values drifting between the database and @vcip/shared.
    check('sessions_status_check', oneOf('status', SESSION_STATUSES)),
    check('sessions_export_status_check', oneOf('export_status', EXPORT_STATUSES)),

    // A verdict, when recorded, is one an agent may actually submit.
    //
    // `ABORTED` was missing until T35 and the omission was a real one: contract
    // §18 lists all three as submittable verdicts and §45 writes `verdict =
    // :verdict` for whichever was submitted, so an agent ending a call as
    // `ABORTED` hit this constraint rather than a row.
    //
    // Note what is still absent. `DROPPED_IN_CALL`, `DROPPED_QUEUED` and
    // `PREFLIGHT_FAILED` are terminal *statuses* but never verdicts — they are
    // things that happen to a session, not judgements a person made — and the
    // sweeper's own `ABORTED` (an agent's reconnect window lapsing) leaves this
    // column null for the same reason. A non-null `verdict` means a named agent
    // decided something.
    check(
      'sessions_verdict_check',
      sql`verdict IS NULL OR verdict IN ('APPROVED', 'REJECTED', 'ABORTED')`,
    ),

    // Billing shape only. WHICH outcome bills what is @vcip/shared's decision,
    // not the database's; this just refuses a half-written pair or a negative
    // amount, and holds money to whole paise via the integer type.
    check(
      'sessions_bill_pair_complete',
      sql`(${t.billCategory} IS NULL) = (${t.billAmountPaise} IS NULL)`,
    ),
    check(
      'sessions_bill_category_check',
      sql.raw(
        `bill_category IS NULL OR bill_category IN (${BILL_CATEGORIES.map((c) => `'${c}'`).join(', ')})`,
      ),
    ),
    check(
      'sessions_bill_amount_non_negative',
      sql`${t.billAmountPaise} IS NULL OR ${t.billAmountPaise} >= 0`,
    ),

    // Durations are elapsed time; negative is always a bug, never data.
    check('sessions_wait_ms_non_negative', sql`${t.waitMs} IS NULL OR ${t.waitMs} >= 0`),
    check('sessions_talk_ms_non_negative', sql`${t.talkMs} IS NULL OR ${t.talkMs} >= 0`),
  ],
);

/**
 * Append-only history of how a session reached its current state (§15, §16).
 *
 * Append-only by application convention: no UPDATE or DELETE path is provided
 * here, and none should be added. `sessions.status` is the current state; this
 * table is the explanation.
 *
 * `BIGSERIAL` rather than a UUID — the design specifies it, and a monotonic key
 * gives a natural append order for a log.
 *
 * Payloads carry flags and metadata only. No images, GPS coordinates, PAN,
 * Aadhaar, or OCR content — that is the sensitive-data boundary, enforced by
 * review and by the writing code, not by a column type.
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    serverTs: tstz('server_ts').notNull().defaultNow(),
  },
  (t) => [
    index('idx_session_events_session_ts').on(t.sessionId, t.serverTs),
    index('idx_session_events_tenant_ts').on(t.tenantId, t.serverTs),
    check('session_events_actor_type_check', oneOf('actor_type', ACTOR_TYPES)),
  ],
);

/**
 * The checklist result for a session. Definition comes from
 * `checklist_templates`; this records what the agent actually ticked.
 *
 * `PRIMARY KEY (session_id, item_key)` makes the upsert at verdict naturally
 * idempotent.
 */
export const sessionChecklistItems = pgTable(
  'session_checklist_items',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    itemKey: text('item_key').notNull(),
    checked: boolean('checked').notNull().default(false),
    checkedAt: tstz('checked_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.itemKey] }),
    // An unchecked item has no check time; a checked one does.
    check(
      'session_checklist_items_checked_at_consistent',
      sql`(${t.checked} = false AND ${t.checkedAt} IS NULL) OR (${t.checked} = true AND ${t.checkedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The final AI summary — a snapshot taken at verdict, not a stream (§20).
 *
 * Live AI results go to Redis during the call. Only this summary is durable, so
 * PostgreSQL never becomes a high-frequency telemetry store. No frames, no
 * embeddings.
 */
export const sessionAiSummaries = pgTable(
  'session_ai_summaries',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => sessions.id),
    livenessScore: numeric('liveness_score', { precision: 5, scale: 2 }),
    livenessStatus: text('liveness_status'),
    faceMatchScore: numeric('face_match_score', { precision: 5, scale: 2 }),
    ocrStatus: text('ocr_status'),
    modelVersions: jsonb('model_versions')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'session_ai_summaries_liveness_score_range',
      sql`${t.livenessScore} IS NULL OR (${t.livenessScore} >= 0 AND ${t.livenessScore} <= 100)`,
    ),
    check(
      'session_ai_summaries_face_match_score_range',
      sql`${t.faceMatchScore} IS NULL OR (${t.faceMatchScore} >= 0 AND ${t.faceMatchScore} <= 100)`,
    ),
  ],
);

// --------------------------------------------------------------- billing

/**
 * The durable billing ledger.
 *
 * `session_id` as PRIMARY KEY is the whole idempotency mechanism (§23, D13):
 * at most one billing row per session, no matter how many times a verdict
 * submission is retried. Invariant I3 holds even if Redis is empty or wrong.
 *
 * Money is an integer number of paise. There is no float anywhere in the money
 * path.
 */
export const billingEntries = pgTable(
  'billing_entries',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => sessions.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    category: text('category').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    billedAt: tstz('billed_at').notNull().defaultNow(),
    invoiceMonth: date('invoice_month').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_billing_entries_tenant_invoice_month').on(t.tenantId, t.invoiceMonth),
    check('billing_entries_category_check', oneOf('category', BILL_CATEGORIES)),
    // A billing row that exists must charge something; Rs 0 outcomes get no row
    // at all (invariant I5). The specific amounts are @vcip/shared's business.
    check('billing_entries_amount_positive', sql`${t.amountPaise} > 0`),
  ],
);

// --------------------------------------------------------------- exports

/**
 * Evidence export metadata (§24). Object keys and hashes only — the database
 * never holds file contents.
 *
 * The export *state* lives on `sessions.export_status`, not here, so the
 * webhook eligibility join stays a single-table condition.
 */
// Named `sessionExports`, not `exports`: a module compiled to CommonJS already
// reserves `exports` at top level, so the shorter name makes the whole schema
// file uncompilable the moment the API imports it. The SQL table is still
// `exports` - this is a binding name, not a schema change.
export const sessionExports = pgTable(
  'exports',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => sessions.id),
    provider: text('provider').notNull(),
    region: text('region').notNull(),
    bucket: text('bucket').notNull(),
    videoKey: text('video_key').notNull(),
    auditKey: text('audit_key').notNull(),
    signatureKey: text('signature_key').notNull(),
    videoSha256: char('video_sha256', { length: 64 }),
    auditSha256: char('audit_sha256', { length: 64 }),
    etag: text('etag'),
    uploadedAt: tstz('uploaded_at'),
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Hex SHA-256, lowercase. A truncated or uppercase digest is a silent
    // verification failure later, so reject it at write time.
    check(
      'exports_video_sha256_hex',
      sql`${t.videoSha256} IS NULL OR ${t.videoSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'exports_audit_sha256_hex',
      sql`${t.auditSha256} IS NULL OR ${t.auditSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// --------------------------------------------------------------- webhooks

/** Enterprise webhook configuration. The secret itself lives behind `secretRef`. */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    url: text('url').notNull(),
    secretRef: text('secret_ref').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_webhook_endpoints_tenant_active').on(t.tenantId, t.active)],
);

/**
 * Transactional outbox (§27, D21).
 *
 * The row is inserted inside the verdict transaction, before evidence exists,
 * then enriched in place when export resolves. Unlike `session_events`, this
 * payload is deliberately mutable — that is what lets one row represent the
 * eventual notification without a second status or a second table.
 *
 * Exactly three statuses. No `PENDING_EVIDENCE`.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The delivery worker scans PENDING rows only; a partial index keeps that
    // scan proportional to the backlog rather than to all history.
    index('idx_webhook_events_pending')
      .on(t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
    index('idx_webhook_events_session').on(t.sessionId),
    index('idx_webhook_events_tenant_status').on(t.tenantId, t.status),
    check('webhook_events_status_check', oneOf('status', WEBHOOK_EVENT_STATUSES)),
  ],
);

/** One row per delivery attempt — operational visibility into retries (§28). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => webhookEvents.id),
    attempt: integer('attempt').notNull(),
    httpStatus: integer('http_status'),
    error: text('error'),
    nextRetryAt: tstz('next_retry_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_event_attempt_unique').on(t.eventId, t.attempt),
    check('webhook_deliveries_attempt_positive', sql`${t.attempt} >= 1`),
  ],
);

// ------------------------------------------------------------------ byoc

/**
 * Bring-your-own-cloud storage configuration (§30). One per tenant.
 *
 * Only `S3` in the MVP; the column exists so adding GCS or Azure later is a
 * value change rather than a schema change. Credentials live behind
 * `secretRef`, never in this table.
 */
export const tenantByocConfigs = pgTable(
  'tenant_byoc_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    region: text('region').notNull(),
    bucket: text('bucket').notNull(),
    prefix: text('prefix'),
    authKind: text('auth_kind').notNull(),
    secretRef: text('secret_ref'),
    probeOkAt: tstz('probe_ok_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [check('tenant_byoc_configs_provider_check', oneOf('provider', BYOC_PROVIDERS))],
);

// ------------------------------------------------------- application-level

/**
 * Invariants PostgreSQL cannot enforce here, and where they live instead.
 *
 * 1. `sessions.agent_id` and `sessions.offered_to_agent_id` must reference a
 *    user in the SAME tenant as the session. A plain foreign key targets
 *    `users(id)` and knows nothing about `tenant_id`. Enforcing it in the
 *    database would need either a composite FK — which requires a redundant
 *    `UNIQUE (id, tenant_id)` on `users` and a duplicated `tenant_id` in every
 *    referencing row — or a trigger. Both were rejected as beyond MVP scope.
 *    Enforced instead by the claim and accept conditional updates (§44), which
 *    always carry `AND tenant_id = :tenant_id`, and by the tenant guard.
 *
 * 2. Legal status transitions. `canTransition()` in `@vcip/shared` owns this.
 *    The CHECK constraints pin the SET of values, not the edges between them;
 *    encoding a state machine in CHECKs would duplicate business logic in the
 *    ORM layer for no gain.
 *
 * 3. Which outcome bills what. `getBillingForOutcome()` in `@vcip/shared`.
 *    The database enforces only the shape: one row per session, a positive
 *    amount, a valid category, and a complete category/amount pair on
 *    `sessions`.
 *
 * 4. `billing_entries.tenant_id` must match `sessions.tenant_id`, and the same
 *    for `webhook_events`. Both are written inside the verdict transaction from
 *    the session already loaded, so they cannot diverge in practice.
 *
 * 5. Append-only `session_events`. Convention plus code review — no UPDATE or
 *    DELETE path exists. A database-level guarantee would need a trigger or a
 *    restricted role, which is a T-later hardening concern, not MVP schema.
 *
 * 6. Tenant scoping on every read (§49). The query layer and the tenant guard.
 *    Row-level security was not adopted for the MVP.
 *
 * 7. `sessions.bill_category` / `bill_amount_paise` mirror `billing_entries`.
 *    Written in the same transaction; the ledger row is authoritative.
 */
export const schema = {
  tenants,
  users,
  agentProfiles,
  tenantApiKeys,
  checklistTemplates,
  sessions,
  sessionEvents,
  sessionChecklistItems,
  sessionAiSummaries,
  billingEntries,
  exports: sessionExports,
  webhookEndpoints,
  webhookEvents,
  webhookDeliveries,
  tenantByocConfigs,
};

/**
 * Re-exported so a reader of the schema can see which value sets are owned by
 * the shared domain package rather than by this file.
 */
export { AGENT_PRESENCES, BILL_CATEGORIES, EXPORT_STATUSES, SESSION_STATUSES };
