import { Injectable } from '@nestjs/common';
import { DomainError, ErrorCode } from '@vcip/shared';
import type { TenantConfig, TenantConfigStore } from './tenant-config.store.js';
import { InjectTenantConfigStore } from './tenant-config.store.js';

/**
 * Tenant configuration, resolved for an already-authenticated tenant.
 *
 * The `tenantId` argument always comes from a verified credential by the time
 * it reaches here — the guards and `TenantScope` see to that — so this service
 * does no authorization of its own. It answers "what is configured?", nothing
 * more.
 */
@Injectable()
export class TenantsService {
  constructor(@InjectTenantConfigStore() private readonly store: TenantConfigStore) {}

  /**
   * Configuration for a tenant that must exist.
   *
   * A missing row here means an authenticated credential pointing at a deleted
   * tenant: a server-side inconsistency, not a client error, so it is a 500
   * rather than a 404. Falling back to default thresholds would be worse —
   * that would silently apply someone else's policy to a real verification.
   */
  async requireConfig(tenantId: string): Promise<TenantConfig> {
    const config = await this.store.findConfig(tenantId);
    if (config === null) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Tenant configuration is unavailable.');
    }
    return config;
  }

  /** The active checklist template to pin on a new session, if one exists. */
  activeChecklistTemplateId(tenantId: string): Promise<string | null> {
    return this.store.findActiveChecklistTemplateId(tenantId);
  }
}
