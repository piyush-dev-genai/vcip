\# V-CIP MVP — API Design

> **Approved decisions live in `docs/00-decisions.md`.**
> Where this document conflicts with that decision record, the decision record wins.
> Sections updated by the approved decisions are marked `[UPDATED]`.



\## 1. Purpose



This document defines the API contracts for the V-CIP MVP.



The API connects:



\* Enterprise backend

\* Customer application

\* Agent portal

\* AI service

\* Egress worker



The API is responsible for:



\* Authentication

\* Session management

\* Consent

\* Preflight

\* Location validation

\* Queueing

\* Agent assignment

\* LiveKit token generation

\* Verdict

\* Billing

\* Export status

\* Webhooks



The API does not carry the actual video stream. Video is handled by LiveKit/WebRTC.



\---



\# 2. API Principles



\### 2.1 Versioning



All public APIs use:



```text

/v1

```



Example:



```text

POST /v1/sessions

```



\---



\### 2.2 JSON



Requests and responses use:



```http

Content-Type: application/json

```



\---



\### 2.3 IDs



All resources use UUIDs unless explicitly specified otherwise.



Example:



```json

{

&#x20; "session\_id": "550e8400-e29b-41d4-a716-446655440000"

}

```



\---



\### 2.4 Server Is the Source of Truth



Clients cannot directly modify:



\* Session status

\* Agent assignment

\* Billing

\* Verdict

\* Export status



These are controlled by the backend.



\---



\# 3. Authentication



There are two main authentication contexts.



\## 3.1 Enterprise API Key



Used by the enterprise backend to create/manage customer sessions.



```http

Authorization: Bearer <tenant\_api\_key>

```



The enterprise API key must not be exposed inside a public customer browser/mobile application.



\---



\## 3.2 Customer Session Token



After the enterprise creates a session, the backend provides a short-lived customer session token.



```http

Authorization: Bearer <customer\_session\_token>

```



The token is:



\* Short lived

\* Bound to one `session\_id`

\* Restricted to customer operations



A customer token cannot:



\* Access another session

\* Access agent APIs

\* Submit a verdict

\* Access tenant configuration



\---



\## 3.3 Agent JWT



Agents use:



```http

Authorization: Bearer <agent\_jwt>

```



The JWT contains:



```text

user\_id

tenant\_id

role

expires\_at

```



Roles for MVP:



```text

agent

tenant\_admin

```



\---



\# 4. Common Headers



Recommended headers:



```http

Authorization: Bearer <token>

Content-Type: application/json

X-Request-Id: <uuid>

Idempotency-Key: <unique-key>

```



`Idempotency-Key` is required for operations where duplicate execution could create an incorrect result.



\---



\# 5. Common Response Format



Successful response:



```json

{

&#x20; "data": {

&#x20;   "session\_id": "..."

&#x20; }

}

```



For simple endpoints, `data` may directly contain the resource.



\---



\# 6. Common Error Format



All API errors follow:



```json

{

&#x20; "error": {

&#x20;   "code": "SESSION\_INVALID\_STATE",

&#x20;   "message": "Session cannot be accepted in its current state.",

&#x20;   "request\_id": "req-123"

&#x20; }

}

```



Example HTTP statuses:



| Status | Meaning                              |

| ------ | ------------------------------------ |

| 400    | Invalid request                      |

| 401    | Authentication required/invalid      |

| 403    | Not authorized                       |

| 404    | Resource not found                   |

| 409    | State conflict / duplicate operation |

| 422    | Business validation failed           |

| 429    | Rate limited                         |

| 500    | Internal error                       |

| 503    | Temporary service unavailable        |



\---



\# 7. Customer APIs



\## 7.1 Create Session



\### Endpoint



```http

POST /v1/sessions

```



\### Authentication



Enterprise API key.



\### Purpose



Creates a new V-CIP session.



\### Request



```json

{

&#x20; "external\_ref": "loan-12345",

&#x20; "language": "en"

}

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "CREATED",

&#x20;   "customer\_token": "short-lived-token"

&#x20; }

}

```



\### Side Effects



Creates:



```text

Session

Session Event: CREATED

```



\### Initial State



```text

CREATED

```



\---



\# 8. Submit Consent



\### Endpoint



```http

POST /v1/sessions/{session\_id}/consent

```



\### Authentication



Customer session token.



\### Request



