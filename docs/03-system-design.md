\# V-CIP MVP — System Architecture

> **Approved decisions live in `docs/00-decisions.md`.**
> Where this document conflicts with that decision record, the decision record wins.
> Sections updated by the approved decisions are marked `[UPDATED]`.




\## 1. Purpose



This document defines the technical architecture for the V-CIP MVP.



The objective is to build a working product that demonstrates the complete V-CIP lifecycle:



```text

Customer

   ↓

Session

   ↓

Consent

   ↓

Preflight

   ↓

Location

   ↓

Queue

   ↓

Agent

   ↓

Live Video

   ↓

AI Assistance

   ↓

Human Verdict

   ↓

Billing

   ↓

Recording

   ↓

Watermarked Evidence

   ↓

Enterprise Storage

   ↓

Webhook

```





The architecture should be:



\* Simple enough to build quickly

\* Correct enough for real end-to-end demos

\* Secure enough to handle sensitive verification data responsibly

\* Structured so production components can be introduced later

\* Explicit enough that the coding agent does not invent architecture



\---



\# 2. Architecture Principles



\## 2.1 PostgreSQL is the source of truth



PostgreSQL owns durable business state.



Examples:



\* Session state

\* Agent assignment

\* Verdict

\* Billing

\* Export status

\* Audit events



Redis is not the permanent source of truth for these.



\---



\## 2.2 Redis is for temporary and high-speed state



Redis is used for:



\* Queue

\* Agent presence

\* Temporary session state

\* AI HUD state

\* Short-lived locks



If Redis is restarted, the system should be able to recover business state from PostgreSQL.



\---



\## 2.3 Video does not pass through the backend



The backend should not proxy customer video.



LiveKit handles real-time media.



```text

Customer

   |

   | WebRTC

   v

LiveKit

   ^

   | WebRTC

   |

Agent

```



The control API manages the session and permissions, while LiveKit handles media transport.



\---



\## 2.4 AI is asynchronous



AI must not be placed in the critical path of the video call.



The call should continue even if AI becomes temporarily unavailable.



```text

                 LiveKit

                   |

          +--------+--------+

          |                 |

          v                 v

        Agent             AI

                            |

                            v

                         Results

                            |

                            v

                         Agent HUD

```



\---



\## 2.5 Human agent makes the final decision



AI provides signals.



AI does not independently approve or reject the customer.



The final verdict belongs to the agent.



\---



\## 2.6 Modular monolith first



The MVP should not start as a large microservice architecture.



Use:



```text

Control API

AI Service

Egress Worker

Customer App

Agent Portal

```



with clear internal modules.



Later, individual modules can be split into separate services when scale or team size justifies it.



\---



\## 2.7 Minimize sensitive data



The platform should avoid permanently storing sensitive customer information unless required.



Examples of data that should not be stored in normal PostgreSQL tables:



\* Face images

\* Raw video

\* GPS coordinates

\* Face embeddings

\* Aadhaar data

\* Full OCR text



The MVP should keep sensitive temporary data in memory or short-lived storage where required.



\---



\# 3. High-Level MVP Architecture



```text

                              INTERNET

                                  |

                    +-------------+-------------+

                    |                           |

                    v                           v

             Customer App                 Agent Portal

                    |                           |

                    | REST / WS                 | REST / WS

                    |                           |

                    +-------------+-------------+

                                  |

                                  v

                         +-------------------+

                         |   Control API     |

                         |   NestJS          |

                         +---------+---------+

                                   |

                  +----------------+----------------+

                  |                |                |

                  v                v                v

             PostgreSQL          Redis           LiveKit

                  |                |                |

                  |                |         +------+------+

                  |                |         |             |

                  |                |         v             v

                  |                |     Customer        Agent

                  |                |

                  |                +------ Queue

                  |                       Presence

                  |                       HUD

                  |

                  +-------------------+

                                      |

                                      v

                               AI Service

                              /    |     \\

                             /     |      \\

                        Liveness Face     OCR

                             \\      |      /

                              \\     |     /

                               +----+----+

                                    |

                                    v

                                  Redis

                                    |

                                    v

                               WebSocket

                                    |

                                    v

                              Agent Portal





LiveKit

   |

   v

Recording

   |

   v

Temporary Object Storage

   |

   v

Egress Worker

   |

   +---- FFmpeg Watermark

   |

   +---- SHA-256

   |

   +---- audit.json

   |

   +---- Digital Signature

   |

   v

Enterprise S3

   |

   v

Webhook

   |

   v

Enterprise Backend

```



\---



\# 4. Main Components



The MVP contains the following logical components.



| Component         | Responsibility                             |

| ----------------- | ------------------------------------------ |

| Customer App      | Starts and participates in verification    |

| Agent Portal      | Allows agent to conduct verification       |

| Control API       | Owns business logic and session lifecycle  |

| PostgreSQL        | Durable system of record                   |

