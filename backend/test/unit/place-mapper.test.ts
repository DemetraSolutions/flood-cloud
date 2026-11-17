import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { leafWrites } from '../../src/modules/companies/company.mapper.ts';
import { PLACE_LEAVES, PLACE_SUMMARY_PROJECTION, toPlace, toPlaceSummary } from '../../src/modules/places/place.mapper.ts';
import { DEPRECATED_ROOMS_PATHS, SETTING_FIELDS } from '../../src/shared/legacy-write/place-settings.ts';
import { PLACES_OWNED_FIELDS } from '../../src/db/collections.ts';
import { PRICE_LIST, SLOT, fullLegacyPlace } from '../helpers/place-fixtures.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const GROUP = fixtureId('group', 1);
const COMPANY = fixtureId('company', 1);
const place = (document: Document = fullLegacyPlace(1, GROUP, COMPANY)) => toPlace(document, GROUP);
const CLOSED = { active: false, values: [] };
const closedWeek = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((day) => [day, CLOSED]));

describe('place mapper: reading', () => {
  it('maps the general data of a complete place', () => {
    const read = place();
    assert.equal(read.id, fixtureId('place', 1).toHexString());
    assert.equal(read.groupId, GROUP.toHexString());
    assert.deepEqual(
      [read.name, read.companyId, read.contactName, read.email, read.phone, read.priceListId, read.ecommercePriceListId, read.invoiceSeries, read.trashed],
      ['Bar Roma', COMPANY.toHexString(), 'Mario Rossi', 'bar@example.test', '+39 02 1234567', PRICE_LIST, null, 'FE', false],
    );
    assert.deepEqual(read.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    assert.deepEqual(read.priceLists, [{ id: PRICE_LIST, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }]);
    assert.equal(read.createdAt, '2024-01-15T10:00:00.000Z');
    assert.equal(read.updatedAt, '2024-01-15T10:00:00.000Z');
  });

  it('maps the license: the plan as stored, the date and the state, and the Sentry switch of the dealer settings', () => {
    assert.deepEqual(place().license, { plan: 'advanced', expirationDate: '2030-01-01T00:00:00.000Z', status: 'active' });
    assert.equal(place().dealerSettings!['sentry'], true);
    for (const plan of ['professional', '', 'enterprice', 'tgm-secondary']) {
      assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { plan })).license.plan, plan);
    }
    for (const plan of [undefined, null, 7, true]) {
      assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { plan })).license.plan, null);
    }
    assert.deepEqual(place(fullLegacyPlace(1, GROUP, COMPANY, { status: false, expirationDate: null, platform: { ip: true } })).license, { plan: 'advanced', expirationDate: null, status: 'disabled' });
    // The Sentry switch is in the dealer settings: a historical platform that is not even an object reads as no Sentry.
    assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { platform: 'web' })).dealerSettings!['sentry'], false);
    assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { status: false, platform: { ip: true } })).dealerSettings!['sentry'], false);
  });

  it('maps the opening hours: the zone, the week, the special days and the delivery hours', () => {
    const hours = place().openingHours;
    assert.equal(hours.timezone, 'Europe/Rome');
    assert.deepEqual(Object.keys(hours.week), ['0', '1', '2', '3', '4', '5', '6']);
    assert.deepEqual(hours.week['0'], CLOSED);
    assert.deepEqual(hours.week['1'], { active: true, values: [SLOT] });
    // Only the dates are special days: the legacy key stays in the document and out of the representation.
    assert.deepEqual(hours.special, { '2026-12-25': { closed: true, values: [] } });
    assert.deepEqual(hours.deliveryTime, { week: closedWeek, special: {} });
  });

  it('reads a place that is damaged or trashed by the legacy without failing: nulls, missing blocks, wrong types', () => {
    const trashed = place(fullLegacyPlace(1, GROUP, COMPANY, { trash: true, address: null, postcode: null, city: null, contact: null, email: null, telephone: null }));
    assert.deepEqual(trashed.address, { street: null, postcode: null, city: null, province: 'MI', country: 'IT' });
    assert.deepEqual([trashed.trashed, trashed.contactName, trashed.email, trashed.phone], [true, null, null, null]);
    const bare = place({ _id: fixtureId('place', 2) });
    assert.deepEqual([bare.companyId, bare.name, bare.priceListId, bare.invoiceSeries, bare.priceLists, bare.license.plan, bare.license.status, bare.openingHours.timezone], [null, null, null, null, [], null, 'disabled', null]);
    assert.deepEqual(bare.openingHours.week, closedWeek);
    assert.equal(place({ _id: 'not an id' }).id, '');
    const odd = place({
      _id: fixtureId('place', 3),
      companyId: 'abc',
      invoicePS: true,
      general: { priceLists: [5, { id: 7 }, { id: 'a', allYouCanEat: 'yes', ayceCode1: '', ayceCode2: 5 }] },
      openingTime: {
        weekGeneric: { '0': 'x', '1': { active: 'yes', values: 'no' }, '2': { active: true, values: [5, { start: '09:00' }, { start: 3, end: 4 }, { start: '10:00', end: '12:00', extra: 1 }] } },
        daySpecial: { '2026-01-01': 'closed', '2026-01-02': { closed: 'yes', values: [] }, 'not a date': { closed: true, values: [] } },
      },
      delivery: 'none',
    });
    assert.deepEqual([odd.companyId, odd.invoiceSeries], [null, null]);
    assert.deepEqual(odd.priceLists, [{ id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    assert.deepEqual(odd.openingHours.week['0'], CLOSED);
    assert.deepEqual(odd.openingHours.week['1'], CLOSED);
    assert.deepEqual(odd.openingHours.week['2'], { active: true, values: [{ start: '10:00', end: '12:00' }] });
    assert.deepEqual(odd.openingHours.special, { '2026-01-02': { closed: false, values: [] } });
    assert.deepEqual(odd.openingHours.deliveryTime, { week: closedWeek, special: {} });
    assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { invoicePS: false })).invoiceSeries, false);
    assert.equal(place(fullLegacyPlace(1, GROUP, COMPANY, { invoicePS: '' })).invoiceSeries, null);
  });

  it('never returns what is not part of the representation: a credential, what the POS writes, the keys of a later release and every unknown key', () => {
    const text = JSON.stringify(place());
    for (const hidden of ['fixture-integration-secret', 'fixture-device-secret', 'fixture-user', '"info"', '"status":{', '"battery"', 'futureBlock', 'unknownGeneral', 'legacyOddKey', '__index', '"port"']) {
      assert.ok(!text.includes(hidden), hidden);
    }
    // What the representation has instead of the credentials: whether each is set.
    const shown = place();
    assert.equal(((shown.integrations as Record<string, Record<string, unknown>>)['dojo'] as Record<string, unknown>)['apiKeySet'], true);
    assert.equal(((shown.integrations as Record<string, Record<string, unknown>>)['dojo'] as Record<string, unknown>)['apiKey'], undefined);
    assert.deepEqual(shown.devices.items.map((device) => [device.id, device.automaticCashUsernameSet, device.automaticCashPasswordSet]), [['device1', true, true], ['device2', false, false]]);
    // The address of the server of the store and of the connector are the dealer settings.
    assert.deepEqual(shown.dealerSettings, { sentry: true, serverIp: '10.0.0.1', connectorAddress: 'http://connector.fixture.example.test' });
  });

  it('unwraps the numbers of the exact types the places are read with', () => {
    const document = fullLegacyPlace(1, GROUP, COMPANY, { general: { priceLists: [{ id: 'a', allYouCanEat: true, ayceCode1: '1', ayceCode2: '2' }], chargeDocumentQt: new Int32(3), totalRounding: new Double(0.5) } });
    assert.equal(place(document).priceLists[0]!.ayceCode2, '2');
  });
});

