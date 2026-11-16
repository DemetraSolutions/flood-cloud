import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument, expectedCopy } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { differences } from '../helpers/legacy-write.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { PRICE_LIST, SLOT } from '../helpers/place-fixtures.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const P = (n: number): ObjectId => fixtureId('place', n);
const path = (n: ObjectId, rest = '') => world.placePath(0, `/${hex(n)}${rest}`);
const CLOSED = { active: false, values: [] };
const week = (overrides: Record<string, unknown> = {}) => ({ '0': CLOSED, '1': CLOSED, '2': CLOSED, '3': CLOSED, '4': CLOSED, '5': CLOSED, '6': CLOSED, ...overrides });
const groupDb = () => ctx.databases.group(world.group(0).groupId, 'cluster0');
const HOURS = (overrides: Document = {}) => ({ timezone: 'Europe/Rome', week: week(), special: {}, deliveryTime: { week: week(), special: {} }, ...overrides });

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
  await world.seed(0, 21, { trash: true });
  await world.seedPlace(0, 100, 1);
  await world.seedPlace(0, 101, 1, { plan: 'professional' });
  await world.seedPlace(0, 102, 20, { invoicePS: false });
  await world.seedPlace(0, 103, 1);
  await groupDb().collection('places').updateOne({ _id: P(103) }, { $unset: { delivery: '' }, $set: { general: {} } });
  await ctx.databases.common().collection('places').updateOne({ _id: P(103) }, { $unset: { delivery: '' }, $set: { general: {} } });
  await world.seedPlace(0, 104, 1, { openingTime: 'none', platform: 'web' });
  await world.seedPlace(0, 105, 1, { openingTime: { weekGeneric: { '1': { active: true, values: [{ start: '9', end: 'late' }] } }, daySpecial: {} } });
  await world.seedPlace(0, 106, 1, { listId: null, general: { priceLists: [{ id: 'old', allYouCanEat: false, ayceCode1: null, ayceCode2: null }] } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

/** The `If-Match` header of the version a place has now. */
const tagOf = async (id: ObjectId): Promise<Record<string, string>> => ({ 'if-match': (await call(psa(), 'GET', path(id))).headers.get('etag')! });
const patch = async (actor: ObjectId, id: ObjectId, body: unknown, headers?: Record<string, string>) => call(actor, 'PATCH', path(id), body, headers ?? (await tagOf(id)));
const put = async (actor: ObjectId, id: ObjectId, segment: string, body: unknown, headers?: Record<string, string>) => call(actor, 'PUT', path(id, `/${segment}`), body, headers ?? (await tagOf(id)));
const stored = async (id: ObjectId): Promise<Document> => (await world.storedPlace(0, id))!;
const current = async (id: ObjectId) => (await call(psa(), 'GET', path(id))).body.data;

describe('PATCH /v1/groups/{groupId}/places/{placeId}', () => {
  it('writes only the keys that differ, on their stored paths, and keeps the types of everything else: the document differs in those keys alone and its copy is identical', async () => {
    const before = await stored(P(100));
    const version = (await tagOf(P(100)))['if-match']!;
    const reply = await patch(psa(), P(100), { name: 'Bar Milano', address: { city: 'Roma', province: 'RM' }, contactName: null, license: { status: 'disabled' }, priceLists: [{ id: PRICE_LIST, allYouCanEat: false, ayceCode1: '7' }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(P(100));
    assert.deepEqual(differences(before, after, ['name', 'city', 'countryAreaCode', 'contact', 'status', 'general', 'updateDate']).sort(), ['city', 'contact', 'countryAreaCode', 'general', 'name', 'status', 'updateDate']);
    assert.deepEqual([after['name'], after['city'], after['countryAreaCode'], after['contact'], after['status']], ['Bar Milano', 'Roma', 'RM', null, false]);
    assert.ok(after['updateDate'] instanceof Date && after['updateDate'].getTime() > (before['updateDate'] as Date).getTime());
    // Inside `general` only the price lists changed: the unknown key and the numbers of the exact types stay.
    const general = after['general'] as Document;
    assert.deepEqual(general['priceLists'], [{ id: PRICE_LIST, allYouCanEat: false, ayceCode1: '7', ayceCode2: null }]);
    assert.ok(general['chargeDocumentQt'] instanceof Int32 && general['totalRounding'] instanceof Double && general['unknownGeneral'] === 'keep');
    assert.notEqual(reply.headers.get('etag'), `"${version}"`);
    assert.equal(reply.headers.get('etag'), `"${versionOf('places', after)}"`);
    assert.deepEqual([reply.body.data.name, reply.body.data.address.city, reply.body.data.license.status, reply.body.data.contactName], ['Bar Milano', 'Roma', 'disabled', null]);
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!));
    const group = (await ctx.databases.common().collection('groups').findOne({ _id: world.group(0).groupId }))!;
    assert.ok((group['places'] as Array<{ _id: ObjectId }>).some((entry) => entry._id.equals(P(100))));
    // Back to normal for the next tests.
    assert.equal((await patch(psa(), P(100), { name: 'Bar Roma', address: { city: 'Milano', province: 'MI' }, contactName: 'Mario Rossi', license: { status: 'active' } })).status, 200);
  });

  it('writes nothing for a request that sends back what the place has: the same ETag, the same document, no entry in the log', async () => {
    const before = await stored(P(100));
    const mark = world.office.activity.entries.length;
    const read = await call(psa(), 'GET', path(P(100)));
    const { id: _id, groupId: _groupId, trashed: _trashed, createdAt: _createdAt, updatedAt: _updatedAt, ...writable } = read.body.data;
    const reply = await call(psa(), 'PATCH', path(P(100)), writable, { 'if-match': read.headers.get('etag')! });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.headers.get('etag'), read.headers.get('etag'));
    assert.ok(sameDocument(before, await stored(P(100))));
    assert.deepEqual(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'place.updated'), []);
  });

  it('needs If-Match: 422 without it or with anything but one strong tag, 412 for a version that is not the stored one', async () => {
    const body = { name: 'Late' };
    assert.deepEqual(failure(await call(psa(), 'PATCH', path(P(100)), body, {})), issues(['If-Match', 'required']));
    for (const header of ['*', 'W/"abc"', '"a", "b"', 'abc']) {
      assert.deepEqual(failure(await call(psa(), 'PATCH', path(P(100)), body, { 'if-match': header })), issues(['If-Match', 'format']), header);
    }
    assert.equal(failure(await call(psa(), 'PATCH', path(P(100)), body, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    const tag = await tagOf(P(100));
    await groupDb().collection('places').updateOne({ _id: P(100) }, { $set: { name: 'Changed by the legacy' } });
    assert.equal(failure(await call(psa(), 'PATCH', path(P(100)), body, tag)).status, 412);
    assert.equal((await stored(P(100)))['name'], 'Changed by the legacy');
    await groupDb().collection('places').updateOne({ _id: P(100) }, { $set: { name: 'Bar Roma' } });
  });

  it('is not made late by a write of the POS: devices[i].info and a table of a room do not change the version, and survive', async () => {
    const tag = await tagOf(P(100));
    await groupDb().collection('places').updateOne({ _id: P(100) }, { $set: { 'devices.0.info.os': 'changed by the POS', 'rooms.0.tables.0.name': 'T1', updateDate: new Date() } });
    const reply = await call(psa(), 'PATCH', path(P(100)), { address: { city: 'Torino' } }, tag);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(P(100));
    assert.deepEqual([((after['devices'] as Document[])[0]!['info'] as Document)['os'], ((after['rooms'] as Document[])[0]!['tables'] as Document[])[0]!['name'], ((after['roomsSettings'] as Document)['reservation'] as Document)['suspendedToday']], ['changed by the POS', 'T1', true]);
    assert.equal(after['city'], 'Torino');
    // A write of the legacy to an owned path, by contrast, is a 412.
    const late = await tagOf(P(100));
    await groupDb().collection('places').updateOne({ _id: P(100) }, { $set: { 'general.priceLists': [] } });
    assert.equal(failure(await call(psa(), 'PATCH', path(P(100)), { address: { city: 'Milano' } }, late)).status, 412);
    await groupDb().collection('places').updateOne({ _id: P(100) }, { $set: { city: 'Milano', 'roomsSettings.reservation.suspendedToday': true, 'general.priceLists': [{ id: PRICE_LIST, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }] } });
  });

  it('refuses an empty body, unknown keys, the group, operators and what is not the place’s to write', async () => {
    for (const [body, expected] of [
      [{}, issues(['(body)', 'required'])],
      [{ groupId: hex(world.group(1).groupId) }, issues(['groupId', 'unknown'])],
      [{ trashed: true }, issues(['trashed', 'unknown'])],
      [{ integrations: { dojo: { apiKey: 'x' } } }, issues(['integrations', 'unknown'])],
      [{ devices: [] }, issues(['devices', 'unknown'])],
      [{ server: { ip: '1.1.1.1' } }, issues(['server', 'unknown'])],
      [{ license: { suspendedToday: true } }, issues(['license.suspendedToday', 'unknown'])],
      [{ $set: { name: 'x' } }, issues(['(key)', 'forbiddenKey'])],
    ] as const) {
      assert.deepEqual(failure(await patch(psa(), P(100), body)), expected, JSON.stringify(body));
    }
    assert.equal(failure(await patch(psa(), P(100), undefined)).status, 422);
  });

  it('answers 413 above the limit of the body', async () => {
    assert.equal((await world.office.call('PATCH', world.placePath(0, `/${hex(P(100))}`), await world.as.tokenOf(psa()), { name: 'x'.repeat(300_000) }, await tagOf(P(100)))).status, 413);
  });

  it('keeps the perimeter: 404 outside it, for every write, and nothing is written', async () => {
    const before = await stored(P(102));
    const tag = await tagOf(P(102));
    // Place 102 belongs to company 20: a CA of company 1 and the PA of place 1 do not reach it, nor does anybody of another group.
    for (const actor of [ca(), pa()]) {
      assert.equal(failure(await call(actor, 'PATCH', path(P(102)), { name: 'x' }, tag)).status, 404);
      assert.equal(failure(await call(actor, 'PUT', path(P(102), '/opening-hours'), HOURS(), tag)).status, 404);
      assert.equal(failure(await call(actor, 'GET', path(P(102)))).status, 404);
    }
    assert.equal(failure(await call(pa(), 'PATCH', path(P(100)), { name: 'x' }, await tagOf(P(100)))).status, 404);
    for (const [actor, index] of [[world.group(1).sa, 0], [world.office.cluster.dealerB, 0], [world.group(0).sa, 1]] as const) {
      const outcome = await call(actor, 'PATCH', world.placePath(index, `/${hex(P(102))}`), { name: 'x' }, tag);
      assert.equal(outcome.status, 404, `${hex(actor)} ${String(index)}`);
    }
    assert.equal((await world.office.call('PATCH', path(P(102)), undefined, { name: 'x' }, tag)).status, 401);
    assert.ok(sameDocument(before, await stored(P(102))));
  });

  it('lets a company administrator change the places of his companies and a place administrator his own', async () => {
    const own = world.group(0).ownPlaceId;
    assert.equal((await patch(ca(), P(100), { contactName: 'By the CA' })).body.data.contactName, 'By the CA');
    assert.equal((await patch(pa(), own, { contactName: 'By the PA' })).body.data.contactName, 'By the PA');
    assert.equal((await patch(pa(), own, { openingHours: { timezone: 'Europe/London' } })).body.data.openingHours.timezone, 'Europe/London');
    assert.equal((await patch(sa(), P(100), { contactName: 'Mario Rossi' })).body.data.contactName, 'Mario Rossi');
  });

  it('moves a place to another company of the group, never to one outside the group, in the trash, or outside the perimeter of the caller', async () => {
    const company2 = hex(fixtureId('company', 2));
    assert.equal((await patch(sa(), P(103), { companyId: company2 })).body.data.companyId, company2);
    assert.equal((await patch(sa(), P(103), { companyId: hex(fixtureId('company', 1)) })).body.data.companyId, hex(fixtureId('company', 1)));
    for (const companyId of [hex(fixtureId('company', 3)), hex(fixtureId('company', 21)), hex(new ObjectId())]) {
      assert.deepEqual(failure(await patch(sa(), P(103), { companyId })), issues(['companyId', 'incorrect']), companyId);
    }
    // A CA has only company 1; a PA has no company at all.
    assert.deepEqual(failure(await patch(ca(), P(103), { companyId: company2 })), issues(['companyId', 'incorrect']));
    assert.deepEqual(failure(await patch(pa(), world.group(0).ownPlaceId, { companyId: company2 })), issues(['companyId', 'incorrect']));
    // The place administrator keeps his own company when he sends it back unchanged, and changes nothing else by it.
    assert.equal((await patch(pa(), world.group(0).ownPlaceId, { companyId: hex(fixtureId('company', 1)) })).status, 200);
    // Sending his own company back is no change.
    assert.equal((await patch(ca(), P(103), { companyId: hex(fixtureId('company', 1)) })).status, 200);
  });

  it('checks the country and the province where they change, and the price lists of the group', async () => {
    assert.deepEqual(failure(await patch(sa(), P(100), { address: { country: 'ZZ' } })), issues(['address.country', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), P(100), { address: { province: 'XX' } })), issues(['address.province', 'incorrect']));
    // A country without areas takes the empty province.
    assert.equal((await patch(sa(), P(100), { address: { country: 'DE', province: '' } })).status, 200);
    assert.equal((await patch(sa(), P(100), { address: { country: 'IT', province: 'MI' } })).status, 200);
    assert.deepEqual(failure(await patch(sa(), P(100), { priceListId: 'nope', ecommercePriceListId: 'nope' })), issues(['priceListId', 'incorrect'], ['ecommercePriceListId', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), P(100), { priceLists: [{ id: PRICE_LIST }, { id: 'nope' }] })), issues(['priceLists.1.id', 'incorrect']));
  });

  it('adds the price list of the sales to the price lists of the place, as the old backoffice does, and does not judge a list the place already has', async () => {
    const reply = await patch(sa(), P(106), { priceListId: PRICE_LIST });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.priceLists, [{ id: 'old', allYouCanEat: false, ayceCode1: null, ayceCode2: null }, { id: PRICE_LIST, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    // The place still has `old`, which the group does not offer: sending it back is fine, and so is one more list that exists.
    assert.equal((await patch(sa(), P(106), { priceLists: [{ id: 'old' }, { id: PRICE_LIST, allYouCanEat: true }] })).status, 200);
    // Without the list of the sales in the list sent, it is put back.
    const again = await patch(sa(), P(106), { priceLists: [{ id: 'old' }] });
    assert.deepEqual(again.body.data.priceLists.map((list: { id: string }) => list.id), ['old', PRICE_LIST]);
    // And an e-commerce price list that exists is accepted.
    assert.equal((await patch(sa(), P(106), { ecommercePriceListId: PRICE_LIST })).body.data.ecommercePriceListId, PRICE_LIST);
    assert.equal((await patch(sa(), P(106), { ecommercePriceListId: null, priceListId: null })).body.data.priceListId, null);
  });

  it('checks the invoice series against the series of the company of the place, and takes false only where the legacy stored it', async () => {
    assert.equal((await patch(sa(), P(102), { invoiceSeries: 'NC' })).body.data.invoiceSeries, 'NC');
    assert.deepEqual(failure(await patch(sa(), P(102), { invoiceSeries: 'XX' })), issues(['invoiceSeries', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), P(102), { invoiceSeries: false })), issues(['invoiceSeries', 'incorrect']));
    assert.equal((await patch(sa(), P(102), { invoiceSeries: null })).body.data.invoiceSeries, null);
    await groupDb().collection('places').updateOne({ _id: P(102) }, { $set: { invoicePS: false } });
    assert.equal((await patch(sa(), P(102), { invoiceSeries: false, name: 'Same series' })).body.data.invoiceSeries, false);
    // A series of another company does not exist for this place, and a change of company is judged with the series of the new one.
    assert.deepEqual(failure(await patch(sa(), P(100), { invoiceSeries: 'NC' })), issues(['invoiceSeries', 'incorrect']));
    await groupDb().collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { invoicesPSValues: [{ name: 'FE', cash: true }] } });
    assert.equal((await patch(pa(), world.group(0).ownPlaceId, { invoiceSeries: 'FE' })).body.data.invoiceSeries, 'FE');
    assert.deepEqual(failure(await patch(pa(), world.group(0).ownPlaceId, { invoiceSeries: 'NC' })), issues(['invoiceSeries', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), P(100), { companyId: hex(fixtureId('company', 2)), invoiceSeries: 'NC' })), issues(['invoiceSeries', 'incorrect']));
    assert.equal((await patch(pa(), world.group(0).ownPlaceId, { invoiceSeries: null })).body.data.invoiceSeries, null);
  });

  it('tells nothing of the invoice series of a company outside the perimeter: the same 422 for a series that exists and one that does not', async () => {
    const outside = hex(fixtureId('company', 20));
    const same = issues(['companyId', 'incorrect']);
    assert.deepEqual(failure(await patch(ca(), P(100), { companyId: outside, invoiceSeries: 'NC' })), same);
    assert.deepEqual(failure(await patch(ca(), P(100), { companyId: outside, invoiceSeries: 'ZZ' })), same);
    assert.deepEqual(failure(await patch(pa(), world.group(0).ownPlaceId, { companyId: outside, invoiceSeries: 'NC' })), same);
    assert.deepEqual(failure(await patch(pa(), world.group(0).ownPlaceId, { companyId: outside, invoiceSeries: 'ZZ' })), same);
  });

  it('refuses operators and dotted keys in the hours, as a key of the special days and inside a day or a slot', async () => {
    const closed = { active: false, values: [] };
    const week = { '0': closed, '1': closed, '2': closed, '3': closed, '4': closed, '5': closed, '6': closed };
    const refuse = async (openingHours: unknown) => assert.equal(failure(await patch(psa(), P(100), { openingHours })).status, 422, JSON.stringify(openingHours));
    await refuse({ special: { $set: { closed: true, values: [] } } });
    await refuse({ special: { 'a.b': { closed: true, values: [] } } });
    await refuse({ special: { '2026-01-01': { closed: true, values: [], $ne: 1 } } });
    await refuse({ special: { '2026-01-01': { closed: true, values: [{ start: '09:00', end: '10:00', 'x.y': 1 }] } } });
    await refuse({ week: { ...week, '1': { active: true, values: [], $where: 'x' } } });
    await refuse({ week: { ...week, '1': { active: true, values: [{ start: '09:00', end: '10:00', $gt: 1 }] } } });
    await refuse({ deliveryTime: { special: { $in: [] } } });
  });

  it('answers 409 when a block of the stored place is not an object, and writes nothing', async () => {
    const before = await stored(P(104));
    const week1 = week({ '1': { active: true, values: [{ ...SLOT }] } });
    const reply = await put(psa(), P(104), 'opening-hours', { timezone: 'Europe/Rome', week: week1, special: {}, deliveryTime: { week: week(), special: {} } });
    assert.equal(failure(reply).status, 409);
    assert.equal(failure(reply).code, 'CONFLICT');
    assert.equal(failure(await patch(psa(), P(104), { license: { sentry: true } })).status, 409);
    assert.ok(sameDocument(before, await stored(P(104))));
    // The general data can still be changed: the blocks that are not an object are not written.
    assert.equal((await patch(psa(), P(104), { name: 'Odd blocks' })).status, 200);
  });

  it('completes a block that is missing or empty with the defaults of the keys it does not set, and keeps the rest', async () => {
    const reply = await put(psa(), P(103), 'opening-hours', { timezone: 'Europe/Rome', week: week({ '2': { active: true, values: [{ ...SLOT }] } }), special: {}, deliveryTime: { week: week(), special: { '2026-12-24': { closed: true, values: [] } } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const delivery = (await stored(P(103)))['delivery'] as Document;
    assert.deepEqual(Object.keys(delivery).sort(), ['lat', 'lng', 'margin', 'maxContemporary', 'minAmount', 'radius', 'step', 'time']);
    assert.deepEqual([delivery['minAmount'], delivery['step']], [{}, null]);
    assert.deepEqual((delivery['time'] as Document)['daySpecial'], { '2026-12-24': { closed: true, values: [] } });
    // `general` was an empty object: it is completed when the price lists are written.
    const general = (await patch(psa(), P(103), { priceLists: [{ id: PRICE_LIST }] }));
    assert.equal(general.status, 200, JSON.stringify(general.body));
    const block = (await stored(P(103)))['general'] as Document;
    assert.equal(Object.keys(block).length, 31);
    assert.deepEqual([block['chargeDocumentQt'] instanceof Int32, block['localWarehouseOutOfStock'], block['priceLists']], [true, 'disabled', [{ id: PRICE_LIST, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]]);
    assert.ok(sameDocument(expectedCopy(await stored(P(103)), world.group(0).groupId), (await world.copyOfPlace(P(103)))!));
  });

  it('names what changed in the log, blocks and fields, and no value', async () => {
    const mark = world.office.activity.entries.length;
    assert.equal((await patch(psa(), P(100), { name: 'Logged name', address: { city: 'Logged city' }, license: { status: 'disabled', expirationDate: '2031-01-01' }, openingHours: { timezone: 'Europe/London' }, priceLists: [{ id: PRICE_LIST, ayceCode1: 'secret-code' }] })).status, 200);
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.updated');
    assert.equal(entry!.resource!.id, hex(P(100)));
    assert.deepEqual(entry!.changes, [
      { field: 'name', redacted: true },
      { field: 'address.city', redacted: true },
      { field: 'priceLists', redacted: true },
      { field: 'license', redacted: true },
      { field: 'openingHours', redacted: true },
    ]);
    const text = JSON.stringify(entry);
    for (const value of ['Logged name', 'Logged city', 'secret-code', 'Europe/London', '2031']) {
      assert.ok(!text.includes(value), value);
    }
    assert.equal((await patch(psa(), P(100), { name: 'Bar Roma', address: { city: 'Milano' }, license: { status: 'active', expirationDate: '2030-01-01' }, openingHours: { timezone: 'Europe/Rome' }, priceLists: [{ id: PRICE_LIST, allYouCanEat: true, ayceCode1: '12' }] })).status, 200);
  });
});

describe('PUT …/license', () => {
  const LICENSE = { plan: 'advanced', expirationDate: '2030-01-01T00:00:00.000Z', status: 'active', sentry: true };

  it('replaces the block: the PSA changes every key, and the stored forms are the legacy ones', async () => {
    const reply = await put(psa(), P(100), 'license', { plan: 'enterprice', expirationDate: '2032-02-02', status: 'disabled', sentry: false });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.license, { plan: 'enterprice', expirationDate: '2032-02-02T00:00:00.000Z', status: 'disabled', sentry: false });
    const document = await stored(P(100));
    assert.deepEqual([document['plan'], document['expirationDate'], document['status']], ['enterprice', new Date('2032-02-02T00:00:00.000Z'), false]);
    // Inside `platform` only the Sentry switch is written: the historical key stays.
    assert.deepEqual(document['platform'], { sentry: false, ip: false });
    assert.equal((await put(psa(), P(100), 'license', LICENSE)).status, 200);
  });

  it('needs every key, and refuses what is not valid', async () => {
    assert.deepEqual(failure(await put(psa(), P(100), 'license', {})), issues(['plan', 'required'], ['expirationDate', 'required'], ['status', 'required'], ['sentry', 'required']));
    assert.deepEqual(failure(await put(psa(), P(100), 'license', { ...LICENSE, plan: 'professional' })), issues(['license.plan', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(100), 'license', { ...LICENSE, plan: null })), issues(['license.plan', 'incorrect']));
    assert.deepEqual(failure(await put(psa(), P(100), 'license', { ...LICENSE, status: 'on' })), issues(['status', 'enum']));
    assert.deepEqual(failure(await put(psa(), P(100), 'license', LICENSE, {})), issues(['If-Match', 'required']));
  });

  it('is the PSA’s for the plan and the Sentry switch, the PSA’s and the dealers’ for the end of the license and the state; a value that does not change is accepted from anybody who may write the place', async () => {
    assert.equal((await put(sa(), P(100), 'license', LICENSE)).status, 200, 'unchanged block from a group administrator');
    assert.equal((await put(ca(), P(100), 'license', LICENSE)).status, 200, 'unchanged block from a company administrator');
    assert.deepEqual(failure(await put(sa(), P(100), 'license', { ...LICENSE, plan: 'basic' })), notAllowed('license.plan'));
    assert.deepEqual(failure(await put(sa(), P(100), 'license', { ...LICENSE, status: 'disabled', expirationDate: '2031-01-01', sentry: false })), notAllowed('license.status', 'license.expirationDate', 'license.sentry'));
    assert.deepEqual(failure(await put(ca(), P(100), 'license', { ...LICENSE, expirationDate: '2031-01-01' })), notAllowed('license.expirationDate'));
    assert.deepEqual(failure(await put(dealer(), P(100), 'license', { ...LICENSE, plan: 'basic' })), notAllowed('license.plan'));
    assert.deepEqual(failure(await put(dealer(), P(100), 'license', { ...LICENSE, sentry: false })), notAllowed('license.sentry'));
    const renewed = await put(dealer(), P(100), 'license', { ...LICENSE, status: 'disabled', expirationDate: '2033-03-03' });
    assert.deepEqual(renewed.body.data.license, { ...LICENSE, status: 'disabled', expirationDate: '2033-03-03T00:00:00.000Z' });
    assert.equal((await put(psa(), P(100), 'license', LICENSE)).status, 200);
    assert.equal((await put(pa(), world.group(0).ownPlaceId, 'license', { plan: 'basic', expirationDate: '2030-01-01T00:00:00.000Z', status: 'active', sentry: false })).status, 403);
  });

  it('keeps a historical plan until a PSA changes it, and never writes the epoch for a license without end', async () => {
    assert.equal((await current(P(101))).license.plan, 'professional');
    assert.equal((await patch(sa(), P(101), { name: 'Still professional' })).body.data.license.plan, 'professional');
    assert.equal((await put(sa(), P(101), 'license', { ...LICENSE, plan: 'professional' })).status, 200);
    assert.equal((await patch(psa(), P(101), { license: { plan: 'professional', sentry: false } })).status, 200);
    assert.equal((await stored(P(101)))['plan'], 'professional');
    assert.equal((await put(psa(), P(101), 'license', { ...LICENSE, plan: 'basic', expirationDate: null })).status, 200);
    assert.deepEqual([(await stored(P(101)))['plan'], (await stored(P(101)))['expirationDate']], ['basic', null]);
  });
});

describe('PUT …/opening-hours', () => {
  it('replaces the block, keeps the keys of the stored objects the backend does not know, and removes the special days that are not sent', async () => {
    const before = await stored(P(100));
    const reply = await put(
      ca(),
      P(100),
      'opening-hours',
      HOURS({ week: week({ '1': { active: true, values: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }] }, '6': { active: true, values: [{ ...SLOT }] } }), special: { '2027-01-01': { closed: true, values: [] } }, timezone: 'Europe/London' }),
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(P(100));
    assert.deepEqual(differences(before, after, ['openingTime', 'timezone', 'updateDate']).filter((key) => key !== 'updateDate').sort(), ['openingTime', 'timezone']);
    const opening = after['openingTime'] as { weekGeneric: Document; daySpecial: Document; unknownOpening: number };
    assert.deepEqual(opening.weekGeneric['1'], { active: true, values: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }] });
    assert.deepEqual(opening.weekGeneric['0'], CLOSED);
    // The date of the old special day is gone, the key that is not a date stays, as does the key of the object.
    assert.deepEqual(opening.daySpecial, { legacyOddKey: { keep: true }, '2027-01-01': { closed: true, values: [] } });
    assert.equal(Number(opening.unknownOpening), 1);
    assert.equal(after['timezone'], 'Europe/London');
    assert.deepEqual(reply.body.data.openingHours.special, { '2027-01-01': { closed: true, values: [] } });
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!));
    // The delivery hours of the place were not touched: its block is as it was.
    assert.ok(sameDocument({ v: (after['delivery'] as Document)['time'] }, { v: (before['delivery'] as Document)['time'] }));
    // Back to the fixture.
    assert.equal((await put(ca(), P(100), 'opening-hours', HOURS({ week: week(Object.fromEntries(['1', '2', '3', '4', '5'].map((day) => [day, { active: true, values: [{ ...SLOT }] }]))), special: { '2026-12-25': { closed: true, values: [] } } }))).status, 200);
  });

  it('writes the delivery hours on their own paths', async () => {
    const reply = await put(sa(), P(100), 'opening-hours', HOURS({ week: (await current(P(100))).openingHours.week, special: (await current(P(100))).openingHours.special, deliveryTime: { week: week({ '4': { active: true, values: [{ start: '18:00', end: '23:00' }] } }), special: { '2026-12-31': { closed: false, values: [{ start: '18:00', end: '22:00' }] } } } }));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const time = (await stored(P(100)))['delivery'] as { time: { weekGeneric: Document; daySpecial: Document }; minAmount: Document; unknownDelivery: number };
    assert.deepEqual(time.time.weekGeneric['4'], { active: true, values: [{ start: '18:00', end: '23:00' }] });
    assert.deepEqual(time.time.daySpecial, { '2026-12-31': { closed: false, values: [{ start: '18:00', end: '22:00' }] } });
    assert.ok(time.minAmount['EUR'] !== undefined && Number(time.unknownDelivery) === 1);
    assert.equal((await put(sa(), P(100), 'opening-hours', HOURS({ week: (await current(P(100))).openingHours.week, special: (await current(P(100))).openingHours.special }))).status, 200);
  });

  it('checks the time zone, the times and the dates where they change, and every key of the block is needed', async () => {
    assert.deepEqual(failure(await put(psa(), P(100), 'opening-hours', {})), issues(['timezone', 'required'], ['week', 'required'], ['special', 'required'], ['deliveryTime', 'required']));
    assert.deepEqual(failure(await put(psa(), P(100), 'opening-hours', HOURS({ timezone: 'Mars/Olympus' }))), issues(['openingHours.timezone', 'incorrect']));
    assert.deepEqual(
      failure(await put(psa(), P(100), 'opening-hours', HOURS({ week: week({ '3': { active: true, values: [{ start: '24:00', end: '12:60' }] } }) }))),
      issues(['openingHours.week.3.values.0.start', 'format'], ['openingHours.week.3.values.0.end', 'format']),
    );
    assert.deepEqual(failure(await put(psa(), P(100), 'opening-hours', HOURS({ special: { '2026-13-01': { closed: true, values: [] } } }))), issues(['openingHours.special.2026-13-01', 'format']));
    assert.deepEqual(
      failure(await put(psa(), P(100), 'opening-hours', HOURS({ deliveryTime: { week: week({ '0': { active: true, values: [{ start: '9:00', end: '10:00' }] } }), special: { '2026-02-29': { closed: false, values: [{ start: '10:00', end: 'x' }] } } } }))),
      issues(['openingHours.deliveryTime.week.0.values.0.start', 'format'], ['openingHours.deliveryTime.special.2026-02-29', 'format'], ['openingHours.deliveryTime.special.2026-02-29.values.0.end', 'format']),
    );
    assert.equal((await put(psa(), P(100), 'opening-hours', HOURS({ timezone: 'UTC' }))).status, 200);
  });

  it('accepts the stored values that do not satisfy the rules when they are sent back unchanged, and judges only the days that change', async () => {
    const read = await current(P(105));
    assert.deepEqual(read.openingHours.week['1'], { active: true, values: [{ start: '9', end: 'late' }] });
    assert.equal((await put(sa(), P(105), 'opening-hours', read.openingHours)).status, 200);
    const reply = await patch(sa(), P(105), { openingHours: { week: { ...read.openingHours.week, '2': { active: true, values: [{ ...SLOT }] } } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.openingHours.week['1'].values, reply.body.data.openingHours.week['2'].values], [[{ start: '9', end: 'late' }], [SLOT]]);
    assert.deepEqual(failure(await patch(sa(), P(105), { openingHours: { week: { ...read.openingHours.week, '1': { active: true, values: [{ start: '9', end: 'later' }] } } } })), issues(['openingHours.week.1.values.0.start', 'format'], ['openingHours.week.1.values.0.end', 'format']));
  });

  it('is open to a place administrator for his own place, and to nobody outside the perimeter', async () => {
    assert.equal((await put(pa(), world.group(0).ownPlaceId, 'opening-hours', HOURS())).status, 200);
    assert.equal(failure(await put(pa(), P(100), 'opening-hours', HOURS())).status, 404);
  });
});

