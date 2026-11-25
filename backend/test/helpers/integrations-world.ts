import { generateKeyPairSync } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryRateLimiter } from './activity.ts';
import type { MemoryRateLimiter } from './activity.ts';
import { startFakeProvider } from './fake-provider.ts';
import type { FakeProvider, FakeReply, FakeRequest } from './fake-provider.ts';
import { fixtureId } from './legacy-fixtures.ts';
import { fullLegacyPlace } from './place-fixtures.ts';
import { startStoreWorld } from './store-keys.ts';
import type { StoreWorld } from './store-keys.ts';
import type { TestDatabases } from './mongo.ts';
import type { BackofficeOptions } from './backoffice.ts';

// Throw-away values, only ever sent to the fakes on the loopback.
export const DOJO_KEY = 'fake-dojo-key-0001';
export const GOOGLE_KEY = 'test-google-key-0123456789'; // gitleaks:allow (fake test value)
export const TSH_ID = 'fake-tsh-id';
export const TSH_SECRET = 'fake-tsh-secret';
export const SATISPAY_KEY_ID = 'fake-satispay-key-id';
/** A nonce and a token as the fake TS Hospitality gives them. */
export const TSH_NONCE = 'fake-nonce-0123456789';
export const TSH_TOKEN = 'fake-token-0123456789abcdef';

/** The fake providers of one world, each with the default answer of a working provider. */
export interface Fakes {
  readonly dojo: FakeProvider;
  readonly satispay: FakeProvider;
  readonly tshAuth: FakeProvider;
  readonly tshApi: FakeProvider;
  readonly tshTestAuth: FakeProvider;
  readonly tshTestApi: FakeProvider;
  readonly geocoding: FakeProvider;
}

/** The answers of working providers. */
const working = {
  dojo: (): FakeReply => ({ json: { items: [{ id: 'trm_1', properties: { tid: 'T-100' }, status: 'Active', serial: 'secret-serial' }, { id: 'trm_2', properties: { tid: 'T-200' }, status: 'Inactive' }] } }),
  satispay: (): FakeReply => ({ json: { key_id: SATISPAY_KEY_ID } }),
  tshAuth: (request: FakeRequest): FakeReply => (request.path === '/api/v3/nonces' ? { json: { nonce: TSH_NONCE } } : { json: { accessToken: TSH_TOKEN, refreshToken: 'r', expiresIn: 3600 } }),
  tshApi: (): FakeReply => ({ json: [{ id: 'c1', name: 'Bar' }, { id: 'c2', name: 'Cucina', extra: 'ignored' }] }),
  geocoding: (): FakeReply => ({ json: { status: 'OK', results: [{ formatted_address: 'must not be forwarded', geometry: { location: { lat: 45.4642, lng: 9.19 } } }] } }),
};

/** Starts the seven fakes. */
export async function startFakes(): Promise<Fakes> {
  return {
    dojo: await startFakeProvider(working.dojo),
    satispay: await startFakeProvider(working.satispay),
    tshAuth: await startFakeProvider(working.tshAuth),
    tshApi: await startFakeProvider(working.tshApi),
    tshTestAuth: await startFakeProvider(working.tshAuth),
    tshTestApi: await startFakeProvider(working.tshApi),
    geocoding: await startFakeProvider(working.geocoding),
  };
}

/** Stops the fakes. */
export async function stopFakes(fakes: Fakes): Promise<void> {
  await Promise.all(Object.values(fakes).map((fake: FakeProvider) => fake.close()));
}

/** A public key in PEM, RSA of 2048 bits, generated once. */
export const PUBLIC_KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** The environment that configures every provider against the fakes. */
export function integrationsEnv(fakes: Fakes): Record<string, string> {
  return {
    DOJO_BASE_URL: fakes.dojo.baseUrl,
    DOJO_RESELLER_ID: 'Fake Reseller',
    DOJO_SOFTWARE_HOUSE_ID: 'Fake Software House',
    SATISPAY_AUTH_BASE_URL: fakes.satispay.baseUrl,
    SATISPAY_PUBLIC_KEY: PUBLIC_KEY_PEM,
    TSH_AUTH_BASE_URL: fakes.tshAuth.baseUrl,
    TSH_API_BASE_URL: fakes.tshApi.baseUrl,
    TSH_TEST_AUTH_BASE_URL: fakes.tshTestAuth.baseUrl,
    TSH_TEST_API_BASE_URL: fakes.tshTestApi.baseUrl,
    GOOGLE_MAPS_API_KEY: GOOGLE_KEY,
    GEOCODING_BASE_URL: fakes.geocoding.baseUrl,
  };
}

/** A world of the integration tests: the places world with the providers configured against the fakes (or not configured at all), and the helpers to seed a place with credentials and to call the routes. */
export interface IntegrationsWorld {
  readonly world: StoreWorld;
  readonly limiter: MemoryRateLimiter;
  /** Seeds a place of group 0 (company 1) whose `integrations` are the fixture's with these keys on top. */
  seed(n: number, integrations: Document, overrides?: Document): Promise<ObjectId>;
  /** `/groups/<group 0>/places/<id>` plus a suffix. */
  path(id: ObjectId, rest?: string): string;
  /** The `If-Match` header of the place as it is now. */
  ifMatch(id: ObjectId): Promise<Record<string, string>>;
  /** What the log of the application holds, as one text. */
  logged(): string;
  /** The activity entries of the integrations, in order. */
  entries(): Array<Record<string, any>>;
  /** The stored `integrations` of a place. */
  integrationsOf(id: ObjectId): Promise<Record<string, Record<string, unknown>>>;
}

/**
 * Starts the places world with the options given and the helpers of the integration tests.
 *
 * @param ctx Throw-away databases.
 * @param options The environment (the providers' configuration) and the HTTP collaborators of the module.
 */
export async function startIntegrationsWorld(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<IntegrationsWorld> {
  const limiter = memoryRateLimiter();
  const world = await startStoreWorld(ctx, { rateLimiter: limiter, ...options });
  const path = (id: ObjectId, rest = ''): string => world.placePath(0, `/${id.toHexString()}${rest}`);
  return {
    world,
    limiter,
    seed: async (n, integrations, overrides = {}) => {
      // A test may seed the same place again.
      await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').deleteOne({ _id: fixtureId('place', n) });
      await ctx.databases.common().collection('places').deleteOne({ _id: fixtureId('place', n) });
      const base = fullLegacyPlace(n, world.group(0).groupId, fixtureId('company', 1))['integrations'] as Document;
      return world.seedPlace(0, n, 1, { integrations: { ...base, ...integrations }, ...overrides });
    },
    path,
    ifMatch: async (id) => ({ 'if-match': (await world.as.call(world.office.cluster.psa, 'GET', path(id))).headers.get('etag')! }),
    logged: () => JSON.stringify(world.office.logEvents),
    entries: () => world.office.activity.entries.filter((entry) => String(entry.action).startsWith('integrations.')) as Array<Record<string, any>>,
    integrationsOf: async (id) => ((await world.storedPlace(0, id))!['integrations'] ?? {}) as Record<string, Record<string, unknown>>,
  };
}
