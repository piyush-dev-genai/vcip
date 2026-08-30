# V-CIP MVP — Development Plan

> **Approved decisions live in `docs/00-decisions.md`.**
> Where this document conflicts with that decision record, the decision record wins.
> This plan was rewritten to match the approved implementation blueprint.

## 1. Goal

Build a working V-CIP MVP that demonstrates the complete customer verification
journey end-to-end, with no manual database intervention:

```text
Create -> Consent -> Preflight -> Location -> Queue -> Claim -> Accept
       -> Live Video -> AI Assistance -> Checklist -> Verdict -> Billing
       -> Recording -> Watermark -> Audit -> Signature -> Export
       -> Webhook -> Cleanup
```

Built by one technical person with a coding agent. Priority is a reliable
end-to-end product, not production-scale infrastructure.

---

## 2. Development Principles

### 2.1 Build vertically

Build complete flows, not isolated components wired together at the end. Every
milestone must produce something usable.

### 2.2 Backend is authoritative

The frontend never decides session state, billing, agent assignment, verdict, or
export status.

### 2.3 Keep the MVP simple

Per D20:

```text
no Kafka
no microservice-per-component
no Kubernetes unless required
no multi-region
no mobile SDKs
no multiple cloud providers
no custom AI model
```

### 2.4 Prefer interfaces over premature infrastructure

`LivenessProvider`, `FaceMatchProvider`, `OCRProvider`, `SigningKeyProvider`,
`GeoProvider`. Mock or single-vendor implementations first.

### 2.5 Satellites hold no database credentials

`apps/ai` and `apps/egress` have no PostgreSQL and no Redis access. Every state
change they cause goes through `/internal/*`. This mechanically enforces D1, D2,
and D10.

### 2.6 Every milestone must be testable

Functional acceptance criteria, automated tests where appropriate, manual
end-to-end verification. "It compiles" is not a gate.

---

## 3. Repository Structure

```text
vkyc/
├── package.json                 pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
│
├── docs/                        00-decisions.md is authoritative
│
├── infra/
│   ├── docker-compose.yml       postgres:16 · redis:7 · livekit · livekit-egress · minio
│   ├── livekit.yaml
│   └── egress.yaml
│
├── packages/shared/             @vcip/shared — pure contracts, no I/O
│   └── src/
│       ├── enums.ts             SessionStatus · ExportStatus · Verdict ·
│       │                        BillCategory · AgentPresence
│       ├── state-machine.ts     transition table + canTransition()
│       ├── billing.ts           outcome -> {category, amount_paise}
│       ├── events.ts            WS event names/payloads · SessionEventType
│       ├── errors.ts            error code enum
│       └── api/                 zod schemas: session · agent · internal
│
└── apps/
    ├── api/                     @vcip/api — NestJS modular monolith
    │   ├── drizzle.config.ts
    │   ├── db/                  schema.ts · migrations/ · seed.ts
    │   └── src/
    │       ├── common/          db · redis · auth · idempotency · errors ·
    │       │                    logging · config
    │       ├── tenants/         auth/        sessions/     queue/
    │       ├── agents/          checklist/   billing/      livekit/
    │       └── realtime/        exports/     webhooks/     internal/
    ├── customer/                Next.js
    ├── agent/                   Next.js
    ├── ai/                      FastAPI — liveness/ face_match/ ocr/ providers/
    └── egress/                  Node worker — ffmpeg · hash · sign · s3
```

---

## 4. Dependency Graph

Build-time:

```text
packages/shared ──┬──> apps/api
                  ├──> apps/customer
                  ├──> apps/agent
                  └──> apps/egress

apps/ai (Python) — independent; mirrors only the /internal/ai/result contract
```

Runtime:

```text
   customer ──REST/WS──>┌─────────────┐──> PostgreSQL   (sole writer)
   agent    ──REST/WS──>│  apps/api   │──> Redis        (sole writer)
                        │             │──> LiveKit Server API
                        └──────▲──────┘
                               │ /internal/* (X-Internal-Token)
              ┌────────────────┼────────────────┐
          apps/ai        apps/egress      livekit webhook
              │                │
        LiveKit (sub)    S3 + FFmpeg
```

---

## 5. Module Responsibilities

| Module | Owns | Must not |
| --- | --- | --- |
| `common/auth` | ApiKey, CustomerToken, AgentJwt, Internal guards; tenant context | Read `tenant_id` from a request body |
| `common/idempotency` | Redis 24h response replay (D13) | Be the sole protection for any invariant |
| `tenants` | Tenant config, preflight thresholds, timeouts | Expose admin APIs (seed script instead) |
| `auth` | Agent login, customer token, WS connection token (D9) | Issue cross-tenant or cross-session tokens |
| `sessions` | Lifecycle, state machine, consent, preflight evaluation, location, abort, `session_events` | Contain queue or billing logic |
| `queue` | Redis ZSET, position, matcher signal, offer-expiry sweeper (D4) | Assign sessions to agents |
| `agents` | Presence, heartbeat, BUSY, queue view, claim (D5), accept | Bypass conditional-update guards |
| `checklist` | Template pinning, `GET .../checklist` (D8), required-item validation | Let a verdict skip required items |
| `billing` | Outcome derivation; ledger write inside the verdict tx | Ever be callable by a client |
| `livekit` | Token minting, webhook receiver (D7) | Proxy media |
| `realtime` | WS gateway, Redis pub/sub bridge, HUD fan-out | Be treated as a source of truth |
| `exports` | `export_status` transitions, `/internal/egress/completed` | Touch `sessions.status` |
| `webhooks` | Outbox, payload enrichment, delivery, retry (D21, D22) | Block cleanup |
| `internal` | `/internal/ai/result` -> Redis HUD -> pub/sub | Let AI influence the verdict (D6) |
| `apps/ai` | Three providers behind interfaces, mock-first | Hold DB/Redis credentials; block the call |
| `apps/egress` | Watermark, SHA-256, canonical JSON, Ed25519 sign, upload + verify | Hold DB/Redis credentials |

---

## 6. Implementation Order

Each step has a gate. Do not advance on "it compiles."

### Day 0 — Foundation + risk spike (parallel)

1. pnpm workspace, tsconfig, lint/format, `.env.example`, five app skeletons with `/health`
2. `infra/docker-compose.yml` up; PostgreSQL and Redis reachable
3. **Throwaway spike:** two browsers in a LiveKit room -> start room-composite egress -> mp4 in MinIO -> FFmpeg watermark
4. **Throwaway spike:** verify `livekit-rtc` installs and decodes frames on the dev machine (decides D23)

*Gate: a watermarked mp4 exists; the AI ingest path is chosen.*

### Day 1 — Data, auth, session lifecycle

5. `packages/shared`: enums, state-machine table, billing table, error codes — unit tested, no I/O
6. Drizzle schema: 15 tables, D3/D11 columns, indexes, partial offer-expiry index
7. `db/seed.ts`: one tenant, two agents, checklist template, API key, webhook endpoint
8. Four auth guards, tenant guard, error filter, pino redaction
9. Idempotency interceptor (Redis, 24h)
10. `sessions`: create, consent, preflight (server-side threshold evaluation), location, get, abort, `session_events`
11. Customer UI screens 1-4 against real endpoints

*Gate: session reaches queue-eligible; invalid transitions return 409; a sub-threshold preflight payload fails server-side.*

### Day 2 — Queue, claim, accept

12. Redis ZSET queue and position; enqueue after commit with retry
13. Agent login, availability, heartbeat, presence TTL, BUSY
14. `GET /v1/agent/queue`
15. Claim (`QUEUED -> OFFERED`) and accept (`OFFERED -> IN_CALL`) as conditional updates
16. Offer-expiry sweeper (`OFFERED -> QUEUED`, preserving queue score)
17. Agent portal shell and queue view

