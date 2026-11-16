import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument, expectedCopy } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { differences } from '../helpers/legacy-write.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const P = (n: number): ObjectId => fixtureId('place', n);
const path = (id: ObjectId, rest = '') => world.placePath(0, `/${hex(id)}${rest}`);
const common = () => ctx.databases.common();
const SECRETS = ['fixture-integration-secret', 'fixture-device-secret', 'fixture-user'];
const copiesOf = (name: string) => ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').find({ name }).toArray();

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 21, { trash: true });
  await world.seedPlace(0, 100, 1);
  await world.seedPlace(0, 101, 1, { trash: true });
  await world.seedPlace(0, 102, 21);
  await world.seedPlace(0, 103, 1, { name: 5, integrations: { reserveWithGoogle: { status: false } } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('POST /v1/groups/{groupId}/places/{placeId}/duplicate', () => {
  it('replicates everything of the place, devices, rooms, storages with the same ids and integrations included, and changes only the id, the dates, the trash flag and the name', async () => {
    const source = (await world.storedPlace(0, P(100)))!;
    const mark = world.office.activity.entries.length;
    const reply = await call(world.office.cluster.psa, 'POST', path(P(100), '/duplicate'));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const place = reply.body.data;
    assert.notEqual(place.id, hex(P(100)));
    assert.equal(reply.headers.get('location'), `/v1${world.placePath(0, `/${place.id}`)}`);
    const id = ObjectId.createFromHexString(place.id);
    const copy = (await world.storedPlace(0, id))!;
    assert.equal(reply.headers.get('etag'), `"${versionOf('places', copy, TEST_VERSION_KEY)}"`);
    // Identical but for the five keys, by BSON bytes and in the same order of keys.
    assert.deepEqual(differences(source, copy, ['_id', 'name', 'insertDate', 'updateDate', 'trash']).sort(), ['_id', 'insertDate', 'name', 'updateDate']);
    assert.deepEqual([copy['name'], copy['trash']], ['Bar Roma (Copy)', false]);
    assert.ok(copy['insertDate'] instanceof Date && (copy['insertDate'] as Date).getTime() === (copy['updateDate'] as Date).getTime());
    assert.ok((copy['insertDate'] as Date).getTime() > (source['insertDate'] as Date).getTime());
    for (const key of ['devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'integrations', 'server', 'connectorAddress', 'roomsSettings', 'general', 'futureBlock', 'service', 'roomsListId', 'groupId']) {
      assert.ok(sameDocument({ v: source[key] }, { v: copy[key] }), key);
    }
    assert.ok((copy['storages'] as Document[])[0]!['id'].equals((source['storages'] as Document[])[0]!['id']), 'the storages keep their ids, as in the legacy duplicate');
    assert.equal(((copy['integrations'] as Document)['dojo'] as Document)['apiKey'], 'fixture-integration-secret', 'the credentials are copied on the server');
    assert.ok(sameDocument(expectedCopy(copy, world.group(0).groupId), (await world.copyOfPlace(id))!));
    // The source is untouched.
    assert.ok(sameDocument(source, (await world.storedPlace(0, P(100)))!));
    // The credentials are never in the response, nor in the log, nor in the application log; the addresses of the store server and of the connector, which the dealers see in the response, are in no log.
    const text = JSON.stringify([reply.body, world.office.activity.entries.slice(mark), world.office.logEvents]);
    for (const secret of SECRETS) {
      assert.ok(!text.includes(secret), secret);
    }
    const logs = JSON.stringify([world.office.activity.entries.slice(mark), world.office.logEvents]);
    for (const network of ['10.0.0.1', 'connector.fixture']) {
      assert.ok(!logs.includes(network), network);
    }
    // The response kept for the idempotency of the request has no credential either.
    const saved = JSON.stringify(await common().collection('idempotencyKeys').find({}).toArray());
    assert.ok(saved.includes(place.id));
    for (const secret of SECRETS) {
      assert.ok(!saved.includes(secret), secret);
    }
    assert.deepEqual(place.dealerSettings, { sentry: true, serverIp: '10.0.0.1', connectorAddress: 'http://connector.fixture.example.test' });
    // groups.places lists the new place, the feed has its record, and the log names the source.
    const group = (await common().collection('groups').findOne({ _id: world.group(0).groupId }))!;
    assert.ok((group['places'] as Array<{ _id: ObjectId }>).some((entry) => entry._id.equals(id)));
    const feed = (await common().collection('reserve_with_google').findOne({ groupId: world.group(0).groupId, placeId: id }))!;
    assert.deepEqual([feed['category'], feed['name'], feed['companyId']], ['restaurant', 'Bar Roma', fixtureId('company', 1)]);
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.duplicated');
    assert.deepEqual([entry!.resource!.id, entry!.metadata], [place.id, { sourceId: hex(P(100)) }]);
    assert.deepEqual(entry!.changes!.map((change) => [change.field, change.after]), [['name', 'Bar Roma (Copy)'], ['status', 'active']]);
    // The representation is the one of the detail.
    assert.deepEqual((await call(world.office.cluster.psa, 'GET', path(id))).body.data, place);
    assert.equal(place.trashed, false);
  });

  it('can be done again: another place, with another id and the same name, whose storages carry the same ids as the source', async () => {
    const reply = await call(world.office.cluster.dealerA, 'POST', path(P(100), '/duplicate'));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal((await copiesOf('Bar Roma (Copy)')).length, 2);
    const [first, second] = await copiesOf('Bar Roma (Copy)');
    assert.ok(!first!['_id'].equals(second!['_id']));
  });

  it('copies a place with a name that is not text as (Copy), and a place whose feed integration is off without a feed record', async () => {
    const reply = await call(world.office.cluster.psa, 'POST', path(P(103), '/duplicate'));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.name, '(Copy)');
    assert.equal(await common().collection('reserve_with_google').countDocuments({ placeId: ObjectId.createFromHexString(reply.body.data.id) }), 0);
  });

  it('is for the PSA and the dealers only: 403 for a group administrator, a company or place administrator', async () => {
    const before = await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').countDocuments({});
    for (const actor of [world.group(0).sa, world.group(0).ca, world.group(0).pa]) {
      assert.equal(failure(await call(actor, 'POST', path(P(100), '/duplicate'))).status, 403);
    }
    assert.equal(await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').countDocuments({}), before);
  });

  it('keeps the perimeter: 404 for another group, another dealer and a place that does not exist, 401 without a session', async () => {
    for (const [actor, index] of [[world.office.cluster.dealerB, 0], [world.office.cluster.dealerA, 2], [world.group(1).sa, 0]] as const) {
      assert.equal(failure(await call(actor, 'POST', world.placePath(index, `/${hex(P(100))}/duplicate`))).status, 404);
    }
    assert.equal(failure(await call(world.office.cluster.psa, 'POST', path(new ObjectId(), '/duplicate'))).status, 404);
    assert.equal(failure(await call(world.office.cluster.psa, 'POST', world.placePath(0, '/not-an-id/duplicate'))).status, 422);
    assert.equal((await world.office.call('POST', path(P(100), '/duplicate'), undefined)).status, 401);
  });

  it('does not duplicate a place that is in the trash, nor one whose company is in the trash (409), and writes nothing', async () => {
    const before = await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').countDocuments({});
    assert.deepEqual(failure(await call(world.office.cluster.psa, 'POST', path(P(101), '/duplicate'))), { status: 409, code: 'CONFLICT', details: undefined });
    assert.deepEqual(failure(await call(world.office.cluster.psa, 'POST', path(P(102), '/duplicate'))), { status: 409, code: 'CONFLICT', details: [{ field: 'companyId', issue: 'incorrect' }] });
    assert.equal(await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').countDocuments({}), before);
  });
});
