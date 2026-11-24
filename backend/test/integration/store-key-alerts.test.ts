import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
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
const dealerA = () => world.office.cluster.dealerA;
const dealerB = () => world.office.cluster.dealerB;
const own = () => world.group(0).ownPlaceId;
const url = (placeId: ObjectId, rest = '') => world.keyPath(0, placeId, rest);
const actions = () => world.office.activity.entries.map((entry) => entry.action).filter((action) => action.startsWith('store.'));
const ALERTS = ['store.activationCodeForActivePlace', 'store.activeKeyReplaced', 'store.activeKeyRevoked'];
const alertsOf = () => world.office.activity.entries.filter((entry) => ALERTS.includes(entry.action));

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
  await common().collection('storeActivationCodes').deleteMany({});
  await common().collection('activityEvents').deleteMany({});
  world.office.activity.entries.length = 0;
});

describe('the code of a place that already has an active key', () => {
  it('needs the explicit confirmation: 409 with a dedicated detail and nothing created, nothing recorded', async () => {
    await world.activate(own());
    world.office.activity.entries.length = 0;
    for (const body of [undefined, {}, { confirmReplaceActiveKey: false }]) {
      const reply = await call(psa(), 'POST', url(own(), '/activation-codes'), body);
      assert.deepEqual(failure(reply), { status: 409, code: 'CONFLICT', details: [{ field: 'confirmReplaceActiveKey', issue: 'required' }] });
      assert.equal(reply.body.error.message, 'The place has an active key: confirm to replace it');
    }
    assert.equal(await common().collection('storeActivationCodes').countDocuments({}), 0);
    assert.deepEqual(actions(), []);
    assert.equal(failure(await call(psa(), 'POST', url(own(), '/activation-codes'), { confirmReplaceActiveKey: 'yes' })).status, 422);
    assert.equal(failure(await call(psa(), 'POST', url(own(), '/activation-codes'), { other: true })).status, 422);
    assert.equal((await call(psa(), 'GET', url(own()))).body.data.status, 'active', 'the status tells the backoffice to ask before generating');
  });

  it('with the confirmation answers 201 and records the creation and one alert, with the hint of the active key and never the code or a key', async () => {
    const { key } = await world.activate(own());
    world.office.activity.entries.length = 0;
    const reply = await call(dealerA(), 'POST', url(own(), '/activation-codes'), { confirmReplaceActiveKey: true });
    assert.equal(reply.status, 201);
    assert.deepEqual(actions(), ['store.activationCodeCreated', 'store.activationCodeForActivePlace']);
    const [alert] = alertsOf();
    assert.deepEqual(
      [alert!.category, alert!.outcome, alert!.actor, alert!.groupId, alert!.resource, alert!.metadata],
      ['security', 'success', { kind: 'user', id: dealerA(), role: 'D' }, world.group(0).groupId, { type: 'place', id: own().toHexString() }, { keyHint: key.slice(6, 10) }],
    );
    const text = JSON.stringify(world.office.activity.entries);
    assert.ok(!text.includes(reply.body.data.code) && !text.includes(key));
  });

  it('records no alert for a place without an active key, with or without the confirmation', async () => {
    assert.equal((await call(psa(), 'POST', url(own(), '/activation-codes'))).status, 201);
    assert.equal((await call(psa(), 'POST', url(own(), '/activation-codes'), { confirmReplaceActiveKey: true })).status, 201);
    assert.deepEqual(alertsOf(), []);
  });

  it('records an alert for the manual revocation of an active key, so that revoking and then asking for a code without confirmation is not a silent way round: one alert in all', async () => {
    const { key, keyId } = await world.activate(own());
    world.office.activity.entries.length = 0;
    assert.equal((await call(dealerA(), 'DELETE', url(own()))).status, 204);
    const codeReply = await call(dealerA(), 'POST', url(own(), '/activation-codes'));
    assert.equal(codeReply.status, 201, 'no active key any more: no confirmation is needed');
    const alerts = alertsOf();
    assert.deepEqual(alerts.map((entry) => entry.action), ['store.activeKeyRevoked']);
    const [alert] = alerts;
    assert.deepEqual(
      [alert!.category, alert!.outcome, alert!.actor, alert!.groupId, alert!.resource, alert!.metadata],
      ['security', 'success', { kind: 'user', id: dealerA(), role: 'D' }, world.group(0).groupId, { type: 'place', id: own().toHexString() }, { keyHint: key.slice(6, 10), keyId }],
    );
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(key));
    assert.equal(actions().filter((action) => action === 'store.keyRevoked').length, 1, 'next to the existing event of the revocation');
    // The revocation of a place that is trashed is not a manual one: no alert. (A key that is not active cannot be revoked by hand: 404, nothing recorded.)
    assert.equal(failure(await call(dealerA(), 'DELETE', url(own()))).status, 404);
    assert.equal(alertsOf().length, 1);
  });

  it('is a 404 for a dealer outside the group, before anything else', async () => {
    await world.activate(own());
    assert.equal(failure(await call(dealerB(), 'POST', url(own(), '/activation-codes'), { confirmReplaceActiveKey: true })).status, 404);
    assert.equal(failure(await call(dealerB(), 'POST', url(own(), '/activation-codes'))).status, 404);
  });
});

