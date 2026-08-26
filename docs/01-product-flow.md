# V-CIP MVP — Product Flow

> Approved decisions live in `docs/00-decisions.md`. Where any document conflicts
> with that decision record, the decision record wins.

## 1. Product

V-CIP is a B2B video verification infrastructure platform for banks, NBFCs, and fintechs.

It connects a customer with a human verification agent through a live video session, provides AI-assisted verification, generates tamper-evident evidence, and delivers the result to the enterprise.

---

## 2. Actors

### Customer
The person being verified through the V-CIP process.

### Agent
A human verification operator who conducts the video verification and gives the final verdict.

### Enterprise
The bank/NBFC/fintech integrating V-CIP into its customer onboarding flow.

---

## 3. Core MVP Flow

```text
Enterprise Backend
   |
   v
Create Session  (enterprise API key, server-side only)
   |
   v
Customer receives short-lived session-scoped token
   |
   v
Consent
   |
   v
Preflight Checks  (measured values, server applies thresholds)
   |
   +---- FAIL ----> PREFLIGHT_FAILED  (Rs 0)
   |
   v
Location Verification
   |
   +---- FAIL ----> PREFLIGHT_FAILED  (Rs 0)
   |
   v
Join Queue  (QUEUED)
   |
   v
Matcher signals eligible agents
   |
   v
Agent claims session  (OFFERED)
   |
   +---- offer timeout ----> back to QUEUED
   |
   v
Agent accepts  (IN_CALL)
   |
   v
Live Video Call
   |
   +----> AI Assistance (assistive only)
   |       - Liveness
   |       - Face Match
   |       - Document/OCR
   |
   v
Agent Checklist
   |
   v
Agent Verdict
   |
   +---- APPROVED ----> Rs 25
   |
   +---- REJECTED ----> Rs 5
   |
   +---- ABORTED -----> Rs 5
   |
   v
Recording
   |
   v
Watermark + Audit + Signature
   |
   v
Export to Enterprise Storage
   |
   v
Webhook  (independent, retried)
   |
   v
Cleanup
```

---

## 4. Session State

Session state has **two independent axes**. Business state and evidence state are
never stored in the same field.

### 4.1 `session.status` — business lifecycle

```text
CREATED
   |
   +--> PREFLIGHT_FAILED        (terminal, Rs 0, no billing row)
   |
   v
QUEUED <-------------------+
   |                       |
   |                       | offer timeout
   +--> DROPPED_QUEUED     |    (terminal, Rs 5)
   |                       |
   v                       |
OFFERED --------------------+
   |
   v
IN_CALL
   |
   +--> APPROVED            (terminal, Rs 25)
   +--> REJECTED            (terminal, Rs 5)
   +--> ABORTED             (terminal, Rs 5)
   +--> DROPPED_IN_CALL     (terminal, Rs 5)
```

Complete set of allowed values:

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

A terminal business status is final. It is never overwritten by evidence
processing.

### 4.2 `session.export_status` — evidence lifecycle

```text
NOT_STARTED
   |
   v
EXPORTING  (covers the whole retry loop)
   |
   +--> FAILED     (retries exhausted, terminal;
   |                enterprise still notified with
   |                evidence_available: false)
   v
EXPORTED
   |
   v
PURGED
```

Complete set of allowed values:

```text
NOT_STARTED
EXPORTING
EXPORTED
FAILED
PURGED
```

The backend is the source of truth for both axes.

---

## 5. Customer Flow

1. The enterprise backend creates the session and hands the customer a short-lived,
   session-scoped token. The enterprise API key never reaches the browser.
2. Customer accepts consent.
3. The client measures and submits preflight values:
   - camera width / height
   - microphone level
   - network round-trip time
   - estimated downlink
   - lighting score
   - stability score

   The server applies the tenant's configured thresholds and decides eligibility.
   The client does not decide whether preflight passed.
4. Customer provides location. The backend validates GPS accuracy and IP country.
5. Customer joins the agent queue.
6. Customer receives queue and assignment updates over WebSocket, with REST polling
   as a fallback.
7. Customer connects to the video call.
8. Customer shows face and identity document.
9. Customer receives final status.

---

## 6. Agent Flow

1. Agent logs into the agent portal.
2. Agent becomes available; presence is refreshed by heartbeat.
3. The matcher signals that eligible queued sessions exist.
4. Agent explicitly claims a session. The claim is atomic: exactly one agent wins,
   and the session moves `QUEUED -> OFFERED`.
