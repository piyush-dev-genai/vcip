/**
 * The decisions a claim makes that need no I/O (T18).
 *
 * Same split as `agent-queue.rules.ts`: everything here is a pure function of
 * values already fetched, so the eligibility rules can be tested exhaustively
 * without a database, a Redis, or a Nest container — and so the service reads
 * as a sequence of named decisions rather than a wall of conditionals.
 *
 * What is deliberately **not** here: the claim itself. Single-winner is a
 * property of one PostgreSQL statement (D5), and no pure function can stand in
 * for it. These rules decide whether it is worth attempting.
 */

import type { AgentPresence } from '@vcip/shared';
import { AgentPresence as Presence } from '@vcip/shared';

/**
 * Whether a live presence permits this agent to claim.
 *
 * `AVAILABLE` only. `BUSY` is an agent already holding work, and `UNAVAILABLE`
 * is one who has stepped away — and `null` covers both "never went available"
 * and "the TTL lapsed", which are the same fact from here: nobody is at the
 * desk.
 *
 * This is an eligibility pre-check, not the concurrency guard. Redis presence
 * is not authoritative business state (D1/D2): it can expire between this
 * function returning true and the UPDATE running, and that is fine, because
 * the UPDATE is what decides.
 */
export function presenceAllowsClaim(status: AgentPresence | null): boolean {
  return status === Presence.AVAILABLE;
}

/**
 * When an offer lapses.
 *
 * `offered_at + tenants.offer_timeout_seconds`, computed once here so the value
 * the agent is told and the value T20 will sweep against come from the same
 * rule rather than from two places that could drift.
 *
 * The timeout is not clamped or defaulted. A non-positive value cannot reach
 * this — the column has `CHECK (offer_timeout_seconds > 0)` — and silently
 * substituting a default for a tenant configuration would hide a real
 * misconfiguration behind a plausible expiry.
 */
export function offerExpiresAt(offeredAt: Date, timeoutSeconds: number): Date {
  return new Date(offeredAt.getTime() + timeoutSeconds * 1000);
}
