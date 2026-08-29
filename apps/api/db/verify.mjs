/* eslint-disable no-console -- A standalone CLI verification script: its
   entire output IS the report. The no-console rule guards application logging,
   which must go through the redacting logger; this file is not that. */

// Schema verification against a live PostgreSQL. Run manually:
//
//   DATABASE_URL=postgresql://... node db/verify.mjs
//
// This is not application logic and not a substitute for the unit tests. It
// exercises the invariants that only a real database can demonstrate: the
// single-winner conditional updates of section 44, the billing primary key, and
// the CHECK constraints. It writes to a scratch tenant and rolls everything
// back, so it leaves no rows behind.

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

const failures = [];
const check = (condition, message) => {
  if (condition) console.log('   PASS  ' + message);
  else {
    console.log('   FAIL  ' + message);
    failures.push(message);
  }
};

// Every write happens inside one transaction that is deliberately rolled back.
await sql
  .begin(async (tx) => {
    console.log('\n[1] Seeding a scratch tenant, two agents, and a queued session');
    const [tenant] = await tx`
      INSERT INTO tenants (slug, name, status) VALUES ('verify-scratch', 'Verify', 'ACTIVE')
      RETURNING id, offer_timeout_seconds`;
    const [agentA] = await tx`
      INSERT INTO users (tenant_id, email, role, status)
      VALUES (${tenant.id}, 'a@verify.local', 'AGENT', 'ACTIVE') RETURNING id`;
    const [agentB] = await tx`
      INSERT INTO users (tenant_id, email, role, status)
      VALUES (${tenant.id}, 'b@verify.local', 'AGENT', 'ACTIVE') RETURNING id`;
    const [session] = await tx`
      INSERT INTO sessions (tenant_id, external_ref, status, language, queued_at)
      VALUES (${tenant.id}, 'ref-1', 'QUEUED', 'en', now()) RETURNING id, version`;
    check(session.version === 1, 'session starts at version 1');
    check(session.id !== null && session.id !== undefined, 'session id defaulted to a uuid');

    console.log('\n[2] Claim is single-winner (section 44.1)');
    const claim = (agentId) => tx`
      UPDATE sessions
         SET status = 'OFFERED', offered_to_agent_id = ${agentId}, offered_at = now(),
             offer_expires_at = now() + (${tenant.offer_timeout_seconds} * interval '1 second'),
             version = version + 1
       WHERE id = ${session.id} AND tenant_id = ${tenant.id} AND status = 'QUEUED'
      RETURNING id`;
    const first = await claim(agentA.id);
    const second = await claim(agentB.id);
    check(first.length === 1, 'the first claim wins one row');
    check(second.length === 0, 'the second claim affects zero rows -> 409');

    console.log('\n[3] Accept requires the offer to be outstanding and yours (section 44.2)');
    const accept = (agentId) => tx`
      UPDATE sessions
         SET status = 'IN_CALL', agent_id = ${agentId}, connected_at = now(),
             offer_expires_at = NULL, version = version + 1
       WHERE id = ${session.id} AND tenant_id = ${tenant.id} AND status = 'OFFERED'
         AND offered_to_agent_id = ${agentId} AND offer_expires_at > now()
      RETURNING id, version`;
    const wrongAgent = await accept(agentB.id);
    check(wrongAgent.length === 0, 'an agent who was not offered the session cannot accept');
    const accepted = await accept(agentA.id);
    check(accepted.length === 1, 'the offered agent accepts');
    check(accepted[0].version === 3, 'version incremented once per update (1 -> 3)');

    console.log('\n[4] The offer-expiry sweeper uses its partial index (section 44.3)');
    const plan = await tx`
      EXPLAIN UPDATE sessions SET status = 'QUEUED'
       WHERE status = 'OFFERED' AND offer_expires_at <= now()`;
    check(
      plan
        .map((r) => r['QUERY PLAN'])
        .join(' ')
        .includes('idx_sessions_offer_expiry'),
      'the sweeper predicate is served by idx_sessions_offer_expiry',
    );

    console.log('\n[5] Billing is idempotent by primary key (invariant I3)');
    await tx`
      INSERT INTO billing_entries (session_id, tenant_id, category, amount_paise, invoice_month)
      VALUES (${session.id}, ${tenant.id}, 'SUCCESS', 2500, date_trunc('month', now()))`;
    let duplicateRejected = false;
    try {
      await tx.savepoint(
        (sp) => sp`
          INSERT INTO billing_entries (session_id, tenant_id, category, amount_paise, invoice_month)
          VALUES (${session.id}, ${tenant.id}, 'FAILED', 500, date_trunc('month', now()))`,
      );
    } catch {
      duplicateRejected = true;
    }
    check(duplicateRejected, 'a second billing row for the same session is rejected');

    console.log('\n[6] CHECK constraints reject invalid values');
    const rejects = async (label, run) => {
      let rejected = false;
      try {
        await tx.savepoint(run);
      } catch {
        rejected = true;
      }
      check(rejected, label);
    };
    await rejects(
      'an unknown session status is rejected',
      (sp) => sp`UPDATE sessions SET status = 'EXPORTING' WHERE id = ${session.id}`,
    );
    await rejects(
      'an export status is rejected in the business status column (D3)',
      (sp) => sp`UPDATE sessions SET status = 'PURGED' WHERE id = ${session.id}`,
    );
    await rejects(
      'a business status is rejected in the export status column (D3)',
      (sp) => sp`UPDATE sessions SET export_status = 'APPROVED' WHERE id = ${session.id}`,
    );
    await rejects(
      'a half-written billing pair is rejected',
      (sp) => sp`UPDATE sessions SET bill_category = 'SUCCESS' WHERE id = ${session.id}`,
    );
    await rejects(
      'a zero-amount billing row is rejected',
      (sp) => sp`
        INSERT INTO billing_entries (session_id, tenant_id, category, amount_paise, invoice_month)
        SELECT id, tenant_id, 'FAILED', 0, date_trunc('month', now())
          FROM sessions WHERE id = ${session.id}`,
    );
    await rejects(
      'a second active checklist template for one tenant is rejected',
      (sp) => sp`
        INSERT INTO checklist_templates (tenant_id, version, items, active)
        VALUES (${tenant.id}, 1, '[]'::jsonb, true), (${tenant.id}, 2, '[]'::jsonb, true)`,
    );
    await rejects(
      'the same email twice within one tenant is rejected',
      (sp) => sp`
        INSERT INTO users (tenant_id, email, role, status)
        VALUES (${tenant.id}, 'a@verify.local', 'AGENT', 'ACTIVE')`,
    );
    await rejects(
      'a malformed sha256 digest is rejected',
      (sp) => sp`
        INSERT INTO exports (session_id, provider, region, bucket, video_key, audit_key,
                             signature_key, video_sha256)
        VALUES (${session.id}, 'S3', 'local', 'b', 'v', 'a', 's', 'NOTAHASH')`,
    );

    console.log('\n[7] The same email in a DIFFERENT tenant is allowed');
    const [other] = await tx`
      INSERT INTO tenants (slug, name, status) VALUES ('verify-other', 'Other', 'ACTIVE')
      RETURNING id`;
    const [reused] = await tx`
      INSERT INTO users (tenant_id, email, role, status)
      VALUES (${other.id}, 'a@verify.local', 'AGENT', 'ACTIVE') RETURNING id`;
    check(
      reused.id !== null && reused.id !== undefined,
      'email uniqueness is scoped to the tenant, not global',
    );

    console.log('\n[8] export_status moves independently of a terminal status (D3)');
    await tx`UPDATE sessions SET status = 'APPROVED', verdict = 'APPROVED' WHERE id = ${session.id}`;
    const [evidence] = await tx`
      UPDATE sessions SET export_status = 'FAILED' WHERE id = ${session.id}
      RETURNING status, export_status`;
    check(
      evidence.status === 'APPROVED' && evidence.export_status === 'FAILED',
      'a failed export leaves the approved business status untouched',
    );

    // Everything above was a probe. Nothing is kept.
    throw new Error('__rollback__');
  })
  .catch((e) => {
    if (e.message !== '__rollback__') {
      console.error('\nUNEXPECTED ERROR: ' + e.message);
      failures.push(e.message);
    }
  });

const [{ count }] =
  await sql`SELECT count(*)::int AS count FROM tenants WHERE slug LIKE 'verify-%'`;
check(count === 0, 'the transaction rolled back; no scratch rows remain');

await sql.end();

if (failures.length > 0) {
  console.error('\n' + failures.length + ' CHECK(S) FAILED');
  process.exit(1);
}
console.log('\nALL SCHEMA CHECKS PASSED');
