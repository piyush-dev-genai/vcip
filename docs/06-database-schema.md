\# V-CIP MVP — Database Design

> **Approved decisions live in `docs/00-decisions.md`.**
> Where this document conflicts with that decision record, the decision record wins.
> Sections updated by the approved decisions are marked `[UPDATED]`.



\## 1. Purpose



This document defines the data architecture for the V-CIP MVP.



The database design must support:



\* Multi-tenant isolation

\* Customer verification sessions

\* Agent assignment

\* Session state transitions

\* Verification checklist

\* AI result summaries

\* Billing

\* Evidence export

\* Webhook delivery

\* Audit history



The MVP uses three storage layers:



```text

PostgreSQL

&#x20;   ↓

Durable business state



Redis

&#x20;   ↓

Temporary / real-time state



Object Storage

&#x20;   ↓

Video and evidence files

```



\---



\# 2. Storage Responsibilities



\## 2.1 PostgreSQL



PostgreSQL is the \*\*authoritative source of truth\*\* for durable business data.



Store:



\* Tenant configuration

\* Users

\* Sessions

\* Session state

\* Agent assignment

\* Session events

\* Checklist

\* AI summaries

\* Billing

\* Export metadata

\* Webhook state



Do not store raw video, video frames, face images, or GPS coordinates in normal PostgreSQL tables.



\---



\## 2.2 Redis



Redis stores temporary, high-frequency data.



Store:



\* Queue

\* Agent presence

\* Temporary session hot state

\* AI HUD

\* Short-lived idempotency/locks where appropriate



Redis data is not the authoritative business record.



\---



\## 2.3 Object Storage



Object storage holds media and evidence files.



For MVP:



```text

AWS S3

```



Temporary objects:



```text

raw video

watermarked video

temporary audit files

```



Final evidence:



```text

video.mp4

audit.json

audit.sig

```



The final evidence should belong to the enterprise's storage in the long-term architecture.



\---



\# 3. Database Technology



Recommended:



```text

PostgreSQL 16+

```



Use:



```text

UUID

timestamptz

jsonb

text

integer

boolean

```



Use UTC for all timestamps.



Money is stored in paise as integers.



```text

₹25 = 2500

₹5  = 500

```



\---



\# 4. Design Principles



\## Principle 1 — Tenant Isolation



Every tenant-owned table must contain:



```text

tenant\_id

```



Queries must always enforce tenant ownership.



\---



\## Principle 2 — PostgreSQL Owns Business State



If Redis says:



```text

QUEUED

```



but PostgreSQL says:



```text

IN\_CALL

```



PostgreSQL wins.



\---



\## Principle 3 — Immutable Events



Session history should never be rewritten.



Instead, append events to:



```text

session\_events

```



\---



\## Principle 4 — No Sensitive Data in the Ledger



The PostgreSQL ledger should contain the minimum information needed to operate and audit the platform.



Avoid storing:



\* GPS latitude/longitude

\* Raw IP address

\* Raw face images

\* Face embeddings

\* Raw identity documents

\* Raw video

\* Full OCR text



\---



\## Principle 5 — Idempotency



Operations that can be retried must not create duplicate business outcomes.



Important examples:



\* Session creation

\* Queue operation

\* Agent accept

\* Verdict

\* Billing

\* Webhook delivery



\---



\# 5. Entity Relationship Diagram



```text

&#x20;                                +----------------+

&#x20;                                |    tenants     |

&#x20;                                |----------------|

&#x20;                                | id PK          |

&#x20;                                | name           |

&#x20;                                | status         |

&#x20;                                +-------+--------+

&#x20;                                        |

&#x20;             +--------------------------+--------------------------+

&#x20;             |             |            |            |            |

&#x20;             v             v            v            v            v

&#x20;       +----------+   +---------+   +---------+   +---------+   +---------+

&#x20;       |  users   |   |  api    |   |checklist|   | webhook |   |  byoc   |

&#x20;       |          |   |  keys   |   |template |   |endpoint |   | config  |

&#x20;       +----+-----+   +---------+   +----+----+   +----+----+   +---------+

&#x20;            |                              |           |

&#x20;            v                              |           v

&#x20;      +-----------+                        |      +----------+

&#x20;      |  agent    |                        |      | webhook  |

&#x20;      | profiles  |                        |      | events   |

&#x20;      +-----------+                        |      +----+-----+

&#x20;                                           |           |

&#x20;                                           v           v

&#x20;                                    +------------------+

&#x20;                                    |     sessions     |

&#x20;                                    +--------+---------+

&#x20;                                             |

&#x20;                +----------------------------+---------------------------+

&#x20;                |            |               |               |           |

&#x20;                v            v               v               v           v

&#x20;         session\_events  checklist\_items  ai\_summary      billing     exports

```



\---



\# 6. `tenants`



Represents a bank, NBFC, fintech, or other enterprise using V-CIP.



\### Columns