describe('place mapper: the list item', () => {
  it('maps the compact reference and the fields of the list, null for what is missing or of the wrong type', () => {
    const _id = fixtureId('place', 1);
    assert.deepEqual(
      toPlaceSummary({ _id, name: 'P', companyId: COMPANY, trash: false, plan: 'basic', status: true, city: 'Milano', countryAreaCode: 'MI', countryCode: 'IT', expirationDate: new Date('2030-01-01T00:00:00.000Z'), integrations: {} }),
      { id: _id.toHexString(), name: 'P', companyId: COMPANY.toHexString(), trashed: false, trashedAt: null, plan: 'basic', status: 'active', city: 'Milano', province: 'MI', country: 'IT', expirationDate: '2030-01-01T00:00:00.000Z' },
    );
    assert.deepEqual(toPlaceSummary({ _id, name: 5, companyId: 'abc', trash: 'yes', plan: 7, status: 'true', city: 3, countryAreaCode: null, countryCode: undefined, expirationDate: 'soon' }), {
      id: _id.toHexString(),
      name: '',
      companyId: null,
      trashed: false,
      trashedAt: null,
      plan: null,
      status: 'disabled',
      city: null,
      province: null,
      country: null,
      expirationDate: null,
    });
    assert.equal(toPlaceSummary({ _id, trash: true }).trashed, true);
    // The date of the trash: a valid date is an ISO string; anything else (absent, a string, an invalid date) is none.
    assert.equal(toPlaceSummary({ _id, trash: true, trashDate: new Date('2026-11-17T09:30:00.000Z') }).trashedAt, '2026-11-17T09:30:00.000Z');
    for (const junk of [undefined, null, '2026-11-17', 17, new Date('nope')]) {
      assert.equal(toPlaceSummary({ _id, trash: true, trashDate: junk }).trashedAt, null);
    }
    assert.deepEqual(Object.keys(PLACE_SUMMARY_PROJECTION).sort(), ['city', 'companyId', 'countryAreaCode', 'countryCode', 'expirationDate', 'name', 'plan', 'status', 'trash', 'trashDate']);
  });
});

