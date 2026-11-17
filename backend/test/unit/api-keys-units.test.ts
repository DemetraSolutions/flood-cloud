import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { auditApiKey } from '../../src/modules/api-keys/api-keys.audit.ts';
import { createApiKeysRepository } from '../../src/modules/api-keys/api-keys.repository.ts';
import { createApiKeysService } from '../../src/modules/api-keys/api-keys.service.ts';
import type { ApiKeysRepository } from '../../src/modules/api-keys/api-keys.repository.ts';
import type { ApiKey, UsageIncrement } from '../../src/modules/api-keys/api-keys.types.ts';
import { fromDocument, toApiKeyResponse, toUsageRow } from '../../src/modules/api-keys/api-keys.mapper.ts';
import { createPublicService } from '../../src/modules/public-api/public.service.ts';
import { toMe } from '../../src/modules/public-api/public.mapper.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { frozenSet } from '../../src/shared/security/frozen.ts';
import type { ApiKeyPrincipal } from '../../src/shared/security/scope/principal.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const GROUP = fixtureId('group', 1);
const access = { groupId: GROUP } as GroupAccess;
const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const client = { requestId: 'req-1', ip: null, userAgent: null };
const psa = principalOf('PSA', { userId: fixtureId('user', 2) });

const key = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: new ObjectId('0a0000000000000000000001'),
  groupId: GROUP,
  name: 'Webshop',
  prefix: 'fc_pk_abcdef',
  hash: '',
  permissions: ['places:read'],
  restrictions: { companyIds: null, placeIds: null },
  rateLimitPerMinute: 60,
  dailyQuota: 1000,
  expiresAt: null,
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  createdAt: new Date(NOW),
  createdBy: { userId: psa.userId, role: 'PSA' },
  lastUsedAt: null,
  ...overrides,
});

const unexpected = (): never => assert.fail('not expected');
const repositoryOf = (overrides: Partial<ApiKeysRepository>): ApiKeysRepository =>
  ({ insert: unexpected, findByHash: unexpected, findInGroup: unexpected, list: unexpected, countActive: unexpected, updateActive: unexpected, revoke: unexpected, touch: unexpected, groupState: unexpected, missing: unexpected, addUsage: unexpected, usage: unexpected, ...overrides }) as ApiKeysRepository;

