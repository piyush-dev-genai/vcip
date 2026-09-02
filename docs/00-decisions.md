# V-CIP MVP — Approved Decision Record

Status: **Approved**  ·  Date: 2026-08-27  ·  Applies to: MVP only

This document records the decisions that resolve the contradictions and open
questions found across `01-product-flow.md`, `03-system-design.md`,
`05-api-contract.md`, `05-development-plan.md`, and `06-database-schema.md`.

**Where any other document conflicts with this one, this document wins.**
Implementation must follow this record.

---

## D1 — PostgreSQL is authoritative

PostgreSQL owns durable business state: session state, agent assignment, verdict,
billing, export metadata, webhook outbox, audit events. If Redis and PostgreSQL
disagree, PostgreSQL is correct.

## D2 — Redis is temporary and real-time only

Redis holds the queue, agent presence, session hot data, the AI HUD, short-lived
locks, and idempotency records. It is never the business source of truth. A Redis
flush must not corrupt business state; it may only degrade liveness of the queue
and HUD.

## D3 — `status` and `export_status` are separate axes

Business state and evidence state are stored in two distinct columns. A terminal
business status is final and is never overwritten by evidence processing.

**`sessions.status`**

```text
CREATED
PREFLIGHT_FAILED
QUEUED
OFFERED
IN_CALL
APPROVED
REJECTED
ABORTED
DROPPED_QUEUED
DROPPED_IN_CALL
```

**`sessions.export_status`**

```text
NOT_STARTED   no evidence work started
EXPORTING     in progress, including the retry loop
EXPORTED      evidence uploaded and verified
FAILED        retries exhausted; terminal; evidence unavailable
PURGED        temporary platform data deleted after EXPORTED
```

`EXPORTING` covers the whole retry loop. `FAILED` means retries are exhausted and
is therefore terminal — this is what makes "permanent export failure" observable
without a separate flag. See D22.

*Supersedes:* `03-system-design.md` §13/§14 and `06-database-schema.md` §12/§25,
which previously placed `EXPORTING`, `EXPORTED`, `EXPORT_FAILED`, and `PURGED`
inside the session status enum.

## D4 — Queue uses pull-claim, with an explicit OFFERED state

The matcher does **not** assign sessions. It publishes/indicates that eligible
queued sessions exist. Agents claim explicitly.

```text
QUEUED --claim--> OFFERED --accept--> IN_CALL
   ^                  |
   +---- timeout -----+
```

- An offered session that is not accepted within `tenants.offer_timeout_seconds`
  returns to `QUEUED`.
- Returning to `QUEUED` is not a billable event.
- Automatic reassignment is **not** implemented unless an explicit failure case
  requires it.

*Supersedes:* `03-system-design.md` §12.2 and §36 Step 5, which described a
push-assignment matcher performing `QUEUED -> IN_CALL` itself.

## D5 — Agent claim is atomic

Exactly one agent can claim a session. Enforced in PostgreSQL by a conditional
update, not by a Redis lock:

```sql
UPDATE sessions
   SET status = 'OFFERED',
       offered_to_agent_id = :agent_id,
       offered_at = now(),
       version = version + 1
 WHERE id = :session_id
   AND tenant_id = :tenant_id
   AND status = 'QUEUED';
```

Zero affected rows -> `409 SESSION_ALREADY_ASSIGNED`.

## D6 — AI stays off the video critical path

```text
AI Service -> POST /internal/ai/result -> Redis HUD -> WebSocket -> Agent Portal
```

AI failure degrades the HUD only. The call continues and the agent may still
submit a verdict, unless `tenants.ai_required_for_verdict` is true.

## D7 — LiveKit webhook endpoint is required

`POST /internal/livekit/webhook` receives participant and room lifecycle events
and drives `agent.joined`, call start/end timestamps, and `DROPPED_IN_CALL`
detection. LiveKit's signature header is verified on every request.

*Adds to:* `05-api-contract.md`, which previously had no such endpoint.

## D8 — Checklist read endpoint is required

`GET /v1/agent/sessions/:id/checklist` returns the checklist template pinned to
that session via `sessions.checklist_template_id`.

*Adds to:* `05-api-contract.md` §32.

## D9 — WebSocket authentication