describe('the activation that replaces an active key', () => {
  it('records one alert, the actor being the new key, with the hint and the id of the replaced key; the first activation records none', async () => {
    const first = await world.activate(own());
    assert.deepEqual(alertsOf(), []);
    const second = await world.activate(own());
    const [alert, ...rest] = alertsOf().filter((entry) => entry.action === 'store.activeKeyReplaced');
    assert.deepEqual(rest, []);
    assert.deepEqual(
      [alert!.category, alert!.outcome, alert!.actor, alert!.groupId, alert!.resource, alert!.metadata],
      ['security', 'success', { kind: 'store', id: ObjectId.createFromHexString(second.keyId) }, world.group(0).groupId, { type: 'place', id: own().toHexString() }, { keyHint: first.key.slice(6, 10), replacedKeyId: first.keyId }],
    );
    const text = JSON.stringify(world.office.activity.entries);
    assert.ok(!text.includes(first.key) && !text.includes(second.key));
    assert.equal(world.office.activity.entries.filter((entry) => entry.action === 'store.activated').length, 2);
  });

  it('records none when the exchange fails', async () => {
    await world.activate(own());
    world.office.activity.entries.length = 0;
    assert.equal(failure(await world.exchange('AAAA-BBBB-CCCC-DDDD')).status, 401);
    assert.deepEqual(alertsOf(), []);
  });
});

describe('the alerts of the store key in the monitor and in the badge', () => {
  it('are listed and counted for the PSA, the dealer of the group and the administrator of the group, never for the others', async () => {
    await world.activate(own());
    await call(psa(), 'POST', url(own(), '/activation-codes'), { confirmReplaceActiveKey: true });
    await world.activate(own());
    const alerts = alertsOf();
    assert.equal(alerts.length, 3, 'two codes for a place with an active key (the confirmed one and the one of the second activation), then the replacement');
    // The monitor reads the stored entries: store them as the activity log would.
    await common().collection('activityEvents').insertMany(
      alerts.map((entry): Document => ({ _id: new ObjectId(), at: new Date(), ...entry, expiresAt: new Date(Date.now() + 86_400_000) })),
    );
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const g0 = world.group(0);
    const read = async (actor: ObjectId) => {
      const list = await call(actor, 'GET', `/activity-log?alerts=true&from=${encodeURIComponent(since)}&limit=100`);
      const count = await call(actor, 'GET', `/activity-log/alerts/count?since=${encodeURIComponent(since)}`);
      assert.deepEqual([list.status, count.status], [200, 200]);
      return [list.body.data.map((item: { action: string }) => item.action).sort(), count.body.data.count];
    };
    const expected = [['store.activationCodeForActivePlace', 'store.activationCodeForActivePlace', 'store.activeKeyReplaced'], 3];
    assert.deepEqual(await read(psa()), expected);
    assert.deepEqual(await read(dealerA()), expected);
    assert.deepEqual(await read(g0.sa), expected);
    for (const actor of [g0.ca, g0.pa, dealerB(), world.group(1).sa]) {
      assert.deepEqual(await read(actor), [[], 0], actor.toHexString());
    }
    // `alerts=true` combines with the other filters and takes no other value.
    assert.equal((await call(psa(), 'GET', '/activity-log?alerts=true&action=auth.loginFailed')).body.data.length, 0);
    assert.equal((await call(psa(), 'GET', '/activity-log?alerts=true&action=store.activeKeyReplaced')).body.data.length, 1);
    assert.equal((await call(psa(), 'GET', '/activity-log?alerts=false')).status, 422);
    assert.ok((await call(psa(), 'GET', '/activity-log')).body.data.length >= 3, 'without the filter the list is not narrowed');
  });
});
