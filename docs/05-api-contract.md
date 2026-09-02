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


A key is bound to the request it was first used for: the method, the endpoint,
the **resolved path parameters**, and the body. Presenting the same key for a
different request is `409 CONFLICT`, never a replay of the earlier answer.

The path parameters are part of that binding because three of the six protected
operations — queue, abort, and claim — carry an empty body and name their
resource only in the URL. Without them, one caller reusing a key across two
sessions was handed the first session's response with a `200`, while the
second session was never touched.



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



\## 15.1 Agent Login



\### Endpoint



```http

POST /v1/agent/login

```



\### Authentication



None. This is the route that mints an agent credential.



\### Request



```json

{

&#x20; "tenant\_slug": "demo-bank",

&#x20; "email": "agent1@example.com",

&#x20; "password": "..."

}

```



`tenant\_slug` is required because `users.email` is unique per tenant, not

globally — `users\_tenant\_email\_unique` is on `(tenant\_id, email)`, so an email

alone does not identify a user. The slug selects which tenant's users to look

in and grants nothing on its own; the password must still match a row that

belongs to that tenant. The tenant in the issued token comes from the matched

database row, never from the request.



\### Response



```json

{

&#x20; "data": {

&#x20;   "access\_token": "...",

&#x20;   "token\_type": "Bearer",

&#x20;   "expires\_at": "2026-08-31T21:00:00.000Z"

&#x20; }

}

```



`expires\_at` is ISO-8601 UTC and matches the token's `exp`. There is no refresh

token and no revocation: agent tokens are short-lived and stateless, as R8's

model is for the customer token.



\### Failure



Every rejection is the same `401 UNAUTHENTICATED` with the same message —

wrong password, unknown email, unknown tenant, disabled user, non-active

tenant, a user who is not an `AGENT`, and a user with no password. Since the

caller chooses the tenant slug, a distinguishable response would be a

cross-tenant user-enumeration oracle, which invariant I8 forbids.



Login does not change presence. The agent becomes available only by calling

`POST /v1/agent/availability`.



\---



\## 15.2 Agent Availability



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



\## 15.3 Agent Heartbeat



\### Endpoint



```http

POST /v1/agent/heartbeat

```



\### Authentication



Agent JWT.



\### Request



```json

{}

```



No fields. The agent is taken from the token; there is nothing for the client

to assert, and a body carrying `status`, `agent\_id`, or `languages` is

rejected with `400 VALIDATION\_ERROR` rather than silently ignored.



\### Response



```json

{

&#x20; "data": {

&#x20;   "agent\_id": "agent-uuid",

&#x20;   "status": "AVAILABLE",

&#x20;   "last\_seen": "2026-08-31T09:00:10.000Z"

&#x20; }

}

```



\### Behaviour



The heartbeat refreshes an **existing** presence's `last\_seen` and re-arms its

TTL. It never creates one and never writes `status`:



- an agent who chose `UNAVAILABLE` is not resurrected by a heartbeat still in

&#x20; flight,

- an agent the server has marked `BUSY` stays `BUSY`.



When there is no presence — the agent is unavailable, or the key expired — the

response is `200` with `status: "UNAVAILABLE"` and `last\_seen: null`, and no

key is created.



The TTL itself is not exposed. It is the liveness mechanism's own detail, and a

client that could read it would start making decisions with it.






\# 16. Agent Queue [UPDATED]

The queued sessions an agent could work. A read: it assigns nothing, offers
nothing, and changes no session, no queue, and no presence. Claiming is
section 17.

\### Endpoint

```http
GET /v1/agent/queue
```

No request body, no query parameters. The tenant, the agent, the eligible
languages, and the result bound are all derived by the server. A `tenant_id`
in the query string that disagrees with the token is rejected with `403
FORBIDDEN`; an `agent_id`, `language`, or `limit` is ignored.

\### Authentication

Agent JWT. A customer token, an enterprise API key, and the internal token are
each rejected with `401 UNAUTHENTICATED`.

A user who holds a valid agent JWT but has no `agent_profiles` row - a
`TENANT_ADMIN`, for instance - is rejected with `403 FORBIDDEN` rather than
given an empty list, because an empty list reads as "no customers waiting".

\### Eligibility

A session appears when **all** of the following hold:

