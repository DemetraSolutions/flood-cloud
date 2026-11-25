import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrations } from '../../src/integrations/index.ts';
import type { IntegrationsDeps } from '../../src/integrations/index.ts';
import type { PlaceIntegrationsPort } from '../../src/shared/integrations/ports.ts';
import type { IdempotencyStore } from '../../src/shared/http/idempotency.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { Secret } from '../../src/shared/security/secret.ts';

const rule = (bucket: string) => ({ bucket, limit: 1, key: () => 'k' });
const off = {
  dojoBaseUrl: 'https://dojo.example',
  dojoResellerId: null,
  dojoSoftwareHouseId: null,
  dojoApiVersion: '2024-02-05',
  satispayAuthBaseUrl: null,
  satispayPublicKey: null,
  tshAuthBaseUrl: null,
  tshApiBaseUrl: null,
  tshTestAuthBaseUrl: null,
  tshTestApiBaseUrl: null,
  googleMapsApiKey: null,
  geocodingBaseUrl: 'https://geocoding.example',
  geocodingDailyLimit: 10,
};
const deps = (apiKey: Secret | null, config: Partial<IntegrationsDeps['config']> = {}): IntegrationsDeps => ({
  config: { ...off, cervedApiKey: apiKey, cervedBaseUrl: 'https://cerved.example', ...config },
  activityLog: { record: async () => undefined },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  rules: { cervedLookupPerUser: rule('a'), cervedLookupPerUserDaily: rule('b') },
  // The routes are not called here: the port is only handed to them.
  places: {} as PlaceIntegrationsPort,
  idempotency: {} as IdempotencyStore,
  rateLimiter: {} as RateLimiter,
});

describe('the entry point of the integrations module', () => {
  it('says a provider is available exactly when it has its configuration', () => {
    assert.deepEqual(createIntegrations(deps(new Secret('test-key-0123456789abcdef'))).status, { cerved: true, dojo: false, satispay: false, tsh: false, geocoding: false }); // gitleaks:allow (fake test value)
    assert.deepEqual(createIntegrations(deps(null)).status, { cerved: false, dojo: false, satispay: false, tsh: false, geocoding: false });
    const configured = { dojoResellerId: 'reseller', dojoSoftwareHouseId: 'house', satispayAuthBaseUrl: 'https://authservices.satispay.com', satispayPublicKey: 'pem', tshAuthBaseUrl: 'https://auth.example', tshApiBaseUrl: 'https://api.example', googleMapsApiKey: new Secret('test-google-key-0123456789') }; // gitleaks:allow (fake test value)
    assert.deepEqual(createIntegrations(deps(null, configured)).status, { cerved: false, dojo: true, satispay: true, tsh: true, geocoding: true });
    // Each needs everything it is made of: half a configuration is no configuration.
    assert.deepEqual(createIntegrations(deps(null, { dojoResellerId: 'reseller', satispayAuthBaseUrl: 'https://authservices.satispay.com', tshAuthBaseUrl: 'https://auth.example' })).status, { cerved: false, dojo: false, satispay: false, tsh: false, geocoding: false });
  });

  it('declares its routes for a backoffice user token alone: never open to a store key, never to an API key', () => {
    const { routes } = createIntegrations(deps(null));
    assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), [
      'GET /integrations',
      'GET /vat-lookups/:vatNumber',
      'GET /groups/:groupId/places/:placeId/integrations/dojo/terminals',
      'POST /groups/:groupId/places/:placeId/integrations/satispay/activation',
      'POST /groups/:groupId/places/:placeId/integrations/tsh/charge-categories/sync',
      'POST /groups/:groupId/places/:placeId/geocoding',
    ]);
    for (const route of routes) {
      assert.equal(route.auth.kind, 'user', route.path);
      assert.equal((route.auth as { store?: unknown }).store, undefined, route.path);
      if (route.path.includes('/places/')) {
        // A route of a place is on a group and needs the permission to change the place, and nothing else.
        assert.deepEqual(route.auth, { kind: 'user', permission: 'places:update', group: true }, route.path);
      }
    }
  });
});
