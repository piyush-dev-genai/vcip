/**
 * Enterprise API key authentication (D14).
 *
 *   Authorization: Bearer <tenant_api_key>
 *
 * The plaintext key exists only as a local, never assigned to the actor, never
 * attached to the request, never logged. What survives authentication is the
 * key's id, its tenant, and its scopes.
 */

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { ApiKeyStore } from './api-key.store.js';
import { InjectApiKeyStore, hashApiKey, hashMatches, parseApiKeyPrefix } from './api-key.store.js';
import type { AuthenticatedRequest } from './auth-context.js';
import { bearerFrom } from './tokens.js';

/**
 * One message for every failure mode.
 *
 * A caller must not be able to distinguish "no such key" from "revoked",
 * "expired", or "belongs to another tenant". Each is a different branch below
 * and the same response out.
 */
const reject = (): never => {
  throw new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Invalid or missing API key.',
  });
};

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@InjectApiKeyStore() private readonly store: ApiKeyStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const presented = bearerFrom(request.headers.authorization);
    if (presented === null) return reject();

    const prefix = parseApiKeyPrefix(presented);
    if (prefix === null) return reject();

    const record = await this.store.findByPrefix(prefix);
    if (record === null) return reject();

    // Constant-time. The prefix is public and indexed; the secret is not.
    if (!hashMatches(hashApiKey(presented), record.keyHash)) return reject();

    if (record.revokedAt !== null) return reject();
    if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) return reject();

    request.actor = {
      kind: 'enterprise',
      tenantId: record.tenantId,
      apiKeyId: record.id,
      // Frozen copy: a downstream handler must not be able to grant itself a
      // scope by mutating the array it was handed.
      scopes: Object.freeze([...record.scopes]),
    };

    return true;
  }
}