- `sessions.tenant_id` equals the tenant in the JWT (invariant I8),
- `sessions.status` is exactly `QUEUED`,
- `sessions.language` is one of the calling agent&#x27;s `agent_profiles.languages`,
- and the session is currently a member of its queue in Redis.

Language comparison is case-insensitive on both sides: neither
`createSessionSchema` nor `agent_profiles.languages` normalises on write, and
the queue key is lower-cased. `en` and `en-IN` remain **different** queues (R13
shards by the language tag as given); an agent configured for `en` does not see
`en-IN`.

Presence is not a precondition. An agent may read the queue while `UNAVAILABLE`
- deciding whether to become available is exactly when they want to look.

\### Ordering and bounds

PostgreSQL is authoritative for whether a session is queued; Redis provides the
candidate set and the order (D1/D2).

For each of the agent&#x27;s languages the API reads the head of
`queue:{tenant_id}:{language}` - a sorted set scored by `queued_at` in
milliseconds - then merges the lists in application code. The merged list is
FIFO on `queued_at` across languages, never grouped by language; equal scores
break on `session_id`, which is the tiebreak Redis itself applies within one
queue.

At most **20** sessions are returned, and at most 20 candidates are read from
each language queue. The bound is a server constant; there is no page size and
no cursor.

`priority` is reported but does **not** order the list. MVP ordering is FIFO on
`queued_at` alone.

No queue position is returned. A session&#x27;s rank within one language queue is
not its position in a merged multi-language list, and reporting the former as
the latter would be reporting a wrong number.

\### Response

```json
{
  "data": {
    "sessions": [
      {
        "session_id": "session-1",
        "language": "en",
        "priority": 1,
        "queued_at": "2026-08-27T10:30:00Z",
        "wait_seconds": 32
      }
    ]
  }
}
```

Exactly these five fields. No `external_ref`, no customer identifier, no
consent, geo, or IP data, and no queue position - the response must not expose
unnecessary customer PII.

`wait_seconds` is derived from the server clock as `max(0, now - queued_at)`,
floored to whole seconds. It is stored nowhere and never supplied by a client,
so two calls a second apart legitimately return different values.

An empty queue is `{"data": {"sessions": []}}` with status `200`, not a `404`.

\### Stale queue members

A session that leaves `QUEUED` may remain in the Redis sorted set until a later
task removes it. Such a member is never returned: every candidate id is
confirmed against PostgreSQL in one bounded query before it reaches the
response, and a member with no row, a row in another tenant, or a row in any
status but `QUEUED` is dropped. This endpoint does not remove it either - it
writes nothing.

The converse gap is accepted and visible: a session that is `QUEUED` in
PostgreSQL but missing from Redis does **not** appear here. Section 15&#x27;s lazy
reconciliation repairs that on the customer&#x27;s next status read, because
repairing it here would mean performing a Redis write on a `GET`.

\### Side effects

None. This endpoint does not claim, offer, or assign a session; does not set or
clear `BUSY`; does not change a session&#x27;s `version` or status; does not append
a `session_events` row; does not create a billing entry; and does not add,
remove, or re-score a queue member.

\---

\# 17. Claim and Accept Session [UPDATED]

The MVP uses pull-claim with an explicit `OFFERED` state. See D4 and D5.

\## 17.1 Claim Session [IMPLEMENTED]

```http
POST /v1/agent/sessions/{session_id}/claim
```

Authentication: Agent JWT.
Headers: `Idempotency-Key: <unique-key>` (required, D13).
Request body: empty. The schema is a strict empty object, so a body naming an
`agent_id`, a `tenant_id`, an `offer_expires_at`, or a `status` is a
`400`, not a field the server has to remember to ignore.

The tenant and the agent come from the JWT. The session id is the only value
the caller chooses.

### Preconditions

```text
Session = QUEUED
Agent   = AVAILABLE (live Redis presence)
Agent speaks the session language
Agent is below max_concurrent
```

Each is checked before the write, and none of them is the guard. Two agents can
satisfy every precondition at the same instant; the conditional UPDATE below is
what makes exactly one of them win.

**Language.** Normalised on both sides — trimmed and lower-cased — so a profile
storing `EN` matches a session storing `en`. Regional
variants remain distinct: `en-IN` is not `en` (R13).