```text

id                  UUID PRIMARY KEY

slug                TEXT UNIQUE NOT NULL

name                TEXT NOT NULL

status              TEXT NOT NULL

routing\_strategy    TEXT NOT NULL DEFAULT 'fifo'

record\_from\_queue  BOOLEAN NOT NULL DEFAULT false

min\_video\_px        INTEGER NOT NULL DEFAULT 480

gps\_max\_accuracy\_m  INTEGER NOT NULL DEFAULT 100

mid\_call\_geo\_policy TEXT NOT NULL DEFAULT 'warn'

ai\_required\_for\_verdict BOOLEAN NOT NULL DEFAULT false

created\_at          TIMESTAMPTZ NOT NULL

updated\_at          TIMESTAMPTZ NOT NULL

```



\### Status



```text

ACTIVE

SUSPENDED

```



\### MVP Notes



For the first demo, only one tenant may exist.



The schema must still support multiple tenants.



\---



\# 7. `users`



Represents platform/tenant users.



\### Columns



```text

id              UUID PRIMARY KEY

tenant\_id       UUID NOT NULL REFERENCES tenants(id)

email           TEXT NOT NULL

role            TEXT NOT NULL

status          TEXT NOT NULL

password\_hash   TEXT NULL

created\_at      TIMESTAMPTZ NOT NULL

updated\_at      TIMESTAMPTZ NOT NULL

```



\### Roles



```text

AGENT

TENANT\_ADMIN

```



\### Status



```text

ACTIVE

DISABLED

```



\### Constraints



```text

UNIQUE (tenant\_id, email)

```



An agent from Tenant A cannot authenticate into Tenant B's resources.



\---



\# 8. `agent\_profiles`



Stores relatively static agent properties.



\### Columns



```text

user\_id         UUID PRIMARY KEY REFERENCES users(id)

languages       TEXT\[] NOT NULL DEFAULT '{}'

skills          TEXT\[] NOT NULL DEFAULT '{}'

max\_concurrent INTEGER NOT NULL DEFAULT 1

created\_at      TIMESTAMPTZ NOT NULL

updated\_at      TIMESTAMPTZ NOT NULL

```



Do not store live availability here.



Live availability belongs in Redis.



\---



\# 9. `tenant\_api\_keys`



Stores enterprise API credentials.



\### Columns



```text

id             UUID PRIMARY KEY

tenant\_id      UUID NOT NULL REFERENCES tenants(id)

key\_prefix     TEXT NOT NULL

key\_hash       TEXT NOT NULL

scopes         TEXT\[] NOT NULL

created\_at     TIMESTAMPTZ NOT NULL

expires\_at     TIMESTAMPTZ NULL

revoked\_at     TIMESTAMPTZ NULL

```



\### Security



Only the hash is stored.



The original secret is shown once when created.



Never store plaintext API keys.



\---



\# 10. `checklist\_templates`



Defines the verification checklist for a tenant.



\### Columns



```text

id            UUID PRIMARY KEY

tenant\_id     UUID NOT NULL REFERENCES tenants(id)

version       INTEGER NOT NULL

items         JSONB NOT NULL

active        BOOLEAN NOT NULL DEFAULT false

created\_at    TIMESTAMPTZ NOT NULL

updated\_at    TIMESTAMPTZ NOT NULL

```



\### Example `items`



```json

\[

&#x20; {

&#x20;   "key": "face\_visible",

&#x20;   "label": "Customer face visible",

&#x20;   "required": true

&#x20; },

&#x20; {

&#x20;   "key": "document\_shown",

&#x20;   "label": "Original document shown",

&#x20;   "required": true

&#x20; },

&#x20; {

&#x20;   "key": "customer\_verified",

&#x20;   "label": "Customer verified",

&#x20;   "required": true

&#x20; }

]

```



\### Constraints



A tenant should have at most one active version.



\---



\# 11. `sessions`



This is the \*\*central business table\*\*.



Every V-CIP verification is represented by one session.



\### Columns



```text

id                    UUID PRIMARY KEY

tenant\_id             UUID NOT NULL REFERENCES tenants(id)

external\_ref          TEXT NOT NULL

status                TEXT NOT NULL



version               INTEGER NOT NULL DEFAULT 1



language              TEXT NOT NULL

priority              INTEGER NOT NULL DEFAULT 0



agent\_id              UUID NULL REFERENCES users(id)



room\_name             TEXT NULL



consent\_ok            BOOLEAN NOT NULL DEFAULT false

consent\_version       TEXT NULL

consent\_at            TIMESTAMPTZ NULL



preflight\_ok          BOOLEAN NOT NULL DEFAULT false

preflight\_at          TIMESTAMPTZ NULL



geo\_ok                BOOLEAN NOT NULL DEFAULT false

gps\_accuracy\_m        INTEGER NULL

geo\_checked\_at        TIMESTAMPTZ NULL

ip\_country            CHAR(2) NULL



quality\_below\_threshold BOOLEAN NOT NULL DEFAULT false



queued\_at             TIMESTAMPTZ NULL

connected\_at          TIMESTAMPTZ NULL

ended\_at              TIMESTAMPTZ NULL



wait\_ms               INTEGER NULL

talk\_ms               INTEGER NULL



verdict               TEXT NULL

verdict\_at            TIMESTAMPTZ NULL



bill\_category         TEXT NULL

bill\_amount\_paise     INTEGER NULL



export\_status         TEXT NOT NULL DEFAULT 'NOT\_STARTED'



created\_at            TIMESTAMPTZ NOT NULL

updated\_at            TIMESTAMPTZ NOT NULL

```



