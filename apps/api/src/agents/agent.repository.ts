/**
 * The PostgreSQL side of the agent module.
 *
 * Two reads and no writes. T16 does not persist availability, does not record a
 * login, and does not touch `sessions` — PostgreSQL is consulted here for
 * identity and configuration only, and live presence lives in Redis (D1/D2).
 *
 * Port plus adapter, as with `ApiKeyStore` (T09), `SessionRepository` (T12) and
 * `QueueRepository` (T15): the service depends on the interface, so the login
 * and presence rules are testable without a database, and every SQL statement
 * the agent module issues is in this one file.
 */

import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { agentProfiles, tenants, users } from '../../db/schema.js';
import { DATABASE } from '../common/db/db.tokens.js';

/**
 * What login needs to know about a user.
 *
 * `passwordHash` is here because verifying is this module's job; it leaves this
 * file only into `verifyPassword`, is never returned from a service, never
 * enters a JWT, and never reaches a log — `logger.ts` redacts the field name,
 * and `event-payload.ts` refuses it outright.
 */
export interface AgentCredentialRow {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly tenantStatus: string;
  readonly passwordHash: string | null;
}

/**
 * The static agent configuration presence is derived from.
 *
 * `maxConcurrent` is returned although T16 never uses it: R5 enforces it at
 * claim time, and the read that T18 will need belongs with the profile rather
 * than in a second query bolted on later. It is deliberately *not* written to
 * Redis.
 */
export interface AgentProfileRow {
  readonly userId: string;
  readonly tenantId: string;
  readonly languages: readonly string[];
  readonly maxConcurrent: number;
}

export interface AgentRepository {
  /**
   * Find a user by tenant slug and email.
   *
   * The slug, not a tenant id: login has no credential yet, so the tenant comes
   * from the request. That is safe precisely because it selects a namespace and
   * grants nothing — the password still has to match a row that the join
   * proves belongs to that tenant. `users_tenant_email_unique` is on
   * `(tenant_id, email)`, so this pair identifies at most one row.
   */
  findAgentByEmail(tenantSlug: string, email: string): Promise<AgentCredentialRow | null>;

  /**
   * The agent's profile, scoped to the tenant that authenticated.
   *
   * `tenantId` is a parameter rather than something derived from `userId`
   * inside the query: it comes from the verified JWT, and passing it into the
   * WHERE clause makes cross-tenant access impossible at the SQL level rather
   * than by a check the caller has to remember (invariant I8).
   */
  findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null>;
}

export const AGENT_REPOSITORY = Symbol('AGENT_REPOSITORY');

export const InjectAgentRepository = (): ParameterDecorator => Inject(AGENT_REPOSITORY);

@Injectable()
export class DrizzleAgentRepository implements AgentRepository {
  constructor(@Inject(DATABASE) private readonly db: PostgresJsDatabase) {}

  async findAgentByEmail(tenantSlug: string, email: string): Promise<AgentCredentialRow | null> {
    const [row] = await this.db
      .select({
        userId: users.id,
        tenantId: users.tenantId,
        email: users.email,
        role: users.role,
        status: users.status,
        tenantStatus: tenants.status,
        passwordHash: users.passwordHash,
      })
      .from(users)
      // An inner join, so a user whose tenant row is missing yields nothing
      // rather than a user with no tenant status to check.
      .innerJoin(tenants, eq(tenants.id, users.tenantId))
      .where(and(eq(tenants.slug, tenantSlug), eq(users.email, email)))
      .limit(1);

    return row ?? null;
  }

  async findProfile(userId: string, tenantId: string): Promise<AgentProfileRow | null> {
    const [row] = await this.db
      .select({
        userId: agentProfiles.userId,
        tenantId: users.tenantId,
        languages: agentProfiles.languages,
        maxConcurrent: agentProfiles.maxConcurrent,
      })
      .from(agentProfiles)
      // `agent_profiles` carries no `tenant_id` of its own — it is keyed by
      // `user_id` alone (see the schema's note on why tenant is not duplicated
      // there). The join to `users` is what makes the tenant predicate below
      // enforceable in SQL.
      .innerJoin(users, eq(users.id, agentProfiles.userId))
      .where(and(eq(agentProfiles.userId, userId), eq(users.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }
}
