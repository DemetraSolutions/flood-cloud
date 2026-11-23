import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const common = () => ctx.databases.common();
const group = () => world.group(0);
const own = () => group().ownPlaceId;
const other = () => group().otherPlaceId;
const hex = (id: ObjectId) => id.toHexString();
const placeUrl = (placeId: ObjectId, index = 0) => `/groups/${hex(world.group(index).groupId)}/places/${hex(placeId)}`;
const unauthenticated = { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } };
const disabled = { error: { code: 'STORE_DISABLED', message: 'Store not operational' } };
const companyOf = async (placeId: ObjectId): Promise<ObjectId> => (await common().collection('places').findOne({ _id: placeId }))!['companyId'];
let store: ActivatedKey;

async function reset(): Promise<void> {
  await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await common().collection('storeKeys').deleteMany({});
  await common().collection('storeActivationCodes').deleteMany({});
  await reset();
  limiter.reset();
  store = await world.activate(own());
});

describe('the requests of a store key', () => {
  it('reads its context: group, company, place, key and activation', async () => {
    const reply = await world.asStore(store.key, 'GET', '/store-context');
    assert.deepEqual(reply.body, {
      data: { groupId: hex(group().groupId), companyId: hex(await companyOf(own())), placeId: hex(own()), keyId: store.keyId, activatedAt: new Date(world.office.clock.now()).toISOString() },
    });
    assert.equal(reply.status, 200);
  });

  it('follows the company of the place when the place moves to another one', async () => {
    const moved = (await common().collection('companies').findOne({ _id: { $ne: await companyOf(own()) }, groupId: group().groupId }))!['_id'] as ObjectId;
    await common().collection('places').updateOne({ _id: own() }, { $set: { companyId: moved } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).body.data.companyId, hex(moved));
  });

  it('has one call for its place: the detail route of the backoffice is 403 to it (own place, any other, or none), the full configuration is /store-context/place', async () => {
    const answers = new Set<string>();
    for (const path of [placeUrl(own()), placeUrl(other()), placeUrl(world.group(1).ownPlaceId, 1), placeUrl(own(), 1), placeUrl(new ObjectId()), `/groups/${hex(group().groupId)}/places/not-an-id`]) {
      const reply = await world.asStore(store.key, 'GET', path);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN'], path);
      assert.equal(reply.headers.get('etag'), null);
      answers.add(JSON.stringify(reply.body));
    }
    assert.equal(answers.size, 1);
    const place = await world.asStore(store.key, 'GET', '/store-context/place');
    assert.deepEqual([place.status, place.body.data.id], [200, hex(own())]);
    assert.ok(JSON.stringify(place.body).includes('fixture-integration-secret'), 'with the credentials, which the detail of the backoffice never carries');
  });

  it('is 403 on everything that was not opened to it: lists, other resources, the profile, the sessions, writes on its own place', async () => {
    const g = hex(group().groupId);
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/groups/${g}/places`],
      ['GET', `/groups/${g}/places/${hex(own())}`],
      ['GET', `/groups/${g}/companies`],
      ['GET', `/groups/${g}`],
      ['GET', `/groups/${g}/users`],
      ['GET', '/groups'],
      ['POST', '/groups', { group: { name: 'x' } }],
      ['GET', '/me'],
      ['GET', '/activity-log'],
      ['GET', '/dealers'],
      ['POST', '/auth/logout'],
      ['POST', '/auth/logout-all'],
      ['POST', '/client-errors', { message: 'x' }],
      ['PATCH', placeUrl(own()), { name: 'x' }],
      ['POST', `${placeUrl(own())}/trash`],
      ['DELETE', placeUrl(own())],
      ['PUT', `${placeUrl(own())}/settings/dealer`, { sentry: true, serverIp: '1.1.1.1', connectorAddress: '' }],
      ['PUT', `${placeUrl(own())}/integrations`, {}],
      ['PUT', `${placeUrl(own())}/devices`, { items: [] }],
      // The tools of the platform (steps T1, T2, T3) are not opened to a store key either; the import is refused before its body is read.
      ['GET', '/diagnostics/devices'],
      ['GET', '/diagnostics/devices.csv'],
      ['GET', `/groups/${g}/email-templates`],
      ['POST', `/groups/${g}/email-templates`, { name: 'x' }],
      ['GET', `/groups/${g}/email-templates/${hex(own())}`],
      ['PATCH', `/groups/${g}/email-templates/${hex(own())}`, { name: 'x' }],
      ['DELETE', `/groups/${g}/email-templates/${hex(own())}`],
      ['GET', '/tobaccos'],
      ['POST', '/tobaccos/import', {}],
      ['GET', world.keyPath(0, own())],
      ['POST', world.keyPath(0, own(), '/activation-codes')],
      ['DELETE', world.keyPath(0, own())],
    ];
    for (const [method, path, body] of attempts) {
      const reply = await world.asStore(store.key, method, path, body);
      assert.deepEqual([reply.status, reply.body?.error?.code], [403, 'FORBIDDEN'], `${method} ${path}`);
    }
    assert.equal((await world.asStore(store.key, 'GET', '/groups/not-a-group/places/x')).status, 403, 'no route is opened to a store key for now: not even the detail of its own place');
    assert.equal(await common().collection('storeActivationCodes').countDocuments({}), 0, 'nothing was created');
    assert.equal(await common().collection('tobaccos').countDocuments({}), 0, 'no list was written');
    assert.equal(await common().collection('idempotencyKeys').countDocuments({}), 0, 'the import did not even begin');
    assert.equal((await world.keysOf(own())).length, 1);
  });

  it('is 401, and the same 401, for a key that is missing, malformed, unknown, revoked, of another kind, or sent in another way', async () => {
    const revoked = await world.activate(other());
    await call(world.office.cluster.psa, 'DELETE', world.keyPath(0, other()));
    const bodies = new Set<string>();
    // Always a different last symbol (a base64url symbol can share its meaning with another when the last bits are padding): the forged key is never the real one.
    const real = store.key.slice(0, 48);
    const forged = `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`;
    for (const [name, headers] of [
      ['no header', {}],
      ['not Bearer', { authorization: `Basic ${store.key}` }],
      ['bearer without key', { authorization: 'Bearer ' }],
      ['prefix only', { authorization: 'Bearer fc_sk_' }],
      ['short', { authorization: `Bearer ${store.key.slice(0, 20)}` }],
      ['one symbol too many', { authorization: `Bearer ${store.key}A` }],
      ['one symbol changed', { authorization: `Bearer ${forged}` }],
      ['a public API key', { authorization: `Bearer fc_pk_${store.key.slice(6)}` }],
      ['a refresh token', { authorization: `Bearer fc_rt_${store.key.slice(6)}` }],
      ['the right key in another header', { 'x-api-key': store.key, 'x-store-key': store.key }],
      ['revoked', { authorization: `Bearer ${revoked.key}` }],
      ['two keys', { authorization: `Bearer ${store.key} ${store.key}` }],
    ] as const) {
      const reply = await world.office.call('GET', '/store-context', undefined, undefined, headers);
      assert.equal(reply.status, 401, name);
      bodies.add(JSON.stringify(await reply.json()));
    }
    assert.deepEqual([...bodies], [JSON.stringify(unauthenticated)]);
  });

  it('keeps the two credentials apart: a user token on the route of the stores is 403, a key on a user route is 403, and neither is ever read as the other', async () => {
    const access = await world.as.tokenOf(world.office.cluster.psa);
    assert.equal((await world.asStore(access, 'GET', '/store-context')).status, 403);
    assert.equal((await world.asStore(`fc_sk_${access.slice(6)}`, 'GET', '/store-context')).status, 401, 'an access token with the prefix of a key is not a key');
    assert.equal((await world.asStore(`fc_at_${store.key.slice(6)}`, 'GET', '/me')).status, 401, 'a key with the prefix of an access token is not a token');
    assert.equal((await world.asStore(access, 'GET', placeUrl(own()))).status, 200, 'a user keeps reading the place as before');
    assert.equal((await world.asStore(store.key, 'GET', '/me')).status, 403);
  });

  it('answers 429 over the limit of the key (600 a minute), counted per key, and counts only the store keys in it', async () => {
    const small = await openTestDatabases();
    const limited = memoryRateLimiter();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '3' }, rateLimiter: limited });
    try {
      const a = await office.activate(office.group(0).ownPlaceId);
      const b = await office.activate(office.group(0).otherPlaceId);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const reply = await office.asStore(a.key, 'GET', '/store-context');
        statuses.push(reply.status);
        if (reply.status === 429) {
          assert.ok(Number(reply.headers.get('retry-after')) >= 1);
        }
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal((await office.asStore(b.key, 'GET', '/store-context')).status, 200, 'another key has its own counter');
      assert.ok(limited.calls.filter((entry) => entry.bucket === 'api:store').every((entry) => [a.keyId, b.keyId].includes(entry.key)));
      assert.ok(!limited.calls.some((entry) => entry.bucket === 'api:user' && [a.keyId, b.keyId].includes(entry.key)));
      const exceeded = office.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded');
      assert.deepEqual([exceeded.length, exceeded[0]!.actor, exceeded[0]!.groupId, exceeded[0]!.metadata], [1, { kind: 'store', id: new ObjectId(a.keyId) }, office.group(0).groupId, { bucket: 'api:store' }]);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('counts the requests a route refuses (403) and the ones of a blocked store: 601 requests of a key end in 429, with the 600 of the default limit shared by the two cases', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '600' }, rateLimiter: memoryRateLimiter() });
    try {
      const refused = await office.activate(office.group(0).ownPlaceId);
      const statuses = new Set<number>();
      let last = 0;
      for (let i = 0; i < 601; i += 1) {
        const reply = await office.asStore(refused.key, 'GET', '/me');
        statuses.add(reply.status);
        last = reply.status;
      }
      assert.deepEqual([[...statuses].sort(), last], [[403, 429], 429], 'a route that does not admit the store is counted');
      // A blocked store, with a key of its own, shares nothing with the first one; half the requests are refused routes, half are on a blocked place.
      const second = await office.activate(office.group(0).otherPlaceId);
      await small.databases.common().collection('places').updateOne({ _id: office.group(0).otherPlaceId }, { $set: { status: false } });
      const seen: number[] = [];
      for (let i = 0; i < 601; i += 1) {
        seen.push((await office.asStore(second.key, 'GET', i % 2 === 0 ? '/store-context' : '/me')).status);
      }
      assert.deepEqual([seen[0], seen[599], seen[600]], [403, 403, 429], 'a blocked store is counted, and both kinds of request share the counter');
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('counts a failed exchange in the failed authentications of its address', async () => {
    limiter.reset();
    limiter.calls.length = 0;
    assert.equal((await world.exchange('0000-0000-0000-0000')).status, 401);
    assert.deepEqual(limiter.calls.map((entry) => entry.bucket).filter((bucket) => bucket === 'auth-fail:ip'), ['auth-fail:ip']);
    const code = await world.codeFor(world.group(0).otherPlaceId);
    limiter.calls.length = 0;
    assert.equal((await world.exchange(code)).status, 201);
    assert.ok(!limiter.calls.some((entry) => entry.bucket === 'auth-fail:ip'), 'a good exchange is not a failure');
  });

  it('is 429 on the exchange over the limit of its address, with Retry-After, before the body is read', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_STORE_ACTIVATION_PER_IP: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const reply = await office.exchange('0000-0000-0000-0000');
        statuses.push(reply.status);
        if (reply.status === 429) {
          assert.ok(Number(reply.headers.get('retry-after')) >= 1);
        }
      }
      assert.deepEqual(statuses, [401, 401, 429, 429]);
      assert.equal((await office.office.call('POST', '/store-activations', undefined, 'not json', { 'content-type': 'text/plain' })).status, 429);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('counts the keys that fail in the failed authentications of the address, and the good ones never', async () => {
    limiter.reset();
    limiter.calls.length = 0;
    await world.asStore(store.key, 'GET', '/store-context');
    assert.ok(!limiter.calls.some((entry) => entry.bucket === 'auth-fail:ip'));
    await world.asStore(`fc_sk_${'z'.repeat(43)}`, 'GET', '/store-context');
    assert.ok(limiter.calls.some((entry) => entry.bucket === 'auth-fail:ip'));
    await world.asStore(store.key, 'GET', '/groups');
    assert.equal(limiter.calls.filter((entry) => entry.bucket === 'auth-fail:ip').length, 1, 'a 403 is not a failed authentication');
  });
});

describe('a store that is not operational: 403 STORE_DISABLED, nothing revoked, it resumes by itself', () => {
  const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ['group suspended', () => common().collection('groups').updateOne({ _id: group().groupId }, { $set: { status: false } }), reset],
    ['group in the trash', () => common().collection('groups').updateOne({ _id: group().groupId }, { $set: { trash: true } }), reset],
    ['place disabled', () => common().collection('places').updateOne({ _id: own() }, { $set: { status: false } }), reset],
    ['place status missing', () => common().collection('places').updateOne({ _id: own() }, { $unset: { status: '' } }), reset],
    ['license over', () => common().collection('places').updateOne({ _id: own() }, { $set: { expirationDate: new Date(world.office.clock.now() - 1) } }), reset],
    ['company in the trash', async () => common().collection('companies').updateOne({ _id: await companyOf(own()) }, { $set: { trash: true } }), reset],
    ['company without a copy', async () => common().collection('companies').deleteOne({ _id: await companyOf(own()) }), async () => undefined],
    ['place without a company', () => common().collection('places').updateOne({ _id: own() }, { $set: { companyId: 'x' } }), async () => undefined],
  ];
  for (const [name, break_, mend] of cases) {
    it(`${name}`, async () => {
      const company = await companyOf(own());
      const savedCompany = await common().collection('companies').findOne({ _id: company });
      const mark = world.office.activity.entries.length;
      await break_();
      for (const path of ['/store-context', '/store-context/place']) {
        const reply = await world.asStore(store.key, 'GET', path);
        assert.deepEqual([reply.status, reply.body], [403, disabled], `${name} ${path}`);
      }
      assert.equal((await world.activeKey(own()))!['status'], 'active', 'nothing is revoked');
      assert.equal(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked').length, 0);
      await mend();
      await common().collection('places').updateOne({ _id: own() }, { $set: { companyId: company, status: true } });
      if (savedCompany !== null) {
        await common().collection('companies').replaceOne({ _id: company }, savedCompany, { upsert: true });
      }
      assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200, `${name}: resumes by itself`);
    });
  }

  it('has no end of license when the date is missing, null or not a date, and ends exactly at the date: the clock of the server decides', async () => {
    for (const value of [null, undefined, 'tomorrow', 5, { $date: 'x' }]) {
      await common().collection('places').updateOne({ _id: own() }, value === undefined ? { $unset: { expirationDate: '' } } : { $set: { expirationDate: value } });
      assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200, String(JSON.stringify(value)));
    }
    const at = new Date(world.office.clock.now() + 60_000);
    await common().collection('places').updateOne({ _id: own() }, { $set: { expirationDate: at } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200, 'not over yet');
    world.office.clock.advance(60_000);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 403, 'over at the date');
    await common().collection('places').updateOne({ _id: own() }, { $set: { expirationDate: new Date(world.office.clock.now() + 86_400_000) } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200, 'renewed: it resumes by itself');
  });

  it('is blocked for a group that does not exist (a key without a group is as good as unknown: 401)', async () => {
    const saved = (await common().collection('groups').findOne({ _id: group().groupId }))!;
    await common().collection('groups').deleteOne({ _id: group().groupId });
    assert.deepEqual((await world.asStore(store.key, 'GET', '/store-context')).body, unauthenticated);
    await common().collection('groups').insertOne(saved);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 200);
  });

  it('does not stop the other places of the group when one is disabled', async () => {
    const second = await world.activate(other());
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 403);
    assert.equal((await world.asStore(second.key, 'GET', '/store-context')).status, 200);
  });
});

describe('a place that leaves the operation revokes its key', () => {
  it('through the legacy: a place in the trash written to its copy revokes the key at the first request (system), and a restore does not bring it back', async () => {
    await common().collection('places').updateOne({ _id: own() }, { $set: { trash: true } });
    const mark = world.office.activity.entries.length;
    assert.deepEqual((await world.asStore(store.key, 'GET', '/store-context')).body, unauthenticated);
    const [stored] = await world.keysOf(own());
    assert.deepEqual([stored!['status'], stored!['revokeReason'], stored!['revokedBy']], ['revoked', 'placeTrashed', { kind: 'system' }]);
    const [event] = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked');
    assert.deepEqual([event!.actor, event!.metadata, event!.resource!.id], [{ kind: 'system' }, { reason: 'placeTrashed', keyHint: store.key.slice(6, 10) }, store.keyId]);
    await common().collection('places').updateOne({ _id: own() }, { $set: { trash: false } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 401, 'restored: the key stays revoked');
    assert.equal((await world.keysOf(own())).length, 1);
    assert.equal(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked').length, 1, 'recorded once');
  });

  it('through the legacy: a place whose copy is gone revokes the key as deleted', async () => {
    const copy = (await common().collection('places').findOne({ _id: own() }))!;
    await common().collection('places').deleteOne({ _id: own() });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 401);
    assert.equal((await world.keysOf(own()))[0]!['revokeReason'], 'placeDeleted');
    await common().collection('places').insertOne(copy);
  });

  it('through the service: trashing the place revokes the key in the same request (by the user, recorded), and restoring it gives no key back', async () => {
    const tag = async () => ({ 'if-match': (await call(group().sa, 'GET', placeUrl(own()))).headers.get('etag')! });
    const mark = world.office.activity.entries.length;
    const trashed = await call(group().sa, 'POST', `${placeUrl(own())}/trash`, undefined, await tag());
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    const [stored] = await world.keysOf(own());
    assert.deepEqual([stored!['status'], stored!['revokeReason'], stored!['revokedBy']], ['revoked', 'placeTrashed', { kind: 'user', userId: group().sa, role: 'SA' }]);
    const [event] = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked');
    assert.deepEqual([event!.actor, event!.metadata!['reason']], [{ kind: 'user', id: group().sa, role: 'SA' }, 'placeTrashed']);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 401);
    assert.equal((await call(group().sa, 'POST', `${placeUrl(own())}/restore`, undefined, await tag())).status, 200);
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 401, 'the key stays revoked');
    assert.equal(await world.activeKey(own()), null);
    const again = await world.activate(own());
    assert.equal((await world.asStore(again.key, 'GET', '/store-context')).status, 200, 'a new activation works');
  });

  it('through the service: deleting a trashed place revokes the key as deleted, and the document of the place is never touched by the key', async () => {
    const id = await world.seedPlace(0, 100, 1);
    const fresh = await world.activate(id);
    // The place goes to the trash without a request of the store (the original and its copy), so the key is still active when it is deleted.
    await ctx.databases.group(group().groupId, 'cluster0').collection('places').updateOne({ _id: id }, { $set: { trash: true } });
    await common().collection('places').updateOne({ _id: id }, { $set: { trash: true } });
    const before = await world.storedPlace(0, id);
    const tag = { 'if-match': (await call(group().sa, 'GET', placeUrl(id))).headers.get('etag')! };
    assert.equal((await call(group().sa, 'DELETE', placeUrl(id), undefined, tag)).status, 204);
    const [stored] = await world.keysOf(id);
    assert.deepEqual([stored!['status'], stored!['revokeReason'], stored!['revokedBy'].role], ['revoked', 'placeDeleted', 'SA']);
    assert.equal((await world.asStore(fresh.key, 'GET', '/store-context')).status, 401);
    assert.equal(before !== null && (await world.storedPlace(0, id)) === null, true);
  });

  it('never writes to the place: its stored document is the same after an activation, many requests and a revocation', async () => {
    const before = await world.storedPlace(0, other());
    const copyBefore = await world.copyOfPlace(other());
    const k = await world.activate(other());
    for (let i = 0; i < 3; i += 1) {
      await world.asStore(k.key, 'GET', '/store-context/place');
    }
    await call(world.office.cluster.psa, 'DELETE', world.keyPath(0, other()));
    assert.deepEqual(await world.storedPlace(0, other()), before);
    assert.deepEqual(await world.copyOfPlace(other()), copyBefore);
  });

  it('does not copy the key or the code when the place is duplicated', async () => {
    await world.codeFor(own());
    const copy = await call(world.office.cluster.psa, 'POST', `${placeUrl(own())}/duplicate`);
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const id = new ObjectId(copy.body.data.id as string);
    assert.deepEqual([await common().collection('storeKeys').countDocuments({ placeId: id }), await common().collection('storeActivationCodes').countDocuments({ placeId: id })], [0, 0]);
    assert.equal((await call(world.office.cluster.psa, 'GET', world.keyPath(0, id))).body.data.status, 'none');
    assert.equal((await world.keysOf(own())).length, 1, 'the source keeps its key');
  });
});

describe('what the key leaves behind', () => {
  it('records a revoked key that is still used, once an hour for a key, and the legitimate ones never', async () => {
    const mark = world.office.activity.entries.length;
    const presented = () => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.revokedKeyPresented');
    await world.asStore(store.key, 'GET', '/store-context');
    assert.equal(presented().length, 0);
    await call(world.office.cluster.psa, 'DELETE', world.keyPath(0, own()));
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 401);
    }
    const [event, ...rest] = presented();
    assert.equal(rest.length, 0);
    assert.deepEqual([event!.actor, event!.resource, event!.groupId, event!.outcome], [{ kind: 'anonymous' }, { type: 'storeKey', id: store.keyId }, group().groupId, 'denied']);
    const second = await world.activate(own());
    await call(world.office.cluster.psa, 'DELETE', world.keyPath(0, own()));
    await world.asStore(second.key, 'GET', '/store-context');
    assert.equal(presented().length, 2, 'another key is another event');
  });

  it('updates the last contact at most once a minute, with the address and the user agent of the request', async () => {
    const first = (await world.activeKey(own()))!;
    const sameMinute = async (): Promise<unknown> => (await world.activeKey(own()))!['lastSeenAt'];
    world.office.clock.advance(30_000);
    await world.asStore(store.key, 'GET', '/store-context', undefined, { 'user-agent': 'Other/9' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await sameMinute(), first['lastSeenAt'], 'within a minute: not written');
    world.office.clock.advance(31_000);
    await world.asStore(store.key, 'GET', '/store-context', undefined, { 'user-agent': 'Other/9' });
    let updated = (await world.activeKey(own()))!;
    for (let tries = 0; tries < 50 && updated['lastSeenAt'].getTime() === first['lastSeenAt'].getTime(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      updated = (await world.activeKey(own()))!;
    }
    assert.deepEqual([updated['lastSeenAt'], updated['lastSeenUserAgent']], [new Date(world.office.clock.now()), 'Other/9']);
    assert.match(updated['lastSeenIp'], /127\.0\.0\.1|::1/);
    // A blocked store is seen too: the support sees that it is alive.
    world.office.clock.advance(61_000);
    await common().collection('places').updateOne({ _id: own() }, { $set: { status: false } });
    assert.equal((await world.asStore(store.key, 'GET', '/store-context')).status, 403);
    for (let tries = 0; tries < 50 && (await world.activeKey(own()))!['lastSeenAt'].getTime() !== world.office.clock.now(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await world.activeKey(own()))!['lastSeenAt'].getTime(), world.office.clock.now());
  });

  it('logs no key and no code, and the stored documents hold only hashes', async () => {
    const code = await world.codeFor(other());
    const done = await world.exchange(code);
    await world.asStore(done.body.data.key, 'GET', '/store-context');
    await world.asStore(done.body.data.key, 'GET', '/groups');
    await world.exchange(code);
    const everything = JSON.stringify([world.office.logEvents, world.office.activity.entries]);
    for (const secret of [done.body.data.key as string, code, code.replaceAll('-', '')]) {
      assert.ok(!everything.includes(secret));
    }
    assert.ok(!everything.includes('fc_sk_'), 'no key, however short, in any log or entry');
  });

  it('has its indexes: one active key per place guaranteed by the database', async () => {
    const keys = common().collection('storeKeys');
    const names = (await keys.indexes()).map((index) => index.name).sort();
    assert.deepEqual(names, ['_id_', 'groupId_1_placeId_1_activatedAt_-1', 'keyHash_1', 'placeId_1_active', 'purgeAt_1']);
    const active = (await keys.indexes()).find((index) => index.name === 'placeId_1_active')!;
    assert.deepEqual([active.unique, active.partialFilterExpression], [true, { status: 'active' }]);
    const document = (await world.activeKey(own()))!;
    const { _id, ...rest } = document;
    await assert.rejects(() => keys.insertOne({ ...rest, keyHash: 'f'.repeat(64) } as never), (error: { code?: number }) => error.code === 11000, 'a second active key of the place');
    await keys.insertOne({ ...rest, placeId: new ObjectId(), keyHash: 'd'.repeat(64), status: 'revoked', revokedAt: new Date(), revokedBy: { kind: 'system' }, revokeReason: 'revoked' } as never);
    const codes = common().collection('storeActivationCodes');
    assert.deepEqual((await codes.indexes()).map((index) => [index.name, index.unique ?? false, index.expireAfterSeconds ?? null]).sort(), [['_id_', false, null], ['codeHash_1', true, null], ['expiresAt_1', false, 0], ['placeId_1', true, null]]);
  });
});