\---



\# 11a. Additional `sessions` Columns [UPDATED]

The approved decisions add the following columns to `sessions`:

```text
offered_to_agent_id   UUID NULL REFERENCES users(id)
offered_at            TIMESTAMPTZ NULL
offer_expires_at      TIMESTAMPTZ NULL
checklist_template_id UUID NULL REFERENCES checklist_templates(id)
```

`export_status` uses the enum in section 25 and defaults to `NOT_STARTED`.

Partial index supporting the offer-expiry sweeper:

```text
INDEX idx_sessions_offer_expiry
ON sessions (offer_expires_at)
WHERE status = 'OFFERED'
```

\---

\# 6a. Additional `tenants` Columns [UPDATED]

Preflight thresholds and timeouts are tenant configuration:

```text
min_mic_level                  NUMERIC(5,2) NOT NULL DEFAULT 10
max_rtt_ms                     INTEGER NOT NULL DEFAULT 300
min_downlink_kbps              INTEGER NOT NULL DEFAULT 500
min_lighting_score             NUMERIC(5,2) NOT NULL DEFAULT 30
min_stability_score            NUMERIC(5,2) NOT NULL DEFAULT 30
offer_timeout_seconds          INTEGER NOT NULL DEFAULT 30
agent_reconnect_timeout_seconds INTEGER NOT NULL DEFAULT 60
```

`min_video_px` already exists and is applied to
`min(camera_width, camera_height)`.

Inert in the MVP (columns created, behaviour not implemented, see R10):
`routing_strategy`, `record_from_queue`, `mid_call_geo_policy`.

\---

\# 12. Session Status



Allowed session states (business axis only). See D3.

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

Export/evidence states are **not** part of this enum. They live in
`sessions.export_status`.

A terminal business status is final and is never overwritten.

The actual implementation may use a PostgreSQL enum or validated text values.



\---



\# 13. Important Session Constraints



\## Tenant ownership



```text

sessions.tenant\_id

```



must match the authenticated tenant.



\---



\## Agent ownership



`agent\_id` must reference a user belonging to the same tenant.



\---



\## Verdict



Allowed only once.



A session cannot transition:



```text

APPROVED → REJECTED

```



or:



```text

REJECTED → APPROVED

```



\---



\## Billing



`bill\_amount\_paise` is populated only when the session becomes billable.



\---



\## Export



`export\_status` represents evidence-processing state.



It is separate from the session's business verdict.



\---



\# 14. Session Indexes



Recommended:



```text

INDEX idx\_sessions\_tenant\_created

ON sessions (tenant\_id, created\_at DESC)



INDEX idx\_sessions\_tenant\_status

ON sessions (tenant\_id, status)



INDEX idx\_sessions\_tenant\_agent\_created

ON sessions (tenant\_id, agent\_id, created\_at DESC)



INDEX idx\_sessions\_tenant\_external\_ref

ON sessions (tenant\_id, external\_ref)

```



If the enterprise frequently searches by external reference:



```text

INDEX (tenant\_id, external\_ref)

```



is important.



\---



\# 15. `session\_events`



This table stores an immutable history of important session events.



\### Columns



```text

id            BIGSERIAL PRIMARY KEY

tenant\_id     UUID NOT NULL REFERENCES tenants(id)

session\_id    UUID NOT NULL REFERENCES sessions(id)

event\_type    TEXT NOT NULL

actor\_type    TEXT NOT NULL

actor\_id      UUID NULL

payload       JSONB NOT NULL DEFAULT '{}'

server\_ts     TIMESTAMPTZ NOT NULL

```



\### Example Events



```text

SESSION\_CREATED

CONSENT\_ACCEPTED

PREFLIGHT\_PASSED

PREFLIGHT\_FAILED

LOCATION\_PASSED

LOCATION\_FAILED

SESSION\_QUEUED

SESSION\_ASSIGNED

AGENT\_ACCEPTED

CALL\_STARTED

CALL\_ENDED

AGENT\_DISCONNECTED

AGENT\_RECONNECTED

AI\_UNAVAILABLE

VERDICT\_SUBMITTED

BILLING\_CREATED

EGRESS\_STARTED

EGRESS\_COMPLETED

EXPORT\_STARTED

EXPORTED

EXPORT\_FAILED

PURGED

WEBHOOK\_CREATED

```



\### Payload



Payload should contain flags/metadata only.