```json

{

&#x20; "accepted": true,

&#x20; "consent\_version": "v1"

}

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "consent\_ok": true,

&#x20;   "status": "CREATED"

&#x20; }

}

```



\### Validation



Consent must be accepted before queueing.



If:



```text

accepted = false

```



the customer cannot continue.



\---



\# 9. Submit Preflight [UPDATED]

### Endpoint

```http
POST /v1/sessions/{session_id}/preflight
```

### Authentication

Customer session token.

### Request

The payload carries **measured values**, not client verdicts. See D11.

```json
{
  "camera_width": 1280,
  "camera_height": 720,
  "microphone_level": 62.5,
  "network_rtt_ms": 48,
  "downlink_kbps": 4200,
  "lighting_score": 71.0,
  "stability_score": 88.0
}
```

### Validation

| Field | Type | Rule |
| --- | --- | --- |
| `camera_width` | integer | > 0 |
| `camera_height` | integer | > 0 |
| `microphone_level` | number | 0-100 |
| `network_rtt_ms` | integer | >= 0 |
| `downlink_kbps` | integer | >= 0 |
| `lighting_score` | number | 0-100 |
| `stability_score` | number | 0-100 |

### Server-side threshold evaluation

The server compares the measurements against tenant configuration and decides
`preflight_ok` itself:

```text
min(camera_width, camera_height) >= tenants.min_video_px
microphone_level                 >= tenants.min_mic_level
network_rtt_ms                   <= tenants.max_rtt_ms
downlink_kbps                    >= tenants.min_downlink_kbps
lighting_score                   >= tenants.min_lighting_score
stability_score                  >= tenants.min_stability_score
```

The client cannot assert that preflight passed.

### Response

Success:

```json
{
  "data": {
    "session_id": "session-uuid",
    "preflight_ok": true,
    "status": "CREATED"
  }
}
```

Failure:

```json
{
  "data": {
    "session_id": "session-uuid",
    "preflight_ok": false,
    "status": "PREFLIGHT_FAILED",
    "failed_checks": ["downlink_kbps", "lighting_score"]
  }
}
```

The measured values are recorded in the `PREFLIGHT_PASSED` / `PREFLIGHT_FAILED`
session event payload. They are not sensitive and are not stored as separate
columns.

\# 10. Submit Location



\### Endpoint



```http

POST /v1/sessions/{session\_id}/location

```



\### Authentication



Customer session token.



\### Request



```json

{

&#x20; "latitude": 28.6139,

&#x20; "longitude": 77.2090,

&#x20; "accuracy\_m": 25,

&#x20; "captured\_at": "2026-08-27T10:30:00Z"

}

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "geo\_ok": true,

&#x20;   "status": "CREATED"

&#x20; }

}

```



\### Rules



The backend validates:



\* GPS location

\* GPS accuracy

\* IP country



The permanent database stores only the required verification result.



Raw coordinates are temporary data.



\---



\# 11. Join Queue



\### Endpoint



```http

POST /v1/sessions/{session\_id}/queue

```



\### Authentication



Customer session token.



\### Headers



```http

Idempotency-Key: <unique-key>

```



\### Preconditions



All required gates must pass:



```text

Consent = PASS

Preflight = PASS

Location = PASS

```



\### State Transition



```text

CREATED → QUEUED

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "QUEUED",

&#x20;   "queue\_position": 3

&#x20; }

}

```



\### Failure



If gates are incomplete:



```json

{

&#x20; "error": {

&#x20;   "code": "SESSION\_NOT\_ELIGIBLE\_FOR\_QUEUE",

&#x20;   "message": "Consent, preflight and location validation are required."

&#x20; }

}

```



\---



\# 12. Get Session



\### Endpoint



```http

GET /v1/sessions/{session\_id}

```



\### Authentication



Customer session token or authorized agent JWT.



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "QUEUED",

&#x20;   "language": "en",

&#x20;   "queue\_position": 2,

&#x20;   "agent\_connected": false,

&#x20;   "verdict": null

&#x20; }

}

```



The endpoint provides polling fallback when WebSocket connectivity is unavailable.



\---



\# 13. Get Media Token



\### Endpoint



```http

GET /v1/sessions/{session\_id}/media-token

```



\### Authentication



Customer session token or authorized agent JWT.



\### Preconditions



Customer:



```text

QUEUED or IN\_CALL

```



Agent:



```text

