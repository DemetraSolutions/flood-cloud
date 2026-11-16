import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument, expectedCopy } from '../../src/shared/legacy-write/copy-rule.ts';
import { differences } from '../helpers/legacy-write.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const P = (n: number): ObjectId => fixtureId('place', n);
const sa = () => world.group(0).sa;
const path = (id: ObjectId, rest = '') => world.placePath(0, `/${hex(id)}${rest}`);
const common = () => ctx.databases.common();
const feedOf = (id: ObjectId): Promise<Document | null> => common().collection('reserve_with_google').findOne({ groupId: world.group(0).groupId, placeId: id });
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(sa(), 'GET', path(id))).headers.get('etag')! });
const listed = async (): Promise<string[]> => ((await common().collection('groups').findOne({ _id: world.group(0).groupId }))!['places'] as Array<{ _id: ObjectId }>).map((entry) => hex(entry._id)).sort();
const storedIds = async (): Promise<string[]> => (await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').find({}, { projection: { _id: 1 } }).toArray()).map((place) => hex(place._id)).sort();

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seedPlace(0, 100, 1);
  await world.seedPlace(0, 101, 1, { trash: true, integrations: { reserveWithGoogle: { status: false } }, address: null, postcode: null, city: null, contact: null, email: null, telephone: null });
  await world.seedPlace(0, 102, 2);
  // The feed of Reserve with Google has the record of place 100, and a record of another group for a place with the same id.
  await common().collection('reserve_with_google').insertMany([
    { groupId: world.group(0).groupId, companyId: fixtureId('company', 1), placeId: P(100), category: 'restaurant', name: 'Bar Roma', telephone: null, url: null, geo: { latitude: 45, longitude: 9, address: { streetAddress: 'a', locality: 'b', postalCode: 'c', country: 'IT' } } },
    { groupId: world.group(1).groupId, companyId: fixtureId('company', 3), placeId: P(100), category: 'bar', name: 'other group' },
  ]);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('POST …/trash and …/restore', () => {
  it('trashes a place: trash, the copy, the feed record (of this group only), groups.places recalculated, and the address left as it is', async () => {
    const before = (await world.storedPlace(0, P(100)))!;
    const mark = world.office.activity.entries.length;
    const reply = await call(sa(), 'POST', path(P(100), '/trash'), undefined, await tagOf(P(100)));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.trashed, true);
    assert.equal(reply.body.data.address.city, 'Milano', 'the legacy nulling of the address is not replicated');
    const after = (await world.storedPlace(0, P(100)))!;
    assert.deepEqual(differences(before, after, ['trash', 'updateDate']).filter((key) => key !== 'updateDate'), ['trash']);
    assert.equal(after['trash'], true);
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!));
    assert.equal(await feedOf(P(100)), null);
    assert.equal(await common().collection('reserve_with_google').countDocuments({ groupId: world.group(1).groupId, placeId: P(100) }), 1);
    assert.deepEqual(await listed(), await storedIds(), 'groups.places lists every place of the database, trashed ones included');
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.trashed');
    assert.deepEqual([entry!.resource!.id, entry!.changes!.map((change) => [change.field, change.before, change.after])], [hex(P(100)), [['trashed', false, true]]]);
    const trashed = await call(sa(), 'GET', world.placePath(0, '?trashed=true'));
    assert.ok(trashed.body.data.some((item: { id: string }) => item.id === hex(P(100))));
  });

  it('refuses to trash a place that is in the trash, and to restore one that is not (409), and needs the version', async () => {
    assert.equal(failure(await call(sa(), 'POST', path(P(100), '/trash'), undefined, await tagOf(P(100)))).status, 409);
    assert.equal(failure(await call(sa(), 'POST', path(P(102), '/restore'), undefined, await tagOf(P(102)))).status, 409);
    assert.deepEqual(failure(await call(sa(), 'POST', path(P(100), '/restore'), undefined, {})), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    assert.equal(failure(await call(sa(), 'POST', path(P(100), '/restore'), undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal(failure(await call(sa(), 'POST', path(P(100), '/restore'), undefined, { 'if-match': 'W/"x"' })).status, 422);
  });

  it('restores a place: trash back to false, the copy, the feed record written again in the legacy shape from the document, groups.places recalculated', async () => {
    const mark = world.office.activity.entries.length;
    const reply = await call(sa(), 'POST', path(P(100), '/restore'), undefined, await tagOf(P(100)));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.trashed, false);
    const after = (await world.storedPlace(0, P(100)))!;
    assert.equal(after['trash'], false);
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!));
    const feed = (await feedOf(P(100)))!;
    assert.deepEqual([feed['category'], feed['name'], feed['companyId'], feed['telephone'], feed['url']], ['restaurant', 'Bar Roma', fixtureId('company', 1), '+39 02 1234567', null]);
    assert.deepEqual(await listed(), await storedIds());
    assert.equal(world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.restored').length, 1);
  });

  it('does not put a restored place in the feed when its integration is not complete, and leaves the legacy place with null registry data as the legacy left it', async () => {
    const reply = await call(sa(), 'POST', path(P(101), '/restore'), undefined, await tagOf(P(101)));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.address.street, reply.body.data.address.city, reply.body.data.contactName], [null, null, null]);
    assert.equal(await feedOf(P(101)), null);
  });

  it('is for the PSA, the dealers and the group administrators: 403 for a company or place administrator, even on his own place', async () => {
    for (const actor of [world.group(0).ca, world.group(0).pa]) {
      assert.equal(failure(await call(actor, 'POST', path(world.group(0).ownPlaceId, '/trash'), undefined, await tagOf(world.group(0).ownPlaceId))).status, 403);
      assert.equal(failure(await call(actor, 'POST', path(P(100), '/restore'), undefined, await tagOf(P(100)))).status, 403);
      assert.equal(failure(await call(actor, 'DELETE', path(P(101)), undefined, await tagOf(P(101)))).status, 403);
    }
    assert.equal((await call(world.office.cluster.dealerA, 'POST', path(P(102), '/trash'), undefined, await tagOf(P(102)))).status, 200);
    assert.equal((await call(world.office.cluster.psa, 'POST', path(P(102), '/restore'), undefined, await tagOf(P(102)))).status, 200);
  });

  it('keeps the perimeter: 404 for another group, another dealer and a place that does not exist, 401 without a session', async () => {
    const tag = await tagOf(P(100));
    for (const [actor, index] of [[world.group(1).sa, 0], [world.office.cluster.dealerB, 0], [sa(), 1]] as const) {
      assert.equal(failure(await call(actor, 'POST', world.placePath(index, `/${hex(P(100))}/trash`), undefined, tag)).status, 404);
      assert.equal(failure(await call(actor, 'DELETE', world.placePath(index, `/${hex(P(100))}`), undefined, tag)).status, 404);
    }
    assert.equal(failure(await call(sa(), 'POST', path(new ObjectId(), '/trash'), undefined, tag)).status, 404);
    assert.equal((await world.office.call('POST', path(P(100), '/trash'), undefined, undefined, tag)).status, 401);
  });
});