| Redis             | Queue, presence, temporary state           |

| WebSocket Gateway | Real-time status updates                   |

| LiveKit           | Real-time audio/video                      |

| AI Service        | Liveness, face match, OCR                  |

| Egress Worker     | Recording processing and evidence creation |

| Object Storage    | Temporary and final evidence storage       |

| Webhook Module    | Notifies enterprise                        |

| KMS/Secret Store  | Protects secrets and signing keys          |



For the MVP, some of these may run inside the same application/process.



Logical separation is more important than physical deployment separation.



\---



\# 5. Customer Application



\## 5.1 Purpose



The customer application is the front end used by the person being verified.



For MVP, this should be a web application.



A future Web SDK can use the same API contracts.



\---



\## 5.2 Responsibilities



The customer application handles:



\* Session start

\* Consent UI

\* Camera permission

\* Microphone permission

\* Preflight checks

\* GPS permission

\* Queue UI

\* Video-call UI

\* Session status

\* Abort action



It should not:



\* Access PostgreSQL

\* Access Redis

\* Access S3 directly

\* Decide session state

\* Decide billing

\* Decide the final KYC verdict



\---



\## 5.3 Customer Flow



```text

Open Verification

       |

       v

Create Session

       |

       v

Consent

       |

       v

Preflight

       |

       v

Location

       |

       v

Queue

       |

       v

Agent Assigned

       |

       v

Video Call

       |

       v

Completed

```



\---



\# 6. Agent Portal



\## 6.1 Purpose



The agent portal is used by verification agents.



Technology:



\* Next.js

\* React

\* TypeScript

\* Tailwind

\* LiveKit React SDK



\---



\## 6.2 Responsibilities



The portal allows agents to:



\* Login

\* Become available

\* See queue

\* Accept a session

\* Join a video call

\* See AI results

\* See location status

\* Complete checklist

\* Submit verdict



The portal should not directly modify database state.



All business operations go through the Control API.



\---



\# 7. Control API



\## 7.1 Purpose



The Control API is the main backend.



Recommended technology:



```text

Node.js

TypeScript

NestJS

```



Think of it as the system's business-logic layer.



\---



\## 7.2 Responsibilities



The Control API owns:



\* Authentication

\* Tenant validation

\* Session lifecycle

\* Consent

\* Preflight results

\* Location eligibility

\* Queue operations

\* Agent assignment

\* Agent availability

\* LiveKit token generation

\* Checklist

\* Verdict

\* Billing

\* Export status

\* Webhook creation

\* Audit events



\---



\## 7.3 Internal Modules



The Control API should be organized into modules:



```text

src/

├── auth/

├── tenants/

├── sessions/

├── queue/

├── agents/

├── livekit/

├── checklist/

├── billing/

├── exports/

├── webhooks/

└── common/

```



This is a modular monolith, not separate microservices.



\---



\# 8. PostgreSQL



\## 8.1 Purpose



PostgreSQL stores durable business information.



Think of it as:



> The official record of what happened.



\---



\## 8.2 Data Stored



MVP tables:



```text

tenants

users

agent\_profiles



sessions

session\_events



checklist\_templates

session\_checklist\_items



session\_ai\_summaries



billing\_entries



exports



webhook\_endpoints

webhook\_events

webhook\_deliveries

```



\---



\## 8.3 Data Not Stored



Do not store in normal PostgreSQL tables:



```text

GPS latitude/longitude

Raw video

Face images

Face embeddings

Aadhaar data

Full document images

Temporary video frames

```



Temporary/sensitive data must use an appropriate short-lived mechanism.



\---



\# 9. Redis



\## 9.1 Purpose



Redis handles data that needs to be accessed very quickly or does not need long-term persistence.



For MVP, Redis handles:



\* Queue

\* Agent presence

\* Temporary session data

\* AI results/HUD

\* Short-lived locks



\---



\## 9.2 Queue



Basic queue:



```text

queue:{tenant\_id}:{language}

```



Use a Redis sorted set.



Example:



```text

score = enqueue timestamp

member = session\_id

```



The oldest eligible session is selected first.



MVP routing:



```text

FIFO

```



Optional simple language matching can be supported.



\---



\## 9.3 Agent Presence



Example:



```text

agent:presence:{agent\_id}

```



Example data:



```text

status = AVAILABLE

languages = \["en", "hi"]

last\_seen = timestamp

```



The presence key should expire automatically.



Example:



```text

TTL = 15 seconds

```



The agent refreshes its heartbeat periodically.



\---



\## 9.4 AI HUD



Example:



```text

session:hud:{session\_id}

```



Example:



```text

liveness\_score = 97

liveness\_status = LIVE

face\_match\_score = 95

ocr\_status = PASS

updated\_at = timestamp

```



This data is temporary.



At verdict time, only the required summary is copied to PostgreSQL.



\---



\## 9.5 Session Hot Data