*Gate (mandatory): two concurrent claims produce one 200 and one 409. Offer timeout returns the session to the queue unbilled.*

### Day 3 — Live video

18. `room_name` at creation (R2); media-token endpoints, both paths (R1)
19. Both apps join LiveKit; publish/subscribe per role
20. `POST /internal/livekit/webhook` -> `agent.joined`, call timestamps, `DROPPED_IN_CALL`, `AGENT_DISCONNECTED`
21. WS gateway, connection tokens, canonical event enum (R3)
22. Recording start on accept

*Gate: two-way A/V; customer closes tab -> `DROPPED_IN_CALL` + Rs 5, exactly once.*

### Day 4 — AI

23. FastAPI with three mock providers behind `LivenessProvider`, `FaceMatchProvider`, `OCRProvider`
24. Frame source per D23 -> `/internal/ai/result` -> Redis HUD -> pub/sub -> agent HUD

*Gate: killing the AI process mid-call leaves the call intact, the HUD reads "AI unavailable", and a verdict is still submittable.*

### Day 5 — Checklist, verdict, billing

25. `GET .../checklist`, submit, required-item validation
26. Verdict transaction per `06-database-schema.md` §45: single-winner guard, billing, AI snapshot, outbox
27. Race tests: duplicate verdict; verdict versus disconnect (D17)

*Gate: approve -> 2500, reject -> 500, retry -> still one billing row, race -> one terminal outcome.*

### Day 6 — Evidence, export, webhook, cleanup

28. Egress worker: fetch recording, watermark, SHA-256
29. Canonical JSON (RFC 8785), `SigningKeyProvider`, Ed25519 signature
30. S3 upload, HEAD verify, `/internal/egress/completed` -> `export_status = EXPORTED`
31. Webhook payload enrichment on export resolution, delivery loop, retry, HMAC (D21, D22)
32. Cleanup -> `export_status = PURGED`, not blocked by webhook state (D16)
33. Standalone verifier script that independently validates `audit.sig`

*Gate: full evidence package produced; verifier passes; export failure retries without touching billing; permanent export failure still delivers a webhook with `evidence_available: false`.*

### Day 7 — Hardening and demo

34. All scenarios from `01-product-flow.md` §10
35. Demo seed data, demo script, repeated end-to-end runs

---

## 6.1 Task Index (T01–T49)

**49 tasks total. 11 are mandatory tests, marked (!).**
Implement one task at a time. Do not implement future tasks early. Stop at every
gate and report.

