import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument, expectedCopy } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { PRICE_LIST } from '../helpers/place-fixtures.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const COMPANY = hex(fixtureId('company', 1));
const SERIES_COMPANY = fixtureId('company', 20);
const body = (overrides: Document = {}): Document => ({ name: 'New Bar', companyId: COMPANY, address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' }, ...overrides });
const NAMES = ['New Bar', 'New Full', 'New Dealer', 'New Hours'];
const CLOSED = { active: false, values: [] };
const WEEK = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((day) => [day, day === '0' ? CLOSED : { active: true, values: [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '19:00' }] }]));

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await world.seed(0, 20);
  await world.seed(0, 21, { trash: true });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

/** Removes the places a test created. */
async function clean(): Promise<void> {
  await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').deleteMany({ name: { $in: NAMES } });
  await ctx.databases.common().collection('places').deleteMany({ name: { $in: NAMES } });
}

describe('POST /v1/groups/{groupId}/places', () => {
  it('creates a place with the general data: 201, Location, ETag, the full representation, the complete legacy document and its identical copy', async () => {
    await clean();
    const mark = world.office.activity.entries.length;
    const reply = await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ contactName: 'Mario', email: 'Bar@Example.test', phone: '+39 02 1' }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const place = reply.body.data;
    assert.equal(reply.headers.get('location'), `/v1${world.placePath(0, `/${place.id}`)}`);
    const id = ObjectId.createFromHexString(place.id);
    const document = (await world.storedPlace(0, id))!;
    assert.equal(reply.headers.get('etag'), `"${versionOf('places', document, TEST_VERSION_KEY)}"`);
    assert.deepEqual([place.name, place.companyId, place.groupId, place.trashed, place.contactName, place.email, place.phone], ['New Bar', COMPANY, hex(world.group(0).groupId), false, 'Mario', 'bar@example.test', '+39 02 1']);
    assert.deepEqual(place.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    assert.deepEqual([place.priceListId, place.ecommercePriceListId, place.invoiceSeries, place.priceLists], [null, null, null, []]);
    assert.deepEqual(place.license, { plan: 'basic', expirationDate: null, status: 'active' });
    // A dealer sees the dealer settings of the template; a group administrator does not.
    assert.deepEqual(place.dealerSettings, { sentry: false, serverIp: null, connectorAddress: '' });
    assert.equal((await call(world.group(0).sa, 'GET', world.placePath(0, `/${place.id}`))).body.data.dealerSettings, undefined);
    assert.equal(place.openingHours.timezone, 'Europe/Rome');
    assert.deepEqual(Object.keys(place.openingHours.week), ['0', '1', '2', '3', '4', '5', '6']);
    // The legacy document: top-level names and types.
    assert.deepEqual(
      [document['name'], document['companyId'], document['address'], document['countryCode'], document['countryAreaCode'], document['contact'], document['email'], document['telephone'], document['status'], document['plan'], document['trash'], document['expirationDate'], document['timezone']],
      ['New Bar', fixtureId('company', 1), 'Via Roma 1', 'IT', 'MI', 'Mario', 'bar@example.test', '+39 02 1', true, 'basic', false, null, 'Europe/Rome'],
    );
    assert.deepEqual(document['groupId'], world.group(0).groupId);
    // The template of the old backoffice: every block, with its defaults and its exact types.
    for (const block of ['medias', 'devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'openingTime', 'platform', 'server', 'general', 'paymentTypes', 'receipt', 'prebilling', 'ordering', 'roomsSettings', 'selfOrdering', 'payments', 'externalDisplay', 'advancedReport', 'appointment', 'deliveryTakeAway', 'kiosk', 'fidelity', 'tgm', 'delivery', 'integrations']) {
      assert.ok(block in document, block);
    }
    assert.deepEqual([document['platform'], document['server'], document['connectorAddress']], [{ sentry: false }, { ip: null }, '']);
    assert.ok((document['ordering'] as Document)['numberFontSize'] === '2-1' && !('notesFontSize' in (document['ordering'] as Document)));
    const receipt = document['receipt'] as Document;
    assert.deepEqual([receipt['noFiscalTaxes'], receipt['noFiscalTaxesTotal']], [false, false]);
    assert.ok(receipt['invoiceQt'] instanceof Int32 && receipt['invoiceQt'].value === 1);
    const rooms = document['roomsSettings'] as Document;
    assert.ok(rooms['exitsNumber'] instanceof Int32 && rooms['exitsNumber'].value === 5);
    assert.deepEqual([rooms['delivery'], rooms['deliveryAutoOrderingTime'], rooms['deliverySendPrebillingOnSave'], rooms['tableGroupName'], rooms['tableGroups']], [false, null, false, false, { status: false, name: false, autoCreateFirst: false, mergeProductsPrint: false }]);
    assert.equal((document['kiosk'] as Document)['mode'], 'sale');
    assert.deepEqual((document['delivery'] as { time: Document }).time['daySpecial'], {});
    assert.equal(Object.keys(((document['delivery'] as { time: { weekGeneric: object } }).time.weekGeneric)).length, 7);
    assert.deepEqual((document['openingTime'] as Document)['daySpecial'], {});
    // No credential and no value of the integrations is invented: every switch off and every secret empty.
    const integrations = document['integrations'] as Record<string, Document>;
    assert.equal(Object.keys(integrations).length, 16);
    assert.ok(Object.values(integrations).every((integration) => integration['status'] === false));
    assert.deepEqual([integrations['dojo'], integrations['plateform']], [{ status: false, apiKey: null }, { status: false, username: null, password: null }]);
    assert.equal(integrations['floodPay']!['stripe'] !== undefined && JSON.stringify(integrations['floodPay']!['stripe']), JSON.stringify({ publicKey: null, privateKey: null, webhookPrivateKey: null }));
    // One cash storage with an id of its own.
    const storages = document['storages'] as Document[];
    assert.equal(storages.length, 1);
    assert.ok(storages[0]!['id'] instanceof ObjectId);
    assert.deepEqual([storages[0]!['name'], storages[0]!['cash'], storages[0]!['ecommerce']], ['Deposito 1', true, false]);
    assert.ok(sameDocument(expectedCopy(document, world.group(0).groupId), (await world.copyOfPlace(id))!));
    // groups.places is recalculated with the new place.
    const group = (await ctx.databases.common().collection('groups').findOne({ _id: world.group(0).groupId }))!;
    assert.ok((group['places'] as Array<{ _id: ObjectId }>).some((entry) => entry._id.equals(id)));
    // The activity log names the place and holds no value but its name and state.
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'place.created');
    assert.equal(entry!.resource!.id, hex(id));
    assert.deepEqual(entry!.changes!.map((change) => [change.field, change.after]), [['name', 'New Bar'], ['status', 'active']]);
    // The read back is the same.
    const { dealerSettings: _dealer, ...general } = place;
    assert.deepEqual((await call(world.group(0).sa, 'GET', world.placePath(0, `/${place.id}`))).body.data, general);
  });

  it('creates a place with every field the step has, giving the stored forms of the legacy, and the price list among the price lists of the place', async () => {
    await clean();
    const reply = await call(
      psa(),
      'POST',
      world.placePath(0),
      body({
        name: 'New Full',
        companyId: hex(SERIES_COMPANY),
        priceListId: PRICE_LIST,
        ecommercePriceListId: PRICE_LIST,
        invoiceSeries: 'NC',
        license: { plan: 'enterprice', status: 'disabled', expirationDate: '2030-06-01' },
        dealerSettings: { sentry: true, serverIp: '10.1.2.3', connectorAddress: 'http://connector.example.test' },
        integrations: { dojo: { status: true, apiKey: 'fake-dojo-key' } }, // gitleaks:allow (fake test value)
        openingHours: { timezone: 'Europe/London', week: WEEK, special: { '2026-12-25': { closed: true, values: [] } }, deliveryTime: { week: WEEK, special: { '2026-12-31': { closed: false, values: [{ start: '10:00', end: '12:00' }] } } } },
      }),
    );
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const place = reply.body.data;
    const document = (await world.storedPlace(0, ObjectId.createFromHexString(place.id)))!;
    assert.deepEqual([document['listId'], document['ecommerceListId'], document['invoicePS'], document['plan'], document['status'], document['expirationDate'], document['timezone']], [PRICE_LIST, PRICE_LIST, 'NC', 'enterprice', false, new Date('2030-06-01T00:00:00.000Z'), 'Europe/London']);
    assert.deepEqual((document['platform'] as Document)['sentry'], true);
    assert.deepEqual([(document['server'] as Document)['ip'], document['connectorAddress']], ['10.1.2.3', 'http://connector.example.test']);
    // A credential is written at creation and never returned: only whether it is set.
    assert.deepEqual([(document['integrations'] as Document)['dojo']], [{ status: true, apiKey: 'fake-dojo-key' }]); // gitleaks:allow (fake test value)
    assert.deepEqual([place.integrations.dojo.status, place.integrations.dojo.apiKeySet, place.integrations.dojo.apiKey], [true, true, undefined]);
    assert.ok(!JSON.stringify(reply.body).includes('fake-dojo-key'));
    assert.deepEqual((document['general'] as Document)['priceLists'], [{ id: PRICE_LIST, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    assert.deepEqual(place.priceLists, [{ id: PRICE_LIST, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    const opening = document['openingTime'] as { weekGeneric: Document; daySpecial: Document };
    assert.deepEqual(opening.weekGeneric['1'], { active: true, values: [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '19:00' }] });
    assert.deepEqual(opening.weekGeneric['0'], CLOSED);
    assert.deepEqual(opening.daySpecial, { '2026-12-25': { closed: true, values: [] } });
    const delivery = (document['delivery'] as { time: { daySpecial: Document; weekGeneric: Document } }).time;
    assert.deepEqual(delivery.daySpecial, { '2026-12-31': { closed: false, values: [{ start: '10:00', end: '12:00' }] } });
    assert.deepEqual(delivery.weekGeneric['6'], { active: true, values: [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '19:00' }] });
    assert.deepEqual([place.license, place.openingHours.timezone, place.invoiceSeries, place.ecommercePriceListId], [{ plan: 'enterprice', expirationDate: '2030-06-01T00:00:00.000Z', status: 'disabled' }, 'Europe/London', 'NC', PRICE_LIST]);
    assert.ok(sameDocument(expectedCopy(document, world.group(0).groupId), (await world.copyOfPlace(ObjectId.createFromHexString(place.id)))!));
    // The exact types of a number written by a JavaScript integer: an Int32, as the old backoffice writes it.
    assert.ok(((document['general'] as Document)['chargeDocumentQt']) instanceof Int32 && !(((document['general'] as Document)['totalRounding']) instanceof Double));
  });

  it('lets a dealer choose the plan of a new place, but never the Sentry switch of the dealer settings', async () => {
    await clean();
    const reply = await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ name: 'New Dealer', license: { plan: 'advanced', status: 'disabled', expirationDate: '2031-01-01' } }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.license.plan, reply.body.data.license.status, reply.body.data.license.expirationDate], ['advanced', 'disabled', '2031-01-01T00:00:00.000Z']);
    assert.deepEqual(failure(await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ dealerSettings: { sentry: true } }))), notAllowed('dealerSettings.sentry'));
    await clean();
  });

  it('lets a dealer create a place sending the default of the Sentry switch', async () => {
    await clean();
    const reply = await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ name: 'New Dealer', dealerSettings: { sentry: false, serverIp: '10.2.2.2' } }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.dealerSettings.serverIp, '10.2.2.2');
    await clean();
  });

  it('does not let a dealer choose desk-secondary, which is the PSA’s alone, and leaves him the other four plans', async () => {
    await clean();
    const dealer = world.office.cluster.dealerA;
    assert.deepEqual(failure(await call(dealer, 'POST', world.placePath(0), body({ license: { plan: 'desk-secondary' } }))), notAllowed('license.plan'));
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'New Bar' }), 0);
    for (const plan of ['basic', 'advanced', 'enterprice', 'tgm-secondary']) {
      assert.equal((await call(dealer, 'POST', world.placePath(0), body({ license: { plan } }))).body.data.license.plan, plan);
      await clean();
    }
    const psaReply = await call(psa(), 'POST', world.placePath(0), body({ license: { plan: 'desk-secondary' } }));
    assert.equal(psaReply.body.data.license.plan, 'desk-secondary');
    await clean();
  });

  it('is for the PSA and the dealers: a group, company or place administrator gets 403', async () => {
    for (const actor of [world.group(0).sa, world.group(0).ca, world.group(0).pa]) {
      assert.equal(failure(await call(actor, 'POST', world.placePath(0), body())).status, 403);
    }
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'New Bar' }), 0);
  });

  it('keeps every group to its callers: 404 for another group, another dealer, no session', async () => {
    for (const [actor, index] of [[world.group(0).sa, 1], [world.office.cluster.dealerB, 0], [world.office.cluster.dealerA, 2]] as const) {
      assert.equal(failure(await call(actor, 'POST', world.placePath(index), body())).status, 404);
    }
    assert.equal((await world.office.call('POST', world.placePath(0), undefined, body())).status, 401);
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'New Bar' }), 0);
  });

  it('refuses the company of another group, a company in the trash and one that does not exist, with 422 on the company', async () => {
    for (const companyId of [hex(fixtureId('company', 3)), hex(fixtureId('company', 21)), hex(new ObjectId())]) {
      assert.deepEqual(failure(await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ companyId }))), issues(['companyId', 'incorrect']), companyId);
    }
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'New Bar' }), 0);
  });

  it('validates the data: a country and a province that are not there, a price list the group does not have, an invoice series the company lacks, a plan, a time zone and the hours', async () => {
    const sa = world.office.cluster.dealerA;
    const refuse = async (overrides: Document, ...expected: Array<[string, string]>) => assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), body(overrides))), issues(...expected), JSON.stringify(overrides));
    await refuse({ address: { street: 's', postcode: 'p', city: 'c', country: 'ZZ' } }, ['address.country', 'incorrect']);
    await refuse({ address: { street: 's', postcode: 'p', city: 'c', province: 'XX', country: 'IT' } }, ['address.province', 'incorrect']);
    await refuse({ priceListId: 'nope', ecommercePriceListId: 'nope2' }, ['priceListId', 'incorrect'], ['ecommercePriceListId', 'incorrect']);
    await refuse({ priceLists: [{ id: PRICE_LIST }, { id: 'nope' }] }, ['priceLists.1.id', 'incorrect']);
    await refuse({ invoiceSeries: 'FE' }, ['invoiceSeries', 'incorrect']);
    await refuse({ invoiceSeries: false }, ['invoiceSeries', 'incorrect']);
    await refuse({ companyId: hex(SERIES_COMPANY), invoiceSeries: 'XX' }, ['invoiceSeries', 'incorrect']);
    await refuse({ openingHours: { timezone: 'Mars/Olympus' } }, ['openingHours.timezone', 'incorrect']);
    await refuse({ openingHours: { week: { ...WEEK, '2': { active: true, values: [{ start: '9:00', end: '25:00' }] } } } }, ['openingHours.week.2.values.0.start', 'format'], ['openingHours.week.2.values.0.end', 'format']);
    await refuse({ openingHours: { special: { '2026-02-30': { closed: true, values: [] } } } }, ['openingHours.special.2026-02-30', 'format']);
    await refuse({ openingHours: { deliveryTime: { special: { '2026-03-01': { closed: false, values: [{ start: '10:00', end: '1pm' }] } } } } }, ['openingHours.deliveryTime.special.2026-03-01.values.0.end', 'format']);
    assert.deepEqual(failure(await call(psa(), 'POST', world.placePath(0), body({ license: { plan: 'professional' } }))), issues(['license.plan', 'incorrect']));
    assert.deepEqual(failure(await call(psa(), 'POST', world.placePath(0), body({ license: { plan: null } }))), issues(['license.plan', 'incorrect']));
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: 'New Bar' }), 0);
  });

  it('requires the name, the company and the address, and refuses unknown fields, operators and the fields that are not the place’s to set', async () => {
    const sa = world.office.cluster.dealerA;
    assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), {})), issues(['name', 'required'], ['companyId', 'required'], ['address', 'required']));
    assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), body({ integrations: { unknownIntegration: { apiKey: 'x' } } }))), issues(['integrations.unknownIntegration', 'unknown']));
    // The lists of items are modified, never created: a new place has the template.
    assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), body({ devices: { items: [] } }))), issues(['devices', 'unknown']));
    assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), body({ groupId: hex(world.group(1).groupId) }))), issues(['groupId', 'unknown']));
    assert.deepEqual(failure(await call(sa, 'POST', world.placePath(0), body({ $set: { name: 'x' } }))), issues(['(key)', 'forbiddenKey']));
    assert.equal(failure(await call(sa, 'POST', world.placePath(0), undefined)).status, 422);
  });

  it('refuses a body that is too large (413) and a body that is not JSON (415)', async () => {
    const token = await world.as.tokenOf(world.office.cluster.dealerA);
    const large = await world.office.call('POST', world.placePath(0), token, body({ name: 'x'.repeat(300_000) }));
    assert.equal(large.status, 413);
    const text = await fetch(`${world.office.app.baseUrl}/v1${world.placePath(0)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    assert.equal(await ctx.databases.common().collection('places').countDocuments({ name: /^xxx/ }), 0);
  });

  it('creates the opening hours of a place with the week closed and the delivery hours when none is given', async () => {
    await clean();
    const reply = await call(world.office.cluster.dealerA, 'POST', world.placePath(0), body({ name: 'New Hours', openingHours: { timezone: 'UTC' } }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.openingHours.timezone, 'UTC');
    assert.deepEqual(reply.body.data.openingHours.week['3'], CLOSED);
    assert.deepEqual(reply.body.data.openingHours.deliveryTime, { week: reply.body.data.openingHours.week, special: {} });
  });
});