Example:



```json

{

&#x20; "camera\_ok": true,

&#x20; "microphone\_ok": true,

&#x20; "network\_ok": true

}

```



Do not place raw images, GPS coordinates, PAN, Aadhaar, or full OCR content into event payloads.



\---



\# 16. Event Immutability



`session\_events` should be append-only.



Application code should never update or delete an existing event.



The session's current state lives in:



```text

sessions.status

```



The historical explanation of how it got there lives in:



```text

session\_events

```



\---



\# 17. `session\_checklist\_items`



Stores the actual checklist result for a session.



\### Columns



```text

session\_id       UUID NOT NULL REFERENCES sessions(id)

item\_key         TEXT NOT NULL

checked          BOOLEAN NOT NULL DEFAULT false

checked\_at       TIMESTAMPTZ NULL

updated\_at       TIMESTAMPTZ NOT NULL

```



\### Primary Key



```text

PRIMARY KEY (session\_id, item\_key)

```



The checklist definition comes from:



```text

checklist\_templates

```



The session records the actual result.



\---



\# 18. Checklist Versioning



A session should reference the exact checklist template version used during verification.



Add to `sessions`:



```text

checklist\_template\_id UUID NULL REFERENCES checklist\_templates(id)

```



When the session is created or queued, the active template is selected.



Afterward, changing the tenant's active checklist must not change the meaning of an existing session.



\---



\# 19. `session\_ai\_summaries`



Stores the final non-sensitive AI summary.



\### Columns



```text

session\_id          UUID PRIMARY KEY REFERENCES sessions(id)



liveness\_score      NUMERIC(5,2) NULL

liveness\_status     TEXT NULL



face\_match\_score    NUMERIC(5,2) NULL



ocr\_status          TEXT NULL



model\_versions      JSONB NOT NULL DEFAULT '{}'



created\_at          TIMESTAMPTZ NOT NULL

updated\_at          TIMESTAMPTZ NOT NULL

```



\### Example



```json

{

&#x20; "liveness": "demo-v1",

&#x20; "face\_match": "demo-v1",

&#x20; "ocr": "demo-v1"

}

```



Only the final summary is stored.



Individual frames and embeddings are not stored.



\---



\# 20. AI Summary Rules



The AI summary is a \*\*snapshot\*\*, not a stream.



During the call:



```text

AI results → Redis

```



At verdict:



```text

Latest AI results → session\_ai\_summaries

```



This prevents PostgreSQL from becoming a high-frequency telemetry store.



\---



\# 21. `billing\_entries`



This is the durable billing ledger.



\### Columns



```text

session\_id       UUID PRIMARY KEY REFERENCES sessions(id)

tenant\_id        UUID NOT NULL REFERENCES tenants(id)



category         TEXT NOT NULL

amount\_paise     INTEGER NOT NULL



billed\_at        TIMESTAMPTZ NOT NULL

invoice\_month    DATE NOT NULL



created\_at       TIMESTAMPTZ NOT NULL

```



\### Category



```text

SUCCESS

FAILED

```



\---



\# 22. Billing Rules



```text

PREFLIGHT\_FAILED → no billing row



APPROVED         → SUCCESS, 2500



REJECTED         → FAILED, 500



ABORTED          → FAILED, 500



DROPPED\_QUEUED   → FAILED, 500



DROPPED\_IN\_CALL  → FAILED, 500

```



The billing amount must be derived by backend business logic.



The customer cannot supply:



```json

{

&#x20; "amount\_paise": 2500

}

```



and have the backend trust it.



\---



\# 23. Billing Idempotency



The following constraint is critical:



```text

PRIMARY KEY (session\_id)

```



This ensures:



```text

One session

&#x20;   ↓

One billing entry

```



Even if verdict submission is retried three times, only one billing record can exist.



\---



\# 24. `exports`



Tracks final evidence export.



\### Columns



```text

session\_id       UUID PRIMARY KEY REFERENCES sessions(id)



provider         TEXT NOT NULL

region           TEXT NOT NULL

bucket           TEXT NOT NULL



video\_key        TEXT NOT NULL

audit\_key        TEXT NOT NULL

signature\_key    TEXT NOT NULL



video\_sha256     CHAR(64) NULL

audit\_sha256     CHAR(64) NULL



etag             TEXT NULL



uploaded\_at      TIMESTAMPTZ NULL

verified\_at      TIMESTAMPTZ NULL



created\_at       TIMESTAMPTZ NOT NULL

updated\_at       TIMESTAMPTZ NOT NULL

```



The database stores metadata about the exported files.



It does not store file contents.



\---



\# 25. `export\_status`



The session's export state is a separate column, `sessions.export_status`:

```text
NOT_STARTED
EXPORTING
EXPORTED
FAILED
PURGED
```

Export, webhook delivery, and cleanup are independent concerns. Cleanup is not
blocked by webhook delivery once evidence is exported and verified. See D16.

The detailed export metadata lives in:



```text

exports

```



