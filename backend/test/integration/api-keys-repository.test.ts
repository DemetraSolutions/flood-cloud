import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { createApiKeysRepository } from '../../src/modules/api-keys/api-keys.repository.ts';
import type { ApiKeysRepository, NewApiKey } from '../../src/modules/api-keys/api-keys.repository.ts';
import type { UsageIncrement } from '../../src/modules/api-keys/api-keys.types.ts';
import { hashSecret } from '../../src/shared/security/secrets.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: ApiKeysRepository;
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const GROUP = new ObjectId();
const issuer = { userId: new ObjectId(), role: 'PSA' } as const;
let counter = 0;
const keys = () => ctx.databases.common().collection('apiKeys');
const usage = () => ctx.databases.common().collection('apiUsage');

const newKey = (overrides: Partial<NewApiKey> = {}): NewApiKey => ({
  groupId: GROUP,
  name: 'Webshop',
  prefix: 'fc_pk_abcdef',
  hash: hashSecret(`key-${String(counter++)}`),
  permissions: ['places:read'],
  restrictions: { companyIds: null, placeIds: null },
  rateLimitPerMinute: 60,
  dailyQuota: 1000,
  expiresAt: null,
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  createdAt: NOW,
  createdBy: issuer,
  lastUsedAt: null,
  ...overrides,
});
const caps = { groupRateLimitPerMinute: 120, groupDailyQuota: 20_000 };
const increment = (overrides: Partial<UsageIncrement> = {}): UsageIncrement => ({ keyId: new ObjectId(), groupId: GROUP, day: '2026-11-17', route: 'GET /public/v1/me', calls: 1, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0, ...overrides });

before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS);
  repository = createApiKeysRepository(ctx.databases);
});
after(() => ctx.cleanup());

describe('the collections of the public API keys (real MongoDB)', () => {
  it('have the indexes: a unique hash, the keys of a group newest first, one usage row per key, day and route, and the TTL on the usage', async () => {
    const indexes = async (name: string) => (await ctx.databases.common().collection(name).indexes()).map((index) => [index.name, index.unique === true, index.expireAfterSeconds]);
    assert.deepEqual((await indexes('apiKeys')).filter(([name]) => name !== '_id_'), [['hash_1', true, undefined], ['groupId_1_createdAt_-1', false, undefined]]);
    assert.deepEqual((await indexes('apiUsage')).filter(([name]) => name !== '_id_'), [['keyId_1_day_1_route_1', true, undefined], ['expireAt_1', false, 0]]);
  });

  it('refuse a second key with the same hash', async () => {
    const good = newKey();
    await keys().insertOne({ ...good });
    await assert.rejects(keys().insertOne({ ...good }), /duplicate key/);
    assert.equal(await keys().countDocuments({ hash: good.hash }), 1);
  });
});

