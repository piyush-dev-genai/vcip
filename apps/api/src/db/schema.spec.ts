import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BILL_CATEGORIES,
  EXPORT_STATUSES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
} from '@vcip/shared';

/**
 * Guards the schema against silent drift from `@vcip/shared`.
 *
 * `db/schema.ts` builds its CHECK constraints by spreading the shared enums, so
 * the TypeScript cannot drift. What CAN drift is the applied database: a value
 * added to the enum without regenerating the migration leaves the committed SQL
 * — and therefore the live table — behind. These tests read the generated SQL
 * itself, which is the artefact that actually reaches PostgreSQL.
 *
 * No database connection: this runs in CI wherever the repo does.
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

const migrationSql = (): string =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');

/**
 * The value list from a `col IN ('A', 'B')` CHECK, in declaration order.
 *
 * The **last** matching line, not the first: migrations accumulate, and a
 * constraint that was later dropped and re-added is defined by its most recent
 * definition. Reading the first would assert against a shape the database no
 * longer has.
 */
const checkValues = (sql: string, constraint: string): string[] => {
  const line = sql
    .split('\n')
    .reverse()
    .find((l) => l.includes(`"${constraint}"`) && l.includes(' IN ('));
  if (line === undefined) throw new Error(`no IN-list CHECK named ${constraint}`);
  const inList = /IN \(([^)]*)\)/.exec(line);
  if (inList === null) throw new Error(`could not parse the IN list of ${constraint}`);
  return (inList[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
};

describe('generated migration', () => {
  const sql = migrationSql();

  it('exists and creates the fifteen documented tables', () => {
    const created = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect([...created].sort()).toEqual(
      [
        'agent_profiles',
        'billing_entries',
        'checklist_templates',
        'exports',
        'session_ai_summaries',
        'session_checklist_items',
        'session_events',
        'sessions',
        'tenant_api_keys',
        'tenant_byoc_configs',
        'tenants',
        'users',
        'webhook_deliveries',
        'webhook_endpoints',
        'webhook_events',
      ].sort(),
    );
  });

  it('creates none of the tables section 32 rules out', () => {
    for (const forbidden of [
      'video_frames',
      'gps_locations',
      'face_embeddings',
      'face_images',
      'ocr_fields',
      'ai_frame_results',
      'livekit_participants',
      'redis_queue',
      'agent_heartbeat',
      'idempotency_keys',
    ]) {
      expect(sql).not.toContain(`CREATE TABLE "${forbidden}"`);
    }
  });
});

describe('status values cannot drift from @vcip/shared', () => {
  const sql = migrationSql();

  it('pins sessions.status to exactly the SessionStatus enum', () => {
    expect(checkValues(sql, 'sessions_status_check').sort()).toEqual([...SESSION_STATUSES].sort());
  });

  it('pins sessions.export_status to exactly the ExportStatus enum', () => {
    expect(checkValues(sql, 'sessions_export_status_check').sort()).toEqual(
      [...EXPORT_STATUSES].sort(),
    );
  });

  it('pins billing_entries.category to exactly the BillCategory enum', () => {
    expect(checkValues(sql, 'billing_entries_category_check').sort()).toEqual(
      [...BILL_CATEGORIES].sort(),
    );
  });

  it('keeps the two status axes disjoint, as D3 requires', () => {
    const business = checkValues(sql, 'sessions_status_check');
    const evidence = checkValues(sql, 'sessions_export_status_check');
    expect(business.filter((v) => evidence.includes(v))).toEqual([]);
  });

  it('admits exactly the verdicts an agent may submit', () => {
    // Contract §18's three, and T35 added `ABORTED`, which the original
    // constraint omitted — an agent ending a call as aborted hit a constraint
    // rather than a row.
    expect(checkValues(sql, 'sessions_verdict_check')).toEqual(['APPROVED', 'REJECTED', 'ABORTED']);
  });

  it('admits no terminal status that is not a decision somebody made', () => {
    // `DROPPED_IN_CALL`, `DROPPED_QUEUED` and `PREFLIGHT_FAILED` are things
    // that happen to a session. A non-null `verdict` means a named agent
    // decided something, and the sweeper's own `ABORTED` leaves it null.
    const verdicts = checkValues(sql, 'sessions_verdict_check');
    for (const status of TERMINAL_SESSION_STATUSES) {
      if (verdicts.includes(status)) expect(TERMINAL_SESSION_STATUSES).toContain(status);
    }
    expect(verdicts).not.toContain('DROPPED_IN_CALL');
    expect(verdicts).not.toContain('DROPPED_QUEUED');
    expect(verdicts).not.toContain('PREFLIGHT_FAILED');
  });

  it('stores no agent presence value - presence is Redis state, not a column', () => {
    // AgentPresence is deliberately absent from the schema (D2). If a column
    // ever appears holding it, that is a durability decision, not a rename.
    expect(sql).not.toContain('presence');
  });
});

describe('constraints the database must enforce', () => {
  const sql = migrationSql();

  it('makes billing_entries.session_id the primary key (invariant I3)', () => {
    expect(sql).toMatch(/"billing_entries"[\s\S]*?"session_id" uuid PRIMARY KEY NOT NULL/);
  });

  it('indexes offer expiry partially, over OFFERED rows only', () => {
    expect(sql).toMatch(
      /CREATE INDEX "idx_sessions_offer_expiry"[\s\S]*?WHERE "sessions"\."status" = 'OFFERED'/,
    );
  });

  it('allows at most one active checklist template per tenant', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "checklist_templates_one_active_per_tenant"[\s\S]*?WHERE "checklist_templates"\."active"/,
    );
  });

  it('scopes user email uniqueness to the tenant, not globally', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "users_tenant_email_unique" ON "users"[^\n]*"tenant_id","email"/,
    );
  });

  it('leaves external_ref non-unique, per D15', () => {
    expect(sql).toContain('CREATE INDEX "idx_sessions_tenant_external_ref"');
    expect(sql).not.toContain('CREATE UNIQUE INDEX "idx_sessions_tenant_external_ref"');
  });

  it('uses no cascading delete - financial and audit history is never swept', () => {
    expect(sql).not.toContain('ON DELETE CASCADE');
  });

  it('gives every timestamp a time zone', () => {
    const timestampCols = [...sql.matchAll(/"[a-z_]+" timestamp(?: with time zone)?/g)].map(
      (m) => m[0],
    );
    expect(timestampCols.length).toBeGreaterThan(0);
    for (const col of timestampCols) expect(col).toContain('with time zone');
  });

  it('holds money in an integer column, never a float', () => {
    expect(sql).toMatch(/"amount_paise" integer NOT NULL/);
    expect(sql).toMatch(/"bill_amount_paise" integer/);
    expect(sql).not.toMatch(/"[a-z_]*paise" (numeric|real|double)/);
  });

  it('carries tenant_id on every tenant-owned table', () => {
    for (const table of [
      'users',
      'tenant_api_keys',
      'checklist_templates',
      'sessions',
      'session_events',
      'billing_entries',
      'webhook_endpoints',
      'webhook_events',
      'tenant_byoc_configs',
    ]) {
      const block = new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`).exec(sql);
      expect(block, `no CREATE TABLE block for ${table}`).not.toBeNull();
      expect(block?.[0]).toContain('"tenant_id" uuid NOT NULL');
    }
  });
});

describe('support for the atomic claim and accept updates', () => {
  const sql = migrationSql();

  it('has every column the claim and accept conditional updates set', () => {
    // Section 44 updates these by name. A rename here breaks claim/accept
    // silently at runtime, so pin them.
    for (const column of [
      'status',
      'offered_to_agent_id',
      'offered_at',
      'offer_expires_at',
      'agent_id',
      'connected_at',
      'version',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it('keeps the offer fields nullable, so expiry can clear them', () => {
    const block = /CREATE TABLE "sessions" \([\s\S]*?\n\);/.exec(sql)?.[0] ?? '';
    for (const column of ['offered_to_agent_id', 'offered_at', 'offer_expires_at']) {
      expect(block).toMatch(new RegExp(`"${column}" [a-z ]+(?!NOT NULL)`));
      expect(block).not.toMatch(new RegExp(`"${column}"[^,]*NOT NULL`));
    }
  });

  it('defaults version to 1 so optimistic locking starts from a known value', () => {
    expect(sql).toMatch(/"version" integer DEFAULT 1 NOT NULL/);
  });
});