\---



\# 26. `webhook\_endpoints`



Stores enterprise webhook configuration.



\### Columns



```text

id           UUID PRIMARY KEY

tenant\_id    UUID NOT NULL REFERENCES tenants(id)



url          TEXT NOT NULL

secret\_ref   TEXT NOT NULL



active       BOOLEAN NOT NULL DEFAULT true



created\_at   TIMESTAMPTZ NOT NULL

updated\_at   TIMESTAMPTZ NOT NULL

```



The actual webhook secret must not be stored in plaintext.



`secret\_ref` points to secure secret storage.



\---



\# 27. `webhook\_events`



Transactional outbox records.



\### Columns



```text

id             UUID PRIMARY KEY

tenant\_id      UUID NOT NULL REFERENCES tenants(id)

session\_id     UUID NOT NULL REFERENCES sessions(id)

endpoint\_id    UUID NOT NULL REFERENCES webhook\_endpoints(id)



event\_type     TEXT NOT NULL

payload        JSONB NOT NULL



status         TEXT NOT NULL DEFAULT 'PENDING'



created\_at     TIMESTAMPTZ NOT NULL

updated\_at     TIMESTAMPTZ NOT NULL

```



\### Status [UPDATED]

```text
PENDING
DELIVERED
DEAD
```

Exactly three statuses. No `PENDING_EVIDENCE`. See D21.

\### Payload lifecycle [UPDATED]

The outbox row is inserted **inside the verdict transaction**, before evidence
exists, so the payload initially carries no evidence keys. When export resolves,
the payload is updated in place:

```text
export_status = EXPORTED  ->  payload gains video_key, audit_key,
                              signature_key, evidence_available = true

export_status = FAILED    ->  payload gains evidence_available = false;
                              keys null or omitted
```

Unlike `session_events`, `webhook_events.payload` is mutable.

\### Delivery eligibility [UPDATED]

A PENDING event becomes deliverable only once its session's export state has
resolved. No extra column and no extra status is required:

```sql
SELECT e.*
  FROM webhook_events e
  JOIN sessions s ON s.id = e.session_id
 WHERE e.status = 'PENDING'
   AND s.export_status IN ('EXPORTED', 'FAILED', 'PURGED');
```

Cleanup is never blocked by webhook delivery. See D16 and D22.



\---



\# 28. `webhook\_deliveries`



Stores each delivery attempt.



\### Columns



```text

id              UUID PRIMARY KEY

event\_id        UUID NOT NULL REFERENCES webhook\_events(id)



attempt         INTEGER NOT NULL

http\_status     INTEGER NULL

error           TEXT NULL



next\_retry\_at   TIMESTAMPTZ NULL

created\_at      TIMESTAMPTZ NOT NULL

```



This gives operational visibility into webhook retries.



\---



\# 29. Webhook Transaction



When the session reaches a final outcome:



```text

BEGIN



UPDATE sessions

SET verdict = 'APPROVED',

&#x20;   status = 'APPROVED'



INSERT billing\_entries



INSERT webhook\_events



COMMIT

```



The webhook is sent asynchronously after the transaction succeeds.



This prevents:



```text

Database updated

but webhook event lost

```



\---



\# 30. `tenant\_byoc\_configs`



For the MVP, only one storage provider is required, but the schema should prepare for BYOC.



\### Columns



```text

id              UUID PRIMARY KEY

tenant\_id       UUID UNIQUE NOT NULL REFERENCES tenants(id)



provider        TEXT NOT NULL

region          TEXT NOT NULL

bucket          TEXT NOT NULL

prefix          TEXT NULL



auth\_kind       TEXT NOT NULL

secret\_ref      TEXT NULL



probe\_ok\_at     TIMESTAMPTZ NULL



created\_at      TIMESTAMPTZ NOT NULL

updated\_at      TIMESTAMPTZ NOT NULL

```



\### Provider



```text

S3

```



Later:



```text

GCS

AZURE

```



\---



\# 31. BYOC Security



Never store cloud credentials directly in the database.



Store only:



```text

secret\_ref

```



Example:



```text

kms/tenants/tenant-123/byoc

```



The application retrieves the actual secret through secure infrastructure.



\---



\# 32. What Is Deliberately NOT a PostgreSQL Table



The MVP should not create tables for:



```text

video\_frames

gps\_locations

face\_embeddings

face\_images

ocr\_fields

ai\_frame\_results

livekit\_participants

redis\_queue

agent\_heartbeat

```



These either belong in:



```text

Redis

Object Storage

External Systems

```



or do not need durable storage at all.



\---



\# 33. Redis Data Model



Redis is separate from PostgreSQL.



\## 33.1 Queue



```text

queue:{tenant\_id}:{language}

```



Type:



```text

SORTED SET

```



Member:



```text

session\_id

```



Score:



```text

enqueue\_timestamp

```



Example:



```text

queue:tenant1:en



sessionA → 1756290100000

sessionB → 1756290200000

sessionC → 1756290300000

```



