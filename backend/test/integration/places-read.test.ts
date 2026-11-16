import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { fixtureId, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { PRICE_LIST, SLOT } from '../helpers/place-fixtures.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const C = (n: number) => fixtureId('company', n);
const P = (n: number) => fixtureId('place', n);
const names = (reply: { body: { data: Array<{ name: string }> } }) => reply.body.data.map((item) => item.name);
const sa = () => world.group(0).sa;

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  // Group 0 has the two places of the cluster; more of them, with every state the list filters and sorts by.
  await world.seedPlace(0, 100, 1, { name: 'Zeta Bar', expirationDate: new Date('2031-01-01T00:00:00.000Z'), city: 'Milano', plan: 'advanced' });
  await world.seedPlace(0, 101, 1, { name: 'Alpha Cafe Reg.Ex (a+', expirationDate: new Date('2029-01-01T00:00:00.000Z'), plan: 'basic', status: false, countryCode: 'DE', countryAreaCode: '', city: 'Berlin' });
  await world.seedPlace(0, 102, 2, { name: 'Mid Bistro', expirationDate: new Date('2029-01-01T00:00:00.000Z'), plan: 'enterprice', countryAreaCode: 'RM', city: 'Roma' });
  await world.seedPlace(0, 103, 2, { name: 'Trashed Pub', trash: true, expirationDate: null, plan: 'professional' });
  await world.seedPlace(0, 104, 2, { name: 'No Date', expirationDate: null, plan: undefined });
  await insertCopies(ctx.databases, 'places', [legacyPlace(105, world.group(0).groupId, C(1), { name: 7, plan: 5, status: 'yes', trash: 'x', city: [], countryCode: 3, countryAreaCode: {}, expirationDate: 'soon' })]);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/places', () => {
  it('lists the untrashed places with the compact reference, the fields of the list and an ETag, and never anything else of the place', async () => {
    const reply = await call(sa(), 'GET', world.placePath(0));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Alpha Cafe Reg.Ex (a+', 'Mid Bistro', 'No Date', 'Zeta Bar', 'place-001', 'place-002']);
    assert.deepEqual(reply.body.data.find((item: { name: string }) => item.name === 'Zeta Bar'), {
      id: hex(P(100)),
      name: 'Zeta Bar',
      companyId: hex(C(1)),
      trashed: false,
      plan: 'advanced',
      status: 'active',
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      expirationDate: '2031-01-01T00:00:00.000Z',
    });
    assert.deepEqual(reply.body.data[0], { id: hex(P(105)), name: '', companyId: hex(C(1)), trashed: false, plan: null, status: 'disabled', city: null, province: null, country: null, expirationDate: null });
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    for (const secret of ['integrations', 'fixture-integration-secret', 'fixture-device-secret', '10.0.0.1', 'connector', 'devices', 'rooms', 'storages', 'general', 'openingTime']) {
      assert.ok(!text.includes(secret), secret);
    }
    const etag = reply.headers.get('etag')!;
    assert.match(etag, /^W\/"/);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const again = await world.office.call('GET', world.placePath(0), await world.as.tokenOf(sa()), undefined, { 'if-none-match': etag });
    assert.equal(again.status, 304);
  });

  it('filters by status, plan, country, province, company, trash and ids', async () => {
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?status=disabled'))), ['', 'Alpha Cafe Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?status=active'))), ['Mid Bistro', 'No Date', 'Zeta Bar', 'place-001', 'place-002']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?plan=basic'))), ['Alpha Cafe Reg.Ex (a+', 'place-001', 'place-002']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?plan=enterprice'))), ['Mid Bistro']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?plan=professional'))), []);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?plan=professional&trashed=true'))), ['Trashed Pub']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?country=DE'))), ['Alpha Cafe Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?country=IT&province=RM'))), ['Mid Bistro', 'place-001', 'place-002']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, `?companyId=${hex(C(2))}`))), ['Mid Bistro', 'No Date', 'place-002']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?trashed=true'))), ['Trashed Pub']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, `?ids=${hex(P(100))},${hex(P(1))}&sort=-name`))), ['place-001', 'Zeta Bar']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, `?status=active&plan=advanced&country=IT&ids=${hex(P(100))},${hex(P(102))}`))), ['Zeta Bar']);
  });

  it('searches the name and the city literally, case-insensitively', async () => {
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?q=reg.ex%20(a%2B'))), ['Alpha Cafe Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?q=BERLIN'))), ['Alpha Cafe Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?q=roma'))), ['Mid Bistro']);
    assert.deepEqual(names(await call(sa(), 'GET', world.placePath(0, '?q=.*'))), []);
  });

  it('sorts by name and by expiration date before the page is cut, with the id as the tie-breaker, and pages without gaps or repeats', async () => {
    const all = (sort: string) => call(sa(), 'GET', world.placePath(0, `?sort=${sort}&limit=200`));
    assert.deepEqual(names(await all('name')), ['', 'Alpha Cafe Reg.Ex (a+', 'Mid Bistro', 'No Date', 'Zeta Bar', 'place-001', 'place-002']);
    assert.deepEqual(names(await all('-name')), ['place-002', 'place-001', 'Zeta Bar', 'No Date', 'Mid Bistro', 'Alpha Cafe Reg.Ex (a+', '']);
    // Places without a date come first ascending, in the order of their ids; the two of 2029 tie and are ordered by id.
    const ascending = await all('expirationDate');
    assert.deepEqual(ascending.body.data.map((item: { expirationDate: string | null }) => item.expirationDate), [null, null, null, null, '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z']);
    assert.deepEqual(names(ascending).slice(4), ['Alpha Cafe Reg.Ex (a+', 'Mid Bistro', 'Zeta Bar']);
    const descending = await all('-expirationDate');
    assert.deepEqual(names(descending).slice(0, 3), ['Zeta Bar', 'Mid Bistro', 'Alpha Cafe Reg.Ex (a+']);
    assert.equal(descending.body.data.at(-1).expirationDate, null);
    for (const sort of ['name', '-name', 'expirationDate', '-expirationDate']) {
      const everything = (await all(sort)).body.data.map((item: { id: string }) => item.id);
      const walked: string[] = [];
      let cursor = '';
      for (let guard = 0; guard < 10; guard++) {
        const page = await call(sa(), 'GET', world.placePath(0, `?sort=${sort}&limit=2${cursor}`));
        assert.equal(page.status, 200);
        walked.push(...page.body.data.map((item: { id: string }) => item.id));
        if (page.body.page.next === null) {
          break;
        }
        cursor = `&cursor=${page.body.page.next as string}`;
      }
      assert.deepEqual(walked, everything, sort);
    }
    // A cursor of another sort is refused.
    const first = await call(sa(), 'GET', world.placePath(0, '?sort=name&limit=1'));
    assert.deepEqual(failure(await call(sa(), 'GET', world.placePath(0, `?sort=-name&limit=1&cursor=${first.body.page.next as string}`))), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'cursor', issue: 'format' }] });
  });

  it('applies the perimeter: a company administrator sees the places of his companies, a place administrator his own', async () => {
    assert.deepEqual(names(await call(world.group(0).ca, 'GET', world.placePath(0))), ['', 'Alpha Cafe Reg.Ex (a+', 'Zeta Bar', 'place-001']);
    assert.deepEqual(names(await call(world.group(0).pa, 'GET', world.placePath(0))), ['place-001']);
    const outside = await call(world.group(0).ca, 'GET', world.placePath(0, `?companyId=${hex(C(2))}`));
    assert.deepEqual([outside.status, outside.body.data], [200, []]);
    assert.deepEqual((await call(world.group(0).pa, 'GET', world.placePath(0, `?ids=${hex(P(100))}`))).body.data, []);
  });

  it('keeps every group to its callers and answers 401 without a session, 422 for a bad query', async () => {
    for (const [actor, index] of [[world.office.cluster.dealerA, 2], [sa(), 1], [world.group(0).pa, 1]] as const) {
      assert.equal(failure(await call(actor, 'GET', world.placePath(index))).status, 404);
    }
    assert.deepEqual(names(await call(world.office.cluster.dealerA, 'GET', world.placePath(1))), ['place-003', 'place-004']);
    assert.equal((await world.office.call('GET', world.placePath(0), undefined)).status, 401);
    for (const query of ['?status=on', '?plan=a%20b', '?country=it', '?sort=city', '?companyId=nope', '?unknown=1', '?limit=0']) {
      assert.equal(failure(await call(sa(), 'GET', world.placePath(0, query))).status, 422, query);
    }
  });
});