**Presence.** An eligibility rule, not a lock. Presence lives in Redis, which is
never authoritative for business state (D1, D2) and whose key may expire a
moment after the check passes. What it prevents is an agent who has closed their
laptop silently taking a customer off the queue.

**Capacity.** `agent_profiles.max_concurrent`, counted in PostgreSQL
over both halves of "holding work": sessions `OFFERED` to this agent
(`offered_to_agent_id`) and sessions `IN_CALL` with this
agent (`agent_id`). Each id is paired with its status, so a stale
`offered_to_agent_id` on a session that has moved on consumes no
capacity.

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

Three predicates and no fourth. Not the caller's observed `version`:
the session being queued is the entire precondition, and a version predicate
would lose a legitimate claim to any unrelated write that had bumped it.

`agent_id` is **not** set here. A claim is an offer, not an
assignment; section 17.2 sets it on accept.

The update and its `session_events` row commit or roll back together,
so a lost claim leaves no trace of an offer that never happened.

### Serialising one agent's own claims

The capacity count runs in the same transaction as the update, immediately after
a row lock on the claiming agent:

```sql
SELECT id FROM users
 WHERE id = :agent_id AND tenant_id = :tenant_id
   FOR UPDATE;
```

Without it the count is a time-of-check/time-of-use hole. Under READ COMMITTED
each statement takes its own snapshot, two claims by one agent touch *different*
session rows so they never block each other, and neither sees the other's
uncommitted `OFFERED` — both would count zero and both would commit.
The lock costs nothing to anyone else: two agents racing for one session lock
different rows and are still decided by the conditional UPDATE, and an agent
only ever locks their own row, so no cycle is possible.

### Session event

One row, using the canonical vocabulary: `SESSION_ASSIGNED`, actor
type `AGENT`, actor id the claiming agent. The payload carries the
edge (`from`, `to`), the agent id, and the offer timeout. No new event
name is introduced for the claim.

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

Exactly these four fields. No `external_ref`, no customer identifier,
no room name, and no queue internals: the claim answers "is this mine, and until
when?", and the session's own routes answer everything else.

`offer_expires_at` is
`offered_at + tenants.offer_timeout_seconds`, computed by the server.
Section 17.3 sweeps against the same rule.

### Retrying a claim you already hold

An agent claiming a session that is already `OFFERED` **to them** gets `200` and
the existing offer, not a `409`. It is answered before language, presence, and
capacity are considered, because none of those is being decided — the offer
exists, and this reports it.

`offer_expires_at` comes from the stored `offered_at`, so a retry reports the
*original* window. Re-basing it would let an agent extend an offer indefinitely
by asking again.

Nothing is re-claimed: no conditional UPDATE runs, no `version` is bumped, and no
second `SESSION_ASSIGNED` is appended. The only write is the best-effort `BUSY`,
which repairs a presence whose first write failed.

The ordinary way to arrive here is a lost response. Before this existed, an agent
retrying their own successful claim was told the session had already been claimed
by another agent — and since a claimed session no longer appears in
`GET /v1/agent/queue`, they had no route back to work they were in fact holding.

### Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | No `Idempotency-Key`, a non-UUID session id, or any body field |
| `401` | `UNAUTHENTICATED` | No agent JWT. A customer token or an API key is also a `401` |
| `403` | `FORBIDDEN` | The user has no agent profile, or does not speak the session's language |
| `404` | `NOT_FOUND` | No such session **or** another tenant's session — deliberately indistinguishable (I8) |
| `409` | `SESSION_ALREADY_ASSIGNED` | Another agent holds the offer or the call, or won the race |
| `409` | `SESSION_INVALID_STATE` | The session is not waiting in the queue — never queued, or already ended |
| `409` | `CONFLICT` | The agent is not live and `AVAILABLE`, or is at `max_concurrent` |

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

### Side effects

On success, and in this order: the session moves to `OFFERED` in
PostgreSQL with its `SESSION_ASSIGNED` event, and then the agent's
Redis presence is set to `BUSY`.

The Redis write is **not** part of the transaction, and a failure of it does not
fail the claim. The offer is already committed, PostgreSQL is authoritative
(D1), and the consequence is bounded and stated: an agent whose `BUSY`
write failed looks free for up to the presence TTL and may be offered a second
session — which `max_concurrent` in PostgreSQL then refuses. That is
precisely why the authority for concurrency is in the database and not in the
presence key.