Sensitive short-lived session information may be stored in Redis with a strict TTL when required by the workflow.



Example:



```text

session:hot:{session\_id}

```



The MVP should avoid persistent Redis snapshots for sensitive data where practical.



\---



\# 10. WebSocket Gateway



\## 10.1 Why WebSocket?



REST is request/response.



For example:



```text

Customer → "What is my session status?"

Server   → "QUEUED"

```



WebSockets allow the server to push events.



For example:



```text

Server → Customer

"Your agent has been assigned."

```



\---



\## 10.2 MVP Events



Customer events:



```text

queue.position

agent.assigned

agent.joined

session.updated

call.started

call.ended

session.completed

```



Agent events:



```text

queue.new\_session

session.assigned

session.cancelled

ai.updated

session.updated

```



\---



\## 10.3 WebSocket Rule



WebSocket events are notifications.



They are not the source of truth.



If the client receives:



```text

APPROVED

```



it should still be possible to verify the official state through the Control API.



\---



\# 11. LiveKit / WebRTC



\## 11.1 Purpose



LiveKit handles real-time audio and video.



The backend should not implement WebRTC itself.



\---



\## 11.2 Room Model



One V-CIP session maps to one LiveKit room.



Example:



```text

session\_id = 123



room = vcip\_123

```



Participants:



```text

customer

agent

analyzer

```



\---



\## 11.3 Permissions



Customer:



```text

Publish audio

Publish video

Subscribe to agent

```



Agent:



```text

Publish audio

Publish video

Subscribe to customer

```



Analyzer:



```text

Subscribe to customer video

```



\---



\## 11.4 Token Flow



The customer requests a media token:



```text

Customer

   |

   | GET /sessions/{id}/media-token

   v

Control API

   |

   v

Generate LiveKit token

   |

   v

Customer

   |

   v

LiveKit

```



The token is:



\* Short-lived

\* Restricted to the session room

\* Restricted to the appropriate role



\---



\# 12. Queue and Agent Matching



\## 12.1 Goal



Match:



```text

Queued Customer

\+

Available Agent

```



\---



\## 12.2 MVP Algorithm [UPDATED]

The MVP uses **pull-claim**. The matcher does not assign sessions; it publishes
that eligible queued sessions exist. Agents claim explicitly. See D4.

```text
QUEUED --claim--> OFFERED --accept--> IN_CALL
   ^                  |
   +---- timeout -----+
```

Ordering is FIFO by enqueue timestamp, with optional language matching:

```text
customer.language in agent.languages
```

An offered session not accepted within `tenants.offer_timeout_seconds` returns
to `QUEUED`. Returning to the queue is not a billable event.

Automatic reassignment is not implemented in the MVP.

\## 12.3 Atomic Assignment



This is critical.



Suppose:



```text

Agent A → accept session 123

Agent B → accept session 123

```



Only one agent can win.



The backend must verify that the session is still `QUEUED`.



The session update should use an atomic database transaction or optimistic locking.



Example concept:



```text

UPDATE sessions

SET status = 'IN\_CALL',

    agent\_id = ?

WHERE id = ?

AND status = 'QUEUED'

```



Then check the number of affected rows.



```text

1 row → success

0 rows → someone else already claimed it

```



PostgreSQL remains authoritative.



\---



\# 13. Session State Machine [UPDATED]

Session state has two independent axes. See D3 in `docs/00-decisions.md`.

## 13.1 `sessions.status` — business lifecycle

```text
CREATED
   |
   +----> PREFLIGHT_FAILED        terminal, Rs 0, no billing row
   |
   v
QUEUED <-------------------+
   |                       |
   +----> DROPPED_QUEUED   | offer timeout
   |                       |
   v                       |
OFFERED --------------------+
   |
   v
IN_CALL
   |
   +----> APPROVED               terminal, Rs 25
   +----> REJECTED               terminal, Rs 5
   +----> ABORTED                terminal, Rs 5
   +----> DROPPED_IN_CALL        terminal, Rs 5
```

Allowed values:

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

A terminal business status is final. Evidence processing never overwrites it.

## 13.2 `sessions.export_status` — evidence lifecycle

```text
NOT_STARTED -> EXPORTING -> EXPORTED -> PURGED
                    |
                    +-----> FAILED (retryable, billing never reversed)
```

Allowed values:

```text
NOT_STARTED
EXPORTING
EXPORTED
FAILED
PURGED
```

Every transition on both axes is validated by the Control API.
Clients cannot set arbitrary states.

\# 14. State Transition Rules



\## CREATED → PREFLIGHT\_FAILED



Allowed when:



\* Required preflight fails

\* Location eligibility fails

\* Required consent fails



Billing:



```text

₹0

```



\---



\## CREATED → QUEUED



Allowed only when:



\* Consent passed

\* Preflight passed

\* Location passed



Billing eligibility starts here.



