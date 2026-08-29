/**
 * Development seed. Provisions the demo tenant that stands in for the tenant
 * admin APIs the MVP does not build (R9).
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @vcip/api run db:seed
 *
 * Idempotent. Every write is matched on a natural key — tenant slug, email
 * within a tenant, template version, key prefix, endpoint URL — so running it
 * ten times leaves exactly the same rows as running it once. There is no
 * "delete everything first" step: that would take any real session history down
 * with it.
 *
 * DEVELOPMENT ONLY. Every record is marked as demo data. It creates no
 * sessions, no billing, and no customer data.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  agentProfiles,
  checklistTemplates,
  sessions,
  tenantApiKeys,
  tenants,
  users,
  webhookEndpoints,
} from './schema.js';

// ------------------------------------------------------------ demo constants

/**
 * Deterministic lookup keys. These are the natural keys the upserts match on,
 * which is what makes re-running the seed a no-op rather than a duplication.
 *
 * The `demo-` prefix and the `.demo.local` domain are deliberate: nothing here
 * should ever be mistaken for a real tenant or a real person.
 */
const DEMO = {
  tenantSlug: 'demo-bank',
  tenantName: 'Demo Bank (development only)',
  checklistVersion: 1,
  apiKeyPrefix: 'vcip_demo',
  webhookUrl: 'http://127.0.0.1:4010/webhooks/vcip',
  agents: [
    { email: 'agent.one@demo.local', languages: ['en', 'hi'], maxConcurrent: 1 },
    { email: 'agent.two@demo.local', languages: ['en'], maxConcurrent: 1 },
  ],
} as const;

/** The checklist from `docs/06-database-schema.md` §10. */
const CHECKLIST_ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
  { key: 'customer_verified', label: 'Customer verified', required: true },
] as const;

// ------------------------------------------------------------------ helpers

const log = (message: string): void => {
  // A block body, not a concise one: `write` returns a boolean, which a
  // concise arrow would return against the declared `void`.
  process.stdout.write(message + '\n');
};
const created = (what: string, detail: string): void => log(`   NEW    ${what}  ${detail}`);
const kept = (what: string, detail: string): void => log(`   KEPT   ${what}  ${detail}`);

/**
 * Was this row just inserted, or did it already exist?
 *
 * On insert both timestamps come from the same `now()` and are identical; the
 * upsert branch stamps `updated_at` from the client, which is always later.
 */
const isNewRow = (row: { createdAt: Date; updatedAt: Date }): boolean =>
  row.createdAt.getTime() === row.updatedAt.getTime();

/**
 * Hash an API key for storage. Only this ever reaches PostgreSQL.
 *
 * SHA-256 rather than a password KDF: an API key is generated entropy, not a
 * human-chosen secret, so there is no dictionary to attack. The verifier will
 * compare in constant time.
 */