What a claim does **not** do: it does not set `agent_id`, does not
create a LiveKit room, does not write a billing entry, and does not touch the
queue projection. The Redis queue member and its score are left exactly as they
were, so section 17.3 can return an expired offer to its original position
rather than reconstructing one. The claimed session disappears from
`GET /v1/agent/queue` on the next read because PostgreSQL no longer
says `QUEUED`, not because anything was removed from Redis.

\---

\## 17.2 Accept Session [IMPLEMENTED]

```http
POST /v1/agent/sessions/{session_id}/accept
```

Authentication: Agent JWT.
Headers: `Idempotency-Key: <unique-key>` (required, D13).
Request body: empty, strictly. A body naming an `agent_id`, a
`connected_at`, or a `room_name` is a `400`.

### Preconditions

```text
Session = OFFERED
offered_to_agent_id = calling agent
offer has not expired
```

**Holding the offer is the authorization.** Unlike the claim, accept performs no
profile lookup, no language check, no `max_concurrent` count, and no
presence check. Each of those decided *whether this agent should get this
session*, and that was settled at claim time; an unexpired offer in the agent's
name is PostgreSQL's record of the answer. In particular an agent whose
heartbeat lapsed between claiming and accepting is **not** refused — dropping a
waiting customer over a late heartbeat would be the worse outcome, and
PostgreSQL, not Redis, is authoritative (D1).

### State Transition

```text
OFFERED -> IN_CALL
```

```sql
UPDATE sessions
   SET status = 'IN_CALL',
       agent_id = :agent_id,
       connected_at = :now,
       version = version + 1
 WHERE id = :session_id
   AND tenant_id = :tenant_id
   AND status = 'OFFERED'
   AND offered_to_agent_id = :agent_id
   AND offer_expires_at > :now;
```

One clock reading does both jobs: it becomes `connected_at` and it is
the instant the expiry is measured against, so an accept can never be judged
late by a clock different from the one that timestamps it.

`offer_expires_at > :now` is strict. The sweeper's predicate is
`<=` on the same column against the same clock, so exactly one of the
two can match a given instant and the boundary belongs to neither twice.

**The contender is the sweeper, not another agent.** No second agent can hold
this offer, so the race accept has to win is against §17.3 returning the same row
to the queue. Both act on `status = 'OFFERED'`, so PostgreSQL
serialises them and the loser matches nothing. The expiry predicate is not what
resolves that race — it is what stops an agent accepting an offer that lapsed
seconds ago and the sweeper has simply not reached yet.

**Why `status = 'OFFERED'` is load-bearing.** The offer fields survive
an accept (see below), so an `IN_CALL` row still satisfies every other
predicate in the statement. Without the status predicate a second accept would
bump the version, append a second `AGENT_ACCEPTED`, and reset
`connected_at` on a call already in progress.

### Session event

One `AGENT_ACCEPTED`, actor type `AGENT`, in the same
transaction as the update. `CALL_STARTED` belongs to the LiveKit join
webhook, not here.

### Side effects

Two, in this order: PostgreSQL commits the transition and its event, then the
agent's Redis presence is reasserted as `BUSY`. The agent was already
`BUSY` from the claim; reasserting repairs a presence whose earlier
write failed. As with the claim, a failed Redis write does not fail the accept.

`offered_to_agent_id`, `offered_at` and
`offer_expires_at` are **kept**, not cleared. On an `IN_CALL`
row they are history — which agent was offered this session, when, and until
when. Only §17.3 clears them.

**What accept does not do.** It does not create a LiveKit room, mint a media
token, start recording, emit a WebSocket event, or send a webhook. Those are
separate tasks. `room_name` is returned because the column has held it
since creation (R2): it is a name, not an admission ticket.

### Response

```json
{
  "data": {
    "session_id": "session-uuid",
    "status": "IN_CALL",
    "agent_id": "agent-uuid",
    "room_name": "vcip_session-uuid"
  }
}
```

Exactly these four fields, and no customer data.

### Retrying an accept

An agent accepting a session they are already `IN_CALL` on gets
`200` and the same body, not a `409`. Nothing transitions
again: no second event, no version bump, and `connected_at` keeps the
instant the call actually began rather than moving forward on every retry. A lost
response is the ordinary way to arrive here, and the agent is about to join a
call.

