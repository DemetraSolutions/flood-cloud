import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const common = () => ctx.databases.common();
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const codes = () => common().collection('storeActivationCodes');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const rejected = { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } };

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
  await codes().deleteMany({});
  await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null } });
  await common().collection('companies').updateMany({}, { $set: { trash: false } });
  await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
});

describe('POST /v1/store-activations', () => {
  it('exchanges a code for the key of the place: 201, the key shown once with the context, only its hash stored, the code spent', async () => {
    const code = await world.codeFor(own(), 0, world.office.cluster.dealerA);
    const mark = world.office.activity.entries.length;
    const reply = await world.exchange(code.toLowerCase().replaceAll('-', ' '), { installation: { appVersion: '2.0.1', platform: 'windows 11' } }, { 'user-agent': 'StoreApp/2.0.1 (Windows)' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.headers.get('location'), '/v1/store-context');
    const data = reply.body.data as Record<string, string>;
    assert.deepEqual(Object.keys(data).sort(), ['companyId', 'groupId', 'key', 'keyId', 'placeId']);
    assert.match(data['key']!, /^fc_sk_[A-Za-z0-9_-]{43}$/);
    const place = (await common().collection('places').findOne({ _id: own() }))!;
    assert.deepEqual([data['groupId'], data['placeId'], data['companyId']], [world.group(0).groupId.toHexString(), own().toHexString(), (place['companyId'] as { toHexString(): string }).toHexString()]);
    const stored = (await world.activeKey(own()))!;
    assert.deepEqual(
      [stored['keyHash'], stored['keyHint'], stored['status'], stored['activatedBy'], stored['installation'], stored['revokedAt'], stored['revokedBy'], stored['revokeReason'], 'purgeAt' in stored, stored['lastSeenUserAgent']],
      [sha256(data['key']!), data['key']!.slice(6, 10), 'active', { userId: world.office.cluster.dealerA, role: 'D' }, { userAgent: 'StoreApp/2.0.1 (Windows)', appVersion: '2.0.1', platform: 'windows 11' }, null, null, null, false, 'StoreApp/2.0.1 (Windows)'],
    );
    assert.equal(stored['_id'].toHexString(), data['keyId']);
    assert.equal(await codes().countDocuments({}), 0, 'the code is spent');
    // The key exists in no place but the response of this request.
    const everything = JSON.stringify([await common().collection('storeKeys').find({}).toArray(), world.office.activity.entries, world.office.logEvents]);
    assert.ok(!everything.includes(data['key']!) && !everything.includes(code) && !everything.includes(code.replaceAll('-', '')));
    const [activated] = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.activated');
    assert.deepEqual([activated!.actor, activated!.resource, activated!.groupId, activated!.metadata, activated!.outcome], [{ kind: 'store', id: stored['_id'] }, { type: 'storeKey', id: data['keyId'] }, world.group(0).groupId, { replacedKeyId: null }, 'success']);
    assert.equal((await world.asStore(data['key'], 'GET', '/store-context')).status, 200);
  });

  it('keeps null for what the app does not declare, and cuts its user agent at 200 characters', async () => {
    await world.activate(own());
    const first = (await world.activeKey(own()))!;
    assert.deepEqual([first['installation'].appVersion, first['installation'].platform], [null, null]);
    const reply = await world.exchange(await world.codeFor(own()), { installation: {} }, { 'user-agent': 'U'.repeat(1000) });
    assert.equal(reply.status, 201);
    const stored = (await world.activeKey(own()))!;
    assert.deepEqual([stored['installation'].userAgent, stored['lastSeenUserAgent']], ['U'.repeat(200), 'U'.repeat(200)]);
    assert.equal(stored['_id'].toHexString(), reply.body.data.keyId);
  });

  it('says the same thing to every failure: a code malformed, unknown, expired, already used, or for a place that is not operational', async () => {
    const used = await world.codeFor(own());
    assert.equal((await world.exchange(used)).status, 201);
    const expired = await world.codeFor(other());
    await codes().updateOne({ placeId: other() }, { $set: { expiresAt: new Date(world.office.clock.now() - 1) } });
    const failures = [
      ['malformed', 'not-a-code'],
      ['empty', ''],
      ['unknown', '0000-0000-0000-0000'],
      ['used', used],
      ['expired, before the TTL of the database removes it', expired],
      ['one symbol too many', `${used}A`],
    ] as const;
    for (const [name, code] of failures) {
      const reply = await world.exchange(code);
      assert.deepEqual([reply.status, reply.body], [401, rejected], name);
    }
    assert.equal(await world.activeKey(other()), null);
  });

  it('spends the code and gives no key when the place is not operational (disabled, license over, company or place in the trash, group suspended or trashed): one and the same 401', async () => {
    const companyId = (await common().collection('places').findOne({ _id: own() }))!['companyId'];
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['place disabled', () => common().collection('places').updateOne({ _id: own() }, { $set: { status: false } })],
      ['license over', () => common().collection('places').updateOne({ _id: own() }, { $set: { expirationDate: new Date(world.office.clock.now() - 1) } })],
      ['company in the trash', () => common().collection('companies').updateOne({ _id: companyId }, { $set: { trash: true } })],
      ['company copy missing', () => common().collection('companies').updateOne({ _id: companyId }, { $set: { groupId: world.group(1).groupId } })],
      ['group suspended', () => common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { status: false } })],
      ['group in the trash', () => common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { trash: true } })],
      ['place in the trash', () => common().collection('places').updateOne({ _id: own() }, { $set: { trash: true } })],
      ['place copy missing', () => common().collection('places').updateOne({ _id: own() }, { $set: { groupId: world.group(1).groupId } })],
    ];
    for (const [name, break_] of cases) {
      const code = await world.codeFor(own());
      await break_();
      const reply = await world.exchange(code);
      assert.deepEqual([reply.status, reply.body], [401, rejected], name);
      assert.equal(await codes().countDocuments({ placeId: own() }), 0, `${name}: the code is spent`);
      assert.equal(await world.activeKey(own()), null, name);
      await common().collection('places').updateMany({}, { $set: { status: true, trash: false, expirationDate: null, groupId: world.group(0).groupId } });
      await common().collection('places').updateOne({ _id: world.group(1).ownPlaceId }, { $set: { groupId: world.group(1).groupId } });
      await common().collection('places').updateOne({ _id: world.group(1).otherPlaceId }, { $set: { groupId: world.group(1).groupId } });
      await common().collection('companies').updateMany({ _id: companyId }, { $set: { trash: false, groupId: world.group(0).groupId } });
      await common().collection('groups').updateMany({}, { $set: { status: true, trash: false } });
    }
  });

  it('refuses a body that is not what it should be (422), never reading it as a query: operators, extra properties, wrong types, bad declarations', async () => {
    const real = await world.codeFor(own());
    const call2 = (body: unknown) => world.office.call('POST', '/store-activations', undefined, body);
    const cases: unknown[] = [
      {},
      { activationCode: { $ne: '' } },
      { activationCode: { $regex: '.*' } },
      { activationCode: ['0000-0000-0000-0000'] },
      { activationCode: 5 },
      { activationCode: null },
      { activationCode: real, $where: 'sleep(1000)' },
      { activationCode: real, extra: 1 },
      { activationCode: real, installation: 'windows' },
      { activationCode: real, installation: { platform: 'x'.repeat(65) } },
      { activationCode: real, installation: { appVersion: '<script>' } },
      { activationCode: real, installation: { appVersion: '1.0', other: 'x' } },
      { activationCode: real, installation: { 'a.b': 'x' } },
      { activationCode: 'x'.repeat(65) },
    ];
    for (const body of cases) {
      const reply = await call2(body);
      assert.equal(reply.status, 422, JSON.stringify(body));
      const text = await reply.text();
      assert.ok(!text.includes(real) && !text.includes('sleep'), 'the value is never echoed');
    }
    assert.equal(await codes().countDocuments({}), 1, 'a body that is refused spends nothing');
    assert.equal((await call2([])).status, 422);
    assert.equal((await world.office.call('POST', '/store-activations', undefined, undefined, { 'content-type': 'application/json' })).status, 422);
  });

  it('refuses a body that is too large (413) and one that is not JSON (415) before reading it', async () => {
    assert.equal((await world.office.call('POST', '/store-activations', undefined, { activationCode: 'A'.repeat(4000) })).status, 413);
    assert.equal((await world.office.call('POST', '/store-activations', undefined, 'x', { 'content-type': 'text/plain' })).status, 415);
  });

  it('is won by exactly one of two exchanges of the same code at the same time', async () => {
    for (let round = 0; round < 3; round += 1) {
      await common().collection('storeKeys').deleteMany({});
      const code = await world.codeFor(own());
      const replies = await Promise.all([world.exchange(code), world.exchange(code), world.exchange(code)]);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 401, 401]);
      assert.equal(await common().collection('storeKeys').countDocuments({ placeId: own(), status: 'active' }), 1);
    }
  });

  it('is won by one exchange of two codes made one after the other for the same place: the second code replaced the first', async () => {
    const first = await world.codeFor(own());
    const second = await world.codeFor(own());
    const replies = await Promise.all([world.exchange(first), world.exchange(second)]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 401]);
    assert.equal((await world.keysOf(own())).length, 1);
  });

  it('revokes the key that was active, in the same transaction, as replaced: the old server stops and the new one works; one active key only', async () => {
    const old = await world.activate(own());
    const mark = world.office.activity.entries.length;
    const fresh = await world.codeFor(own(), 0, world.office.cluster.dealerA);
    assert.equal((await world.asStore(old.key, 'GET', '/store-context')).status, 200, 'the old key works until the new server activates');
    const done = await world.exchange(fresh);
    assert.equal(done.status, 201);
    assert.equal((await world.asStore(old.key, 'GET', '/store-context')).status, 401);
    assert.equal((await world.asStore(done.body.data.key, 'GET', '/store-context')).status, 200);
    const [oldDoc, newDoc] = await world.keysOf(own());
    assert.deepEqual([oldDoc!['status'], oldDoc!['revokeReason'], oldDoc!['revokedBy'], newDoc!['status']], ['revoked', 'replaced', { kind: 'user', userId: world.office.cluster.dealerA, role: 'D' }, 'active']);
    assert.equal(oldDoc!['purgeAt'].getTime() - oldDoc!['revokedAt'].getTime(), 365 * 86_400_000);
    assert.equal(await common().collection('storeKeys').countDocuments({ placeId: own(), status: 'active' }), 1);
    const events = world.office.activity.entries.slice(mark);
    const revoked = events.find((entry) => entry.action === 'store.keyRevoked')!;
    assert.deepEqual([revoked.metadata, revoked.actor.kind, revoked.resource!.id], [{ reason: 'replaced', keyHint: old.key.slice(6, 10) }, 'user', old.keyId]);
    assert.deepEqual(events.find((entry) => entry.action === 'store.activated')!.metadata, { replacedKeyId: old.keyId });
  });

  it('does not touch the key of another place of the same group when one is activated', async () => {
    const a = await world.activate(own());
    const b = await world.activate(other());
    assert.equal((await world.asStore(a.key, 'GET', '/store-context')).status, 200);
    assert.equal((await world.asStore(b.key, 'GET', '/store-context')).status, 200);
  });

  it('records a failed exchange without the code, at most ten an hour for an address', async () => {
    limiter.reset();
    const mark = world.office.activity.entries.length;
    for (let i = 0; i < 13; i += 1) {
      await world.exchange(`0000-0000-0000-${String(i).padStart(4, '0')}`);
    }
    const failures = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.activationFailed');
    assert.equal(failures.length, 10);
    assert.deepEqual([failures[0]!.actor, failures[0]!.outcome, failures[0]!.metadata], [{ kind: 'anonymous' }, 'denied', { reason: 'rejected' }]);
    assert.ok(!JSON.stringify(failures).includes('0000-0000'));
  });
});