describe('place mapper: the table of keys', () => {
  it('has a leaf for every stored path the backend owns, and only for those', () => {
    const owned = PLACES_OWNED_FIELDS.filter((field) => field !== 'updateDate' && !DEPRECATED_ROOMS_PATHS.includes(field as never));
    const writable = PLACE_LEAVES.filter((leaf) => leaf.readOnly !== true).map((leaf) => leaf.legacy);
    assert.deepEqual([...writable].sort(), owned.filter((field) => field !== 'trash' && field !== 'trashDate').sort());
    // The read-only keys: the state and the dates, the flag of every credential (at the path of the credential) and the list of categories the provider gave.
    assert.deepEqual(
      PLACE_LEAVES.filter((leaf) => leaf.readOnly === true).map((leaf) => leaf.legacy),
      ['trash', 'trashDate', 'insertDate', 'updateDate', ...SETTING_FIELDS.filter((field) => field.readOnly === true).map((field) => field.legacy), 'devices', 'printStations', 'productionCenter', 'rooms', 'storages'],
    );
    // The flags of the lists (whether they can be written) are read only and never written.
    const flags = PLACE_LEAVES.filter((leaf) => leaf.domain.endsWith('ditable') || leaf.domain.endsWith('Editable'));
    assert.equal(flags.length, 5);
    assert.ok(flags.every((leaf) => leaf.readOnly === true && leaf.codec.write(true, undefined) === true));
    // The credentials are write-only leaves: never in a representation.
    const secrets = PLACE_LEAVES.filter((leaf) => leaf.writeOnly === true);
    assert.equal(secrets.length, 17);
    assert.ok(secrets.every((leaf) => leaf.legacy.startsWith('integrations.') && PLACE_LEAVES.some((flag) => flag.legacy === leaf.legacy && flag.domain === `${leaf.domain}Set`)));
    assert.equal(new Set(PLACE_LEAVES.map((leaf) => leaf.domain)).size, PLACE_LEAVES.length);
  });
});