\---



\## QUEUED → IN\_CALL



Allowed when:



\* Agent is available

\* Agent successfully claims the session



\---



\## QUEUED → DROPPED\_QUEUED



Allowed when:



\* Customer aborts

\* Queue timeout occurs



Billing:



```text

₹5

```



\---



\## IN\_CALL → APPROVED



Allowed when:



\* Agent is assigned to session

\* Required checklist items are completed

\* Agent submits approval



Billing:



```text

₹25

```



\---



\## IN\_CALL → REJECTED



Billing:



```text

₹5

```



\---



\## IN\_CALL → ABORTED



Billing:



```text

₹5

```



\---



\## IN\_CALL → DROPPED\_IN\_CALL



Triggered when customer disconnects unexpectedly and no valid verdict has already been recorded.



Billing:



```text

₹5

```



\---



\# 15. AI Service



\## 15.1 Purpose



The AI service provides real-time assistance during verification.



For MVP, use one AI service rather than multiple independent microservices.



Recommended technology:



```text

Python

FastAPI

```



\---



\## 15.2 Internal Modules



```text

ai/

├── liveness/

├── face\_match/

├── ocr/

└── providers/

```



\---



\## 15.3 AI Provider Interfaces



The business logic should not depend directly on a specific vendor.



Example:



```typescript

interface LivenessProvider {

  analyze(input: LivenessInput): Promise<LivenessResult>;

}



interface FaceMatchProvider {

  compare(input: FaceMatchInput): Promise<FaceMatchResult>;

}



interface OCRProvider {

  extract(input: OCRInput): Promise<OCRResult>;

}

```



This allows the implementation to change later.



\---



\# 16. AI Frame Flow



The analyzer receives the customer's video stream from LiveKit.



The basic flow:



```text

Customer Video

      |

      v

LiveKit

      |

      v

Analyzer

      |

      v

Frame Sampling

      |

      +---- Liveness

      |

      +---- Face Match

      |

      +---- OCR

      |

      v

AI Results

      |

      v

Redis

      |

      v

WebSocket

      |

      v

Agent Portal

```



Frames should remain in memory as much as possible.



Do not persist every frame.



\---



\# 17. Liveness



Liveness checks whether the customer appears to be a real live person rather than an obvious presentation attack.



MVP result:



```text

score

status

```



Example:



```json

{

  "score": 97,

  "status": "LIVE"

}

```



Possible status values:



```text

LIVE

NOT\_LIVE

UNKNOWN

```



The AI result should be displayed as a signal, not an automatic final decision.



\---



\# 18. Face Match



Face matching compares:



```text

Reference Face

\+

Live Customer Face

```



and produces a similarity score.



Example:



```json

{

  "score": 95

}

```



The reference image may come from:



\* A tenant-provided reference

\* A supported document workflow

\* A future KYC provider integration



For MVP, a fixed/demo reference flow is acceptable.



\---



\# 19. OCR / Document Detection



OCR should be triggered only when the agent/customer indicates that a document is being shown.



Do not run expensive OCR on every frame.



Flow:



```text

Customer shows document

        |

        v

Document trigger

        |

        v

Capture a small frame burst

        |

        v

OCR

        |

        v

Result

        |

        v

Agent HUD

```



MVP output can be:



```text

DOCUMENT\_DETECTED

OCR\_PASS

OCR\_FAILED

```



Full sensitive document text should not be placed into normal PostgreSQL records.



\---



\# 20. AI Failure Handling



AI should not automatically break the video call.



Example:



```text

Live Video

   |

   +------> Agent

   |

   +------> AI

               |

               X

            AI down

```



The customer and agent can continue the call.



The agent sees:



```text

AI unavailable

```



Unless the tenant explicitly requires AI, the agent can still complete the session.



\---



\# 21. Recording



\## 21.1 Purpose



The session needs an evidence recording.



For the MVP, use LiveKit recording/egress.



\---



\## 21.2 Flow



```text

Customer + Agent

       |

       v

LiveKit

       |

       v

Recording

       |

       v

Temporary S3

```



Recording starts when the actual call begins.



For MVP, queue-time recording is not required.



\---



\# 22. Egress Worker



The egress worker processes the recording after the session ends.



Recommended implementation:



```text

Node.js / TypeScript

```



It can initially run as a background worker process.



Responsibilities:



\* Wait for recording completion

\* Read temporary recording

\* Watermark

\* Generate hash

\* Generate audit JSON

\* Sign audit

\* Upload evidence

\* Verify upload

\* Trigger cleanup

\* Create webhook event



\---



\# 23. Watermarking



Use FFmpeg.



Example overlay:



```text

Session: session-123

Agent: agent-001

Time: 2026-08-27 14:32:21 IST

```



The watermark is burned into the exported video.



It should not rely only on a browser overlay.



\---



\# 24. Audit JSON



Example structure:



```json

{

  "session\_id": "session-123",

  "tenant\_id": "tenant-001",

  "external\_ref": "loan-456",

  "agent\_id": "agent-001",

  "verdict": "APPROVED",

  "timestamps": {

    "created\_at": "...",

    "queued\_at": "...",

    "connected\_at": "...",

    "ended\_at": "..."

  },

  "ai": {

    "liveness\_score": 97,

    "liveness\_status": "LIVE",

    "face\_match\_score": 95,

    "ocr\_status": "PASS"

  },

  "billing": {

    "category": "SUCCESS",

    "amount\_paise": 2500

  },

  "media": {

    "sha256": "..."

  }

}

```



The audit should contain the minimum information necessary for verification and audit.



\---



\# 25. Digital Signature [UPDATED]

The platform signs the canonical audit JSON.

```text
audit.json
    |
    v
Canonical JSON (RFC 8785 / JCS)
    |
    v
SigningKeyProvider
    |
    v
audit.sig
```

Algorithm: **Ed25519**.

AWS KMS does not offer Ed25519 signing keys, so the design must not assume direct
KMS support. All signing goes through an abstraction:

```typescript
interface SigningKeyProvider {
  keyId(): string;
  sign(canonicalBytes: Uint8Array): Promise<Uint8Array>;
  publicKey(): Promise<Uint8Array>;
}
```

MVP implementation: `EnvEd25519SigningKeyProvider`, with the private key injected
through a secure environment/secret mechanism. The signing private key must never
be stored in source code. Future HSM/KMS providers replace the implementation
without touching the egress worker. See D12.

\# 26. Object Storage



For MVP, use:



```text

AWS S3

```



There are two conceptual storage areas.



\## Temporary Platform Storage



Used for processing:



```text

raw/{tenant\_id}/{session\_id}.mp4

wm/{tenant\_id}/{session\_id}.mp4

audit/{tenant\_id}/{session\_id}.json

```



Temporary data should have a lifecycle policy.



\---



\## Enterprise Storage



The final evidence is delivered to enterprise-controlled storage.



For the MVP, this can be a configured S3 bucket.



Later, support:



```text

S3

GCS

Azure Blob

```



\---



\# 27. Export Flow



```text

Session Verdict

      |

      v

EXPORTING

      |

      v

Recording Complete

      |

      v

Watermark

      |

      v

Generate Audit

      |

      v

Sign Audit

      |

      v

Upload Video

      |

      v

Upload Audit

      |

      v

Upload Signature

      |

      v

Verify Upload

      |

      v

EXPORTED

      |

      v

Webhook

      |

      v

PURGE

```



\---



\# 28. Export Failure [UPDATED]

If enterprise storage is temporarily unavailable:

```text
EXPORTING
    |
    v
Upload Failure
    |
    v
Retry (still EXPORTING)
    |
    +---- Success ----> EXPORTED
    |
    +---- Exhausted --> FAILED   (terminal)
```

`EXPORTING` covers the entire retry loop. `FAILED` means retries are exhausted
and is terminal.

In both terminal cases the enterprise is notified:

```text
EXPORTED -> webhook payload carries evidence keys, evidence_available = true
FAILED   -> webhook payload carries evidence_available = false, keys null
```

Billing is never reversed. The temporary evidence remains available until the
retention limit so the export worker can retry. See D22.
\# 29. Webhooks



The enterprise needs to know when a session is completed.



The webhook system sends:



```text

session.completed

```



Example:



```json

{

  "event": "session.completed",

  "session\_id": "session-123",

  "external\_ref": "loan-456",

  "verdict": "APPROVED",

  "bill\_category": "SUCCESS",

  "bill\_amount\_paise": 2500,

  "video\_key": "...",

  "audit\_key": "..."

}

```



Do not send:



\* Face image

\* Video bytes

\* GPS coordinates

\* Aadhaar

\* PAN

\* Full OCR text



\---



\# 30. Webhook Reliability



Use the transactional outbox pattern.



When the session is finalized:



```text

BEGIN TRANSACTION



Update session

Create billing entry

Create webhook\_event



COMMIT

```



A worker later delivers the webhook, but only once the session's export state
has resolved:

```sql
status = 'PENDING' AND export_status IN ('EXPORTED','FAILED','PURGED')
```

At verdict time the payload has no evidence keys because export has not run.
The payload is enriched when export resolves. Webhook statuses remain PENDING,
DELIVERED, DEAD. Delivery never blocks cleanup. See D21.



If the webhook fails:



```text

retry

retry

retry

```



This prevents a completed database transaction from losing its webhook event because the process crashed immediately afterward.



For MVP, a simple retry schedule is sufficient.



\---



\# 31. Billing



Billing is derived from the session outcome.



Rules:



```text

Preflight/location failure   → ₹0

Queue drop                   → ₹5

Customer abort              → ₹5

Rejected                     → ₹5

Aborted                      → ₹5

Dropped during call         → ₹5

Approved                     → ₹25

```



