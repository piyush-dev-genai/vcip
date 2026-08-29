import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyStore } from './idempotency.store.js';

/**
 * D13's replay layer.
 *
 * The interceptor is a provider rather than a global one: routes opt in with
 * `@Idempotent(...)`, so nothing is protected by accident and nothing that
 * needs protection is left to a guess about the HTTP verb.
 */
@Module({
  providers: [IdempotencyStore, IdempotencyInterceptor],
  exports: [IdempotencyStore, IdempotencyInterceptor],
})
export class IdempotencyModule {}