\---



\# 34. Agent Presence



Key:



```text

agent:presence:{agent\_id}

```



Type:



```text

HASH

```



Example:



```text

status = AVAILABLE

languages = \["en", "hi"]

last\_seen = 1756290300

```



TTL:



```text

15 seconds

```



The agent refreshes its heartbeat periodically.



If the key expires:



```text

Agent = unavailable

```



\---



\# 35. Session Hot Data



Key:



```text

session:hot:{session\_id}

```



Possible temporary values:



```text

agent\_id

ip\_country

gps\_latitude

gps\_longitude

gps\_accuracy

last\_location\_timestamp

```



This data exists only while required by the workflow.



Use a strict TTL.



Do not treat this key as the business source of truth.



\---



\# 36. AI HUD



Key:



```text

session:hud:{session\_id}

```



Example:



```text

liveness\_score = 97

liveness\_status = LIVE

face\_match\_score = 95

ocr\_status = PASS

updated\_at = ...

```



TTL:



```text

24 hours maximum

```



The HUD is temporary and can be reconstructed/expired.



\---



\# 37. Session Lock



Optional short-lived key:



```text

lock:session:{session\_id}

```



Used only when necessary for coordination.



It must not replace PostgreSQL's authoritative state transition.



Database-level atomicity remains the final protection.



\---



\# 38. Redis Pub/Sub



For near-real-time AI updates:



```text

hud:{session\_id}

```



can be used as a Redis pub/sub channel.



Flow:



```text

AI

&#x20;|

&#x20;v

Redis

&#x20;|

&#x20;v

WebSocket Gateway

&#x20;|

&#x20;v

Agent Browser

```



Pub/sub messages are ephemeral.



If the browser misses one, it can fetch the current session/HUD state again.



\---



\# 39. Redis TTL Policy



Recommended MVP TTLs:



| Key              |                        TTL |

| ---------------- | -------------------------: |

| Agent presence   |                     15 sec |

| Session hot data |                  ≤24 hours |

| AI HUD           |                  ≤24 hours |

| Session locks    |                  10–30 sec |

| Queue membership | Until session leaves queue |



TTL is a safety mechanism, not the primary cleanup mechanism for business state.



\---



\# 40. Object Storage Layout



\## Temporary Platform Storage



```text

raw/{tenant\_id}/{session\_id}.mp4

wm/{tenant\_id}/{session\_id}.mp4

audit/{tenant\_id}/{session\_id}.json

```



These objects are temporary.



For MVP:



```text

Maximum retention = 24 hours

```



\---



\## Enterprise Storage



```text

vcip/{yyyy}/{mm}/{dd}/{session\_id}/video.mp4

vcip/{yyyy}/{mm}/{dd}/{session\_id}/audit.json

vcip/{yyyy}/{mm}/{dd}/{session\_id}/audit.sig

```



The enterprise owns the final evidence.



\---



\# 41. Data Lifecycle



A typical session's data lifecycle:



```text

CREATE

&#x20; |

&#x20; v

PostgreSQL

(session)

&#x20; |

&#x20; v

Redis

(queue / hot state / AI HUD)

&#x20; |

&#x20; v

LiveKit

(video)

&#x20; |

&#x20; v

Temporary S3

(raw recording)

&#x20; |

&#x20; v

Egress

&#x20; |

&#x20; +--> Watermarked video

&#x20; +--> Audit JSON

&#x20; +--> Signature

&#x20; |

&#x20; v

Enterprise S3

&#x20; |

&#x20; v

Webhook

&#x20; |

&#x20; v

Delete temporary platform data

```



\---



\# 42. Session Creation Transaction



When creating a session:



```text

BEGIN



Validate tenant



Create session

status = CREATED



Create SESSION\_CREATED event



COMMIT

```



The API then returns the new session ID and customer session token.



\---



\# 43. Queue Transaction



When entering the queue:



```text

BEGIN



Lock/check session



Verify:

\- consent passed

\- preflight passed

\- geo passed

\- status = CREATED



Update session:

status = QUEUED

queued\_at = now()



Create SESSION\_QUEUED event



COMMIT



Add session to Redis queue

```



If Redis queue insertion fails after the DB transaction succeeds, the system needs reconciliation/retry logic.



The session remains `QUEUED` in PostgreSQL until the queue operation is successfully reflected in Redis.



For MVP, retrying the Redis enqueue is sufficient.



\---



\# 44. Agent Claim and Accept Transactions [UPDATED]

Two steps, each a single-winner conditional update. See D4 and D5.

## 44.1 Claim (QUEUED -> OFFERED)

```sql
UPDATE sessions
   SET status = 'OFFERED',
       offered_to_agent_id = :agent_id,
       offered_at = now(),
       offer_expires_at = now() + (:offer_timeout_seconds * interval '1 second'),
       version = version + 1
 WHERE id = :session_id
   AND tenant_id = :tenant_id
   AND status = 'QUEUED';
```