describe('place mapper: choosing the keys to write', () => {
  const current = place();
  const document = fullLegacyPlace(1, GROUP, COMPANY);
  const writes = (request: object, from: typeof current | null = current, stored: Document | null = document) => leafWrites(request, from, stored, PLACE_LEAVES);

  it('writes nothing for a request that sends back what the place has', () => {
    assert.deepEqual(writes(JSON.parse(JSON.stringify(current)) as object), []);
  });

  it('writes only the keys that differ, each on its stored path, in the stored form', () => {
    const result = writes({
      name: 'Bar Milano',
      companyId: fixtureId('company', 2).toHexString(),
      address: { city: 'Roma', province: 'RM' },
      contactName: null,
      priceListId: null,
      invoiceSeries: null,
      license: { plan: 'basic', status: 'disabled', expirationDate: '2031-06-01T00:00:00.000Z' },
      dealerSettings: { sentry: false },
    });
    assert.deepEqual(
      result.map((write) => [write.legacy, write.value]),
      [
        ['name', 'Bar Milano'],
        ['companyId', fixtureId('company', 2)],
        ['city', 'Roma'],
        ['countryAreaCode', 'RM'],
        ['contact', null],
        ['listId', null],
        ['invoicePS', null],
        ['plan', 'basic'],
        ['expirationDate', new Date('2031-06-01T00:00:00.000Z')],
        ['status', false],
        ['platform.sentry', false],
      ],
    );
    assert.ok(result[1]!.value instanceof ObjectId);
  });

  it('writes the price lists with the four keys of the document', () => {
    const [write] = writes({ priceLists: [{ id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: '9' }] });
    assert.deepEqual([write!.legacy, write!.value], ['general.priceLists', [{ id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: '9' }]]);
  });

  it('writes the week with the seven days and keeps the keys of the stored object, and the special days without losing the keys that are not dates', () => {
    const week = { ...closedWeek, '3': { active: true, values: [{ start: '10:00', end: '14:00' }] } } as never;
    const stored = { ...document, openingTime: { weekGeneric: { ...(document['openingTime'] as Document)['weekGeneric'], '8': 'extra' }, daySpecial: (document['openingTime'] as Document)['daySpecial'] } };
    const result = writes({ openingHours: { week, special: { '2027-01-01': { closed: false, values: [{ start: '09:00', end: '12:00' }] } } } }, current, stored);
    const [weekWrite, specialWrite] = result;
    assert.equal(weekWrite!.legacy, 'openingTime.weekGeneric');
    assert.deepEqual(Object.keys(weekWrite!.value as object), ['0', '1', '2', '3', '4', '5', '6', '8']);
    assert.deepEqual((weekWrite!.value as Document)['3'], { active: true, values: [{ start: '10:00', end: '14:00' }] });
    assert.equal((weekWrite!.value as Document)['8'], 'extra');
    assert.equal(specialWrite!.legacy, 'openingTime.daySpecial');
    assert.deepEqual(specialWrite!.value, { legacyOddKey: { keep: true }, '2027-01-01': { closed: false, values: [{ start: '09:00', end: '12:00' }] } });
    // The delivery hours are written the same way, to their own paths, from a document that has none of the stored objects.
    const [delivery] = writes({ openingHours: { deliveryTime: { week } } }, current, { _id: document['_id'] });
    assert.equal(delivery!.legacy, 'delivery.time.weekGeneric');
    assert.deepEqual(Object.keys(delivery!.value as object), ['0', '1', '2', '3', '4', '5', '6']);
    const [onlySpecial] = writes({ openingHours: { deliveryTime: { special: { '2027-02-02': { closed: true, values: [] } } } } }, current, { _id: document['_id'], delivery: 'none' });
    assert.deepEqual([onlySpecial!.legacy, onlySpecial!.value], ['delivery.time.daySpecial', { '2027-02-02': { closed: true, values: [] } }]);
  });

  it('writes every key the creation has, whatever the template holds', () => {
    const result = writes({ name: 'New', license: { status: 'active' } }, null, null);
    assert.deepEqual(
      result.map((write) => write.legacy),
      ['name', 'status'],
    );
  });
});