### Errors

| Status | Code | When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | No `Idempotency-Key`, a non-UUID session id, or any body field |
| `401` | `UNAUTHENTICATED` | No agent JWT |
| `404` | `NOT_FOUND` | No such session, or another tenant's — deliberately indistinguishable (I8) |
| `409` | `SESSION_ALREADY_ASSIGNED` | The offer, or the call, belongs to another agent |
| `409` | `SESSION_INVALID_STATE` | No offer outstanding, or the offer has expired and the session has returned to the queue |

\---

\## 17.3 Offer Expiry [IMPLEMENTED]

An offer not accepted within `tenants.offer_timeout_seconds` is
returned to the queue by a sweeper:

```text
OFFERED -> QUEUED
```

```sql
WITH due AS (
  SELECT id, tenant_id, offered_to_agent_id
    FROM sessions
   WHERE status = 'OFFERED'
     AND offer_expires_at <= :now
   ORDER BY offer_expires_at
   LIMIT :batch
     FOR UPDATE SKIP LOCKED
), swept AS (
  UPDATE sessions s
     SET status = 'QUEUED',
         offered_to_agent_id = NULL,
         offered_at = NULL,
         offer_expires_at = NULL,
         version = s.version + 1
    FROM due WHERE s.id = due.id
  RETURNING s.id
)
SELECT due.id, due.tenant_id, due.offered_to_agent_id AS agent_id
  FROM due JOIN swept ON swept.id = due.id;
```

`offered_to_agent_id`, `offered_at` and
`offer_expires_at` are cleared, and one `OFFER_EXPIRED`
event is appended per swept row in the same transaction. `OFFER_EXPIRED`
rather than `SESSION_QUEUED`: the audit trail has to distinguish a
customer joining the queue from an agent letting an offer lapse, which is what
explains why a customer waited twice.

This is not a billable event, and automatic reassignment to another agent is not
implemented (D4).

**The CTE is not decoration.** `RETURNING` reports the row as it now
is, so `RETURNING offered_to_agent_id` on a statement that just set
that column to `NULL` returns `NULL` for every row. The
agent who let the offer lapse would be unreachable and nothing would ever clear
their `BUSY`.

### Freeing the agent

`BUSY` is a Redis status on a key the heartbeat keeps refreshing, so
an agent whose offer lapsed would otherwise stay `BUSY` indefinitely
and never be offered work again. Each distinct agent in a swept batch is returned
to `AVAILABLE`, best-effort and individually guarded: PostgreSQL has
already committed, and a Redis failure must neither undo that nor stop the
remaining agents being freed.

### The queue projection

Nothing is written to Redis. §17.1 deliberately leaves the ZSET member in place
on claim, so a session returning to `QUEUED` is already sitting at its
original score — the customer keeps the place they have been waiting in, at no
cost.

### Running it

A pass runs on an interval inside the API process, bounded to a fixed batch per
pass. It is safe to run on every instance simultaneously and needs no lock or
leader election: each row is taken by exactly one statement, and
`FOR UPDATE SKIP LOCKED` means concurrent sweepers take disjoint
batches rather than contending.

```http
POST /internal/offers/sweep
```

Internal token only (D10). It runs one pass immediately and reports counts —
`{ "expired": n, "freed": n }` — and exists for deterministic testing
and for operations, not because the sweeper needs a caller. It is naturally
idempotent: a second pass finds the same offers already `QUEUED`.


\## 17.4 Agent Work [IMPLEMENTED]



\### Endpoint



```http

GET /v1/agent/work

```



\### Authentication



Agent JWT. Takes no parameters: the agent and the tenant come from the

credential, so there is no field through which one agent could ask what another

is holding.



\### Why it exists



No other endpoint answers "what am I working on". `GET /v1/agent/queue` lists

what an agent *could* take, and a session assigned to them has by definition

left the queue; `GET /v1/sessions/{id}` needs an id the caller may not have;

the login response carries a credential and nothing else.



Without it the agent portal's only record of its own work was browser storage,

which is per-tab. A fresh login lost it, and the agent landed on the queue

screen while `POST /v1/agent/availability` refused them with `409` for holding