5. Agent accepts, moving `OFFERED -> IN_CALL`. If the agent does not accept within
   the configured offer timeout, the session returns to `QUEUED`.
6. Agent joins the video call and sees:
   - Customer video
   - Liveness score
   - Face-match score
   - Document/OCR status
   - Location status
7. Agent completes the verification checklist.
8. Agent submits `APPROVED`, `REJECTED`, or `ABORTED`.

The agent makes the final decision. AI is assistive only.

Automatic reassignment is **not** implemented in the MVP. If an agent disconnects,
the session stays `IN_CALL`, `AGENT_DISCONNECTED` is appended to `session_events`,
and a short reconnect window applies. On reconnect, `AGENT_RECONNECTED` is
appended and the call resumes. On expiry the session becomes `ABORTED` (Rs 5).
No disconnect column is added to `sessions`.

---

## 7. Evidence Flow

After the session reaches a terminal business status:

```text
Live Video
    |
    v
Recording
    |
    v
Watermark (FFmpeg burn-in)
    |
    v
Generate audit.json (canonical)
    |
    v
Generate audit.sig (Ed25519 via SigningKeyProvider)
    |
    v
Upload to Enterprise Storage
    |
    v
export_status = EXPORTED
    |
    +----> Webhook to enterprise (independent, retried)
    |
    v
Delete temporary platform data -> export_status = PURGED
```

The final evidence package contains:

```text
video.mp4
audit.json
audit.sig
```

Export, webhook delivery, and cleanup are independent concerns. Cleanup is not
blocked by webhook delivery once evidence is safely exported and verified.

The webhook outbox row is created in the verdict transaction so it can never be
lost, and is delivered once the export state resolves:

```text
export EXPORTED -> payload carries evidence keys, evidence_available = true
export FAILED   -> payload carries evidence_available = false, keys null
```

The enterprise is notified either way. Billing is never reversed by an export
or webhook failure.

---

## 8. Billing

| Outcome                | Amount |
| ---------------------- | -----: |
| Preflight failure      |   Rs 0 |
| Created, never queued  |   Rs 0 |
| Queue drop             |   Rs 5 |
| Rejected               |   Rs 5 |
| Aborted                |   Rs 5 |
| Disconnect during call |   Rs 5 |
| Approved               |  Rs 25 |

Billing is idempotent: one session can generate at most one billing entry,
enforced by `billing_entries.session_id` being the primary key.

Billing is never reversed by an export or webhook failure.

---

## 9. MVP Scope

### Must Have

```text
Customer session creation (enterprise server-side)
Consent
Preflight with measured values
Location validation
Queue with pull-claim (QUEUED -> OFFERED -> IN_CALL)
Agent portal
Atomic agent claim
WebRTC video call
Recording
Basic AI liveness
Basic face match
Basic document detection/OCR
Agent checklist
Approve/reject/abort
Billing
Watermarked recording
Audit JSON
Ed25519 signature
S3 export
Webhook with retry
Cleanup
```

### Later

```text
Native Android SDK
Native iOS SDK
Multiple KYC providers
Multiple cloud storage providers
Advanced routing
Automatic session reassignment
Advanced fraud detection
Multi-region infrastructure
Enterprise SSO
Advanced analytics
High-scale optimization
```

---

## 10. MVP Success Criteria

A complete session should work end-to-end with no manual database intervention:

```text
CREATE
  v
VERIFY
  v
QUEUE
  v
OFFER + ACCEPT
  v
LIVE CALL
  v
AI ASSISTANCE
  v
HUMAN VERDICT
  v
BILLING
  v
SIGNED EVIDENCE
  v
ENTERPRISE EXPORT
  v
WEBHOOK
  v
CLEANUP
```

And these scenarios must hold:

```text
Preflight failure       -> Rs 0, no billing row
Created, never queued   -> Rs 0, no billing row
Queue abort             -> Rs 5
Rejected                -> Rs 5
Approved                -> Rs 25
Customer disconnect     -> Rs 5
Offer timeout           -> session returns to QUEUED, not billed
Export failure          -> retried, billing not reversed
Duplicate claim         -> one agent only, second gets 409
Duplicate verdict       -> one verdict, one billing entry
Verdict/disconnect race -> first valid terminal transition wins, loser gets 409
```
