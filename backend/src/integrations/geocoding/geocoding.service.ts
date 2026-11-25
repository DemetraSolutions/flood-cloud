import { AppError } from '../../shared/http/errors.ts';
import type { PlaceIntegrationsPort } from '../../shared/integrations/ports.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import { targetOf } from '../place-call.ts';
import type { CallRequest, CallSpec, ProviderCalls } from '../provider-call.ts';
import type { Coordinates, GeocodingAddress, GeocodingClient } from './geocoding-client.ts';

/** The call, as the activity log and the errors know it (the key of the platform is not the user's, so a refused key is a `502`, never a `422`). */
export const GEOCODING_CALL: CallSpec = Object.freeze({ action: 'integrations.geocoded', category: 'data', provider: 'Google Maps', credentialField: null });

/** The counter of the calls of the whole platform in a day. */
export const GEOCODING_GLOBAL_BUCKET = 'geocoding:global';

/** Length of the day of the global counter, in seconds. */
const DAY_SECONDS = 86_400;

/** The coordinates of an address. */
export interface GeocodingService {
  /**
   * Finds the coordinates of the address of the form. Nothing is saved: the backoffice puts them in the form, which saves them. The calls of the whole platform in a day are capped (`GEOCODING_DAILY_LIMIT`).
   *
   * @param request The caller and the place.
   * @param address The address of the form.
   * @returns The coordinates.
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` (Google Maps off for the place; `street` when the provider knows no such address), `RATE_LIMITED` (the daily cap of the platform), `SERVICE_UNAVAILABLE` (no key configured), `PROVIDER_ERROR`.
   */
  geocode(request: CallRequest, address: GeocodingAddress): Promise<Coordinates>;
}

/** Dependencies of {@link createGeocodingService}. */
export interface GeocodingDeps {
  readonly geocoding: GeocodingClient;
  readonly places: Pick<PlaceIntegrationsPort, 'checkGeocoding'>;
  readonly calls: ProviderCalls;
  readonly limiter: RateLimiter;
  /** Calls per day for the whole platform. */
  readonly dailyLimit: number;
}

/**
 * Builds the geocoding service.
 *
 * @param deps The client, the place port, the runner of calls, the counters and the daily cap.
 */
export function createGeocodingService(deps: GeocodingDeps): GeocodingService {
  const { geocoding, places, calls, limiter, dailyLimit } = deps;
  return {
    geocode: (request, address) =>
      calls.run(GEOCODING_CALL, request, async () => {
        if (!geocoding.available) {
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        await places.checkGeocoding(targetOf(request));
        // The cap counts the calls that are really made: the ones refused above never reach the provider.
        const decision = await limiter.consume(GEOCODING_GLOBAL_BUCKET, 'platform', dailyLimit, DAY_SECONDS);
        if (!decision.allowed) {
          throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(decision.resetSeconds) } });
        }
        const found = await geocoding.geocode(address);
        if (found === null) {
          throw new AppError('VALIDATION_ERROR', { details: [{ field: 'street', issue: 'incorrect' }] });
        }
        return found;
      }),
  };
}
