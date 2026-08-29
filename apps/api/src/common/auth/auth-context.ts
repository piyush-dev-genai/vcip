/**
 * Authenticated actor context.
 *
 * This answers "who are you?" and nothing else. Which tenant an actor may
 * operate within, and whether a given row belongs to them, is
 * `TenantScope`'s job — see `tenant-scope.ts`. Keeping the two apart is what
 * stops "authenticated" quietly becoming "authorized".
 *
 * A discriminated union rather than a bag of optional fields: a customer actor
 * has no `userId`, an internal actor has no tenant at all, and the type system
 * should say so rather than leaving every caller to guess.
 */

/** Roles the MVP supports. Mirrors `users.role` and its CHECK constraint. */
export const ActorRole = {
  AGENT: 'AGENT',
  TENANT_ADMIN: 'TENANT_ADMIN',
} as const;

export type ActorRole = (typeof ActorRole)[keyof typeof ActorRole];

export const ACTOR_ROLES: readonly ActorRole[] = Object.freeze(Object.values(ActorRole));

export function isActorRole(value: unknown): value is ActorRole {
  return typeof value === 'string' && (ACTOR_ROLES as readonly string[]).includes(value);
}

/**
 * The enterprise backend, holding a tenant API key (D14). Creates sessions on
 * behalf of its own tenant and never reaches a customer browser.
 */
export interface EnterpriseActor {
  readonly kind: 'enterprise';
  readonly tenantId: string;
  /** Which key authenticated, for audit. Never the key itself. */
  readonly apiKeyId: string;
  readonly scopes: readonly string[];
}

/**
 * A customer browser holding a short-lived, session-scoped token (R8). Bound to
 * exactly one session; it can do nothing outside that session.
 */
export interface CustomerActor {
  readonly kind: 'customer';
  readonly tenantId: string;
  readonly sessionId: string;
}

/** An agent or tenant admin holding a JWT. */
export interface AgentActor {
  readonly kind: 'agent';
  readonly tenantId: string;
  readonly userId: string;
  readonly role: ActorRole;
}

/**
 * A trusted internal service: the AI service, the egress worker, or the LiveKit
 * webhook (D10).
 *
 * Deliberately carries NO tenant. Internal callers act across tenants and
 * resolve the tenant from the resource they name, which is why `TenantScope`
 * refuses them on tenant-scoped routes rather than inventing a tenant for them.
 */
export interface InternalActor {
  readonly kind: 'internal';
  readonly service: 'internal';
}

export type Actor = EnterpriseActor | CustomerActor | AgentActor | InternalActor;

/**
 * The tenant an actor is bound to, or null when it has none.
 *
 * The only null case is an internal actor. Everything else carries a tenant
 * that came from a verified credential, never from the request payload.
 */
export function tenantOf(actor: Actor): string | null {
  return actor.kind === 'internal' ? null : actor.tenantId;
}

/**
 * The request surface authentication actually touches, plus the actor a guard
 * attaches.
 *
 * Structural rather than `extends express.Request`: these four fields are
 * everything the guards read, and describing exactly that keeps the auth layer
 * free of a dependency on one HTTP framework's request type. An Express
 * request satisfies it; so does a test double built from an object literal.
 *
 * Guards assign `req.actor`; handlers read it through the `@Auth()` decorator
 * rather than reaching into the request, so the actor is typed at the point of
 * use instead of being an untyped property.
 */
export interface AuthenticatedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  actor?: Actor;
}

/** The header carrying the internal shared credential (D10). */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