a session no response would name. Nothing frees an `IN_CALL` session — the

expiry sweeper handles `OFFERED` only — so the agent stayed stuck until the

customer aborted.



\### Response



```json

{

&#x20; "data": {

&#x20;   "sessions": [

&#x20;     {

&#x20;       "session\_id": "session-uuid",

&#x20;       "status": "IN\_CALL",

&#x20;       "room\_name": "vcip\_session-uuid",

&#x20;       "offer\_expires\_at": null

&#x20;     }

&#x20;   ]

&#x20; }

}

```



A list, because `agent\_profiles.max\_concurrent` may exceed one. An agent

holding nothing gets `{ "sessions": [] }` — a `200`, not a `404`: holding

nothing is a true answer.



`status` is `OFFERED` or `IN\_CALL`, the two states that count as held work.

That is the same definition the claim's capacity check and the availability

guard use, so what this lists and what makes availability refuse can never

disagree.



`offer\_expires\_at` is non-null only for an `OFFERED` session, where it is the

window the claim issued. It is reported because `GET /v1/sessions/{id}` does

not carry it, and an agent recovering an offer needs a real countdown rather

than an invented one.



\### Side effects



None. No session moves, no presence changes, no offer is extended, and no

event is appended. It reports rows that already exist.



---



\# 17a. Get Checklist [IMPLEMENTED]



Returns the verification checklist **pinned to this session**, never the

tenant's currently active one (D8).



\### Endpoint



```http

GET /v1/agent/sessions/{session\_id}/checklist

```



\### Authentication



Agent JWT. There is no customer path onto this route.



\### Preconditions



```text

Agent = assigned agent (sessions.agent\_id)

```



Any session status. Unlike a media token, this is not a live credential: it is

the list of statements the agent is being held to, and it stays readable after

the verdict — which is when "what exactly did I confirm" is usually asked.



\### Response



```json

{

&#x20; "data": {

&#x20;   "session\_id": "9f1c...",

&#x20;   "template\_id": "3ab2...",

&#x20;   "version": 1,

&#x20;   "items": \[

&#x20;     {

&#x20;       "key": "face\_visible",

&#x20;       "label": "Customer face visible",

&#x20;       "required": true

&#x20;     }

&#x20;   ]

&#x20; }

}

```



`template\_id` and `version` are returned alongside the items because which

checklist a verification was judged against must be answerable after the fact,

from the response the portal actually received.



\### Pinning



```text

sessions.checklist\_template\_id  ->  checklist\_templates.id

```



Written once when the session is created, from the tenant's active template.

Activating a different template afterwards does not change what an existing

session returns (`06-database-schema.md` §18). The join is on the pinned id and

not on `active`, so a superseded template stays readable for every session

pinned to it.



\### Errors



```text

403  FORBIDDEN        another agent holds this session, or nobody does yet

404  NOT\_FOUND        no such session in this tenant

500  INTERNAL\_ERROR   no template is pinned, or the pinned template is not a

&#x20;                    valid checklist

```



The 500 is deliberate and is never an empty item list. A checklist served

shorter than the tenant configured would let a verdict be submitted against

required items the agent was never shown.



\### Side effects



None. No session moves and no event is appended. Reading what you are about to

attest to is not a fact about the verification; the answers are, and they are

recorded at the verdict (§18).



\---



\# 18. Submit Verdict [IMPLEMENTED]



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

Required checklist items = checked   (APPROVED only; see below)

```



\### Checklist [T34]



The submission must answer **every** item in the template the session is pinned

to (section 17a). An item left out is refused rather than recorded as

unchecked: a blank answer and a portal running against an older template arrive

looking identical, and recording the second as the first would store an

attestation nobody made. Answers naming items the template does not contain are

refused for the same reason.



`required` gates **`APPROVED` only.** Read literally, the precondition above

would make a rejection impossible in the case rejections exist for: an agent

rejects *because* a required check failed, so demanding every required item be

`true` first would leave the only submittable rejection one where nothing was

wrong. `REJECTED` and `ABORTED` record the checklist exactly as answered.



The checklist is stored in full for every verdict either way. What varies is

whether it gates, not whether it is kept -- the unchecked item is the answer to

"why was this rejected".



Refusals are `422 UNPROCESSABLE` and name the offending item keys. The answers

are written to `session\_checklist\_items` inside the verdict transaction

(`06-database-schema.md` §45), so they commit with the verdict or not at all.



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



\## 19.0 Connection Tokens [IMPLEMENTED]



A WebSocket handshake cannot carry an `Authorization` header from a browser, so

D9 authenticates the connection with a short-lived token in a query parameter,

minted by a REST endpoint the caller is already authorised to use. The token

grants nothing the caller did not already hold; it re-expresses an existing

credential in a form the handshake can carry.



```http

