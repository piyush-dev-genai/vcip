/**
 * Typed access to the authenticated actor.
 *
 * Handlers take `@Auth() actor: Actor` rather than reaching into
 * `request.actor`, so the actor is typed at the point of use instead of being
 * an untyped property that every caller has to narrow for itself.
 */

import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator, UnauthorizedException } from '@nestjs/common';
import { ErrorCode } from '@vcip/shared';
import type { Actor, AuthenticatedRequest } from './auth-context.js';

/**
 * The authenticated actor.
 *
 * Throws if no guard ran. That is a wiring mistake, not a client error, and it
 * should fail loudly the first time rather than hand a handler `undefined`.
 */
export const Auth = createParamDecorator((_data: unknown, context: ExecutionContext): Actor => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.actor === undefined) {
    throw new UnauthorizedException({
      code: ErrorCode.UNAUTHENTICATED,
      message: 'Not authenticated.',
    });
  }
  return request.actor;
});
