import type { ActivityLog } from '../shared/activity-log/activity-log.ts';
import type { IdempotencyStore } from '../shared/http/idempotency.ts';
import type { PlaceIntegrationsPort } from '../shared/integrations/ports.ts';
import type { RouteDefinition } from '../shared/http/routes.ts';
import type { Logger } from '../shared/logging/logger.ts';
import type { RateLimiter } from '../shared/security/rate-limit/rate-limiter.ts';
import type { RateLimitRules } from '../shared/security/rate-limit/rules.ts';
import type { Secret } from '../shared/security/secret.ts';
import { createCervedClient } from './cerved/index.ts';
import type { CervedHttpOptions } from './cerved/index.ts';
import { createVatLookupsController } from './cerved/vat-lookups.controller.ts';
import { createVatLookupsRoutes } from './cerved/vat-lookups.routes.ts';
import { createVatLookupsService } from './cerved/vat-lookups.service.ts';
import { createDojoClient } from './dojo/dojo-client.ts';
import type { DojoHttpOptions } from './dojo/dojo-client.ts';
import { createDojoController } from './dojo/dojo.controller.ts';
import { createDojoRoutes } from './dojo/dojo.routes.ts';
import { createDojoService } from './dojo/dojo.service.ts';
import { createGeocodingClient } from './geocoding/geocoding-client.ts';
import type { GeocodingHttpOptions } from './geocoding/geocoding-client.ts';
import { createGeocodingController } from './geocoding/geocoding.controller.ts';
import { createGeocodingRoutes } from './geocoding/geocoding.routes.ts';
import { createGeocodingService } from './geocoding/geocoding.service.ts';
import { createIntegrationsStatusRoutes } from './integrations.routes.ts';
import { createProviderCalls } from './provider-call.ts';
import { createSatispayClient } from './satispay/satispay-client.ts';
import type { SatispayHttpOptions } from './satispay/satispay-client.ts';
import { createSatispayController } from './satispay/satispay.controller.ts';
import { createSatispayRoutes } from './satispay/satispay.routes.ts';
import { createSatispayService } from './satispay/satispay.service.ts';
import { createTshClient } from './tsh/tsh-client.ts';
import type { TshHttpOptions } from './tsh/tsh-client.ts';
import { createTshController } from './tsh/tsh.controller.ts';
import { createTshRoutes } from './tsh/tsh.routes.ts';
import { createTshService } from './tsh/tsh.service.ts';
import type { IntegrationsStatus } from './integrations.routes.ts';

export type { CervedHttpOptions } from './cerved/index.ts';
export type { DojoHttpOptions } from './dojo/dojo-client.ts';
export type { GeocodingHttpOptions } from './geocoding/geocoding-client.ts';
export type { SatispayHttpOptions } from './satispay/satispay-client.ts';
export type { TshHttpOptions } from './tsh/tsh-client.ts';
export type { IntegrationsStatus } from './integrations.routes.ts';

/**
 * What the module reads of the configuration: only its own settings. The core hands them over (the `Config` of the platform has them under the same names), so the module
 * never reads `process.env` and never knows the rest of the configuration.
 */
export interface IntegrationsConfig {
  /** Key of the Cerved API, `null` when not configured: the provider is then off. */
  readonly cervedApiKey: Secret | null;
  /** Base URL of the Cerved API, validated by the configuration. */
  readonly cervedBaseUrl: string;
  /** Base URL of the Dojo API (validated by the configuration). */
  readonly dojoBaseUrl: string;
  /** Identifier of the reseller and of the software house sent to Dojo, `null` when not configured: Dojo is then off (both are needed). */
  readonly dojoResellerId: string | null;
  readonly dojoSoftwareHouseId: string | null;
  /** The version of the Dojo API. */
  readonly dojoApiVersion: string;
  /** One of the two hosts of Satispay and the public key of the platform (PEM), `null` when not configured: Satispay is then off (both are needed). */
  readonly satispayAuthBaseUrl: string | null;
  readonly satispayPublicKey: string | null;
  /** The hosts of TS Hospitality (production and test), `null` when not configured: it is off without the first two, and a place in test mode needs the other two. */
  readonly tshAuthBaseUrl: string | null;
  readonly tshApiBaseUrl: string | null;
  readonly tshTestAuthBaseUrl: string | null;
  readonly tshTestApiBaseUrl: string | null;
  /** Key of the Geocoding API, `null` when not configured: the geocoding is then off. */
  readonly googleMapsApiKey: Secret | null;
  /** Base URL of the Geocoding API (validated by the configuration). */
  readonly geocodingBaseUrl: string;
  /** Calls to the Geocoding API per day allowed to the whole platform. */
  readonly geocodingDailyLimit: number;
}