POST /v1/sessions/{session\_id}/ws-token     customer session token

POST /v1/agent/ws-token                     agent JWT

```



\### Scope



| Route | Scoped to |

| --- | --- |

| `/v1/sessions/{id}/ws-token` | tenant + that one session |

| `/v1/agent/ws-token` | tenant + that one user |



The asymmetry is D9's. A customer token is bound to one session (R8); an

agent's connection outlives any one session, so scoping it to a session would

mean re-minting on every claim.



Every claim is taken from the verified caller. The path `{session\_id}` is only

ever checked — the guard refuses a token naming a different session — and the

minted token is signed from the credential, never from the path.



\### Response



```json

{

&#x20; "data": {

&#x20;   "token": "connection-token",

&#x20;   "expires\_at": "2026-09-02T10:05:00Z",

&#x20;   "audience": "customer"

&#x20; }

}

```



\### Lifetime



Five minutes, and **not** single-use. Long enough that a client which fetches a

token, renders, and then opens a socket is not racing the clock, and that an

ordinary reconnect inside the window needs no second round trip. Short enough

that a token in an access log or a browser history entry is worthless by the

time anyone reads it.



\### Signing



A dedicated secret (`VCIP\_WS\_TOKEN\_SECRET`) and a dedicated `act` claim, both

distinct from the customer and agent credentials. This is the one credential

the system puts in a URL, so it must not be worth as much as a session token if

it leaks: a WS token that shared a signing key would differ from a full

credential by a single claim.



Servers must keep connection tokens out of access logs. The API redacts the

query string from every line it writes about a connection.



---



\## 19.1 Connection [UPDATED]



```http

GET /v1/ws?token=<short-lived-connection-token>

```



Native WebSocket, not Socket.IO. The connection is scoped to the tenant plus

either a session (customer) or a user (agent), derived **from the verified

token only**. No other query parameter is read, and the server accepts no

message that changes what a connection receives — a client cannot ask for a

channel.



An unauthenticated, expired, or wrongly-purposed token closes the connection

with code `4401`. Expired and forged are indistinguishable to the caller.



The server pings periodically; a connection that does not answer is terminated

and its subscriptions released.



\### Event vocabulary



R3 is canonical. `03-system-design.md` §10.2 lists `agent.assigned`,

`call.started` and `call.ended`; those names predate R3 and are stale.



Customer:



```text

queue.position

session.offered

session.assigned

agent.joined

session.updated

session.completed

```



Agent:



```text

queue.new\_session

session.claimed\_elsewhere

session.offer\_expired

ai.updated

session.updated

session.cancelled

```



`session.updated` is the only name both audiences receive, and it means the

same thing to each. Every other name belongs to exactly one audience, and the

server refuses to deliver an event to the wrong one.



These are **not** `session\_events` types. That is the append-only audit

vocabulary, written inside the transaction that made something happen and kept

forever; this is a notification vocabulary, delivered best-effort and

authoritative for nothing.



\### Routing



Events are routed server-side from the connection's verified scope.



| Audience | Receives |

| --- | --- |

| customer | events for its own session only |

| agent | events addressed to that user, plus queue events for languages the agent is configured to work |



`queue.new\_session` is targeted, never broadcast: an agent receives it only

when the session's language matches one in `agent\_profiles.languages`, using

the same normalisation the queue projection applies (trim and lower-case, with

`en` distinct from `en-IN`). Browser-side filtering is not relied on.



\### Delivery guarantees



None. Redis Pub/Sub is fire-and-forget: a notification published while nobody

is connected is dropped, with no queue and no replay. That is correct for this

transport — §33.11 — and REST is the recovery path for anything missed. A

client that reconnects reads the session; it is never told to replay.



---







\## 19b. Call Sweeper [IMPLEMENTED]



```http

