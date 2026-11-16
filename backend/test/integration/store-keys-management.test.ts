import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Document, ObjectId } from 'mongodb';
import { hashActivationCode, normalizeActivationCode } from '../../src/modules/store-keys/activation-code.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const common = () => ctx.databases.common();
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const codes = () => common().collection('storeActivationCodes');
const keyUrl = (placeId: ObjectId, rest = '', index = 0) => world.keyPath(index, placeId, rest);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await common().collection('storeKeys').deleteMany({});
  await codes().deleteMany({});
  await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
});

describe('the status of the key of a place', () => {
  it('is none for a place that was never activated, for the PSA and for the dealer of the group', async () => {
    for (const actor of [psa(), dealer()]) {
      const reply = await call(actor, 'GET', keyUrl(own()));
      assert.deepEqual([reply.status, reply.body], [200, { data: { status: 'none', key: null, pendingActivation: null, lastRevoked: null } }]);
    }
  });

  it('shows the active key by its hint, who activated it and what the app declared, and never the key or its hash', async () => {
    const code = await world.codeFor(own(), 0, dealer());
    const done = await world.exchange(code, { installation: { appVersion: '2.0.1', platform: 'windows' } }, { 'user-agent': 'StoreApp/2.0.1' });
    assert.equal(done.status, 201);
    const reply = await call(psa(), 'GET', keyUrl(own()));
    assert.equal(reply.status, 200);
    const { key, status, pendingActivation, lastRevoked } = reply.body.data;
    assert.deepEqual([status, pendingActivation, lastRevoked], ['active', null, null]);
    assert.deepEqual(key, {
      id: done.body.data.keyId,
      hint: `fc_sk_${(done.body.data.key as string).slice(6, 10)}…`,
      activatedAt: new Date(world.office.clock.now()).toISOString(),
      activatedBy: { id: dealer().toHexString(), role: 'D' },
      installation: { userAgent: 'StoreApp/2.0.1', appVersion: '2.0.1', platform: 'windows' },
      lastSeenAt: new Date(world.office.clock.now()).toISOString(),
      lastSeenIp: key.lastSeenIp,
    });
    assert.match(key.lastSeenIp, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    const text = JSON.stringify(reply.body);
    assert.ok(!text.includes(done.body.data.key) && !text.includes('keyHash') && !text.includes(sha256(done.body.data.key)));
  });

  it('shows the pending code (who made it, when it expires) and hides it once it expired, even before the TTL of the database removed it', async () => {
    await world.codeFor(own());
    const pending = (await call(psa(), 'GET', keyUrl(own()))).body.data.pendingActivation;
    assert.deepEqual(Object.keys(pending).sort(), ['createdAt', 'createdBy', 'expiresAt']);
    assert.deepEqual(pending.createdBy, { id: psa().toHexString(), role: 'PSA' });
    assert.equal(new Date(pending.expiresAt).getTime() - new Date(pending.createdAt).getTime(), 24 * 3_600_000);
    await codes().updateOne({ placeId: own() }, { $set: { expiresAt: new Date(world.office.clock.now() - 1) } });
    assert.equal((await call(psa(), 'GET', keyUrl(own()))).body.data.pendingActivation, null);
  });

  it('tells when and why the last key ended', async () => {
    await world.activate(own());
    assert.equal((await call(psa(), 'DELETE', keyUrl(own()))).status, 204);
    const reply = await call(psa(), 'GET', keyUrl(own()));
    assert.deepEqual(reply.body.data, { status: 'none', key: null, pendingActivation: null, lastRevoked: { revokedAt: new Date(world.office.clock.now()).toISOString(), reason: 'revoked' } });
  });
});

describe('the permissions on the key of a place: only the PSA and the dealers', () => {
  it('is 403 for a group administrator, a company administrator and a place administrator on every route, even on their own place', async () => {
    const { sa, ca, pa } = world.group(0);
    for (const actor of [sa, ca, pa]) {
      for (const [method, rest] of [['GET', ''], ['POST', '/activation-codes'], ['DELETE', '/activation-code'], ['DELETE', '']] as const) {
        assert.equal(failure(await call(actor, method, keyUrl(own(), rest))).status, 403, `${actor.toHexString()} ${method} ${rest}`);
      }
    }
    assert.equal(await codes().countDocuments({}), 0);
  });

  it('is 404 for a dealer outside his groups, for another group, and for a place that is not in the group of the path', async () => {
    const outside = world.office.cluster.dealerB;
    for (const [method, rest] of [['GET', ''], ['POST', '/activation-codes'], ['DELETE', '/activation-code'], ['DELETE', '']] as const) {
      assert.equal(failure(await call(outside, method, keyUrl(own(), rest))).status, 404, `${method} ${rest}`);
      assert.equal(failure(await call(psa(), method, keyUrl(world.group(1).ownPlaceId, rest, 0))).status, 404, `${method} ${rest}: the place of another group`);
    }
    assert.equal((await call(psa(), 'GET', keyUrl(world.group(1).ownPlaceId, '', 1))).status, 200);
    assert.equal(failure(await call(psa(), 'GET', `/groups/${world.group(0).groupId.toHexString()}/places/not-an-id/store-key`)).status, 422);
    assert.equal(await codes().countDocuments({}), 0);
  });

  it('is 401 without a session and 405 for a method the path does not have', async () => {
    assert.equal((await world.office.call('GET', keyUrl(own()), undefined)).status, 401);
    assert.equal(failure(await call(psa(), 'PUT', keyUrl(own()))).status, 405);
  });
});

describe('POST …/store-key/activation-codes', () => {
  it('makes a code of 16 symbols valid for 24 hours, answers 201 with its Location, and keeps only its hash', async () => {
    const mark = world.office.activity.entries.length;
    const reply = await call(psa(), 'POST', keyUrl(own(), '/activation-codes'));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.headers.get('location'), `/v1${keyUrl(own())}`);
    const { code, expiresAt } = reply.body.data as { code: string; expiresAt: string };
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    assert.equal(expiresAt, new Date(world.office.clock.now() + 24 * 3_600_000).toISOString());
    const stored = (await codes().find({}).toArray()) as Document[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!['codeHash'], hashActivationCode(normalizeActivationCode(code)!));
    assert.deepEqual(Object.keys(stored[0]!).sort(), ['_id', 'codeHash', 'companyId', 'createdAt', 'createdBy', 'expiresAt', 'groupId', 'placeId']);
    assert.ok(!JSON.stringify(stored).includes(code) && !JSON.stringify(stored).includes(normalizeActivationCode(code)!));
    const [event] = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.activationCodeCreated');
    assert.deepEqual([event!.category, event!.outcome, event!.actor.kind, event!.resource!.id, event!.groupId], ['security', 'success', 'user', own().toHexString(), world.group(0).groupId]);
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(code) && !world.office.logEvents.some((line) => JSON.stringify(line).includes(code)));
  });

  it('replaces the pending code of the place: one at a time, and the old one stops working', async () => {
    const first = await world.codeFor(own());
    const second = await world.codeFor(own(), 0, dealer());
    assert.equal(await codes().countDocuments({ placeId: own() }), 1);
    assert.equal(failure(await world.exchange(first)).status, 401);
    assert.equal((await world.exchange(second)).status, 201);
    await world.codeFor(other());
    assert.equal(await codes().countDocuments({}), 1, 'the code of the other place is the only one left: the first was spent');
  });

  it('leaves the active key alone: the store keeps working until the new server activates', async () => {
    const { key } = await world.activate(own());
    await world.codeFor(own());
    assert.equal((await world.asStore(key, 'GET', '/store-context')).status, 200);
    assert.equal((await call(psa(), 'GET', keyUrl(own()))).body.data.status, 'active');
  });

  it('accepts an empty body or {} and refuses any property (422), and a body that is not JSON', async () => {
    assert.equal((await call(psa(), 'POST', keyUrl(own(), '/activation-codes'), {})).status, 201);
    assert.deepEqual(failure(await call(psa(), 'POST', keyUrl(own(), '/activation-codes'), { placeId: 'x' })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'placeId', issue: 'unknown' }] });
    const text = await world.office.call('POST', keyUrl(own(), '/activation-codes'), await world.as.tokenOf(psa()), 'x', { 'content-type': 'text/plain' });
    assert.equal(text.status, 415);
  });

  it('is 404 for a place in the trash or that does not exist, and 409 when the group, the place or its company is not operational: no code for a store that could not use it', async () => {
    const url = keyUrl(own(), '/activation-codes');
    const companyOfOwn = (await common().collection('places').findOne({ _id: own() }))!['companyId'];
    await common().collection('places').updateOne({ _id: own() }, { $set: { trash: true } });
    assert.equal(failure(await call(psa(), 'POST', url)).status, 404);
    await common().collection('places').updateOne({ _id: own() }, { $set: { trash: false } });
    assert.equal(failure(await call(psa(), 'POST', keyUrl(world.group(1).ownPlaceId, '/activation-codes', 0))).status, 404);
    for (const [name, collection, id, set] of [
      ['place disabled', 'places', own(), { status: false }],
      ['license over', 'places', own(), { expirationDate: new Date(world.office.clock.now() - 1) }],
      ['company in the trash', 'companies', companyOfOwn, { trash: true }],
      ['group suspended', 'groups', world.group(0).groupId, { status: false }],
      ['group in the trash', 'groups', world.group(0).groupId, { trash: true }],
    ] as const) {
      await common().collection(collection).updateOne({ _id: id as ObjectId }, { $set: set });
      assert.deepEqual(failure(await call(psa(), 'POST', url)), { status: 409, code: 'CONFLICT', details: undefined }, name);
      await beforeEachReset();
    }
    assert.equal(await codes().countDocuments({}), 0);
    // A group that is not available is the PSA's alone: a dealer does not even see it.
    await common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { status: false } });
    assert.equal(failure(await call(dealer(), 'POST', url)).status, 404);
  });
});