Zero affected rows -> reject with 409. Then append `SESSION_OFFERED`.

## 44.2 Accept (OFFERED -> IN_CALL)

```sql
UPDATE sessions
   SET status = 'IN_CALL',
       agent_id = :agent_id,
       connected_at = now(),
       offer_expires_at = NULL,
       version = version + 1
 WHERE id = :session_id
   AND tenant_id = :tenant_id
   AND status = 'OFFERED'
   AND offered_to_agent_id = :agent_id
   AND offer_expires_at > now();
```

Zero affected rows -> reject with 409. Then append `SESSION_ASSIGNED` and
`AGENT_ACCEPTED`.

## 44.3 Offer expiry sweeper (OFFERED -> QUEUED)

```sql
UPDATE sessions
   SET status = 'QUEUED',
       offered_to_agent_id = NULL,
       offered_at = NULL,
       offer_expires_at = NULL,
       version = version + 1
 WHERE status = 'OFFERED'
   AND offer_expires_at <= now();
```

Not a billable event. Re-enqueue in Redis preserving the original queue score so
the customer does not lose their place.

\# 45. Verdict Transaction [UPDATED]

Verdict submission is the most important transaction. It is single-winner: the
first valid terminal transition commits and any later conflicting transition
returns 409. See D17.

```text
BEGIN

  UPDATE sessions
     SET status = :verdict,
         verdict = :verdict,
         verdict_at = now(),
         ended_at = now(),
         bill_category = :category,
         bill_amount_paise = :amount,
         export_status = 'EXPORTING',
         version = version + 1
   WHERE id = :session_id
     AND tenant_id = :tenant_id
     AND status = 'IN_CALL'
     AND agent_id = :agent_id
     AND verdict IS NULL;

  If affected rows = 0 -> abort, return 409

  Validate required checklist items are checked
  Upsert session_checklist_items
  Snapshot Redis HUD -> session_ai_summaries
  INSERT billing_entries        (PK session_id, enforces one row)
  INSERT session_events         (VERDICT_SUBMITTED, BILLING_CREATED)
  INSERT webhook_events         (outbox, PENDING)

COMMIT
```

The same guard shape protects the disconnect path
(`DROPPED_IN_CALL`) and the abort path (`ABORTED`), so a verdict racing a
disconnect produces exactly one terminal outcome and one billing row.

Export and webhook delivery proceed independently after the commit. Neither can
reverse billing. See D16.

\# 46. Why Billing and Session Should Be in One Transaction



We do not want:



```text

Session = APPROVED

Billing = missing

```



or:



```text

Billing = ₹25

Session = still IN\_CALL

```



The transaction guarantees:



```text

Session outcome

\+

Billing

\+

Event

\+

Webhook outbox

```



are committed together.



\---



\# 47. Database Concurrency Strategy



The MVP uses:



```text

PostgreSQL transactions

\+

row-level locking / conditional updates

\+

unique constraints

```



Do not rely entirely on Redis locks.



Important concurrency points:



\### Agent accept



Only one agent wins.



\### Verdict



Only one final verdict wins.



\### Billing



Only one billing record can exist.



\### Webhook



Outbox prevents event loss.



\---



\# 48. Optimistic Locking



The `sessions.version` field is used for optimistic concurrency where appropriate.



Example:



```text

Current version = 4

```



Update:



```sql

UPDATE sessions

SET

&#x20;   status = 'IN\_CALL',

&#x20;   version = version + 1

WHERE

&#x20;   id = $1

&#x20;   AND version = 4;

```



If zero rows are updated, another request changed the session.



The application returns:



```text

409 Conflict

```



This is useful for frontend retries and concurrent operations.



\---



\# 49. Tenant Query Rule



Every tenant-scoped query should follow this pattern:



```sql

SELECT \*

FROM sessions

WHERE id = $1

&#x20; AND tenant\_id = $2;

```



Never:



```sql

SELECT \*

FROM sessions

WHERE id = $1;

```



unless the operation is explicitly performed in a trusted internal context where tenant ownership has already been established.



\---



\# 50. Foreign Key Strategy



Use foreign keys for business relationships.



Examples:



```text

sessions.tenant\_id

&#x20;   → tenants.id



sessions.agent\_id

&#x20;   → users.id



session\_events.session\_id

&#x20;   → sessions.id



billing\_entries.session\_id

&#x20;   → sessions.id

```



Do not use cascading deletes for financial/audit history.



\---



\# 51. Deletion Policy



Do not physically delete:



```text

billing\_entries

session\_events

```



as part of ordinary application behavior.



For tenant/user lifecycle operations:



```text

disable / suspend

```



is preferred over destructive deletion.



The permanent audit trail must remain consistent.



\---



\# 52. Timestamp Policy



Store all timestamps as:



```text

TIMESTAMPTZ

```



and write them in UTC.



Example:



```text

2026-08-27T10:30:00Z

```



The UI can convert timestamps to IST.



Do not store separate local-time values as the authoritative timestamp.



