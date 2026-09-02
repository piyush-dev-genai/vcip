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
// The application's own KDF, not a copy. A second hashing implementation here
// could drift from the verifier by one parameter and lock every seeded agent
// out with no failing test to show for it.
import { hashPassword } from '../src/common/auth/password.js';
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
 * A stable identity for a checklist, for comparing stored against intended.
 *
 * Field by field rather than a byte comparison: PostgreSQL normalises `jsonb`
 * object key order on the way in, so stringifying both sides would report a
 * difference that does not exist. Array order *is* preserved by `jsonb` and is
 * part of what a checklist is, so it is preserved here.
 */
const fingerprint = (items: unknown): string => {
  if (!Array.isArray(items)) return 'not-an-array';
  return items
    .map((item: unknown) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return [record['key'], record['label'], record['required']].map(String).join('|');
    })
    .join(';');
};

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
    //
    // T16 gave these rows a password (`users.password_hash`). Where it comes
    // from is deliberate:
    //
    //   - `VCIP_DEMO_AGENT_PASSWORD` set  -> hashed and stored on every run, so
    //     a developer can choose one, put it in .env, and keep it across
    //     re-seeds.
    //   - unset -> one is generated for agents that have no hash yet, printed
    //     once at the end, and never stored in plaintext or written to a file.
    //     Agents that already have a hash keep it, so re-running the seed does
    //     not silently change the password someone is using.
    //
    // Only the hash reaches PostgreSQL, and nothing here logs the plaintext
    // except that single deliberate line.
    const chosenPassword = process.env.VCIP_DEMO_AGENT_PASSWORD;
    let issuedPassword: string | null = null;
    const passwordFor = async (existingHash: string | null): Promise<string | null> => {
      if (chosenPassword !== undefined && chosenPassword.length > 0) {
        return hashPassword(chosenPassword);
      }
      if (existingHash !== null) return null;
      issuedPassword ??= randomBytes(18).toString('base64url');
      return hashPassword(issuedPassword);
    };

    for (const agent of DEMO.agents) {
      const [existing] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.tenantId, tenant.id), eq(users.email, agent.email)))
        .limit(1);

      const passwordHash = await passwordFor(existing?.passwordHash ?? null);

      const [user] = await db
        .insert(users)
        .values({
          tenantId: tenant.id,
          email: agent.email,
          role: 'AGENT',
          status: 'ACTIVE',
          passwordHash,
        })
        .onConflictDoUpdate({
          target: [users.tenantId, users.email],
          set: {
            status: 'ACTIVE',
            updatedAt: new Date(),
            // Only when there is a new hash to write. `undefined` leaves the
            // column alone; writing null would delete a working credential.
            ...(passwordHash === null ? {} : { passwordHash }),
          },
        })
        .returning({ id: users.id, createdAt: users.createdAt, updatedAt: users.updatedAt });

      if (user === undefined) throw new Error(`user upsert returned no row for ${agent.email}`);
      (isNewRow(user) ? created : kept)('agent            ', `${agent.email}  ${user.id}`);
      log(
        `          password ${passwordHash === null ? 'kept' : 'set'}` +
          (chosenPassword === undefined ? '' : ' from VCIP_DEMO_AGENT_PASSWORD'),
      );

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
    // Matched on (tenant_id, version), and **never overwritten** (T33).
    //
    // This used to be an upsert that rewrote `items`, which quietly defeated
    // the guarantee the whole pinning mechanism exists for. Sessions store
    // `checklist_template_id`, so schema §18 promises that changing a tenant's
    // checklist cannot change what an existing verification was judged
    // against — but the pin holds an *id*, and rewriting the row it points at
    // changes the meaning of every session already pinned to it, retroactively
    // and with nothing in the history to say so.
    //
    // So editing CHECKLIST_ITEMS now requires bumping `checklistVersion`,
    // which is what a new version is for. The partial unique index permits
    // only one active template per tenant, so activating the new one is a
    // separate, deliberate step rather than something a re-seed does.
    const existing = await db
      .select({ id: checklistTemplates.id, items: checklistTemplates.items })
      .from(checklistTemplates)
      .where(
        and(
          eq(checklistTemplates.tenantId, tenant.id),
          eq(checklistTemplates.version, DEMO.checklistVersion),
        ),
      )
      .limit(1);

    const describeTemplate = (id: string): string =>
      `v${DEMO.checklistVersion} active, ${CHECKLIST_ITEMS.length} items  ${id}`;

    if (existing[0] === undefined) {
      const [inserted] = await db
        .insert(checklistTemplates)
        .values({
          tenantId: tenant.id,
          version: DEMO.checklistVersion,
          items: CHECKLIST_ITEMS,
          active: true,
        })
        .returning({ id: checklistTemplates.id });

      if (inserted === undefined) throw new Error('checklist template insert returned no row');
      created('checklist        ', describeTemplate(inserted.id));
    } else if (fingerprint(existing[0].items) !== fingerprint(CHECKLIST_ITEMS)) {
      throw new Error(
        `checklist template v${DEMO.checklistVersion} already exists with different items. ` +
          'Sessions are pinned to it (schema 18), so it must not be rewritten - ' +
          'bump DEMO.checklistVersion to publish a new version instead.',
      );
    } else {
      kept('checklist        ', describeTemplate(existing[0].id));
    }

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

    if (issuedPassword !== null) {
      log('\n' + '-'.repeat(72));
      log('DEVELOPMENT AGENT PASSWORD - shown once, not stored, not committed:');
      log('\n   ' + issuedPassword + '\n');
      log(`Log in at POST /v1/agent/login with tenant_slug "${DEMO.tenantSlug}" and any of:`);
      for (const agent of DEMO.agents) log('   ' + agent.email);
      log('\nSet VCIP_DEMO_AGENT_PASSWORD to choose your own and keep it across re-seeds.');
      log('-'.repeat(72));
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