async function beforeEachReset(): Promise<void> {
  await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
}

describe('DELETE …/store-key/activation-code', () => {
  it('cancels the pending code (204), which then no longer works, and records it; 404 when there is none', async () => {
    const code = await world.codeFor(own());
    const mark = world.office.activity.entries.length;
    assert.equal((await call(dealer(), 'DELETE', keyUrl(own(), '/activation-code'))).status, 204);
    assert.equal(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.activationCodeCancelled' && entry.resource!.id === own().toHexString()).length, 1);
    assert.equal(failure(await world.exchange(code)).status, 401);
    assert.equal(failure(await call(dealer(), 'DELETE', keyUrl(own(), '/activation-code'))).status, 404);
    await world.codeFor(own());
    assert.equal(failure(await call(psa(), 'DELETE', keyUrl(other(), '/activation-code'))).status, 404, 'the code of another place is not touched');
    assert.equal(await codes().countDocuments({}), 1);
  });
});

describe('DELETE …/store-key', () => {
  it('revokes the active key (204): the store stops at its next request, the revocation is recorded, and the pending code stays', async () => {
    const { key, keyId } = await world.activate(own());
    await world.codeFor(own());
    const mark = world.office.activity.entries.length;
    assert.equal((await call(dealer(), 'DELETE', keyUrl(own()))).status, 204);
    assert.equal(failure(await world.asStore(key, 'GET', '/store-context')).status, 401);
    const [stored] = await world.keysOf(own());
    assert.deepEqual([stored!['status'], stored!['revokeReason'], stored!['revokedBy'], stored!['revokedAt']], ['revoked', 'revoked', { kind: 'user', userId: dealer(), role: 'D' }, new Date(world.office.clock.now())]);
    assert.equal(stored!['purgeAt'].getTime() - stored!['revokedAt'].getTime(), 365 * 86_400_000);
    const [event] = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked');
    assert.deepEqual([event!.resource, event!.metadata, event!.actor.role, event!.groupId], [{ type: 'storeKey', id: keyId }, { reason: 'revoked', keyHint: key.slice(6, 10) }, 'D', world.group(0).groupId]);
    assert.equal(await codes().countDocuments({ placeId: own() }), 1, 'the code exists to activate again');
  });

  it('is 404 when the place has no active key, and when the key was already revoked (never recorded twice)', async () => {
    assert.equal(failure(await call(psa(), 'DELETE', keyUrl(own()))).status, 404);
    await world.activate(own());
    assert.equal((await call(psa(), 'DELETE', keyUrl(own()))).status, 204);
    const mark = world.office.activity.entries.length;
    assert.equal(failure(await call(psa(), 'DELETE', keyUrl(own()))).status, 404);
    assert.equal(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.keyRevoked').length, 0);
  });
});
