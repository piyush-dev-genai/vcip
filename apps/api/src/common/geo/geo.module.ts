import { Module } from '@nestjs/common';
import { GEO_PROVIDER, StaticGeoProvider } from './geo.provider.js';

/**
 * The `GeoProvider` binding (R7).
 *
 * `useFactory`, not `useClass`: the provider takes its environment as an
 * explicit argument, and a factory hands it over without the container trying
 * to resolve a `NodeJS.ProcessEnv` dependency it has no provider for. A future
 * lookup-service implementation replaces the factory body and nothing in the
 * sessions module changes.
 */
@Module({
  providers: [{ provide: GEO_PROVIDER, useFactory: () => new StaticGeoProvider(process.env) }],
  exports: [GEO_PROVIDER],
})
export class GeoModule {}