IN\_CALL

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "room\_name": "vcip\_session\_uuid",

&#x20;   "token": "livekit-token",

&#x20;   "expires\_at": "2026-08-27T11:00:00Z"

&#x20; }

}

```



The token must be:



\* Short-lived

\* Bound to the specific room

\* Bound to the caller's role



The API does not return another participant's credentials.



\---



\# 14. Abort Session



\### Endpoint



```http

POST /v1/sessions/{session\_id}/abort

```



\### Authentication



Customer session token.



\### Headers



```http

Idempotency-Key: <unique-key>

```



\### Allowed States



```text

QUEUED

IN\_CALL

```



\### Queue Abort



```text

QUEUED → DROPPED\_QUEUED

```



Billing:



```text

₹5

```



\### In-call Abort



```text

IN\_CALL → ABORTED

```



Billing:



```text

₹5

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "ABORTED",

&#x20;   "bill\_amount\_paise": 500

&#x20; }

}

```



\---



\# 15. Agent APIs



\## 15.1 Agent Availability



\### Endpoint



```http

POST /v1/agent/availability

```



\### Authentication



Agent JWT.



\### Request



```json

{

&#x20; "status": "AVAILABLE"

}

```



Allowed values:



```text

AVAILABLE

UNAVAILABLE

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "agent\_id": "agent-uuid",

&#x20;   "status": "AVAILABLE"

&#x20; }

}

```



Agent availability is temporary state and is maintained in Redis.



\---



\# 16. Agent Queue



\### Endpoint



```http

GET /v1/agent/queue

```



\### Authentication



Agent JWT.



\### Response



```json

{

&#x20; "data": {

&#x20;   "sessions": \[

&#x20;     {

&#x20;       "session\_id": "session-1",

&#x20;       "language": "en",

&#x20;       "priority": 1,

&#x20;       "queued\_at": "2026-08-27T10:30:00Z",

&#x20;       "wait\_seconds": 32

&#x20;     }

&#x20;   ]

&#x20; }

}

```



The response must not expose unnecessary customer PII.



\---



\# 17. Claim and Accept Session [UPDATED]

The MVP uses pull-claim with an explicit `OFFERED` state. See D4 and D5.

\## 17.1 Claim Session

```http
POST /v1/agent/sessions/{session_id}/claim
```

Authentication: Agent JWT.
Headers: `Idempotency-Key: <unique-key>`

### Preconditions

```text
Session = QUEUED
Agent   = AVAILABLE
Agent is eligible for session (tenant, language, max_concurrent)
```

### State Transition

```text
QUEUED -> OFFERED
```

Implemented as a single conditional update. Zero affected rows means another
agent won.

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

### Response

```json
{
  "data": {
    "session_id": "session-uuid",
    "status": "OFFERED",
    "offered_to_agent_id": "agent-uuid",
    "offer_expires_at": "2026-08-27T10:31:00Z"
  }
}
```

### Concurrent Claim

```http
409 Conflict
```

```json
{
  "error": {
    "code": "SESSION_ALREADY_ASSIGNED",
    "message": "The session has already been claimed by another agent."
  }
}
```

\---

\## 17.2 Accept Session

```http
POST /v1/agent/sessions/{session_id}/accept
```

Authentication: Agent JWT.
Headers: `Idempotency-Key: <unique-key>`

### Preconditions

```text
Session = OFFERED
offered_to_agent_id = calling agent
offer has not expired
```

### State Transition

```text
OFFERED -> IN_CALL
```

### Side Effects

1. Assigns `agent_id`
2. Marks agent presence BUSY
3. Opens the LiveKit room
4. Sets `connected_at`
5. Emits `session.assigned`
6. Emits `agent.joined` when the participant actually joins (via LiveKit webhook)
7. Starts recording

### Response

```json
{
  "data": {
    "session_id": "session-uuid",
    "status": "IN_CALL",
    "agent_id": "agent-uuid",
    "room_name": "vcip_session_uuid"
  }
}
```

\---

\## 17.3 Offer Expiry

If the offer is not accepted within `tenants.offer_timeout_seconds`, a sweeper
returns the session to the queue:

```text
OFFERED -> QUEUED
```

`offered_to_agent_id` and `offered_at` are cleared, and
`session.offer_expired` is emitted to the agent. This is not a billable event.

Automatic reassignment to a different agent is not implemented in the MVP.

\# 18. Submit Verdict



\### Endpoint



```http