Connections authenticate with a short-lived connection token passed as a query
parameter (browsers cannot set `Authorization` on a WS handshake). The token is
scoped to tenant plus either a session (customer) or a user (agent), and is
minted by a REST endpoint the caller is already authorized to use.

## D10 — Internal APIs use shared internal authentication

`/internal/*` requires a shared internal credential (`X-Internal-Token`) and is
not routed publicly. This covers `/internal/ai/result`,
`/internal/egress/completed`, and `/internal/calls/sweep`.

**Amended by T26 for `/internal/livekit/webhook`.** That route verifies
LiveKit's signature *instead of* `X-Internal-Token`, not in addition to it.
`livekit-server` has no configuration for custom webhook headers — it sends only
its own signed `Authorization` — so requiring the shared credential would leave
the endpoint permanently unreachable. The signature covers the request body, so
the route is still authenticated and a replayed delivery cannot be edited. See
`05-api-contract.md` §19a.

## D11 — Preflight submits measured values

The preflight payload carries measurements, not client verdicts. Minimum fields:

```text
camera_width          integer, px
camera_height         integer, px
microphone_level      number, 0-100
network_rtt_ms        integer
downlink_kbps         integer
lighting_score        number, 0-100
stability_score       number, 0-100
```

The server compares these against tenant thresholds and computes `preflight_ok`
itself. The client cannot assert that preflight passed.

*Supersedes:* `05-api-contract.md` §9, whose payload was five client-asserted
booleans.

## D12 — Signing uses a `SigningKeyProvider` abstraction

Ed25519, with the private key injected through a secure environment/secret
mechanism. AWS KMS does **not** offer Ed25519 signing keys, so the design must not
assume direct KMS support. All signing goes through:

```typescript
interface SigningKeyProvider {
  keyId(): string;
  sign(canonicalBytes: Uint8Array): Promise<Uint8Array>;
  publicKey(): Promise<Uint8Array>;
}
```

MVP implementation: `EnvEd25519SigningKeyProvider`. Future HSM/KMS providers drop
in without touching the egress worker.

*Supersedes:* `03-system-design.md` §25, which named AWS KMS alongside Ed25519.

## D13 — Idempotency

- Idempotency records live in Redis with a 24-hour TTL, keyed by
  `idem:{actor}:{endpoint}:{key}`, storing the original serialized response.
- Redis is a convenience layer only. Business invariants are protected in
  PostgreSQL regardless of Redis state:
  - `billing_entries.session_id` is the primary key -> at most one billing row.
  - Agent claim is a conditional update -> single winner.
  - Verdict is a conditional update requiring `status = 'IN_CALL'` and
    `verdict IS NULL` -> single winner.

## D14 — Session creation is enterprise-server-side

`POST /v1/sessions` requires the enterprise API key and is called by the
enterprise backend. The customer browser receives only a short-lived,
session-scoped token. For the demo, a server-side route handler stands in for the
enterprise backend; the key stays on the server.

## D15 — `external_ref` is non-unique

Duplicate `external_ref` values are permitted. Retry safety for session creation
comes from `Idempotency-Key`, not from a uniqueness constraint.

## D16 — Export, webhook, and cleanup are independent

- Evidence uploaded and verified -> `export_status = EXPORTED`.
- Webhook delivery proceeds independently with its own retry schedule and its own
  status in `webhook_events`.
- Cleanup of temporary platform data is **not** blocked by webhook delivery once
  evidence is safely exported and verified. Cleanup sets
  `export_status = PURGED`.
- Neither export failure nor webhook failure ever reverses billing.

Delivery gating (see D21): a `PENDING` webhook event becomes eligible for delivery
only once its session's `export_status` has resolved to `EXPORTED`, `FAILED`, or
`PURGED`. No extra column and no extra webhook status is needed to express this.

## D17 — First valid terminal transition wins

If a customer disconnect and an agent verdict race, only the first valid terminal
transition commits. Any later conflicting transition returns `409`. Enforced by a
conditional update guarded on `status = 'IN_CALL' AND verdict IS NULL`.

## D18 — Agent disconnect gets a reconnect window

