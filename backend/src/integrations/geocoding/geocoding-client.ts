import type { Secret } from '../../shared/security/secret.ts';
import { createHttpClient, ProviderHttpError } from '../http/index.ts';
import type { HttpClientOptions } from '../http/index.ts';

/** Path of the Geocoding API. */
const GEOCODE_PATH = '/maps/api/geocode/json';

/** A point on the map. */
export interface Coordinates {
  readonly lat: number;
  readonly lng: number;
}

/** What the geocoding asks about: the postal address of a place, in the fields the place keeps. */
export interface GeocodingAddress {
  readonly street: string;
  readonly postcode: string;
  readonly city: string;
  readonly province: string;
  /** The two letters of the country. */
  readonly country: string;
}

/** The Geocoding API of Google Maps behind an interface of the domain. */
export interface GeocodingClient {
  /** `false` when the platform has no key: the geocoding is then off. */
  readonly available: boolean;
  /**
   * Finds the coordinates of an address: the first result of the provider.
   *
   * @param address The address.
   * @returns The coordinates, or `null` when the provider knows no such address (`ZERO_RESULTS`).
   * @throws {ProviderHttpError} `network`, `timeout`, `status`, `tooLarge` or `invalidResponse` (the provider refused the key or the quota, or the answer is not what was asked for).
   */
  geocode(address: GeocodingAddress): Promise<Coordinates | null>;
}

/** The collaborators of the HTTP calls of the client that a test replaces. */
export type GeocodingHttpOptions = Pick<HttpClientOptions, 'fetch' | 'timeoutMs' | 'totalTimeoutMs' | 'maxBodyBytes' | 'now' | 'sleep' | 'random'>;

/** Settings of {@link createGeocodingClient}. */
export interface GeocodingClientOptions extends GeocodingHttpOptions {
  readonly baseUrl: string;
  /** The key of the platform, `null` when not configured. */
  readonly apiKey: Secret | null;
}

/** A coordinate: a finite number inside the range of its axis. */
const inRange = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * Builds the geocoding client. The key travels in the query (the API takes it nowhere else), so the URL is a secret: the HTTP client never puts it in an error or a log, and this one never
 * logs anything. The URL is made with `URLSearchParams`, so no value can add a parameter or a path.
 *
 * @param options Base URL, key and the collaborators a test replaces.
 * @returns The client.
 */
export function createGeocodingClient(options: GeocodingClientOptions): GeocodingClient {
  const { baseUrl, apiKey, ...collaborators } = options;
  const http = createHttpClient({ provider: 'Google Maps', baseUrl, ...collaborators });
  return {
    available: apiKey !== null,
    geocode: async (address) => {
      const query = new URLSearchParams({
        address: `${address.street}, ${address.postcode} ${address.city} ${address.province}`,
        components: `country:${address.country}`,
        key: (apiKey as Secret).reveal(),
      });
      const body = (await http.getJson({ operation: 'geocode', url: `${baseUrl}${GEOCODE_PATH}?${query.toString()}` })) as { status?: unknown; results?: unknown } | null;
      if (body?.status === 'ZERO_RESULTS') {
        return null;
      }
      const first = body?.status === 'OK' && Array.isArray(body.results) ? ((body.results[0] ?? {}) as { geometry?: { location?: { lat?: unknown; lng?: unknown } } }) : undefined;
      const location = first?.geometry?.location;
      if (!inRange(location?.lat, 90) || !inRange(location.lng, 180)) {
        // `REQUEST_DENIED`, `OVER_QUERY_LIMIT`, `INVALID_REQUEST`, an empty result or a point that is not one: the platform's problem, not the caller's.
        throw new ProviderHttpError('Google Maps', 'geocode', 'invalidResponse');
      }
      return { lat: location.lat, lng: location.lng };
    },
  };
}
