import { Module } from '@nestjs/common';
import { DrizzleTenantConfigStore, TENANT_CONFIG_STORE } from './tenant-config.store.js';
import { TenantsService } from './tenants.service.js';

/**
 * Tenant configuration lookup.
 *
 * No tenant-admin API is built (R9): a seed script provisions tenants, and this
 * module only reads what it provisioned.
 */
@Module({
  providers: [{ provide: TENANT_CONFIG_STORE, useClass: DrizzleTenantConfigStore }, TenantsService],
  exports: [TENANT_CONFIG_STORE, TenantsService],
})
export class TenantsModule {}