POST /v1/agent/sessions/{session\_id}/verdict

```



\### Authentication



Agent JWT.



\### Headers



```http

Idempotency-Key: <unique-key>

```



\### Request



```json

{

&#x20; "verdict": "APPROVED",

&#x20; "checklist": \[

&#x20;   {

&#x20;     "key": "face\_visible",

&#x20;     "checked": true

&#x20;   },

&#x20;   {

&#x20;     "key": "document\_shown",

&#x20;     "checked": true

&#x20;   },

&#x20;   {

&#x20;     "key": "customer\_verified",

&#x20;     "checked": true

&#x20;   }

&#x20; ]

}

```



Allowed verdicts:



```text

APPROVED

REJECTED

ABORTED

```



\### Preconditions



```text

Session = IN\_CALL

Agent = assigned agent

Required checklist items = checked

```



\### State Transition



```text

IN\_CALL → APPROVED

IN\_CALL → REJECTED

IN\_CALL → ABORTED

```



\### Billing



```text

APPROVED → ₹25

REJECTED → ₹5

ABORTED → ₹5

```



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "APPROVED",

&#x20;   "verdict": "APPROVED",

&#x20;   "bill\_category": "SUCCESS",

&#x20;   "bill\_amount\_paise": 2500

&#x20; }

}

```



\---



\# 19. WebSocket API



\## 19.1 Connection



```text

GET /v1/ws

```



Authentication is performed using an appropriate short-lived token.



The connection is scoped to:



```text

tenant\_id

user/session identity

```



\---



\## 19.2 Customer Events



\### `queue.position`



```json

{

&#x20; "event": "queue.position",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "position": 2

&#x20; }

}

```



\### `session.assigned`



```json

{

&#x20; "event": "session.assigned",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid"

&#x20; }

}

```



\### `agent.joined`



```json

{

&#x20; "event": "agent.joined",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid"

&#x20; }

}

```



\### `session.updated`



```json

{

&#x20; "event": "session.updated",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "status": "IN\_CALL"

&#x20; }

}

```



\### `session.completed`



```json

{

&#x20; "event": "session.completed",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "verdict": "APPROVED"

&#x20; }

}

```



\---



\## 19.3 Agent Events



\### `queue.new\_session`



```json

{

&#x20; "event": "queue.new\_session",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid"

&#x20; }

}

```



\### `ai.updated`



```json

{

&#x20; "event": "ai.updated",

&#x20; "data": {

&#x20;   "session\_id": "session-uuid",

&#x20;   "liveness\_score": 97,

&#x20;   "liveness\_status": "LIVE",

&#x20;   "face\_match\_score": 95,

&#x20;   "ocr\_status": "PASS"

&#x20; }

}

```



AI events must not contain images or raw document content.



\---



\# 20. Webhook Contract



The webhook is sent to the enterprise backend after successful evidence export.



\### Endpoint



Configured by the enterprise.



Example:



```http

POST https://enterprise.example.com/webhooks/vcip

```



\### Event



```text

session.completed

```



\### Payload [UPDATED]

On successful export:

```json
{
  "event": "session.completed",
  "session_id": "session-uuid",
  "external_ref": "loan-12345",
  "verdict": "APPROVED",
  "bill_category": "SUCCESS",
  "bill_amount_paise": 2500,
  "evidence_available": true,
  "video_key": "vcip/2026/08/27/session-uuid/video.mp4",
  "audit_key": "vcip/2026/08/27/session-uuid/audit.json",
  "signature_key": "vcip/2026/08/27/session-uuid/audit.sig",
  "occurred_at": "2026-08-27T10:35:00Z"
}
```

On permanent export failure (`export_status = FAILED`, retries exhausted) the
enterprise is still notified. The verdict and billing remain valid. See D22.

```json
{
  "event": "session.completed",
  "session_id": "session-uuid",
  "external_ref": "loan-12345",
  "verdict": "APPROVED",
  "bill_category": "SUCCESS",
  "bill_amount_paise": 2500,
  "evidence_available": false,
  "video_key": null,
  "audit_key": null,
  "signature_key": null,
  "occurred_at": "2026-08-27T10:35:00Z"
}
```

`evidence_available` is always present. Evidence keys are present only when
it is `true`.
The webhook does not contain:



\* Video bytes

\* Face images

\* GPS coordinates

