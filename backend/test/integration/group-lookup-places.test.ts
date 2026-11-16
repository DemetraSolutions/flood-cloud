import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const group = (index = 0) => world.group(index);
const lookup = (segment: string, index = 0) => `/groups/${group(index).groupId.toHexString()}/lookup/${segment}`;
const hex = (id: ObjectId) => id.toHexString();

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  const templates = ctx.databases.group(group(0).groupId, 'cluster0').collection('email_templates');
  await templates.insertMany([
    { _id: new ObjectId(), name: 'Conferma', text: 'riservato', html: '<b>riservato</b>', insertDate: new Date() },
    { _id: new ObjectId(), name: 'Annullo', text: '', html: '' },
    { _id: new ObjectId(), name: 'Cestinato', trash: true },
    { _id: new ObjectId(), name: 5 },
  ]);
  await ctx.databases.group(group(1).groupId, 'cluster0').collection('email_templates').insertOne({ _id: new ObjectId(), name: 'Altro gruppo' });
  await ctx.databases.common().collection('groups').updateOne({ _id: group(0).groupId }, { $set: { 'settings.languages': ['it', 'en', 5, '', 'de'] } });
  await ctx.databases.common().collection('groups').updateOne({ _id: group(1).groupId }, { $unset: { 'settings.languages': '' } });
  await ctx.databases.group(group(0).groupId, 'cluster0').collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { invoicesPSValues: [{ name: 'FE', cash: true }, { name: 'NC', cash: 'yes' }, { name: 7 }, 'x'] } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/lookup/email-templates', () => {
  it('lists the templates of the group by name, without their text, for whoever saves a place, with an ETag and a 304', async () => {
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, group(0).sa, group(0).ca, group(0).pa]) {
      const reply = await call(actor, 'GET', lookup('email-templates'));
      assert.equal(reply.status, 200, hex(actor));
      assert.deepEqual(reply.body.data.map((item: { name: string }) => item.name), ['', 'Annullo', 'Conferma']);
      assert.ok(reply.body.data.every((item: object) => Object.keys(item).sort().join() === 'id,name'));
      assert.deepEqual(reply.body.page, { limit: 50, next: null });
    }
    const first = await call(group(0).pa, 'GET', lookup('email-templates'));
    assert.ok(!JSON.stringify(first.body).includes('riservato'));
    const again = await call(group(0).pa, 'GET', lookup('email-templates'), undefined, { 'if-none-match': first.headers.get('etag')! });
    assert.equal(again.status, 304);
  });

  it('keeps the group: another group is 404, and the ids and the search narrow the list', async () => {
    assert.equal((await call(group(1).sa, 'GET', lookup('email-templates', 0))).status, 404);
    assert.deepEqual((await call(group(1).sa, 'GET', lookup('email-templates', 1))).body.data.map((item: { name: string }) => item.name), ['Altro gruppo']);
    assert.deepEqual((await call(group(0).sa, 'GET', `${lookup('email-templates')}?q=conf`)).body.data.map((item: { name: string }) => item.name), ['Conferma']);
    assert.equal((await call(group(0).sa, 'GET', `${lookup('email-templates')}?limit=0`)).status, 422);
    assert.equal((await world.office.call('GET', lookup('email-templates'), undefined)).status, 401);
  });
});

describe('GET /v1/groups/{groupId}/lookup/languages', () => {
  it('lists the languages of the group as codes, keeping the texts only, and it when the group lists none', async () => {
    for (const actor of [world.office.cluster.psa, group(0).sa, group(0).ca, group(0).pa]) {
      const reply = await call(actor, 'GET', lookup('languages'));
      assert.deepEqual([reply.status, reply.body.data], [200, [{ code: 'it' }, { code: 'en' }, { code: 'de' }]]);
    }
    const none = await call(group(1).pa, 'GET', lookup('languages', 1));
    assert.deepEqual(none.body.data, [{ code: 'it' }]);
    const tag = await call(group(1).pa, 'GET', lookup('languages', 1), undefined, { 'if-none-match': none.headers.get('etag')! });
    assert.equal(tag.status, 304);
    assert.equal((await call(group(1).pa, 'GET', lookup('languages', 0))).status, 404);
  });
});

describe('GET /v1/groups/{groupId}/places/{placeId}/invoice-series', () => {
  const url = (placeId: ObjectId, index = 0) => `/groups/${group(index).groupId.toHexString()}/places/${hex(placeId)}/invoice-series`;

  it('gives the series of the company of the place, with the cash flag, to the place administrator too (who has no companies:read)', async () => {
    for (const actor of [world.office.cluster.psa, group(0).sa, group(0).ca, group(0).pa]) {
      const reply = await call(actor, 'GET', url(group(0).ownPlaceId));
      assert.deepEqual([reply.status, reply.body.data], [200, [{ name: 'FE', cash: true }, { name: 'NC', cash: false }]], hex(actor));
    }
    assert.deepEqual((await call(group(0).sa, 'GET', url(group(0).otherPlaceId))).body.data, []);
    const reply = await call(group(0).pa, 'GET', url(group(0).ownPlaceId));
    assert.equal((await call(group(0).pa, 'GET', url(group(0).ownPlaceId), undefined, { 'if-none-match': reply.headers.get('etag')! })).status, 304);
  });

  it('is scoped like the place: 404 outside the perimeter, in another group or for a place that does not exist, 422 for a malformed id', async () => {
    assert.equal((await call(group(0).pa, 'GET', url(group(0).otherPlaceId))).status, 404);
    assert.equal((await call(group(0).ca, 'GET', url(group(0).otherPlaceId))).status, 404);
    assert.equal((await call(group(1).sa, 'GET', url(group(0).ownPlaceId))).status, 404);
    assert.equal((await call(group(0).sa, 'GET', url(new ObjectId()))).status, 404);
    assert.equal((await call(group(0).sa, 'GET', `/groups/${hex(group(0).groupId)}/places/zzz/invoice-series`)).status, 422);
    assert.equal((await world.office.call('GET', url(group(0).ownPlaceId), undefined)).status, 401);
  });

  it('gives [] for a place whose company has no copy of its series', async () => {
    await ctx.databases.group(group(0).groupId, 'cluster0').collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { invoicesPSValues: 'none' } });
    assert.deepEqual((await call(group(0).pa, 'GET', url(group(0).ownPlaceId))).body.data, []);
  });
});