On agent disconnect the session **stays `IN_CALL`** and an `AGENT_DISCONNECTED`
row is appended to `session_events`. A reconnect timer runs operationally
(`tenants.agent_reconnect_timeout_seconds`).

- If the agent reconnects, `AGENT_RECONNECTED` is appended and the call resumes.
- If the timer expires, the session terminates per the failure policy
  (`ABORTED`, billed Rs 5) through the same single-winner guard as any other
  terminal transition.

**Implemented in T26.** The deadline is a Redis sorted set scored by the instant
it falls due, swept on an interval — transient real-time state (D2), holding no
authority: the transition itself is a guarded UPDATE against PostgreSQL. A key
with a TTL would not do, because a key that expires is a key that is gone, and
the sweeper would find nothing exactly when the deadline mattered. The customer
gets a symmetric but shorter window for the same reason, ending in
`DROPPED_IN_CALL` rather than `ABORTED` (R4).

**No `agent_disconnected_at` column is added to `sessions`.** Disconnect history
lives in `session_events`. A column would only be justified by a concrete query
requirement, and there is none in the MVP.

Automatic reassignment is not implemented.

## D19 — Created-but-never-queued sessions remain unbilled

They stay in `CREATED` indefinitely and produce no billing row. No expiry state is
added unless a later requirement demands it.

## D20 — MVP simplicity constraints

```text
modular monolith
one AI service
one egress worker
one PostgreSQL
one Redis
one LiveKit deployment
one S3-compatible storage provider

no Kafka
no Kubernetes unless required
no mobile SDKs
no multiple KYC providers
no multi-region
```

## D21 — Webhook outbox is created at verdict, enriched at export

The outbox row is written **inside the verdict transaction** so it can never be
lost. Evidence keys do not exist yet at that moment, so the payload is written
without them.

```text
verdict transaction
   INSERT webhook_events (status = PENDING, payload without evidence keys)
        |
        v
export resolves
        |
        +-- EXPORTED -> UPDATE payload: video_key, audit_key, signature_key,
        |                               evidence_available = true
        |
        +-- FAILED   -> UPDATE payload: evidence_available = false,
                                        keys null/omitted
        |
        v
event becomes eligible for delivery
        |
        v
delivery worker -> DELIVERED | DEAD
```

Webhook statuses remain exactly:

```text
PENDING
DELIVERED
DEAD
```

No `PENDING_EVIDENCE` status is introduced. Eligibility is derived from the
session's `export_status`, not from a fourth webhook status:

```sql
SELECT e.*
  FROM webhook_events e
  JOIN sessions s ON s.id = e.session_id
 WHERE e.status = 'PENDING'
   AND s.export_status IN ('EXPORTED', 'FAILED', 'PURGED');
```

`webhook_events.payload` is mutable (unlike `session_events`, which is
append-only). Webhook delivery remains fully independent of cleanup.

## D22 — Permanent export failure still notifies the enterprise

The business verdict and billing remain valid regardless of evidence export.

- Export is retried per the existing policy while `export_status = EXPORTING`.
- When retries are exhausted, `export_status = FAILED` — terminal.
- The enterprise **still receives** the `session.completed` webhook.
- The payload carries `evidence_available: false`.
- Evidence keys may be null or omitted.
- Billing is never reversed.

Silence after a billed session is a worse outcome than a webhook without evidence
keys.

## D23 — AI frame source is decided by the Day-0 spike

Server-side LiveKit subscription with frame decoding is verified first. If it
proves to be a significant blocker on the development machine, the MVP switches
to browser-side frame sampling.

Either way the provider interfaces and the entire downstream flow are unchanged:

```text
AI -> /internal/ai/result -> Redis HUD -> pub/sub -> WebSocket -> Agent HUD
```

Only the ingest differs. No other module is affected by this choice.

### Resolved by T05 — server-side native subscription

**Selected: server-side LiveKit subscription in Python (`livekit` 1.1.16, which
provides `livekit.rtc`). The browser-side fallback is not required and is not
built.**

The spike (`spikes/t05-ai-frame-ingestion/`) decoded 300 consecutive frames from
a real browser publisher with no errors:

| observation | value |
|---|---|
| install on Python 3.14 / Windows | clean; every dependency had a `cp314` wheel, no source builds |
| frames decoded | 300 / 300 |
| resolution | ramps `320x180` -> `640x360` -> `1280x720` (simulcast), steady at 720p |
| source format | I420, converted to RGB24 through the SDK |
| frame rate | ~20 fps |
| consumer lag | 12-15 ms across ~14.9 s of media — the consumer keeps up in real time |
| cost | ~75% of one core, ~100 MB RSS, for one stream converting *every* frame |

Two constraints this places on T30:

1. **Frame size is not constant.** Simulcast starts on a low layer and ramps up,
   so a frame's dimensions change mid-stream. Anything downstream must read
   width/height per frame rather than assuming the first frame's geometry.
2. **Do not convert every frame.** Full-frame I420 -> RGB24 at 720p costs ~23 ms.
   That fits inside a 20 fps budget on one core with nothing else running, but it
   is the whole budget. Liveness and face match need a few frames per second, not
   twenty, so T30 samples frames rather than consuming the stream exhaustively.

## D24 — LiveKit deployment differs by environment, not by code

```text
Local development : self-hosted LiveKit + MinIO via Docker Compose
VC demo           : LiveKit Cloud development project
```

Application integration is identical. The difference is expressed purely through
environment variables (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
and the S3/MinIO endpoint settings). No conditional code paths.

## D25 — Disconnect history lives in events, not columns

`AGENT_DISCONNECTED` and `AGENT_RECONNECTED` are appended to `session_events`.
No dedicated column is added to `sessions`. See D18.

---

## D26 — A call that never begins is timed out

Every other deadline in the call lifecycle is armed by a *departure*: the
customer leaves and gets `CUSTOMER_GRACE_SECONDS`, the agent leaves and gets
`agent_reconnect_timeout_seconds` (D18). That left one case with no clock at
all, because a participant who never arrives never leaves.

An agent could accept a session, join the room, and sit in it indefinitely —
`IN_CALL`, capacity consumed, `BUSY`, no billing row, no verdict, and no exit
but closing the tab, which then charged the customer Rs 5 as `ABORTED` through
the agent-disconnect path. Nothing in the approved scenarios covered it.

A third deadline is armed whenever somebody is in the room alone and
`CALL_STARTED` has not been appended, and disarmed the moment both parties are
present.

```text
first arrival (either party, session IN_CALL)
   |
   +-- both present within 120s  -> disarmed; CALL_STARTED as usual
   |
   +-- 120s elapse               -> DROPPED_IN_CALL, billed Rs 5,
                                     talk_ms NULL, verdict NULL
```

**Two minutes, and a constant rather than a tenant column.** The same reasoning
`CUSTOMER_GRACE_SECONDS` records: D18 provides one configurable timeout and
adding schema for a number nobody has asked to vary is inventing a requirement.
Measured from the first arrival rather than from the accept, so an agent who is
slow to load the call screen does not spend the customer's allowance.

**`DROPPED_IN_CALL`, billed Rs 5.** The customer reached the queue, so the
session is past `BILLING_ELIGIBILITY_START`, and every other abandonment past
that point bills Rs 5 (R4). `talk_ms` stays null and the `CALL_ENDED` payload
carries `call_never_started`, which is what distinguishes it in the record from
a customer who joined and then vanished.

**The sweeper re-checks history before acting.** A start deadline that fires on
a call which did begin is a member that outlived its meaning, and terminating a
live verification on a stale timer would be the worst outcome this mechanism
could have. PostgreSQL is asked whether `CALL_STARTED` exists; Redis is not,
because that is durable history (D1).

*Adds to:* `01-product-flow.md` §10 — a thirteenth scenario the approved list
did not name.

---

## Resolved secondary ambiguities

These follow from the decisions above and are recorded so implementation does not
re-litigate them.