Store money as integer paise:



```text

₹25 = 2500

₹5  = 500

```



\---



\## 31.1 Billing Idempotency



The billing table must enforce:



```text

UNIQUE(session\_id)

```



This prevents:



```text

Approve

Approve

Approve

```



from creating:



```text

₹25

₹25

₹25

```



Instead, there can only be one billing entry.



\---



\# 32. Authentication



\## Customer



The enterprise initially authenticates itself using an API key.



The Control API creates a short-lived session token bound to the specific session.



The customer must not receive unrestricted tenant credentials.



\---



\## Agent



For MVP:



```text

Email + Password

        ↓

JWT

```



JWT contains:



```text

user\_id

tenant\_id

role

expiration

```



Later:



```text

SSO

OIDC

SAML

```



can be added.



\---



\# 33. Tenant Isolation



Every tenant-owned record must contain:



```text

tenant\_id

```



Example:



```text

sessions

\---------

id

tenant\_id

status

...

```



Every backend query must enforce tenant ownership.



An agent belonging to Tenant A must never access a session belonging to Tenant B.



The tenant ID should come from authenticated context rather than trusting:



```json

{

  "tenant\_id": "..."

}

```



from the request body.



\---



\# 34. Data Ownership



A useful mental model is:



```text

              CONTROL DATA

                  |

                  v

             PostgreSQL

                  |

                  |

      TEMPORARY SENSITIVE DATA

                  |

                  v

              Redis / S3

                  |

                  |

           FINAL EVIDENCE

                  |

                  v

         Enterprise Storage

```



The platform should not become the permanent archive.



The enterprise owns the final long-term evidence.



\---



\# 35. API Communication



There are three primary communication patterns.



\## REST



Used for commands and normal queries.



Example:



```text

Create session

Submit preflight

Join queue

Accept session

Submit verdict

```



\---



\## WebSocket



Used for real-time updates.



Example:



```text

Queue position changed

Agent assigned

AI score updated

Call ended

```



\---



\## WebRTC / LiveKit



Used for audio and video.



Example:



```text

Customer video

Agent video

Customer audio

Agent audio

```



The Control API does not transport the actual video.



\---



\# 36. Example End-to-End Request Flow



A customer starts verification.



\### Step 1



```text

Customer

   |

POST /v1/sessions

   |

   v

Control API

   |

   v

PostgreSQL

   |

   v

CREATED

```



\### Step 2



```text

POST /consent

POST /preflight

POST /location

```



Control API updates the session.



\---



\### Step 3



```text

POST /queue

```



Control API:



```text

PostgreSQL → status = QUEUED

Redis      → add session to queue

```



\---



\### Step 4



Agent becomes available.



```text

Agent Portal

     |

     v

POST /agent/availability

     |

     v

Redis

```



\---



\### Step 5



Queue matcher finds:



```text

Customer + Agent

```



Then:



```text

PostgreSQL

QUEUED → IN\_CALL

agent\_id = A1

```



\---



\### Step 6



Control API generates LiveKit tokens.



```text

Customer → LiveKit

Agent    → LiveKit

```



Call starts.



\---



\### Step 7



Analyzer receives customer video.



```text

LiveKit

   |

   v

AI Analyzer

   |

   v

Liveness / Face / OCR

   |

   v

Redis

   |

   v

WebSocket

   |

   v

Agent Portal

```



\---



\### Step 8



Agent submits:



```text

POST /agent/sessions/{id}/verdict

```



Backend:



```text

Validate checklist

        |

        v

Update session

        |

        v

Create billing entry

        |

        v

Snapshot AI summary

        |

        v

Create export job

```



\---



\### Step 9



Egress worker processes the recording.



```text

Recording

   |

   v

Watermark

   |

   v

Audit

   |

   v

Sign

   |

   v

Enterprise S3

```



\---



\### Step 10



Webhook worker notifies enterprise.



```text

Enterprise

    |

    v

session.completed

```



\---



\# 37. Failure Handling



\## Customer leaves queue



```text

QUEUED

   |

   v

DROPPED\_QUEUED

   |

   v

₹5

```



\---



\## Customer disconnects during call



```text

IN\_CALL

   |

   v

DROPPED\_IN\_CALL

   |

   v

₹5

```



\---



\## Agent disconnects [UPDATED]

The Control API receives the LiveKit participant event.

```text
Agent disconnects
       |
       v
Session stays IN_CALL
Append AGENT_DISCONNECTED to session_events
Start reconnect window (tenants.agent_reconnect_timeout_seconds)
       |
       +---- Agent reconnects --> append AGENT_RECONNECTED, call resumes
       |
       +---- Timeout ----------> ABORTED (Rs 5)
```

