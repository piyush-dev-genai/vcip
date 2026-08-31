/**
 * Request schemas for agent identity and presence (T16).
 *
 * Same reasoning as `session.ts`: these live in `@vcip/shared` because the
 * agent app validates the payloads before sending them, so the browser cannot
 * believe a body is acceptable that the Control API will reject.
 *
 * Three rules are expressed here rather than in prose:
 *
 *   - **The agent never names itself.** No `agent_id`, no `user_id`. The
 *     Control API takes the agent from the verified JWT, and `strictObject`
 *     turns an attempt to supply one into a 400 instead of something the server
 *     has to remember to ignore.
 *   - **The agent never names its tenant on an authenticated route.** Only
 *     login carries `tenant_slug`, and only because there is no credential yet
 *     to derive it from — `users.email` is unique per tenant, not globally, so
 *     `{email, password}` alone does not identify a row.
 *   - **The agent never sets `BUSY`.** `BUSY` is server state, set on claim and
 *     cleared on session end (R5). It is absent from the availability schema,
 *     so the rejection is structural rather than a check someone could delete.
 *
 * Field names are snake_case: this is the JSON wire contract, not internal
 * TypeScript style.
 */

import { z } from 'zod';
import { AgentPresence } from '../enums.js';

// ----------------------------------------------------------------- login

/**
 * Email is normalised to lower case on the way in.
 *
 * `users_tenant_email_unique` is a plain B-tree on `(tenant_id, email)`, so the
 * stored value is matched byte for byte. Normalising here — in the one schema
 * both the browser and the server parse with — is what lets an agent type
 * `Agent.One@Demo.local` and still match the seeded row, without the lookup
 * having to wrap the column in `lower()` and abandon the index.
 *
 * Same shape as `normaliseLanguage` in the queue: one rule, one place, applied
 * identically on both sides of the wire.
 */
const email = () =>
  z
    .string()
    .min(3)
    .max(320)
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'must be an email address');

/**
 * `POST /v1/agent/login`.
 *
 * `tenant_slug` is present because login is the one agent route with no
 * credential to derive a tenant from, and email is only unique within a tenant.
 * It is not a secret and it is not authority: it selects which tenant's user
 * table to look in, and the password still has to match.
 *
 * The password is bounded at both ends. A minimum because a shorter one is not
 * a password; a maximum because a KDF is CPU work and an unbounded input is a
 * free denial of service.
 */
export const agentLoginSchema = z.strictObject({
  tenant_slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a tenant slug'),
  email: email(),
  password: z.string().min(8).max(200),
});

export type AgentLoginRequest = z.infer<typeof agentLoginSchema>;

// ---------------------------------------------------------- availability

/**
 * The presence values an agent may set on itself.
 *
 * Written as literals so zod infers a union of exactly these two rather than
 * the whole `AgentPresence` type. `agent.spec.ts` asserts this list equals
 * `AGENT_SETTABLE_PRESENCES`, so adding a value in one place and not the other
 * fails a test instead of silently diverging.
 */
export const AGENT_AVAILABILITY_VALUES = [
  AgentPresence.AVAILABLE,
  AgentPresence.UNAVAILABLE,
] as const;

/** `POST /v1/agent/availability`. */
export const agentAvailabilitySchema = z.strictObject({
  status: z.enum(AGENT_AVAILABILITY_VALUES),
});

export type AgentAvailabilityRequest = z.infer<typeof agentAvailabilitySchema>;

// ------------------------------------------------------------- heartbeat

/**
 * `POST /v1/agent/heartbeat` — no fields at all.
 *
 * An empty `strictObject` rather than no schema. The heartbeat refreshes the
 * agent's own presence and has nothing to say about it: not which agent, not
 * which status, not which languages. Parsing `{}` strictly is what makes
 * "the client cannot influence the heartbeat" testable rather than incidental.
 */
export const agentHeartbeatSchema = z.strictObject({});

export type AgentHeartbeatRequest = z.infer<typeof agentHeartbeatSchema>;

// ----------------------------------------------------------------- claim

/**
 * `POST /v1/agent/sessions/{session_id}/claim` — no fields at all.
 *
 * Everything the claim needs is already established: the session is in the
 * path, and the agent and the tenant come from the verified JWT. An empty
 * `strictObject` is what makes that structural — a body carrying `agent_id`,
 * `tenant_id`, `language`, or a `priority` the caller would like applied is a
 * 400, not a field the server has to remember not to read.
 *
 * Note what is absent from the *response* contract too (§17.1): no
 * `external_ref`, no customer identifier, no queue internals. Claiming tells an
 * agent that the offer is theirs and when it lapses; the session itself is
 * fetched through the routes that already exist.
 */
export const agentClaimSchema = z.strictObject({});

export type AgentClaimRequest = z.infer<typeof agentClaimSchema>;

// ---------------------------------------------------------------- accept

/**
 * `POST /v1/agent/sessions/{session_id}/accept` — no fields either.
 *
 * The agent is in the JWT, the session is in the path, and everything the
 * accept decides is already recorded: an unexpired offer in this agent's name.
 * There is nothing left for a body to contribute, and a strict empty object
 * says so structurally — a request offering an `agent_id`, a `connected_at`, or
 * a `room_name` it would like used is a 400 rather than a field the server has
 * to remember not to trust.
 */
export const agentAcceptSchema = z.strictObject({});

export type AgentAcceptRequest = z.infer<typeof agentAcceptSchema>;
