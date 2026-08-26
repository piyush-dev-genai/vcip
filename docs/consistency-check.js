const fs = require('fs');
const path = require('path');
const DOCS = 'C:/Users/DigitaBluez/vkyc/docs';
const files = fs.readdirSync(DOCS).filter(f => f.endsWith('.md')).sort();

// normalise: strip backslash-escapes and NBSP so checks see plain text
const norm = s => s.replace(/\\([#*_`\-\[\]])/g, '$1').replace(/\u00A0/g, ' ');
const docs = {};
for (const f of files) docs[f] = norm(fs.readFileSync(path.join(DOCS, f), 'utf8'));

let pass = 0, fail = 0;
const line = (ok, msg) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

console.log('=== files ===');
for (const f of files) console.log(`      ${f}  (${fs.statSync(path.join(DOCS, f)).size} bytes)`);

console.log('\n=== C1: every doc points at the decision record ===');
for (const f of files) {
  if (f === '00-decisions.md') continue;
  line(docs[f].includes('docs/00-decisions.md'), `${f} references 00-decisions.md`);
}

console.log('\n=== C2: session status enum is complete and consistent ===');
const STATUS = ['CREATED','PREFLIGHT_FAILED','QUEUED','OFFERED','IN_CALL',
                'APPROVED','REJECTED','ABORTED','DROPPED_QUEUED','DROPPED_IN_CALL'];
for (const f of ['00-decisions.md','01-product-flow.md','03-system-design.md','06-database-schema.md']) {
  const missing = STATUS.filter(s => !docs[f].includes(s));
  line(missing.length === 0, `${f} contains all 10 business states${missing.length ? ' — missing: ' + missing : ''}`);
}

console.log('\n=== C3: export states are NOT in the session status enum ===');
// look for a fenced block that lists session states and also contains EXPORTING
for (const f of files) {
  const blocks = docs[f].match(/```text[\s\S]*?```/g) || [];
  const bad = blocks.filter(b =>
    b.includes('DROPPED_IN_CALL') && b.includes('PREFLIGHT_FAILED') &&
    (b.includes('EXPORTING') || b.includes('EXPORT_FAILED')));
  line(bad.length === 0, `${f} has no block mixing business + export states`);
}

console.log('\n=== C4: OFFERED state is present everywhere it matters ===');
for (const f of ['00-decisions.md','01-product-flow.md','03-system-design.md',
                 '05-api-contract.md','05-development-plan.md','06-database-schema.md']) {
  line(docs[f].includes('OFFERED'), `${f} documents OFFERED`);
}

console.log('\n=== C5: pull-claim, not push-assignment ===');
line(docs['03-system-design.md'].includes('pull-claim'), '03 states pull-claim');
line(docs['05-api-contract.md'].includes('/claim'), '05-api defines the claim endpoint');
line(docs['06-database-schema.md'].includes("status = 'OFFERED'"), '06 has the claim conditional update');

console.log('\n=== C6: webhook statuses are exactly PENDING/DELIVERED/DEAD ===');
for (const f of files) {
  // the term may legitimately appear inside an explicit prohibition
  const mentions = (docs[f].match(/PENDING_EVIDENCE/g) || []).length;
  const prohibitions = (docs[f].match(/(?:No|not)[^.\n]{0,40}PENDING_EVIDENCE/g) || []).length;
  line(mentions === prohibitions,
       `${f} does not introduce PENDING_EVIDENCE (${mentions} mentions / ${prohibitions} prohibitions)`);
}
line(docs['00-decisions.md'].includes('evidence_available'), '00 documents evidence_available');
line(docs['05-api-contract.md'].includes('evidence_available'), '05-api documents evidence_available');
line(docs['06-database-schema.md'].includes("export_status IN ('EXPORTED', 'FAILED', 'PURGED')"),
     '06 documents the delivery-eligibility gate');

console.log('\n=== C7: D25 — no agent_disconnected_at column ===');
for (const f of files) {
  line(!docs[f].includes('agent_disconnected_at TIMESTAMPTZ'),
       `${f} declares no agent_disconnected_at column`);
}
line(docs['06-database-schema.md'].includes('AGENT_DISCONNECTED'), '06 lists AGENT_DISCONNECTED event');
line(docs['03-system-design.md'].includes('AGENT_DISCONNECTED'), '03 uses AGENT_DISCONNECTED event');

console.log('\n=== C8: signing does not claim KMS supports Ed25519 ===');
const kmsEd = /KMS[^.]{0,80}Ed25519|Ed25519[^.]{0,80}AWS KMS/;
for (const f of files) {
  const m = docs[f].match(kmsEd);
  // tolerate markdown emphasis in the disclaimer, e.g. "does **not** offer Ed25519"
  const disclaimed = /does\s+\*{0,2}not\*{0,2}\s+(?:offer|support)\s+Ed25519/.test(docs[f])
    || /must not assume direct KMS support/.test(docs[f]);
  const okCtx = !m || disclaimed;
  line(okCtx, `${f} does not assert KMS Ed25519 support`);
}
line(docs['00-decisions.md'].includes('SigningKeyProvider'), '00 defines SigningKeyProvider');
line(docs['03-system-design.md'].includes('SigningKeyProvider'), '03 defines SigningKeyProvider');

console.log('\n=== C9: preflight uses measured values ===');
const METRICS = ['camera_width','camera_height','microphone_level','network_rtt_ms',
                 'downlink_kbps','lighting_score','stability_score'];
const miss5 = METRICS.filter(m => !docs['05-api-contract.md'].includes(m));
line(miss5.length === 0, `05-api lists all 7 preflight metrics${miss5.length ? ' — missing: ' + miss5 : ''}`);
line(!/"camera_ok"\s*:/.test(docs['05-api-contract.md']), '05-api no longer uses boolean camera_ok payload');
line(docs['06-database-schema.md'].includes('min_downlink_kbps'), '06 has tenant threshold columns');

console.log('\n=== C10: required new endpoints are documented ===');
const EP = ['/internal/livekit/webhook','/v1/agent/sessions/:id/checklist',
            '/internal/ai/result','/internal/egress/completed'];
for (const e of EP) line(docs['05-api-contract.md'].includes(e), `05-api documents ${e}`);

console.log('\n=== C11: billing invariants stated consistently ===');
for (const f of ['00-decisions.md','01-product-flow.md','05-development-plan.md']) {
  line(/2500/.test(docs[f]) || /Rs 25/.test(docs[f]), `${f} states the approved amount`);
}
line(docs['06-database-schema.md'].includes('PRIMARY KEY (session_id)') ||
     docs['06-database-schema.md'].includes('session_id       UUID PRIMARY KEY'),
     '06 enforces one billing row per session');

console.log('\n=== C12: dev plan matches the approved blueprint ===');
const P = ['Day 0','Day 1','Day 2','Day 3','Day 4','Day 5','Day 6','Day 7'];
const missP = P.filter(p => !docs['05-development-plan.md'].includes(p));
line(missP.length === 0, `dev plan has all day phases${missP.length ? ' — missing: ' + missP : ''}`);
line(docs['05-development-plan.md'].includes('apps/egress'), 'dev plan includes apps/egress');
line(docs['05-development-plan.md'].includes('Satellites hold no database credentials'),
     'dev plan states the satellite-credential rule');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