No `agent_disconnected_at` column is added to `sessions`; disconnect history
lives in `session_events`. Termination on timeout uses the same single-winner
guard as any other terminal transition. Automatic reassignment is not
implemented in the MVP. See D18 and D25.
\## AI unavailable



The video call continues.



Agent sees:



```text

AI unavailable

```



The session can continue unless AI is configured as mandatory.



\---



\## LiveKit unavailable



The customer cannot enter the call.



The session should not incorrectly become `APPROVED`.



The session remains in a recoverable state or moves to a controlled failure state.



\---



\## Redis unavailable



The queue/presence layer is affected.



PostgreSQL remains the source of truth.



For MVP, Redis recovery can be handled operationally rather than building a complex failover mechanism.



\---



\## PostgreSQL unavailable



No business-state mutation should be treated as successful.



The backend should return an error rather than pretending the operation succeeded.



\---



\## Object Storage unavailable



The session remains billable.



Export is retried.



Temporary evidence is retained until the configured retention limit.



\---



\# 38. Security Boundaries



The system should be divided into public and private components.



```text

PUBLIC

\--------------------------------

Customer API

Agent Portal

WebSocket

LiveKit signaling

TURN





PRIVATE

\--------------------------------

PostgreSQL

Redis

AI service

Egress worker

Temporary object storage

KMS

Secrets

```



The internet should never directly access:



\* PostgreSQL

\* Redis

\* AI workers

\* Egress workers



\---



\# 39. Sensitive Data Boundaries



A simplified data classification:



```text

LOW SENSITIVITY

\----------------

session\_id

tenant\_id

status

timestamps

billing category





SENSITIVE

\----------------

GPS

IP

AI scores

OCR output

reference face





HIGHLY SENSITIVE

\----------------

Raw video

Face images

Identity document images

Government identity information

```



The higher-sensitivity data should have stricter retention and access controls.



\---



\# 40. Logging



Application logs must not contain:



```text

Raw video

GPS coordinates

PAN

Aadhaar

Face images

OCR text

Passwords

API keys

JWTs

```



Logs should prefer:



```text

session\_id

tenant\_id

event

duration

status

error\_code

```



Example:



```text

session\_id=123

event=EXPORT\_FAILED

provider=S3

retry=2

```



\---



\# 41. Observability for MVP



The MVP only needs a small set of important metrics.



\### Session



```text

sessions\_created

sessions\_queued

sessions\_completed

sessions\_failed

```



\### Queue



```text

queue\_depth

queue\_wait\_time

assignment\_latency

```



\### Video



```text

call\_setup\_time

call\_duration

disconnect\_count

```



\### AI



```text

ai\_latency

ai\_failure\_count

ai\_updates

```



\### Export



```text

export\_success

export\_failure

export\_latency

```



\### Billing



```text

approved\_sessions

failed\_sessions

billed\_amount

```



\---



\# 42. Deployment Architecture



For the first MVP, keep deployment simple.



```text

                    AWS Mumbai

                        |

        +---------------+---------------+

        |               |               |

        v               v               v

     Frontend         API            LiveKit

        |               |

        |               +---- PostgreSQL

        |               |

        |               +---- Redis

        |               |

        |               +---- AI

        |               |

        |               +---- Egress Worker

        |

        v

      Browser

```



Recommended MVP infrastructure:



```text

AWS

Region: ap-south-1



Frontend: Next.js

Backend: NestJS

AI: FastAPI

Database: PostgreSQL

Cache: Redis

Media: LiveKit

Storage: S3

```



Do not introduce multi-region infrastructure for the first demo.



\---



\# 43. Deployment Units



Initial deployment can be:



```text

1\. Customer Web App

2\. Agent Web App

3\. NestJS API

4\. AI Service

5\. Egress Worker

6\. LiveKit

7\. PostgreSQL

8\. Redis

9\. S3

```



Some components can run together initially.



Example:



```text

AI Service

\+

Egress Worker

```



could be deployed separately later.



\---



\# 44. Repository Structure



Recommended structure:



```text

kyc/

│

├── apps/

│   ├── api/

│   │   └── src/

│   │       ├── auth/

│   │       ├── tenants/

│   │       ├── sessions/

│   │       ├── queue/

│   │       ├── agents/

│   │       ├── livekit/

│   │       ├── checklist/

│   │       ├── billing/

│   │       ├── exports/

│   │       └── webhooks/

│   │

│   ├── customer/

│   │

│   ├── agent/

│   │

│   ├── ai/

│   │

│   └── egress/

│

├── packages/

│   └── shared/

│

├── docs/

│   ├── 01-product-flow.md

│   ├── 02-system-architecture.md

│   ├── 03-api-design.md

│   ├── 04-database-design.md

│   └── 05-development-plan.md

│

└── infra/

```



\---



\# 45. MVP vs Production Architecture



\## MVP



```text

Modular Monolith

\+

Single AI service

\+

Single Redis

\+

Single PostgreSQL

\+

Single LiveKit deployment

\+

Single S3

\+

Single AWS region

```