| # | Question | Resolution |
|---|---|---|
| R1 | Duplicate media-token endpoints | Both `GET /v1/sessions/:id/media-token` and `GET /v1/agent/sessions/:id/media-token` exist; the agent path delegates to the same handler. |
| R2 | `room_name` assigned when? | At session creation, deterministically `vcip_{session_id}`. A customer may therefore obtain a media token while `QUEUED`. |
| R3 | WebSocket event names | The API contract is canonical. One shared enum in `packages/shared`. Customer: `queue.position`, `session.offered`, `session.assigned`, `agent.joined`, `session.updated`, `session.completed`. Agent: `queue.new_session`, `session.claimed_elsewhere`, `session.offer_expired`, `ai.updated`, `session.updated`, `session.cancelled`. |
| R4 | `ABORTED` vs `DROPPED_IN_CALL` | Customer- or agent-initiated termination -> `ABORTED`. Unexpected disconnect with no verdict recorded -> `DROPPED_IN_CALL`. Both billed Rs 5. |
| R5 | Agent presence values | `AVAILABLE`, `UNAVAILABLE` are settable by the agent. `BUSY` is internal, set on claim, cleared on session end. `agent_profiles.max_concurrent` is enforced at claim time. |
| R6 | Face-match reference image | The AI service holds a local demo reference for the MVP. No reference-intake API, and no face images in PostgreSQL. |
| R7 | IP country source | A `GeoProvider` interface with a static/local implementation. Unknown country passes in local development so the demo is not blocked. |
| R8 | Customer token lifetime | 2 hours, session-scoped, stateless. No refresh endpoint in the MVP; no revocation. |
| R9 | Tenant admin APIs | Not built. A seed script provisions tenant, agents, checklist template, API key, and webhook endpoint. |
| R10 | Inert tenant flags | `routing_strategy`, `record_from_queue`, and `mid_call_geo_policy` columns exist but are not implemented; defaults apply. |
| R11 | Migration tool | Drizzle + drizzle-kit, for direct control over conditional updates, partial indexes, and array columns. |
| R12 | Canonical JSON | RFC 8785 (JCS) serialization before signing, with a round-trip test and an independent verifier script. |
| R13 | Queue sharding by language | Keys remain `queue:{tenant_id}:{language}`. Multi-language agents merge candidate sets in application code, ordered by score. |
| R15 | Customer abort while `OFFERED` | Treated like `QUEUED`: `OFFERED -> DROPPED_QUEUED`, billed Rs 5. |
| R16 | Max queue wait | No automatic queue timeout in the MVP. `DROPPED_QUEUED` arises only from customer abort. Auto-dropping a waiting customer and billing Rs 5 for our own staffing gap is not shipped untested. |
| R17 | Recording mode | Room-composite (both participants, one file) — better evidence. Confirmed viable by the Day-0 spike. |
| R18 | Agent disconnect state | Session stays `IN_CALL`; history in `session_events`. See D18/D25. |
| R14 | Doc filename drift | `03-system-design.md` is the system architecture; `05-api-contract.md` is the API design; `06-database-schema.md` is the database design. References to `02-system-architecture.md`, `03-api-design.md`, and `04-database-design.md` mean these files. |

---

## Billing table (restated — server-derived, never client-supplied)

| Terminal outcome | `bill_category` | `amount_paise` | Billing row |
| --- | --- | ---: | --- |
| `PREFLIGHT_FAILED` | — | 0 | none |
| `CREATED` (never queued) | — | 0 | none |
| `DROPPED_QUEUED` | `FAILED` | 500 | yes |
| `REJECTED` | `FAILED` | 500 | yes |
| `ABORTED` | `FAILED` | 500 | yes |
| `DROPPED_IN_CALL` | `FAILED` | 500 | yes |
| `APPROVED` | `SUCCESS` | 2500 | yes |

Rs 25 = 2500 paise. Rs 5 = 500 paise. Money is always an integer number of paise.

`OFFERED -> QUEUED` (offer timeout) is **not** a terminal outcome and produces no
billing row. Export failure and webhook failure never reverse billing.

---

## Invariants (unchanged, restated for implementation)

```text
I1  PostgreSQL is authoritative for session state.
I2  A session has at most one assigned agent.
I3  A session has at most one billing entry.
I4  A session has at most one final verdict.
I5  A preflight-failed session has no billing entry.
I6  Customer video never passes through the Control API.
I7  AI never decides the final verdict.
I8  Tenant A can never access Tenant B's data.
I9  Export or webhook failure never reverses billing.
I10 session_events is append-only.
I11 A terminal session.status is never overwritten.
I12 Sensitive temporary data has bounded retention.
```