describe('what the POS and the legacy own survives every write', () => {
  const OWNED_BY_OTHERS = ['devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'paymentTypes', 'integrations', 'server', 'connectorAddress', 'roomsSettings', 'receipt', 'ordering', 'medias', 'futureBlock', 'service', 'roomsListId', 'groupId', 'insertDate', 'kiosk', 'deliveryTakeAway'];

  it('keeps every block it does not own, byte for byte, through a creation of changes in every block it owns', async () => {
    const start = await stored(P(100));
    const steps: Array<[string, () => Promise<{ status: number }>]> = [
      ['patch', () => patch(psa(), P(100), { name: 'S1', priceListId: null, ecommercePriceListId: PRICE_LIST, invoiceSeries: null, address: { postcode: '00100' } })],
      ['license', () => put(psa(), P(100), 'license', { plan: 'basic', expirationDate: null, status: 'disabled', sentry: false })],
      ['hours', () => put(psa(), P(100), 'opening-hours', { timezone: 'Europe/London', week: week(), special: {}, deliveryTime: { week: week(), special: {} } })],
      ['company', () => patch(sa(), P(100), { companyId: hex(fixtureId('company', 2)) })],
    ];
    for (const [step, run] of steps) {
      const reply = await run();
      assert.equal(reply.status, 200, step);
      const after = await stored(P(100));
      for (const key of OWNED_BY_OTHERS) {
        assert.ok(sameDocument({ v: start[key] }, { v: after[key] }), `${key} changed at ${step}`);
      }
      assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOfPlace(P(100)))!), `copy at ${step}`);
    }
    const final = await stored(P(100));
    // The credentials of the integrations and of the devices are exactly as they were, and the exact types stay.
    assert.equal(((final['integrations'] as Document)['dojo'] as Document)['apiKey'], 'fixture-integration-secret');
    assert.equal(((final['devices'] as Document[])[0]!)['automaticCashPassword'], 'fixture-device-secret');
    assert.ok(((final['devices'] as Document[])[0]!['info'] as Document)['battery'] instanceof Double);
    assert.ok((((final['rooms'] as Document[])[0]!['tables'] as Document[])[0]!['seats']) instanceof Int32);
    assert.ok((final['storages'] as Document[])[0]!['id'].equals((start['storages'] as Document[])[0]!['id']));
    assert.deepEqual([((final['roomsSettings'] as Document)['reservation'] as Document)['suspendedToday'], (final['server'] as Document)['port'] instanceof Double, sameDocument({ v: final['futureBlock'] }, { v: start['futureBlock'] })], [true, true, true]);
    // The owned keys moved, and the keys the backend does not know inside the blocks it owns stayed.
    assert.deepEqual([final['status'], final['plan'], final['listId'], final['ecommerceListId'], final['postcode'], final['timezone'], final['companyId']], [false, 'basic', null, PRICE_LIST, '00100', 'Europe/London', fixtureId('company', 2)]);
    assert.deepEqual(final['platform'], { sentry: false, ip: false });
    assert.equal(((final['general'] as Document)['unknownGeneral']), 'keep');
    assert.equal(Number((final['openingTime'] as Document)['unknownOpening']), 1);
    assert.equal(Number((final['delivery'] as Document)['unknownDelivery']), 1);
    assert.equal((await patch(psa(), P(100), { companyId: hex(fixtureId('company', 1)) })).status, 200);
  });
});
