/**
 * Tenant configuration lookup.
 *
 * The preflight thresholds and the GPS accuracy limit are tenant configuration
 * (D11, `docs/06-database-schema.md` §6a), and the server compares measurements
 * against them. That is the whole reason this module exists as its own
 * boundary: the sessions module asks "what are this tenant's thresholds?" and
 * never reaches into the tenants table itself.
 *
 * A port plus a Drizzle adapter, matching the shape T09 established for
 * `ApiKeyStore`: the business logic depends on the interface, so it is testable
 * without a database, and the SQL lives in one place.
 */

import { Inject, Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { checklistTemplates, tenants } from '../../db/schema.js';
import { InjectDatabase } from '../common/db/db.tokens.js';

/**
 * Everything the session lifecycle needs to know about a tenant.
 *
 * Numbers, not strings. `min_mic_level`, `min_lighting_score`, and
 * `min_stability_score` are `NUMERIC(5,2)` columns, and the PostgreSQL driver
 * hands `NUMERIC` back as a string to preserve precision. Comparing a
 * measurement against `'30'` with `>=` would coerce silently and usually give
 * the right answer, which is exactly what makes it a bad bug to have: the
 * conversion happens once, here, at the boundary.
 */
export interface TenantConfig {
  readonly tenantId: string;
  readonly status: string;

  /** Applied to `min(camera_width, camera_height)`. */
  readonly minVideoPx: number;
  readonly minMicLevel: number;
  readonly maxRttMs: number;
  readonly minDownlinkKbps: number;
  readonly minLightingScore: number;
  readonly minStabilityScore: number;

  /** GPS accuracy ceiling in metres, for the location gate. */
  readonly gpsMaxAccuracyM: number;
}

export interface TenantConfigStore {
  /** The tenant's configuration, or null when there is no such tenant. */
  findConfig(tenantId: string): Promise<TenantConfig | null>;

  /**
   * The id of the tenant's active checklist template, or null if none is set.
   *
   * A session pins the template it used, so a template change later never
   * rewrites the meaning of a completed verification.
   */
  findActiveChecklistTemplateId(tenantId: string): Promise<string | null>;
}

export const TENANT_CONFIG_STORE = Symbol('TENANT_CONFIG_STORE');

export const InjectTenantConfigStore = (): ParameterDecorator => Inject(TENANT_CONFIG_STORE);

/** `NUMERIC` arrives as a string; everything else is already a number. */
const toNumber = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

@Injectable()
export class DrizzleTenantConfigStore implements TenantConfigStore {
  constructor(@InjectDatabase() private readonly db: PostgresJsDatabase) {}

  async findConfig(tenantId: string): Promise<TenantConfig | null> {
    const rows = await this.db
      .select({
        tenantId: tenants.id,
        status: tenants.status,
        minVideoPx: tenants.minVideoPx,
        minMicLevel: tenants.minMicLevel,
        maxRttMs: tenants.maxRttMs,
        minDownlinkKbps: tenants.minDownlinkKbps,
        minLightingScore: tenants.minLightingScore,
        minStabilityScore: tenants.minStabilityScore,
        gpsMaxAccuracyM: tenants.gpsMaxAccuracyM,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    return {
      tenantId: row.tenantId,
      status: row.status,
      minVideoPx: toNumber(row.minVideoPx),
      minMicLevel: toNumber(row.minMicLevel),
      maxRttMs: toNumber(row.maxRttMs),
      minDownlinkKbps: toNumber(row.minDownlinkKbps),
      minLightingScore: toNumber(row.minLightingScore),
      minStabilityScore: toNumber(row.minStabilityScore),
      gpsMaxAccuracyM: toNumber(row.gpsMaxAccuracyM),
    };
  }

  async findActiveChecklistTemplateId(tenantId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: checklistTemplates.id })
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.tenantId, tenantId), eq(checklistTemplates.active, true)))
      .limit(1);

    return rows[0]?.id ?? null;
  }
}