/** What the core gives the module: everything it needs, nothing it could take on its own (no database, no `process.env`). */
export interface IntegrationsDeps {
  readonly config: IntegrationsConfig;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** The rate limit rules of the platform; the module picks the ones of its routes. */
  readonly rules: Pick<RateLimitRules, 'cervedLookupPerUser' | 'cervedLookupPerUserDaily'>;
  /** What the module may ask of the places of the core (credentials, the writes the providers' answers lead to): the core redoes the perimeter and the permission on every call. */
  readonly places: PlaceIntegrationsPort;
  /** The record of the idempotency keys, for the routes that spend something single use (the activation of Satispay). */
  readonly idempotency: IdempotencyStore;
  /** The rate limit counters, for the daily cap of the platform on the geocoding. */
  readonly rateLimiter: RateLimiter;
  /** The collaborators of the HTTP calls to each provider that only a test replaces (a `fetch`, a timeout). */
  readonly http?: {
    readonly cerved?: CervedHttpOptions;
    readonly dojo?: DojoHttpOptions;
    readonly satispay?: SatispayHttpOptions;
    readonly tsh?: TshHttpOptions;
    readonly geocoding?: GeocodingHttpOptions;
  };
}

/** What the module gives the core. */
export interface Integrations {
  /** The routes to mount on `/v1`; every one is for a `user` token only (the surface refuses to start with a route open to a store key or an API key). */
  readonly routes: RouteDefinition[];
  /** Which providers are available, from the configuration. */
  readonly status: IntegrationsStatus;
}

/**
 * The only entry of the integrations module: builds the providers' clients and services and returns their routes and the availability of each. The core calls it from the
 * composition root and nothing else of the core knows the module, so unplugging the integrations means removing that call.
 *
 * @param deps Configuration of the module, the activity log, the logger, the rate limit rules and, in a test, the HTTP collaborators.
 * @returns The routes (the route of the status included) and the status of the providers.
 */
export function createIntegrations(deps: IntegrationsDeps): Integrations {
  const { config, activityLog, logger, rules, places } = deps;
  const cerved = createCervedClient({ apiKey: config.cervedApiKey, baseUrl: config.cervedBaseUrl, ...deps.http?.cerved });
  const dojo = createDojoClient({ baseUrl: config.dojoBaseUrl, resellerId: config.dojoResellerId, softwareHouseId: config.dojoSoftwareHouseId, apiVersion: config.dojoApiVersion, ...deps.http?.dojo });
  const satispay = createSatispayClient({ authBaseUrl: config.satispayAuthBaseUrl, publicKey: config.satispayPublicKey, ...deps.http?.satispay });
  const tsh = createTshClient({ authBaseUrl: config.tshAuthBaseUrl, apiBaseUrl: config.tshApiBaseUrl, testAuthBaseUrl: config.tshTestAuthBaseUrl, testApiBaseUrl: config.tshTestApiBaseUrl, ...deps.http?.tsh });
  const geocoding = createGeocodingClient({ baseUrl: config.geocodingBaseUrl, apiKey: config.googleMapsApiKey, ...deps.http?.geocoding });
  const status: IntegrationsStatus = { cerved: cerved.available, dojo: dojo.available, satispay: satispay.available, tsh: tsh.available, geocoding: geocoding.available };
  const calls = createProviderCalls({ activityLog, logger });
  const vatLookups = createVatLookupsController(createVatLookupsService({ cerved, activityLog, logger }));
  return {
    routes: [
      ...createIntegrationsStatusRoutes(status),
      ...createVatLookupsRoutes(vatLookups, rules),
      ...createDojoRoutes(createDojoController(createDojoService({ dojo, places, calls }))),
      ...createSatispayRoutes(createSatispayController(createSatispayService({ satispay, places, calls })), deps.idempotency),
      ...createTshRoutes(createTshController(createTshService({ tsh, places, calls }))),
      ...createGeocodingRoutes(createGeocodingController(createGeocodingService({ geocoding, places, calls, limiter: deps.rateLimiter, dailyLimit: config.geocodingDailyLimit }))),
    ],
    status,
  };
}