const hashApiKey = (plaintext: string): string =>
  createHash('sha256').update(plaintext, 'utf8').digest('hex');

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set.');
  }

  // A seed that can silently overwrite a real deployment is a footgun. This
  // will not stop a determined operator, but it stops the accident.
  if (process.env.NODE_ENV === 'production' && process.env.VCIP_SEED_FORCE !== 'yes') {
    throw new Error(
      'refusing to seed with NODE_ENV=production (set VCIP_SEED_FORCE=yes to override)',
    );
  }

  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  try {
    log('\nSeeding development data (idempotent)');

    // ----------------------------------------------------------- 1. tenant
    //
    // Upsert on the slug rather than DoNothing, so a changed demo name is
    // picked up on the next run. Thresholds stay at their schema defaults; the
    // seed does not restate them.
    const [tenant] = await db
      .insert(tenants)
      .values({ slug: DEMO.tenantSlug, name: DEMO.tenantName, status: 'ACTIVE' })
      .onConflictDoUpdate({
        target: tenants.slug,
        set: { name: DEMO.tenantName, updatedAt: new Date() },
      })
      .returning({ id: tenants.id, createdAt: tenants.createdAt, updatedAt: tenants.updatedAt });

    if (tenant === undefined) throw new Error('tenant upsert returned no row');
    (isNewRow(tenant) ? created : kept)('tenant           ', `${DEMO.tenantSlug}  ${tenant.id}`);

    // ----------------------------------------------------------- 2. agents
    //
    // Matched on (tenant_id, email) — the same unique index that keeps one
    // tenant's agents out of another's.
    for (const agent of DEMO.agents) {
      const [user] = await db
        .insert(users)
        .values({
          tenantId: tenant.id,
          email: agent.email,
          role: 'AGENT',
          status: 'ACTIVE',
          // No password hash: agent login is a later task's concern.
        })
        .onConflictDoUpdate({
          target: [users.tenantId, users.email],
          set: { status: 'ACTIVE', updatedAt: new Date() },
        })
        .returning({ id: users.id, createdAt: users.createdAt, updatedAt: users.updatedAt });

      if (user === undefined) throw new Error(`user upsert returned no row for ${agent.email}`);
      (isNewRow(user) ? created : kept)('agent            ', `${agent.email}  ${user.id}`);

      // -------------------------------------------------- 3. agent profile
      await db
        .insert(agentProfiles)
        .values({
          userId: user.id,
          languages: [...agent.languages],
          skills: [],
          maxConcurrent: agent.maxConcurrent,
        })
        .onConflictDoUpdate({
          target: agentProfiles.userId,
          set: { languages: [...agent.languages], updatedAt: new Date() },
        });
      log(
        `          profile  languages=[${agent.languages.join(', ')}] ` +
          `max_concurrent=${agent.maxConcurrent}`,
      );
    }

    // ------------------------------------------------ 4. checklist template
    //
    // Matched on (tenant_id, version). The partial unique index permits only
    // one active template per tenant, so re-running cannot leave two active.
    const [template] = await db
      .insert(checklistTemplates)
      .values({
        tenantId: tenant.id,
        version: DEMO.checklistVersion,
        items: CHECKLIST_ITEMS,
        active: true,
      })
      .onConflictDoUpdate({
        target: [checklistTemplates.tenantId, checklistTemplates.version],
        set: { items: CHECKLIST_ITEMS, active: true, updatedAt: new Date() },
      })
      .returning({
        id: checklistTemplates.id,
        createdAt: checklistTemplates.createdAt,
        updatedAt: checklistTemplates.updatedAt,
      });

    if (template === undefined) throw new Error('checklist template upsert returned no row');
    (isNewRow(template) ? created : kept)(
      'checklist        ',
      `v${DEMO.checklistVersion} active, ${CHECKLIST_ITEMS.length} items  ${template.id}`,
    );

    // ---------------------------------------------------------- 5. API key
    //
    // The plaintext is generated here, printed once, and never stored or
    // written to a file. Only the hash reaches PostgreSQL.
    //
    // Re-running does NOT mint a new key: that would silently invalidate the
    // one already in someone's .env. Rotation is explicit.
    const existingKey = await db
      .select({ id: tenantApiKeys.id })
      .from(tenantApiKeys)
      .where(eq(tenantApiKeys.keyPrefix, DEMO.apiKeyPrefix))
      .limit(1);

    const rotate = process.env.VCIP_SEED_ROTATE_KEY === 'yes';
    let issuedKey: string | null = null;

    if (existingKey[0] === undefined || rotate) {
      issuedKey = `${DEMO.apiKeyPrefix}_${randomBytes(24).toString('base64url')}`;
      await db
        .insert(tenantApiKeys)
        .values({
          tenantId: tenant.id,
          keyPrefix: DEMO.apiKeyPrefix,
          keyHash: hashApiKey(issuedKey),
          scopes: ['sessions:write', 'sessions:read'],
        })
        .onConflictDoUpdate({
          target: tenantApiKeys.keyPrefix,
          set: { keyHash: hashApiKey(issuedKey), revokedAt: null },
        });
      created(
        'api key          ',
        `prefix ${DEMO.apiKeyPrefix}, hash stored${rotate ? ' (rotated)' : ''}`,
      );
    } else {
      kept('api key          ', `prefix ${DEMO.apiKeyPrefix} (VCIP_SEED_ROTATE_KEY=yes to rotate)`);
    }

    // ------------------------------------------------- 6. webhook endpoint
    //
    // `secret_ref` points at secure storage; the signing secret itself is
    // never a column. Locally it names an environment variable.
    //
    // Look up then insert, rather than ON CONFLICT: the approved schema has no
    // unique index on (tenant_id, url), because a tenant registering the same
    // URL twice is not a documented error. Adding one to make this upsert
    // convenient would be a schema change in service of the seed script, which
    // is backwards. The seed is single-threaded and the only writer here.
    const [existingEndpoint] = await db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.tenantId, tenant.id), eq(webhookEndpoints.url, DEMO.webhookUrl)),
      )
      .limit(1);

    if (existingEndpoint === undefined) {
      const [endpoint] = await db
        .insert(webhookEndpoints)
        .values({
          tenantId: tenant.id,
          url: DEMO.webhookUrl,
          secretRef: 'env:VCIP_DEMO_WEBHOOK_SECRET',
          active: true,
        })
        .returning({ id: webhookEndpoints.id });
      created('webhook endpoint ', `${DEMO.webhookUrl}  ${endpoint?.id ?? ''}`);
    } else {
      await db
        .update(webhookEndpoints)
        .set({ active: true, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, existingEndpoint.id));
      kept('webhook endpoint ', `${DEMO.webhookUrl}  ${existingEndpoint.id}`);
    }

    // ------------------------------------------------------------- report
    const counts = await db.execute<{ table_name: string; n: number }>(sql`
      SELECT 'tenants' AS table_name, count(*)::int AS n FROM tenants
      UNION ALL SELECT 'users', count(*)::int FROM users
      UNION ALL SELECT 'agent_profiles', count(*)::int FROM agent_profiles
      UNION ALL SELECT 'checklist_templates', count(*)::int FROM checklist_templates
      UNION ALL SELECT 'tenant_api_keys', count(*)::int FROM tenant_api_keys
      UNION ALL SELECT 'webhook_endpoints', count(*)::int FROM webhook_endpoints
      UNION ALL SELECT 'sessions', count(*)::int FROM sessions
      UNION ALL SELECT 'session_events', count(*)::int FROM session_events
      UNION ALL SELECT 'billing_entries', count(*)::int FROM billing_entries
      ORDER BY table_name`);

    log('\nRow counts');
    for (const row of counts) log(`   ${String(row.n).padStart(3)}  ${row.table_name}`);

    // The seed must never manufacture business history. A session here came
    // from running the application, which is fine — but say so, so nobody
    // mistakes it for seeded data.
    const [sessionCount] = await db.select({ n: sql<number>`count(*)::int` }).from(sessions);
    if (sessionCount !== undefined && sessionCount.n > 0) {
      log('\n   note: sessions exist in this database. The seed did not create them.');
    }

    if (issuedKey !== null) {
      log('\n' + '-'.repeat(72));
      log('DEVELOPMENT API KEY - shown once, not stored, not committed:');
      log('\n   ' + issuedKey + '\n');
      log('Put it in your local .env. It cannot be recovered; re-issue with');
      log('VCIP_SEED_ROTATE_KEY=yes.');
      log('-'.repeat(72));
    }

    log('\nSeed complete.\n');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    '\nSEED FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n',
  );
  process.exitCode = 1;
});