\---



\# 53. Sensitive Data Policy



\### PostgreSQL



Allowed:



```text

session\_id

tenant\_id

status

verdict

billing

AI summary

timestamps

```



Avoid:



```text

GPS coordinates

raw IP

face image

face embedding

raw document

raw video

full OCR text

```



\### Redis



Temporary sensitive operational data may exist with strict TTL.



\### Object Storage



Contains video/evidence only as required for processing/export.



\### Enterprise Vault



Long-term storage of final evidence.



\---



\# 54. Database Backup



For MVP:



PostgreSQL should be backed up.



Backup:



```text

tenants

users

sessions

events

billing

exports

webhook state

```



Do not use PostgreSQL backup as the mechanism for storing temporary video/GPS data.



Temporary media belongs in object storage with controlled lifecycle policies.



\---



\# 55. Migration Strategy



Use a proper migration tool.



Recommended with NestJS:



```text

Prisma Migrate

```



or:



```text

Drizzle migrations

```



Choose one and use it consistently.



Never manually modify production schema without a migration.



Every schema change should be version-controlled.



\---



\# 56. Recommended MVP Database



The minimum durable PostgreSQL model is:



```text

tenants

users

agent\_profiles

tenant\_api\_keys



checklist\_templates



sessions

session\_events

session\_checklist\_items

session\_ai\_summaries



billing\_entries

exports



tenant\_byoc\_configs



webhook\_endpoints

webhook\_events

webhook\_deliveries

```



This is enough for the MVP.



\---



\# 57. What Should Stay Out of the Database



Do not create unnecessary tables just because a concept exists in the system.



For example, the following do not need durable tables in the MVP:



```text

queue\_positions

agent\_heartbeats

video\_frames

ai\_frame\_results

livekit\_rooms

livekit\_participants

gps\_history

face\_embeddings

```



These are either:



\* derived data

\* temporary data

\* external-system state

\* high-frequency telemetry



\---



\# 58. Final Data Architecture



```text

&#x20;                       +--------------------+

&#x20;                       |    PostgreSQL      |

&#x20;                       |--------------------|

&#x20;                       | tenants            |

&#x20;                       | users              |

&#x20;                       | sessions           |

&#x20;                       | events             |

&#x20;                       | checklist          |

&#x20;                       | AI summaries       |

&#x20;                       | billing            |

&#x20;                       | exports            |

&#x20;                       | webhooks           |

&#x20;                       +---------+----------+

&#x20;                                 |

&#x20;                                 |

&#x20;                   Durable Business State

&#x20;                                 |

&#x20;            +--------------------+-------------------+

&#x20;            |                                        |

&#x20;            v                                        v

&#x20;       +-----------+                           +-------------+

&#x20;       |   Redis   |                           | Object S3  |

&#x20;       |-----------|                           |-------------|

&#x20;       | Queue     |                           | Raw video   |

&#x20;       | Presence  |                           | WM video    |

&#x20;       | HUD       |                           | Audit JSON  |

&#x20;       | Hot data  |                           | Signature   |

&#x20;       +-----------+                           +-------------+

&#x20;            |                                        |

&#x20;            |                                        |

&#x20;       Temporary state                          Media/evidence

&#x20;            |                                        |

&#x20;            +----------------+-----------------------+

&#x20;                             |

&#x20;                             v

&#x20;                      Enterprise Vault

```



\---



\# 59. Database Invariants



These rules must always hold.



\### Invariant 1



Every tenant-owned record belongs to exactly one tenant.



\### Invariant 2



A session has at most one assigned agent.



\### Invariant 3



A session has at most one final verdict.



\### Invariant 4



A session has at most one billing entry.



\### Invariant 5



A preflight-failed session has no billing entry.



\### Invariant 6



An approved session is billed ₹25 unless a future tenant-specific pricing model explicitly changes this.



\### Invariant 7



Every post-queue non-approved terminal outcome is billed ₹5.



\### Invariant 8



`session\_events` are append-only.



\### Invariant 9



Billing records are never silently deleted.



\### Invariant 10



PostgreSQL is authoritative for business state.



\### Invariant 11



Redis data is temporary and reconstructable where possible.



\### Invariant 12



Video is never stored inside PostgreSQL.



\---



\# 60. Database Design Summary



The MVP database has a simple responsibility split:



```text

PostgreSQL

&#x20;   =

"What officially happened?"



Redis

&#x20;   =

"What is happening right now?"



Object Storage

&#x20;   =

"What media/evidence files exist?"



Enterprise Storage

&#x20;   =

"What evidence does the enterprise permanently retain?"

```



The most important table is:



```text

sessions

```



because it represents the current state of each V-CIP verification.



The most important supporting tables are:



```text

session\_events

billing\_entries

exports

webhook\_events

```



Together they provide:



```text

Current state

\+

Historical state

\+

Money

\+

Evidence

\+

Enterprise notification

```



This database design is the durable data foundation for the V-CIP MVP.