POST /internal/calls/sweep

```



Internal token only (D10) — unlike the webhook, this route has a caller we

control. It runs one pass immediately and reports counts:

`{ "due": n, "dropped": n, "aborted": n, "stale": n }`. A pass also runs on an

interval inside the API process; the route exists for deterministic testing and

for operations.



A window that lapses ends the session, and which side vanished decides how (R4,

D18):



| Window | Outcome | Billing |

| --- | --- | --- |

| customer did not return | `DROPPED\_IN\_CALL` | `FAILED`, 500 paise |

| agent did not return | `ABORTED` | `FAILED`, 500 paise |



The customer window is 20 seconds, matching `departure\_timeout` in

`infra/livekit.yaml`. It exists because a page reload and a closed tab arrive

identically — both are `participant\_left` with `CLIENT\_INITIATED` — and the

customer app rejoins automatically on reload. The agent window is

`tenants.agent\_reconnect\_timeout\_seconds` (D18).



The transition and its billing row are written in one transaction, guarded on

`status = 'IN\_CALL'`. A verdict that committed first, a customer abort, or a

second pass all match nothing, so a session is ended and billed at most once

(I3, I11).



---



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



\# 21a. Recording [IMPLEMENTED]



\### When it starts



When **both participants are in the room** — the same instant `CALL\_STARTED` is

appended (§19a).



`05-development-plan.md` calls this task "recording start on accept". That is

not implementable: at accept nobody has joined, so the room does not exist and

LiveKit answers `requested room does not exist`. `03-system-design.md` §21.2

already says recording starts "when the actual call begins", and that is what

happens. Starting from the first arrival instead would open every evidence file

with however long one party waited alone.



\### What is recorded



Room-composite, `grid` layout, MP4 — R17's "both participants, one file".

`speaker` would shrink whoever is not talking, and a document held up in

silence is exactly the frame that must not be the small one. No custom

template: the Day-0 spike used one to prove a layout was possible, and it

required the egress container to reach a page served from the host.



The file lands in the temporary bucket under a key derived from the session id:



```text

raw/{session\_id}.mp4

```



Deliberately not LiveKit's `{room\_name}-{time}` template. The key has to be

recomputable from the session id so the egress worker can find it without a

listing, and a time component would silently permit two files for one session.



The Control API never touches the bytes (I6). It asks LiveKit to record, and

the egress container writes to object storage itself.



\### Where the egress id lives



In the `EGRESS\_STARTED` event payload:



```json

{

&#x20; "egress\_id": "EG\_...",

&#x20; "room\_name": "vcip\_session-uuid",

&#x20; "video\_key": "raw/session-uuid.mp4"

}

```



No column. D18 and D25 both refused one for this kind of in-flight fact, and

the egress worker reads the id back from the log.



\### When it stops



Nothing in this codebase stops a recording. Room-composite egress ends when the

room does, and `infra/livekit.yaml` closes an empty room after

`empty\_timeout`. The evidence file therefore extends past the end of the

conversation by that timeout.



\### When it fails



A failed start never fails the call. `EGRESS\_FAILED` is appended once — added

to §15's catalogue for this, because "the recording never started" and "the

recording is still running" must not look the same to an auditor — and the

verification proceeds. The verdict stands and billing is unaffected (I9).



A retry pass runs on an interval for calls that are `IN\_CALL` with a

`CALL\_STARTED` and no `EGRESS\_STARTED`, so a recording that could not start

while the egress container was restarting still gets going. The file then

misses the opening of the conversation, which `EGRESS\_FAILED` in the log is

what discloses.



```http

POST /internal/recordings/retry

```



Internal token only (D10). Runs one pass immediately and reports counts —

`{ "found": n, "started": n, "failed": n }` — for deterministic testing and for

operations. Naturally idempotent: a session that started recording no longer

matches, and a second start for one session is refused.



---



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
| LiveKit webhook                    | No status change; call events only                |
| recording start / retry            | No status change; egress events only              |
| call sweeper (customer window)     | `IN\_CALL → DROPPED\_IN\_CALL`                     |
| call sweeper (agent window)        | `IN\_CALL → ABORTED`                               |

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
GET  /v1/agent/work
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
POST /internal/calls/sweep
POST /internal/recordings/retry
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



