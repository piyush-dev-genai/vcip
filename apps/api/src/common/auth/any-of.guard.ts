/**
 * Accept any one of several credentials.
 *
 * `GET /v1/sessions/:id` is readable by the customer holding that session's
 * token or by an agent of the same tenant (API contract §12). Nest composes
 * guards with AND, so expressing OR needs a composite.
 *
 * This composite deliberately contains **no authentication logic of its own**.
 * It resolves the real guards from the container and delegates; whether a
 * credential is valid is still decided in exactly one place per credential
 * type, which is the separation T09 established. If this file ever starts
 * parsing a token, that is the mistake.
 *
 * Failure semantics: every guard is tried, and the first rejection is rethrown
 * if none succeed. The alternatives all raise the same `401` with the same
 * message, so a caller cannot learn which credential the route "really" wanted.
 */

import type { CanActivate, ExecutionContext, Type } from '@nestjs/common';
import { Injectable, UnauthorizedException, mixin } from '@nestjs/common';
// A value import, NOT `import type`: ModuleRef is the injection token Nest
// resolves this constructor argument by. Erasing it at compile time makes the
// guard unresolvable at boot — the failure this codebase hit once already in
// tenant.guard.ts.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ModuleRef } from '@nestjs/core';
import { ErrorCode } from '@vcip/shared';

const unauthenticated = (): UnauthorizedException =>
  new UnauthorizedException({
    code: ErrorCode.UNAUTHENTICATED,
    message: 'Authentication is required.',
  });

/** Build a guard that passes when any of `guards` passes. */
export function AnyOf(...guards: readonly Type<CanActivate>[]): Type<CanActivate> {
  @Injectable()
  class AnyOfGuard implements CanActivate {
    constructor(private readonly moduleRef: ModuleRef) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      let firstRejection: unknown;

      for (const guard of guards) {
        // `strict: false` searches the whole container: the delegate guards are
        // provided by AuthModule, not by whichever module imported this one.
        const instance = this.moduleRef.get(guard, { strict: false });
        try {
          if (await instance.canActivate(context)) return true;
        } catch (error) {
          firstRejection ??= error;
        }
      }

      throw firstRejection ?? unauthenticated();
    }
  }

  return mixin(AnyOfGuard);
}
