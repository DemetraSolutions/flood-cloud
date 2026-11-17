import { ApiKey, ApiKeyUsage } from '../app/features/groups/public-api/api-key.types';

/** A complete public API key for tests; override what the test cares about. */
export function fakeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: '6650c0a1b2c3d4e5f6a7b8c9',
    name: 'Webshop',
    prefix: 'fc_pk_AbCdEf',
    permissions: ['places:read', 'companies:read'],
    restrictions: { companyIds: null, placeIds: null },
    rateLimitPerMinute: 60,
    dailyQuota: 10000,
    expiresAt: null,
    status: 'active',
    createdAt: '2026-11-17T10:00:00.000Z',
    createdBy: { id: '665f1c2e9b1d4a0012ab34d1', role: 'D' },
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

/** The usage of a key for tests: two days, two routes. */
export function fakeUsage(overrides: Partial<ApiKeyUsage> = {}): ApiKeyUsage {
  return {
    keyId: '6650c0a1b2c3d4e5f6a7b8c9',
    from: '2026-10-19',
    to: '2026-11-17',
    totals: { calls: 18, errors4xx: 2, errors5xx: 1, rateLimited: 1, aborted: 0 },
    rows: [
      {
        day: '2026-11-16',
        route: 'GET /public/v1/me',
        calls: 8,
        errors4xx: 0,
        errors5xx: 1,
        rateLimited: 0,
        aborted: 0,
      },
      {
        day: '2026-11-17',
        route: 'GET /public/v1/places',
        calls: 10,
        errors4xx: 2,
        errors5xx: 0,
        rateLimited: 1,
        aborted: 0,
      },
      {
        day: '2026-11-17',
        route: 'GET /public/v1/companies',
        calls: 0,
        errors4xx: 0,
        errors5xx: 0,
        rateLimited: 0,
        aborted: 0,
      },
    ],
    ...overrides,
  };
}