\## Production



Can evolve into:



```text

API Service

Queue Service

Session Service

WebSocket Gateway

AI Grabber

Liveness Worker

Face Worker

OCR Worker

Egress Worker

Webhook Worker

Purge Worker

Analytics

```



and eventually:



```text

Multi-AZ

Multi-region

Autoscaling

Advanced routing

Multiple providers

Native SDKs

Enterprise SSO

Advanced AI

```



The MVP architecture should make these possible without requiring them now.



\---



\# 46. Important Architecture Decisions



\## ADR-001 — Modular monolith



Use a modular monolith for the MVP.



Reason:



One engineer should not have to operate many independent services.



\---



\## ADR-002 — PostgreSQL is authoritative



Reason:



Business state needs transactions and strong consistency.



\---



\## ADR-003 — Redis for queue and temporary state



Reason:



Queue and presence require low latency.



\---



\## ADR-004 — LiveKit for WebRTC



Reason:



Do not build WebRTC infrastructure from scratch.



\---



\## ADR-005 — AI outside the video critical path



Reason:



AI failures should not terminate the communication channel.



\---



\## ADR-006 — Vendor/mock AI first



Reason:



The MVP validates the product workflow, not the creation of a proprietary AI model.



\---



\## ADR-007 — S3 for MVP storage



Reason:



Simple object storage with lifecycle support and easy integration.



\---



\## ADR-008 — One region first



Reason:



Prove the product before building multi-region infrastructure.



\---



\## ADR-009 — Web customer app first



Reason:



Native Android/iOS SDKs would significantly increase MVP scope.



\---



\## ADR-010 — Outcome-based billing



Reason:



Billing is directly tied to the business model and must be represented as a durable ledger.



\---



\# 47. Architecture Invariants



These rules must always remain true.



\### Invariant 1



PostgreSQL is the source of truth for session state.



\### Invariant 2



A session can have at most one assigned agent at any point in time.



\### Invariant 3



A session can have at most one billing entry.



\### Invariant 4



A session can have only one final verdict.



\### Invariant 5



Customer video does not pass through the Control API.



\### Invariant 6



AI does not directly decide the final verdict.



\### Invariant 7



Sensitive temporary data must have bounded retention.



\### Invariant 8



Tenant A must never access Tenant B's sessions.



\### Invariant 9



Export failure must not reverse billing.



\### Invariant 10



The enterprise owns the permanent evidence archive.



\---



\# 47a. Additional Required Endpoints [UPDATED]

Two control-plane surfaces are required that earlier drafts omitted:

```text
POST /internal/livekit/webhook     participant + room lifecycle (D7)
GET  /v1/agent/sessions/:id/checklist   pinned checklist template (D8)
```

All `/internal/*` endpoints require a shared internal credential
(`X-Internal-Token`) and are not routed publicly. The LiveKit webhook
additionally verifies LiveKit's own signature header. See D10.

WebSocket connections authenticate with a short-lived connection token passed as
a query parameter, scoped to tenant plus session (customer) or user (agent).
See D9.

\---

\# 48. What We Are NOT Building in MVP



Do not add these unless a concrete product requirement appears:



```text

Android SDK

iOS SDK

Kafka

Microservice-per-component

Multi-region deployment

Complex Kubernetes setup

Multiple storage providers

Multiple KYC providers

Complex routing engine

Advanced fraud engine

Custom liveness model

Enterprise SSO

Advanced analytics

Active-active media infrastructure

```



The goal is a reliable end-to-end product, not maximum infrastructure complexity.



\---



\# 49. Final MVP Architecture



The complete MVP can be summarized as:



```text

                       CUSTOMER

                          |

                     Customer Web

                          |

                    REST / WebSocket

                          |

                          v

                  +----------------+

                  |  Control API   |

                  |    NestJS      |

                  +---+---+---+----+

                      |   |   |

              +-------+   |   +--------+

              |           |            |

              v           v            v

         PostgreSQL     Redis       LiveKit

              |           |            |

              |       Queue/Presence   |

              |       AI HUD           |

              |                        |

              |                  +-----+-----+

              |                  |           |

              |               Customer     Agent

              |                  |

              |                  v

              |             AI Analyzer

              |             /    |    \\

              |          Live  Face   OCR

              |             \\    |    /

              |                  |

              |                  v

              |                Redis

              |                  |

              |             WebSocket

              |                  |

              |                  v

              |             Agent HUD

              |

              v

         Verdict + Billing

              |

              v

         Egress Worker

              |

        +-----+------+

        |            |

        v            v

     FFmpeg       Audit

        |            |

        +-----+------+

              |

           Sign

              |

              v

             S3

              |

              v

          Enterprise

              |

              v

           Webhook

              |

              v

          Cleanup

```



This architecture is the technical foundation for the V-CIP MVP.