describe('the repository of the keys (real MongoDB)', () => {
  it('stores a key, finds it by the hash with the hash and in its group without it', async () => {
    const input = newKey({ restrictions: { companyIds: [new ObjectId()], placeIds: [new ObjectId()] }, expiresAt: new Date(NOW.getTime() + 1000) });
    const stored = await repository.insert(input);
    assert.deepEqual([stored.id instanceof ObjectId, stored.name, stored.hash], [true, 'Webshop', input.hash]);
    const byHash = (await repository.findByHash(input.hash))!;
    assert.deepEqual([byHash.id, byHash.hash, byHash.restrictions, byHash.expiresAt], [stored.id, input.hash, input.restrictions, input.expiresAt]);
    assert.equal(await repository.findByHash(hashSecret('unknown')), null);
    const inGroup = (await repository.findInGroup(GROUP, stored.id))!;
    assert.deepEqual([inGroup.id, inGroup.hash], [stored.id, '']);
    assert.equal(await repository.findInGroup(new ObjectId(), stored.id), null);
    assert.equal(await repository.findInGroup(GROUP, new ObjectId()), null);
  });

  it('changes an active key and never a revoked one; revokes once', async () => {
    const stored = await repository.insert(newKey());
    const changed = (await repository.updateActive(GROUP, stored.id, { name: 'Renamed' }, NOW))!;
    assert.deepEqual([changed.name, changed.hash], ['Renamed', '']);
    assert.equal(await repository.updateActive(new ObjectId(), stored.id, { name: 'X' }, NOW), null);
    const first = (await repository.revoke(GROUP, stored.id, { at: NOW, by: issuer }))!;
    assert.deepEqual([first.changed, first.key.status, first.key.revokedAt, first.key.revokedBy], [true, 'revoked', NOW, issuer]);
    const again = (await repository.revoke(GROUP, stored.id, { at: new Date(NOW.getTime() + 5), by: { userId: new ObjectId(), role: 'D' } }))!;
    assert.deepEqual([again.changed, again.key.revokedAt, again.key.revokedBy], [false, NOW, issuer]);
    assert.equal(await repository.updateActive(GROUP, stored.id, { name: 'Late' }, NOW), null);
    assert.equal(await repository.revoke(GROUP, new ObjectId(), { at: NOW, by: issuer }), null);
    assert.equal(await repository.revoke(new ObjectId(), stored.id, { at: NOW, by: issuer }), null);
    // A key whose time is over is not changed either, not even to move its expiry.
    const expired = await repository.insert(newKey({ expiresAt: new Date(NOW.getTime() - 1) }));
    assert.equal(await repository.updateActive(GROUP, expired.id, { expiresAt: new Date(NOW.getTime() + 86_400_000) }, NOW), null);
    const open = await repository.insert(newKey({ expiresAt: new Date(NOW.getTime() + 1) }));
    assert.equal((await repository.updateActive(GROUP, open.id, { name: 'Open' }, NOW))!.name, 'Open');
  });

  it('counts the keys that work in a group and pages them newest first with a cursor', async () => {
    const group = new ObjectId();
    const made = [];
    for (let index = 0; index < 3; index += 1) {
      made.push(await repository.insert(newKey({ groupId: group, createdAt: new Date(NOW.getTime() + index * 1000) })));
    }
    await repository.revoke(group, made[0]!.id, { at: NOW, by: issuer });
    assert.equal(await repository.countActive(group, NOW), 2);
    await repository.insert(newKey({ groupId: group, expiresAt: new Date(NOW.getTime() - 1) }));
    await repository.insert(newKey({ groupId: group, expiresAt: NOW }));
    await repository.insert(newKey({ groupId: group, expiresAt: new Date(NOW.getTime() + 1) }));
    assert.equal(await repository.countActive(group, NOW), 3, 'an expired key is not counted');
    const params = { limit: 2, sort: '-createdAt', q: null, cursor: null };
    const first = await repository.list(group, { ...params, limit: 2 }, null);
    assert.deepEqual([first.keys.map((key) => key.id), typeof first.page.next], [[made[2]!.id, made[1]!.id], 'string']);
    assert.ok(first.keys.every((key) => key.hash === ''));
    assert.deepEqual((await repository.list(group, params, 'revoked')).keys.map((key) => key.id), [made[0]!.id]);
    assert.deepEqual((await repository.list(group, params, 'active')).keys.length, 2);
  });

  it('writes lastUsedAt only when the last use is at or before the limit, or when there is none', async () => {
    const stored = await repository.insert(newKey());
    const read = async () => (await repository.findInGroup(GROUP, stored.id))!.lastUsedAt;
    await repository.touch(stored.id, NOW, new Date(NOW.getTime() - 60_000));
    assert.deepEqual(await read(), NOW);
    await repository.touch(stored.id, new Date(NOW.getTime() + 59_000), new Date(NOW.getTime() - 1));
    assert.deepEqual(await read(), NOW);
    await repository.touch(stored.id, new Date(NOW.getTime() + 60_000), NOW);
    assert.deepEqual(await read(), new Date(NOW.getTime() + 60_000));
  });

  it('tells what the group says: usable only when it is active, not in the trash and has the switch on', async () => {
    const groups = ctx.databases.common().collection('groups');
    const state = async (document: Document) => {
      const _id = new ObjectId();
      await groups.insertOne({ _id, ...document });
      return repository.groupState(_id);
    };
    assert.deepEqual(await state({ name: 'G', status: true, trash: false, publicApi: { enabled: true } }), { name: 'G', usable: true, ...caps });
    assert.deepEqual(await state({ name: 'G', status: true, publicApi: { enabled: true } }), { name: 'G', usable: true, ...caps });
    assert.deepEqual(await state({ name: 'G', status: true, publicApi: { enabled: true, groupRateLimitPerMinute: 300, groupDailyQuota: 5000 } }), { name: 'G', usable: true, groupRateLimitPerMinute: 300, groupDailyQuota: 5000 });
    for (const bad of [{ groupRateLimitPerMinute: 0, groupDailyQuota: 10_000_001 }, { groupRateLimitPerMinute: 6001, groupDailyQuota: 1.5 }, { groupRateLimitPerMinute: 'x', groupDailyQuota: null }]) {
      assert.deepEqual(await state({ name: 'G', status: true, publicApi: { enabled: true, ...bad } }), { name: 'G', usable: true, ...caps });
    }
    for (const document of [
      { status: true, publicApi: { enabled: false } },
      { status: true },
      { status: true, publicApi: null },
      { status: true, publicApi: 'x' },
      { status: true, publicApi: { enabled: 'true' } },
      { status: false, publicApi: { enabled: true } },
      { status: 'true', publicApi: { enabled: true } },
      { status: true, trash: true, publicApi: { enabled: true } },
    ]) {
      assert.equal((await state({ name: 'G', ...document }))!.usable, false, JSON.stringify(document));
    }
    assert.deepEqual(await state({ name: 7, status: true, publicApi: { enabled: true } }), { name: '', usable: true, ...caps });
    assert.equal(await repository.groupState(new ObjectId()), null);
  });

  it('adds the counters of the metering to the rows of key, day and route, and gives back only the rows that could not be written', async () => {
    const keyId = new ObjectId();
    const a = increment({ keyId, calls: 3, errors4xx: 1 });
    const b = increment({ keyId, route: 'GET /public/v1/places', calls: 2, rateLimited: 2 });
    assert.deepEqual(await repository.addUsage([a, b]), { failed: [], unacknowledged: false });
    assert.deepEqual(await repository.addUsage([{ ...a, calls: 4, errors4xx: 0, errors5xx: 1, aborted: 2 }]), { failed: [], unacknowledged: false });
    const rows = await repository.usage(GROUP, keyId, '2026-11-17', '2026-11-17');
    assert.deepEqual(rows, [
      { day: '2026-11-17', route: 'GET /public/v1/me', calls: 7, errors4xx: 1, errors5xx: 1, rateLimited: 0, aborted: 2 },
      { day: '2026-11-17', route: 'GET /public/v1/places', calls: 2, errors4xx: 0, errors5xx: 0, rateLimited: 2, aborted: 0 },
    ]);
    const stored = (await usage().findOne({ keyId, route: 'GET /public/v1/me' }))!;
    assert.deepEqual([stored['groupId'], stored['expireAt']], [GROUP, new Date(Date.parse('2026-11-17T00:00:00.000Z') + 401 * 86_400_000)]);
    // A row the database refuses (here a stored counter that is not a number) is given back; the others are written all the same, so a retry never counts them twice.
    const bad = increment({ keyId, route: 'GET /public/v1/taxes' });
    await usage().insertOne({ keyId, groupId: GROUP, day: bad.day, route: bad.route, calls: 'broken' });
    const good = increment({ keyId, route: 'GET /public/v1/companies', calls: 1 });
    assert.deepEqual(await repository.addUsage([bad, good]), { failed: [{ row: bad, code: 14 }], unacknowledged: false });
    assert.equal(await usage().countDocuments({ keyId, route: good.route, calls: 1 }), 1);
  });

  it('reads the usage of a key in a range, by day and route, and of no other key or group', async () => {
    const keyId = new ObjectId();
    await repository.addUsage([increment({ keyId, day: '2026-11-16' }), increment({ keyId, day: '2026-11-17', route: 'GET /b' }), increment({ keyId, day: '2026-11-17', route: 'GET /a' }), increment({ keyId, day: '2026-11-18' })]);
    const days = (rows: Array<{ day: string; route: string }>) => rows.map((row) => `${row.day} ${row.route}`);
    assert.deepEqual(days(await repository.usage(GROUP, keyId, '2026-11-16', '2026-11-17')), ['2026-11-16 GET /public/v1/me', '2026-11-17 GET /a', '2026-11-17 GET /b']);
    assert.deepEqual(await repository.usage(new ObjectId(), keyId, '2026-11-16', '2026-11-18'), []);
    assert.deepEqual(await repository.usage(GROUP, new ObjectId(), '2026-11-16', '2026-11-18'), []);
  });
});
