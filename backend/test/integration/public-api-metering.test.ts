import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld } from '../helpers/api-keys.ts';

let ctx: TestDatabases;
let world: KeysWorld;
const common = () => ctx.databases.common();
const asKey = (...args: Parameters<KeysWorld['asKey']>) => world.asKey(...args);
const today = () => new Date(world.office.clock.now()).toISOString().slice(0, 10);
const rows = async (keyId: string): Promise<Document[]> => common().collection('apiUsage').find({ keyId: new ObjectId(keyId) }, { projection: { _id: 0 } }).sort({ route: 1 }).toArray();
const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  // What the last test left in the memory of the meter is written now, and removed with the rest.
  await world.office.meter.flush();
  await common().collection('apiKeys').deleteMany({});
  await common().collection('apiUsage').deleteMany({});
  await common().collection('groups').updateMany({}, { $unset: { publicApi: '' } });
});

describe('the metering of the public API', () => {
  it('counts the requests of a key by day and route, aggregates them in memory and writes them with $inc', async () => {
    const { id, secret } = await world.makeKey(0, { permissions: ['places:read'], rateLimitPerMinute: 8 });
    await asKey(secret, '/me');
    await asKey(secret, '/places');
    await asKey(secret, '/places');
    await asKey(secret, `/places/${new ObjectId().toHexString()}`);
    await asKey(secret, '/companies');
    await asKey(secret, '/places?limit=0');
    await world.office.publicCall('HEAD', '/me', secret);
    // Refused before the key is known: never counted.
    await asKey(undefined, '/me');
    await asKey(`fc_pk_${'A'.repeat(43)}`, '/me'); // gitleaks:allow (fake test value)
    assert.deepEqual(await rows(id), [], 'nothing is written until the meter flushes');
    await world.office.meter.flush();
    const base = { keyId: new ObjectId(id), groupId: world.group(0).groupId, day: today() };
    const found = await rows(id);
    assert.deepEqual(
      found.map(({ expireAt: _expireAt, ...row }) => row),
      [
        { ...base, route: 'GET /public/v1/companies', calls: 1, errors4xx: 1, errors5xx: 0, rateLimited: 0, aborted: 0 },
        { ...base, route: 'GET /public/v1/me', calls: 2, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 },
        { ...base, route: 'GET /public/v1/places', calls: 3, errors4xx: 1, errors5xx: 0, rateLimited: 0, aborted: 0 },
        { ...base, route: 'GET /public/v1/places/:placeId', calls: 1, errors4xx: 1, errors5xx: 0, rateLimited: 0, aborted: 0 },
      ],
    );
    const expire = found[0]!['expireAt'] as Date;
    assert.equal(expire.toISOString(), new Date(Date.parse(`${today()}T00:00:00.000Z`) + 401 * 86_400_000).toISOString());
    // The next block adds to the same rows.
    await asKey(secret, '/me');
    await world.office.meter.flush();
    assert.equal((await rows(id)).find((row) => row['route'] === 'GET /public/v1/me')!['calls'], 3);
    assert.equal((await rows(id)).length, 4);
    await world.office.meter.flush();
    assert.equal((await rows(id)).find((row) => row['route'] === 'GET /public/v1/me')!['calls'], 3, 'an empty flush writes nothing');
  });

  it('counts the requests refused by a limit as rate limited, and never counts a request twice', async () => {
    const { id, secret } = await world.makeKey(0, { rateLimitPerMinute: 2 });
    for (let index = 0; index < 5; index += 1) {
      await asKey(secret, '/me');
    }
    await world.office.meter.flush();
    assert.deepEqual((await rows(id)).map((row) => [row['route'], row['calls'], row['errors4xx'], row['rateLimited']]), [['GET /public/v1/me', 5, 0, 3]]);
  });

  it('keeps a row of each key, and shows the rows to the PSA in the usage of the key', async () => {
    const one = await world.makeKey(0);
    const two = await world.makeKey(0);
    await asKey(one.secret, '/me');
    await asKey(two.secret, '/me');
    await asKey(two.secret, '/me');
    await world.office.meter.flush();
    const usage = await world.as.call(world.office.cluster.psa, 'GET', world.keysPath(0, `/${two.id}/usage`));
    assert.deepEqual([usage.status, usage.body.data.totals.calls, usage.body.data.rows.map((row: { route: string; calls: number }) => [row.route, row.calls])], [200, 2, [['GET /public/v1/me', 2]]]);
    const other = await world.as.call(world.office.cluster.psa, 'GET', world.keysPath(0, `/${one.id}/usage`));
    assert.equal(other.body.data.totals.calls, 1);
  });

  it('refreshes lastUsedAt at most once a minute', async () => {
    const { id, secret } = await world.makeKey();
    const lastUsed = async () => (await world.storedKey(id))!['lastUsedAt'] as Date | null;
    assert.equal(await lastUsed(), null);
    await asKey(secret, '/me');
    await until(async () => (await lastUsed()) !== null);
    const first = (await lastUsed())!;
    assert.equal(first.getTime(), world.office.clock.now());
    world.office.clock.advance(59_000);
    await asKey(secret, '/me');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await lastUsed())!.getTime(), first.getTime());
    world.office.clock.advance(1000);
    await asKey(secret, '/me');
    await until(async () => (await lastUsed())!.getTime() !== first.getTime());
    assert.equal((await lastUsed())!.getTime(), first.getTime() + 60_000);
    // The next use is again within the minute.
    world.office.clock.advance(5000);
    await asKey(secret, '/me');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await lastUsed())!.getTime(), first.getTime() + 60_000);
    // A key that is refused is not "used".
    const revoked = await world.makeKey();
    await world.as.call(world.office.cluster.psa, 'POST', world.keysPath(0, `/${revoked.id}/revoke`));
    await asKey(revoked.secret, '/me');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await world.storedKey(revoked.id))!['lastUsedAt'], null);
  });

  it('does not touch the key of another group, and writes no row for a group that has the API off', async () => {
    const { id, secret } = await world.makeKey(0);
    const other = await world.makeKey(1);
    await world.setPublicApi(0, { enabled: false });
    await asKey(secret, '/me');
    await asKey(other.secret, '/me');
    await world.office.meter.flush();
    assert.deepEqual(await rows(id), []);
    assert.equal((await rows(other.id)).length, 1);
    assert.deepEqual([...new Set((await common().collection('apiUsage').find().toArray()).map((row) => (row['groupId'] as ObjectId).toHexString()))], [world.group(1).groupId.toHexString()]);
    assert.ok(fixtureId('group', 1));
  });
});