describe('the service of the keys (units)', () => {
  const entries: ActivityEntry[] = [];
  const service = (repository: Partial<ApiKeysRepository>, group: unknown = { group: { publicApi: { defaultRateLimitPerMinute: 60, defaultDailyQuota: 1000 } } }) =>
    createApiKeysService({ repository: repositoryOf(repository), groups: { findById: () => Promise.resolve(group as never) }, activityLog: { record: (entry) => (entries.push(entry), Promise.resolve()) }, now: () => NOW });

  it('does not create a key for a group that is gone since the access was checked', async () => {
    await assert.rejects(service({ countActive: () => Promise.resolve(0) }, null).create(psa, access, { name: 'X', permissions: ['places:read'] }, client), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
  });

  it('refuses a change that finds the key revoked between the read and the write', async () => {
    const svc = service({ findInGroup: () => Promise.resolve(key()), updateActive: () => Promise.resolve(null) });
    await assert.rejects(svc.update(psa, access, key().id, { name: 'Other' }, client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT');
    assert.equal(entries.length, 0);
  });

  it('records a key without a client address, and an update with its fields', async () => {
    entries.length = 0;
    await auditApiKey({ record: (entry) => (entries.push(entry), Promise.resolve()) }, { action: 'apiKey.revoked', key: key(), actor: { kind: 'user', id: psa.userId, role: 'PSA' }, client });
    await auditApiKey({ record: (entry) => (entries.push(entry), Promise.resolve()) }, { action: 'apiKey.updated', key: key(), actor: { kind: 'user', id: psa.userId, role: 'PSA' }, client: { ...client, ip: '203.0.113.1' }, fields: ['name', 'permissions'] });
    assert.deepEqual(entries.map((entry) => [entry.metadata, 'ip' in entry]), [[{ name: 'Webshop', keyHint: 'abcdef' }, false], [{ name: 'Webshop', keyHint: 'abcdef', fields: 'name,permissions' }, true]]);
  });

  it('shows a key field by field, without its hash', () => {
    const shown = toApiKeyResponse(key({ hash: 'a'.repeat(64), expiresAt: new Date(NOW), lastUsedAt: new Date(NOW), revokedAt: new Date(NOW), revokedBy: { userId: psa.userId, role: 'D' }, restrictions: { companyIds: [fixtureId('company', 1)], placeIds: [fixtureId('place', 1)] } }));
    assert.deepEqual(Object.keys(shown).sort(), ['createdAt', 'createdBy', 'dailyQuota', 'expiresAt', 'id', 'lastUsedAt', 'name', 'permissions', 'prefix', 'rateLimitPerMinute', 'restrictions', 'revokedAt', 'revokedBy', 'status']);
    assert.ok(!JSON.stringify(shown).includes('a'.repeat(64)));
    assert.deepEqual([shown.expiresAt, shown.lastUsedAt, shown.revokedAt, shown.revokedBy], [new Date(NOW).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString(), { id: psa.userId.toHexString(), role: 'D' }]);
    const read = fromDocument({ ...shown, _id: key().id, groupId: GROUP, createdAt: new Date(NOW), createdBy: key().createdBy, expiresAt: null, lastUsedAt: null, revokedAt: null, revokedBy: null, restrictions: { companyIds: null, placeIds: null } } as unknown as Document);
    assert.equal(read.hash, '');
  });
});

describe('the repository of the keys (units)', () => {
  it('lets an error of the database that is not a failure of some rows reject: the whole block stays with the meter', async () => {
    const databases = { common: () => ({ collection: () => ({ bulkWrite: () => Promise.reject(new TypeError('network')) }) }) } as never;
    const repository = createApiKeysRepository(databases);
    const row: UsageIncrement = { keyId: key().id, groupId: GROUP, day: '2026-11-17', route: 'GET /x', calls: 1, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 };
    await assert.rejects(repository.addUsage([row]), TypeError);
    assert.deepEqual(await repository.addUsage([]), { failed: [], unacknowledged: false });
  });
});

describe('reading a stored usage row', () => {
  it('reads a counter a row written earlier does not have as zero, never as NaN', () => {
    const old = toUsageRow({ day: '2026-11-17', route: 'GET /x', calls: 4, errors4xx: 1, errors5xx: 0, rateLimited: 2 });
    assert.deepEqual(old, { day: '2026-11-17', route: 'GET /x', calls: 4, errors4xx: 1, errors5xx: 0, rateLimited: 2, aborted: 0 });
    assert.deepEqual(toUsageRow({ day: 'd', route: 'r', calls: 'x', errors4xx: null }), { day: 'd', route: 'r', calls: 0, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 });
  });
});

describe('the public service (units)', () => {
  const principal: ApiKeyPrincipal = {
    kind: 'apiKey',
    keyId: key().id,
    groupId: GROUP,
    groupName: 'Group',
    name: 'Webshop',
    prefix: 'fc_pk_abcdef',
    permissions: frozenSet(['places:read' as const]),
    restrictions: { companyIds: null, placeIds: null },
    rateLimitPerMinute: 60,
    dailyQuota: 1000,
    groupRateLimitPerMinute: 120,
    groupDailyQuota: 20_000,
    expiresAt: new Date(NOW),
  };

  it('answers 404 for the catalogs of a group that is gone', async () => {
    const service = createPublicService({ repository: {} as never, groups: { findById: () => Promise.resolve(null) }, rateLimiter: { peek: unexpected } });
    for (const read of [() => service.priceLists(principal), () => service.taxes(principal)]) {
      await assert.rejects(read(), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
    }
  });

  it('shows the expiry of the key in /me, and what it used as the quota counter says', () => {
    const me = toMe(principal, 7);
    assert.deepEqual([me.key.expiresAt, me.usageToday, me.limits], [new Date(NOW).toISOString(), { calls: 7 }, { rateLimitPerMinute: 60, dailyQuota: 1000, group: { rateLimitPerMinute: 120, dailyQuota: 20_000 } }]);
    assert.equal(toMe({ ...principal, expiresAt: null }, 0).key.expiresAt, null);
  });
});