describe('GET /v1/groups/{groupId}/places/{placeId}', () => {
  const detail = (actor: ObjectId, id: ObjectId, index = 0) => call(actor, 'GET', world.placePath(index, `/${hex(id)}`));

  it('returns the whole representation with a strong ETag that is the version of the stored document', async () => {
    const reply = await detail(sa(), P(100));
    assert.equal(reply.status, 200);
    const document = (await world.storedPlace(0, P(100)))!;
    assert.equal(reply.headers.get('etag'), `"${versionOf('places', document, TEST_VERSION_KEY)}"`);
    const place = reply.body.data;
    assert.deepEqual(Object.keys(place), ['id', 'groupId', 'name', 'companyId', 'address', 'contactName', 'email', 'phone', 'priceListId', 'ecommercePriceListId', 'invoiceSeries', 'priceLists', 'trashed', 'createdAt', 'updatedAt', 'license', 'openingHours', 'cashSettings', 'printing', 'payments', 'tables', 'reservations', 'delivery', 'selfOrdering', 'kiosk', 'appointments', 'externalDisplay', 'fidelity', 'tobacco', 'media', 'integrations', 'devices', 'printStations', 'rooms', 'storages']);
    assert.deepEqual([place.id, place.groupId, place.name, place.companyId, place.priceListId, place.ecommercePriceListId, place.invoiceSeries, place.trashed], [hex(P(100)), hex(world.group(0).groupId), 'Zeta Bar', hex(C(1)), PRICE_LIST, null, 'FE', false]);
    assert.deepEqual(place.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    assert.deepEqual([place.contactName, place.email, place.phone], ['Mario Rossi', 'bar@example.test', '+39 02 1234567']);
    assert.deepEqual(place.priceLists, [{ id: PRICE_LIST, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }]);
    assert.deepEqual(place.license, { plan: 'advanced', expirationDate: '2031-01-01T00:00:00.000Z', status: 'active' });
    assert.equal(place.openingHours.timezone, 'Europe/Rome');
    assert.deepEqual(place.openingHours.week['1'], { active: true, values: [SLOT] });
    assert.deepEqual(place.openingHours.special, { '2026-12-25': { closed: true, values: [] } });
    assert.deepEqual(Object.keys(place.openingHours.deliveryTime), ['week', 'special']);
    assert.deepEqual([place.createdAt, place.updatedAt], ['2024-01-15T10:00:00.000Z', '2024-01-15T10:00:00.000Z']);
  });

  it('never returns a credential, what the POS writes in an item, the dealer settings to a group administrator or a key the backend does not know', async () => {
    const reply = await detail(sa(), P(100));
    const text = JSON.stringify(reply.body);
    for (const hidden of ['fixture-integration-secret', 'fixture-device-secret', 'fixture-user', '10.0.0.1', 'connector.fixture', 'dealerSettings', '"info"', '"battery"', 'futureBlock', 'unknownGeneral', 'legacyOddKey', '"apiKey"', '"automaticCashPassword"', '"automaticCashUsername"', '"password"', '__index']) {
      assert.ok(!text.includes(hidden), hidden);
    }
    // What it has instead: whether each credential is set.
    assert.deepEqual([reply.body.data.integrations.dojo.apiKeySet, reply.body.data.integrations.satispay.keyIdSet, reply.body.data.integrations.floodPay.stripe.privateKeySet], [true, false, false]);
    assert.deepEqual(reply.body.data.devices.items.map((device: Record<string, unknown>) => [device['id'], device['automaticCashUsernameSet'], device['automaticCashPasswordSet']]), [['device1', true, true], ['device2', false, false]]);
    // The dealers see the address of the server of the store and of the connector, and the switch of Sentry.
    const dealer = (await detail(world.office.cluster.dealerA, P(100))).body.data;
    assert.deepEqual(dealer.dealerSettings, { sentry: true, serverIp: '10.0.0.1', connectorAddress: 'http://connector.fixture.example.test' });
    assert.ok(!JSON.stringify(dealer).includes('fixture-integration-secret'));
    for (const other of [world.group(0).ca, world.group(0).pa]) {
      assert.equal((await detail(other, P(1))).body.data.dealerSettings, undefined);
    }
  });

  it('reads a place that the legacy trashed with null registry data, and a damaged one, without failing', async () => {
    const trashed = await detail(sa(), P(103));
    assert.equal(trashed.status, 200);
    assert.equal(trashed.body.data.trashed, true);
    await world.seedPlace(0, 110, 1, { trash: true, address: null, postcode: null, city: null, contact: null, email: null, telephone: null });
    const nulls = (await detail(sa(), P(110))).body.data;
    assert.deepEqual([nulls.address.street, nulls.address.city, nulls.contactName, nulls.email, nulls.phone, nulls.trashed], [null, null, null, null, null, true]);
    // The detail is read from the group database: a place that is only in the copies is not there.
    assert.equal(failure(await detail(sa(), P(105))).status, 404);
    await world.seedPlace(0, 111, 1, { companyId: 'nope', general: null, openingTime: [], platform: 5, delivery: 'x', plan: undefined, status: 'yes', expirationDate: 'soon', invoicePS: 7 });
    const odd = await detail(sa(), P(111));
    assert.equal(odd.status, 200, JSON.stringify(odd.body));
    assert.deepEqual([odd.body.data.companyId, odd.body.data.license, odd.body.data.priceLists, odd.body.data.invoiceSeries], [null, { plan: null, expirationDate: null, status: 'disabled' }, [], null]);
    assert.equal(Object.keys(odd.body.data.openingHours.week).length, 7);
  });

  it('is limited by the perimeter: a company administrator reaches the places of his companies, a place administrator his own, and the rest is 404', async () => {
    assert.equal((await detail(world.group(0).ca, P(100))).status, 200);
    assert.equal(failure(await detail(world.group(0).ca, P(102))).status, 404);
    assert.equal((await detail(world.group(0).pa, P(1))).status, 200);
    assert.equal(failure(await detail(world.group(0).pa, P(100))).status, 404);
    assert.equal((await detail(world.office.cluster.dealerA, P(100))).status, 200);
    assert.equal((await detail(world.office.cluster.psa, P(100))).status, 200);
  });

  it('answers 404 for a place that does not exist, of another group, in another group of the same dealer, or for another dealer; 422 for a malformed id; 401 without a session', async () => {
    assert.equal(failure(await detail(sa(), new ObjectId())).status, 404);
    assert.equal(failure(await detail(sa(), P(3))).status, 404, 'a place of another group through the own group');
    for (const [actor, index] of [[world.group(1).sa, 0], [world.office.cluster.dealerB, 0], [sa(), 1]] as const) {
      assert.equal(failure(await detail(actor, P(100), index)).status, 404);
    }
    assert.equal(failure(await call(sa(), 'GET', world.placePath(0, '/not-an-id'))).status, 422);
    assert.equal((await world.office.call('GET', world.placePath(0, `/${hex(P(100))}`), undefined)).status, 401);
  });
});