| ID | Day | Task | Status |
| --- | --- | --- | --- |
| T01 | 0 | pnpm workspace, TypeScript base config, ESLint/Prettier, env template, root structure | done |
| T02 | 0 | Five app skeletons, each with `/health` | done |
| T03 | 0 | `infra/docker-compose.yml` — postgres, redis, livekit, livekit-egress, minio | done |
| T04 | 0 | (!) Spike: two browsers -> room-composite egress -> mp4 in MinIO -> FFmpeg watermark | done |
| T05 | 0 | (!) Spike: `livekit-rtc` install + frame decode on dev machine -> decides D23 | done |
| T06 | 1 | `@vcip/shared`: enums, state-machine, billing, errors — pure, unit-tested | done |
| T07 | 1 | Drizzle schema: 15 tables, D3/D11 columns, indexes, partial offer-expiry index | done |
| T08 | 1 | `db/seed.ts`: tenant, 2 agents, checklist template, API key, webhook endpoint | done |
| T09 | 1 | Four auth guards (ApiKey / CustomerToken / AgentJwt / Internal) + tenant guard | done |
| T10 | 1 | Error filter + pino redaction list | done |
| T11 | 1 | Idempotency interceptor (Redis, 24h) | done |
| T12 | 1 | `sessions`: create, consent, preflight with server-side thresholds, location, get, abort | done |
| T13 | 1 | `session_events` append-only writer | done |
| T14 | 1 | Customer UI screens 1-4 | done |
| T15 | 2 | Redis ZSET queue, position, post-commit enqueue with retry | done |
| T16 | 2 | Agent login, availability, heartbeat, presence TTL, internal BUSY | todo |
| T17 | 2 | `GET /v1/agent/queue` | todo |
| T18 | 2 | Claim `QUEUED -> OFFERED` (conditional update) | todo |
| T19 | 2 | Accept `OFFERED -> IN_CALL` (conditional update, offer not expired) | todo |
| T20 | 2 | Offer-expiry sweeper `OFFERED -> QUEUED`, preserving queue score | todo |
| T21 | 2 | Agent portal shell + queue view | todo |
| T22 | 2 | (!) Two concurrent claims -> one 200, one 409 | todo |
| T23 | 2 | (!) Offer timeout -> back to QUEUED, unbilled | todo |
| T24 | 3 | `room_name` at creation; media-token endpoints, both paths | todo |
| T25 | 3 | Customer + agent join LiveKit, role-scoped publish/subscribe | todo |
| T26 | 3 | `POST /internal/livekit/webhook` -> agent.joined, timestamps, DROPPED_IN_CALL, AGENT_DISCONNECTED | todo |
| T27 | 3 | WS gateway + connection tokens + canonical event enum | todo |
| T28 | 3 | Recording start on accept | todo |
| T29 | 4 | FastAPI + three mock providers behind interfaces | todo |
| T30 | 4 | Frame source per D23 -> `/internal/ai/result` | todo |
| T31 | 4 | Redis HUD + pub/sub -> WS -> agent HUD | todo |
| T32 | 4 | (!) Kill AI mid-call -> call survives, HUD "AI unavailable", verdict submittable | todo |
| T33 | 5 | `GET /v1/agent/sessions/:id/checklist` (pinned template) | todo |
| T34 | 5 | Checklist submit + required-item validation | todo |
| T35 | 5 | Verdict transaction: single-winner guard + billing + AI snapshot + outbox | todo |
| T36 | 5 | (!) Duplicate verdict -> one verdict, one billing row | todo |
| T37 | 5 | (!) Verdict racing disconnect -> one terminal outcome, loser 409 | todo |
| T38 | 6 | Egress worker: fetch recording, FFmpeg watermark, SHA-256 | todo |
| T39 | 6 | Canonical JSON (RFC 8785) + SigningKeyProvider + Ed25519 | todo |
| T40 | 6 | S3 upload + HEAD verify -> `/internal/egress/completed` -> EXPORTED | todo |
| T41 | 6 | Export retry loop inside EXPORTING; exhaustion -> FAILED | todo |
| T42 | 6 | Webhook payload enrichment on export resolution (D21) | todo |
| T43 | 6 | Delivery loop + eligibility gate + retry + HMAC signature | todo |
| T44 | 6 | Cleanup -> PURGED, not blocked by webhook state | todo |
| T45 | 6 | Standalone `audit.sig` verifier script | todo |
| T46 | 6 | (!) Permanent export failure -> webhook with `evidence_available: false`, billing intact | todo |
| T47 | 7 | All 12 scenarios from section 11 | todo |
| T48 | 7 | Demo seed data + demo script | todo |
| T49 | 7 | Repeated end-to-end runs | todo |

Critical path: T06 -> T07 -> T12 -> T18 -> T19 -> T25 -> T35 -> T40 -> T43.
Everything else can slip a day without stalling the build.

---

## 7. Testing Strategy

### Unit

Deterministic business logic only: state transitions, billing rules, checklist
validation, authorization, queue selection, preflight threshold evaluation,
canonical JSON.

### Integration

