/**
 * IP geolocation, behind an interface (R7).
 *
 * The MVP ships a static implementation and no third-party lookup. The seam
 * exists so that adding one later is a provider swap rather than a change to
 * the session lifecycle, and so the location rule has one place to live.
 *
 * Two constraints shape the interface:
 *
 *   1. **The IP is never persisted and never logged.** `docs/03-system-design.md`
 *      §39 classes a raw client IP as sensitive; only the resolved two-letter
 *      country reaches `sessions.ip_country`. The address is an argument, used,
 *      and dropped.
 *   2. **Unknown must pass.** R7: "Unknown country passes in local development
 *      so the demo is not blocked." A provider that cannot resolve a country
 *      reports `country: null, allowed: true` — it does not fail the customer
 *      for the provider's own ignorance.
 */

import { Inject } from '@nestjs/common';

export interface GeoDecision {
  /** ISO 3166-1 alpha-2, uppercase, or null when the country is unknown. */
  readonly country: string | null;
  /**
   * Whether this connection is permitted to proceed.
   *
   * Separate from `country` because "which country" and "is that acceptable"
   * are different questions, and only the first is a fact. A future provider
   * with a deny list decides the second; the static one never blocks.
   */
  readonly allowed: boolean;
}

export interface GeoProvider {
  /** Resolve a client address. `null` when the address is unavailable. */
  resolve(ip: string | null): Promise<GeoDecision>;
}

export const GEO_PROVIDER = Symbol('GEO_PROVIDER');

export const InjectGeoProvider = (): ParameterDecorator => Inject(GEO_PROVIDER);

/** Uppercase alpha-2, or null for anything that is not one. */
export function normaliseCountry(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * The MVP provider: no network call, never blocks.
 *
 * `VCIP_GEO_STATIC_COUNTRY` lets local development and the demo present a
 * specific country without a lookup service. Unset means unknown, which passes.
 *
 * Deliberately NOT `@Injectable()`, and its environment is a required argument
 * rather than a defaulted one. Nest constructs providers by reading
 * `design:paramtypes`, so a constructor parameter typed `NodeJS.ProcessEnv`
 * emits as `Object` and the container tries to resolve it — which fails at boot
 * with "can't resolve dependencies of the StaticGeoProvider (?)", however
 * harmless the default looked. `geo.module.ts` builds it with `useFactory` and
 * passes `process.env` explicitly, so the container never inspects this
 * signature at all.
 */
export class StaticGeoProvider implements GeoProvider {
  private readonly country: string | null;

  constructor(env: NodeJS.ProcessEnv) {
    this.country = normaliseCountry(env['VCIP_GEO_STATIC_COUNTRY']);
  }

  resolve(_ip: string | null): Promise<GeoDecision> {
    // The address is deliberately unused and deliberately not logged. It is
    // accepted so the interface is honest about what a real provider needs.
    return Promise.resolve({ country: this.country, allowed: true });
  }
}