describe('DELETE /v1/groups/{groupId}/places/{placeId}', () => {
  it('deletes a place that is in the trash: the original, the copy and the feed record, and groups.places no longer lists it', async () => {
    assert.equal((await call(sa(), 'POST', path(P(100), '/trash'), undefined, await tagOf(P(100)))).status, 200);
    // A record of the feed that the trash would have removed is back (the legacy writes it): the deletion removes it as well.
    await common().collection('reserve_with_google').insertOne({ groupId: world.group(0).groupId, companyId: fixtureId('company', 1), placeId: P(100), category: 'restaurant', name: 'orphan' });
    const mark = world.office.activity.entries.length;
    const reply = await call(sa(), 'DELETE', path(P(100)), undefined, await tagOf(P(100)));
    assert.equal(reply.status, 204);
    assert.equal(reply.body, undefined);
    assert.equal(await world.storedPlace(0, P(100)), null);
    assert.equal(await world.copyOfPlace(P(100)), null);
    assert.equal(await feedOf(P(100)), null);
    assert.equal(await common().collection('reserve_with_google').countDocuments({ groupId: world.group(1).groupId, placeId: P(100) }), 1);
    assert.ok(!(await listed()).includes(hex(P(100))));
    assert.deepEqual(await listed(), await storedIds());
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.deleted');
    assert.equal(entry!.resource!.id, hex(P(100)));
    assert.equal(failure(await call(sa(), 'GET', path(P(100)))).status, 404);
    assert.equal(failure(await call(sa(), 'DELETE', path(P(100)), undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 404);
  });

  it('deletes only from the trash (409), with the version (422, 412)', async () => {
    assert.equal(failure(await call(sa(), 'DELETE', path(P(102)), undefined, await tagOf(P(102)))).status, 409);
    assert.ok(await world.storedPlace(0, P(102)));
    assert.deepEqual(failure(await call(sa(), 'DELETE', path(P(102)), undefined, {})), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    assert.equal((await call(sa(), 'POST', path(P(102), '/trash'), undefined, await tagOf(P(102)))).status, 200);
    assert.equal(failure(await call(sa(), 'DELETE', path(P(102)), undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.ok(await world.storedPlace(0, P(102)));
  });

  it('refuses to delete a place that a user of the group still has in his scope (409 referenced), trashed users included, and deletes it once they are gone', async () => {
    const own = world.group(0).ownPlaceId;
    assert.equal((await call(sa(), 'POST', path(own, '/trash'), undefined, await tagOf(own))).status, 200);
    const refused = failure(await call(sa(), 'DELETE', path(own), undefined, await tagOf(own)));
    assert.deepEqual(refused, { status: 409, code: 'CONFLICT', details: [{ field: 'users', issue: 'referenced' }] });
    assert.ok(await world.storedPlace(0, own));
    // The reference through the list of places of a user counts as well.
    const users = common().collection('users');
    await users.updateMany({ placeId: own }, { $unset: { placeId: '' } });
    assert.equal(failure(await call(sa(), 'DELETE', path(own), undefined, await tagOf(own))).status, 409);
    await users.updateMany({ placesId: own }, { $set: { placesId: [] } });
    assert.equal((await call(sa(), 'DELETE', path(own), undefined, await tagOf(own))).status, 204);
    assert.equal(await world.storedPlace(0, own), null);
  });
});