```text
API + PostgreSQL
API + Redis
API + LiveKit
Worker + S3
Webhook outbox + delivery gate
```

### End-to-end

One test simulating the full journey, eventually in CI.

### Mandatory concurrency tests

```text
Two agents claim the same session   -> one wins, one 409
Duplicate verdict                    -> one verdict, one billing row
Verdict racing customer disconnect   -> one terminal outcome
Offer timeout during claim           -> session returns to QUEUED, unbilled
```

---

## 8. Local Development Environment

Docker Compose provides infrastructure only:

```text
postgres
redis
livekit
livekit-egress
minio
```

Application processes run directly with hot reload:

```text
api · customer · agent · ai · egress
```

Per D24, LiveKit is self-hosted locally and LiveKit Cloud for the demo. The
integration code is identical; only environment variables change.

---

## 9. Environment Configuration

```text
DATABASE_URL
REDIS_URL

LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_WEBHOOK_KEY

S3_ENDPOINT
S3_BUCKET_TEMP
S3_BUCKET_ENTERPRISE
S3_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY

JWT_SECRET
CUSTOMER_TOKEN_SECRET
INTERNAL_TOKEN

SIGNING_KEY_REFERENCE
SIGNING_KEY_ED25519_PRIVATE
```

Never commit real secrets. Provide `.env.example` with placeholders.

---

## 10. Definition of Done for Every Task

```text
[ ] Implementation matches docs/00-decisions.md
[ ] TypeScript/Python type checks pass
[ ] Unit tests pass where applicable
[ ] Integration tests pass where applicable
[ ] No secrets committed
[ ] Logs do not expose sensitive data
[ ] Tenant isolation preserved
[ ] Error cases handled
[ ] API contract updated if required
[ ] Documentation updated if behaviour changed
```

---

## 11. MVP Definition of Done

The MVP is complete when the full journey runs with no manual database
intervention, and these scenarios all hold:

```text
Preflight failure        -> Rs 0, no billing row
Created, never queued    -> Rs 0, no billing row
Queue abort              -> Rs 5
Rejected                 -> Rs 5
Approved                 -> Rs 25
Customer disconnect      -> Rs 5
Offer timeout            -> returns to QUEUED, unbilled
Export failure           -> retried, billing not reversed
Permanent export failure -> webhook sent with evidence_available: false
Duplicate claim          -> one agent only, second gets 409
Duplicate verdict        -> one verdict, one billing entry
Verdict/disconnect race  -> first valid terminal transition wins
```

---

## 12. Agent Workflow Rules

The coding agent must:

1. Read `docs/00-decisions.md` first, then the relevant design doc.
2. Explain the approach briefly.
3. Make the smallest reasonable change.
4. Follow the documented architecture.
5. Add and update tests.
6. Run tests, typecheck, and lint.
7. Report files changed and remaining issues.
8. Never silently change architecture.

If a design change appears necessary:

```text
STOP -> explain -> propose -> update the decision record -> then implement
```

---

## 13. Post-MVP Roadmap

### V1 — Pilot readiness

```text
Native Android SDK
Native iOS SDK
Production AI providers
Real KYC integrations
BYOC onboarding
Enterprise SSO
Improved observability
Security review
Performance testing
```

### V2 — Scale

```text
Service separation
Redis cluster
Postgres read replicas
Autoscaling
Advanced queue routing
Automatic session reassignment
Multiple India regions
Advanced fraud detection
Multiple storage providers
```

Production architecture should evolve from measured bottlenecks, not premature
complexity.

---

## 14. Final Development Principle

```text
Do not optimize for architecture size.
Optimize for a complete, reliable customer journey.
```

The first milestone is not "all services are deployed." It is:

```text
"A real customer completed a real verification with a real agent,
 start to finish, and that verification produced a correct business
 outcome, correct billing, and verifiable evidence delivered to the
 enterprise."
```