\* Aadhaar

\* PAN

\* Full OCR text



\---



\# 21. Webhook Security



Each webhook contains an HMAC signature.



Example:



```http

X-V-CIP-Signature: <hmac>

```



The signature is calculated over the raw request body.



The enterprise verifies the signature using the webhook secret.



\---



\# 22. Webhook Reliability



Webhook delivery is at-least-once.

\### Ordering relative to export [UPDATED]

The outbox row is created inside the verdict transaction, so it can never be
lost. It is not delivered until the session's export state resolves:

```text
verdict tx  -> webhook_events PENDING, payload without evidence keys
export done -> payload enriched (EXPORTED) or marked
               evidence_available:false (FAILED)
            -> event becomes eligible for delivery
delivery    -> DELIVERED | DEAD
```

Statuses remain PENDING, DELIVERED, DEAD. Delivery never blocks cleanup.
See D21 and D22.



If delivery fails:



```text

pending

&#x20;  ↓

retry

&#x20;  ↓

retry

&#x20;  ↓

retry

&#x20;  ↓

delivered

```



If all retries are exhausted:



```text

dead

```



Duplicate webhook delivery is possible.



The enterprise should treat `session\_id + event` as an idempotency key.



\---



\# 23. Internal AI API



These endpoints are internal and are not exposed to customers.



\## AI Result



```http

POST /internal/ai/result

```



Request:



```json

{

&#x20; "session\_id": "session-uuid",

&#x20; "liveness\_score": 97,

&#x20; "liveness\_status": "LIVE",

&#x20; "face\_match\_score": 95,

&#x20; "ocr\_status": "PASS"

}

```



The Control API stores the relevant summary and publishes an AI update to the agent.



The internal API must be authenticated.



\---



\# 24. Internal Egress API



\## Egress Completed



```http

POST /internal/egress/completed

```



Request:



```json

{

&#x20; "session\_id": "session-uuid",

&#x20; "video\_key": "wm/session-uuid.mp4",

&#x20; "audit\_key": "audit/session-uuid.json",

&#x20; "signature\_key": "audit/session-uuid.sig",

&#x20; "video\_sha256": "...",

&#x20; "audit\_sha256": "..."

}

```



The Control API updates export state.



\---



\# 25. API-to-State Mapping



| API                                | State Change                                     |

| ---------------------------------- | ------------------------------------------------ |

| `POST /sessions`                   | → `CREATED`                                      |

| `POST /sessions/:id/consent`       | Consent recorded                                 |

| `POST /sessions/:id/preflight`     | → `PREFLIGHT\_FAILED` on failure                  |

| `POST /sessions/:id/location`      | Location eligibility recorded                    |

| `POST /sessions/:id/queue`         | `CREATED → QUEUED`                               |

| `POST /agent/sessions/:id/claim`   | `QUEUED → OFFERED`                               |

| `POST /agent/sessions/:id/accept`  | `OFFERED → IN\_CALL`                              |

| offer timeout sweeper              | `OFFERED → QUEUED`                               |

| `POST /sessions/:id/abort`         | `QUEUED → DROPPED\_QUEUED` or `IN\_CALL → ABORTED` |

| `POST /agent/sessions/:id/verdict` | `IN\_CALL → APPROVED/REJECTED/ABORTED`            |

| Egress completion                  | → `EXPORTED`                                     |

| Cleanup                            | → `PURGED`                                       |



Unexpected state transitions must return `409 Conflict`.



\---



\# 26. Idempotency



Idempotency prevents retries from causing duplicate business actions.



The following APIs must support idempotency:



```text

POST /v1/sessions

POST /v1/sessions/{id}/queue

POST /v1/sessions/{id}/abort

POST /v1/agent/sessions/{id}/accept

POST /v1/agent/sessions/{id}/verdict

```



The client sends:



```http

Idempotency-Key: 2fa0c5b5-...

```



The backend stores the result associated with the key in **Redis with a 24-hour
TTL**, keyed `idem:{actor}:{endpoint}:{key}`. See D13.

Redis is a convenience layer only. Business invariants remain protected by
PostgreSQL regardless of Redis state: billing is unique by `session_id`, agent
claim is a conditional update, and verdict is a single-winner conditional update.

The idempotent endpoint list is:

```text
POST /v1/sessions
POST /v1/sessions/{id}/queue
POST /v1/sessions/{id}/abort
POST /v1/agent/sessions/{id}/claim
POST /v1/agent/sessions/{id}/accept
POST /v1/agent/sessions/{id}/verdict
```




If the same request is retried:



```text

Same key

\+

Same endpoint

\+

Same authenticated actor

```



the backend returns the original result instead of performing the operation again.



\---



\# 27. Authorization Rules



\### Customer [UPDATED]

```text
POST /v1/sessions
POST /v1/sessions/:id/consent
POST /v1/sessions/:id/preflight
POST /v1/sessions/:id/location
POST /v1/sessions/:id/queue
GET  /v1/sessions/:id
GET  /v1/sessions/:id/media-token
POST /v1/sessions/:id/abort
POST /v1/sessions/:id/ws-token
```

## Agent

```text
POST /v1/agent/login
POST /v1/agent/availability
POST /v1/agent/heartbeat
GET  /v1/agent/queue
POST /v1/agent/sessions/:id/claim
POST /v1/agent/sessions/:id/accept
GET  /v1/agent/sessions/:id/checklist
POST /v1/agent/sessions/:id/verdict
GET  /v1/agent/sessions/:id/media-token
POST /v1/agent/ws-token
```

## WebSocket

```text
/v1/ws?token=<short-lived-connection-token>
```

Scoped to tenant plus session (customer) or user (agent). See D9.

## Internal

All require X-Internal-Token and are not publicly routed. See D10.

```text
POST /internal/ai/result
POST /internal/egress/completed
POST /internal/livekit/webhook
```
## Webhook



```text

POST enterprise webhook

```



\### Cleanup



```text

EXPORTED

&#x20;  |

&#x20;  v

PURGED

```



\---



\# 32. MVP API Checklist



The MVP API is complete when the following endpoints work:



\## Customer



```text

POST /v1/sessions

POST /v1/sessions/:id/consent

POST /v1/sessions/:id/preflight

POST /v1/sessions/:id/location

POST /v1/sessions/:id/queue

GET  /v1/sessions/:id

GET  /v1/sessions/:id/media-token

POST /v1/sessions/:id/abort

```



\## Agent



```text

POST /v1/agent/availability

GET  /v1/agent/queue

POST /v1/agent/sessions/:id/accept

POST /v1/agent/sessions/:id/verdict

GET  /v1/agent/sessions/:id/media-token

```



\## WebSocket



```text

/v1/ws

```



\## Internal



```text

POST /internal/ai/result

POST /internal/egress/completed

```



\## Webhook



```text

POST <tenant-configured-webhook-url>

```



\---



\# 33. API Design Rules for Implementation



The implementation must follow these rules:



1\. PostgreSQL is authoritative for business state.

2\. Redis is used for temporary/real-time state.

3\. Clients cannot directly modify session status.

4\. All session mutations validate the current state.

5\. Agent assignment must be atomic.

6\. Verdict submission must be idempotent.

7\. Billing must be idempotent.

8\. Customer tokens are session-scoped.

9\. Agent tokens are tenant-scoped and role-scoped.

10\. Webhook delivery is at-least-once.

11\. WebSocket events are notifications, not the source of truth.

12\. Video never passes through the Control API.

13\. Internal APIs require service authentication.

14\. Tenant ownership must be checked on every tenant-scoped operation.



\---



\# 34. API Design Summary



The API has four primary responsibilities:



```text

1\. Manage the V-CIP session

&#x20;       ↓

2\. Connect customer and agent

&#x20;       ↓

3\. Record the business outcome

&#x20;       ↓

4\. Deliver the final result

```



The complete request flow is:



```text

Enterprise

&#x20;   |

&#x20;   | Create Session

&#x20;   v

Control API

&#x20;   |

&#x20;   v

Customer Token

&#x20;   |

&#x20;   v

Customer

&#x20;   |

&#x20;   +---- Consent

&#x20;   +---- Preflight

&#x20;   +---- Location

&#x20;   +---- Queue

&#x20;   |

&#x20;   v

Agent

&#x20;   |

&#x20;   +---- Accept

&#x20;   |

&#x20;   v

LiveKit

&#x20;   |

&#x20;   v

AI

&#x20;   |

&#x20;   v

Agent Verdict

&#x20;   |

&#x20;   v

Billing + Export

&#x20;   |

&#x20;   v

Enterprise Webhook

```



This API design is the contract between the product flow and the implementation.



