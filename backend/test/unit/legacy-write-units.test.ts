import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import { COMPANIES_OWNED_FIELDS, GROUPS_OWNED_FIELDS, GROUPS_PLACES_FIELD, PLACES_OWNED_FIELDS, COLLECTIONS } from '../../src/db/collections.ts';
import { DEFAULT_STORAGE_NAME, DEFAULT_TIMEZONE, newCompanyDocument, newPlaceDocument } from '../../src/shared/legacy-write/defaults.ts';
import { CrossClusterWriteError, InvalidWriteInputError } from '../../src/shared/legacy-write/errors.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkChanges, checkFields, checkObjectId, requireFields } from '../../src/shared/legacy-write/fields.ts';
import { reserveWithGoogleRecord } from '../../src/shared/legacy-write/reserve-with-google.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';

const GROUP = ObjectId.createFromHexString('0200000000000000000000aa');
const COMPANY = ObjectId.createFromHexString('0300000000000000000000bb');
const NOW = new Date('2026-11-13T10:00:00.000Z');
const invalid = (field: string | null) => (error: unknown) => error instanceof InvalidWriteInputError && error.field === field;

describe('legacy write: registry and allowlists', () => {
  it('derives the updatable fields of both collections from the owned fields of the registry', () => {
    const updatable = (owned: readonly string[]): string[] => owned.filter((field) => field !== 'trash' && field !== 'updateDate').sort();
    assert.deepEqual(Object.keys(COMPANY_FIELD_KINDS).sort(), updatable(COMPANIES_OWNED_FIELDS));
    assert.deepEqual(Object.keys(PLACE_FIELD_KINDS).sort(), updatable(PLACES_OWNED_FIELDS));
    assert.equal(COLLECTIONS.group.companies.ownership, 'legacy-write');
    assert.equal(COLLECTIONS.group.places.ownership, 'legacy-write');
    assert.deepEqual([...COLLECTIONS.group.companies.ownedFields], [...COMPANIES_OWNED_FIELDS]);
    assert.deepEqual([...COLLECTIONS.group.places.ownedFields], [...PLACES_OWNED_FIELDS]);
  });

  it('never owns the blocks of the POS and of the legacy', () => {
    for (const field of ['devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'integrations', 'roomsSettings', 'general', 'ordering', 'openingTime', 'plan', 'groupId', '_id', 'insertDate']) {
      assert.ok(!PLACES_OWNED_FIELDS.includes(field), field);
    }
    for (const field of ['settings', 'fattura_elettronica', 'invoicesPS', 'invoicesPSValues', 'banks', 'ticketsSuppliers', 'medias', 'groupId', '_id', 'insertDate']) {
      assert.ok(!COMPANIES_OWNED_FIELDS.includes(field), field);
    }
  });

  it('registers groups.places and the feed as owned, without letting the management of the group write the list of places', () => {
    assert.ok(COLLECTIONS.common.groups.ownedFields.includes(GROUPS_PLACES_FIELD));
    assert.ok(!GROUPS_OWNED_FIELDS.includes(GROUPS_PLACES_FIELD));
    assert.equal(COLLECTIONS.common.reserve_with_google.ownership, 'legacy-write');
    assert.ok(COLLECTIONS.common.reserve_with_google.ownedFields.includes('geo.address.country'));
  });
});

describe('legacy write: field checks', () => {
  it('accepts valid fields of every kind and returns a new plain object', () => {
    const input = { name: ' x ', code: '', email: null, status: false, expirationDate: NOW };
    const checked = checkFields(COMPANY_FIELD_KINDS, input);
    assert.deepEqual(checked, input);
    assert.notEqual(checked, input);
    assert.deepEqual(checkFields(PLACE_FIELD_KINDS, { companyId: COMPANY, invoicePS: false, listId: 'a', contact: null, expirationDate: null }), { companyId: COMPANY, invoicePS: false, listId: 'a', contact: null, expirationDate: null });
    assert.deepEqual(checkFields(PLACE_FIELD_KINDS, { invoicePS: 'x' }), { invoicePS: 'x' });
    assert.deepEqual(checkFields(PLACE_FIELD_KINDS, { invoicePS: null }), { invoicePS: null });
  });

  it('treats undefined as absent', () => {
    assert.deepEqual(checkFields(COMPANY_FIELD_KINDS, { name: 'a', code: undefined }), { name: 'a' });
  });

  it('rejects what is not an object', () => {
    for (const value of [null, undefined, 'x', 3, [], [1]]) {
      assert.throws(() => checkFields(COMPANY_FIELD_KINDS, value), invalid(null));
    }
  });

  it('rejects fields outside the allowlist, also the ones the POS and the legacy own and the prototype keys', () => {
    for (const field of ['devices', 'integrations', 'storages', 'trash', 'updateDate', 'groupId', '_id', 'unknown', 'toString', '__proto__', 'constructor']) {
      assert.throws(() => checkFields(PLACE_FIELD_KINDS, JSON.parse(`{ "${field}": 1 }`)), invalid(field), field);
    }
    assert.throws(() => checkFields(COMPANY_FIELD_KINDS, { settings: {} }), invalid('settings'));
  });

  it('rejects values of the wrong kind, naming the field and never the value', () => {
    const bad: Array<[string, unknown]> = [
      ['name', ''],
      ['name', '   '],
      ['name', 3],
      ['code', null],
      ['code', 5],
      ['email', 5],
      ['status', 'true'],
      ['status', 1],
      ['expirationDate', '2026-01-01'],
      ['expirationDate', new Date('invalid')],
    ];
    for (const [field, value] of bad) {
      assert.throws(
        () => checkFields(COMPANY_FIELD_KINDS, { [field]: value }),
        (error: unknown) => error instanceof InvalidWriteInputError && error.field === field && (String(value).trim() === '' || !error.message.includes(String(value))),
        field,
      );
    }
    for (const [field, value] of [['companyId', COMPANY.toHexString()], ['companyId', null], ['invoicePS', 1], ['invoicePS', {}], ['listId', 1], ['timezone', null]] as Array<[string, unknown]>) {
      assert.throws(() => checkFields(PLACE_FIELD_KINDS, { [field]: value }), invalid(field), field);
    }
  });

  it('requires at least one field in an update', () => {
    assert.deepEqual(checkChanges(COMPANY_FIELD_KINDS, { name: 'a' }), { name: 'a' });
    assert.throws(() => checkChanges(COMPANY_FIELD_KINDS, {}), invalid(null));
    assert.throws(() => checkChanges(COMPANY_FIELD_KINDS, { name: undefined }), invalid(null));
    assert.throws(() => checkChanges(COMPANY_FIELD_KINDS, null), invalid(null));
  });

  it('requires the creation fields and checks the ids', () => {
    assert.doesNotThrow(() => requireFields({ name: 'a' }, ['name']));
    assert.throws(() => requireFields({}, ['name']), invalid('name'));
    assert.equal(checkObjectId(COMPANY, 'id'), COMPANY);
    for (const value of [COMPANY.toHexString(), null, undefined, {}, 5]) {
      assert.throws(() => checkObjectId(value, 'id'), invalid('id'));
    }
  });

  it('has errors that carry ids and names only', () => {
    const error = new CrossClusterWriteError(GROUP, 'cluster1', 'cluster0');
    assert.equal(error.name, 'CrossClusterWriteError');
    assert.deepEqual([error.groupId, error.groupCluster, error.commonCluster], [GROUP.toHexString(), 'cluster1', 'cluster0']);
    assert.ok(error instanceof Error);
    assert.equal(new InvalidWriteInputError('m').field, null);
  });
});

describe('legacy write: defaults of a new company', () => {
  it('builds the complete structure the legacy reads without checks', () => {
    const id = new ObjectId();
    const company = newCompanyDocument(id, GROUP, { name: 'Acme' }, NOW);
    assert.equal(company['_id'], id);
    assert.equal(company['groupId'], GROUP);
    assert.deepEqual(
      [company['name'], company['code'], company['code2'], company['countryCode'], company['currencyCode'], company['email'], company['telephone']],
      ['Acme', '', '', 'IT', 'EUR', null, null],
    );
    assert.deepEqual([company['status'], company['trash'], company['expirationDate'], company['insertDate'], company['updateDate']], [true, false, null, NOW, NOW]);
    assert.deepEqual([company['invoicesPS'], company['invoicesPSValues'], company['ticketsSuppliers'], company['banks'], company['medias']], [null, [], [], [], {}]);
    const invoicing = company['fattura_elettronica'] as Record<string, unknown>;
    assert.equal(Object.keys(invoicing).length, 16);
    assert.equal(invoicing['regime_fiscale'], 'RF01');
    assert.equal(invoicing['hub'], '');
    const settings = company['settings'] as { global: Record<string, unknown>; api: Record<string, unknown>; ecommerce: Record<string, unknown> };
    assert.deepEqual(Object.keys(settings).sort(), ['api', 'ecommerce', 'global']);
    assert.equal(Object.keys(settings.global).length, 5);
    assert.equal(Object.keys(settings.ecommerce).length, 27);
    assert.equal(settings.global['lastInvoiceNumber'], null);
  });

  it('takes the owned fields from the caller, with the group of the access and a valid expiration date', () => {
    const expiration = new Date('2030-01-01T00:00:00.000Z');
    const company = newCompanyDocument(new ObjectId(), GROUP, { name: 'Acme', code: 'IT123', status: false, expirationDate: expiration, countryCode: 'DE', email: 'a@example.test' }, NOW);
    assert.deepEqual([company['code'], company['status'], company['expirationDate'], company['countryCode'], company['email']], ['IT123', false, expiration, 'DE', 'a@example.test']);
    assert.equal(company['groupId'], GROUP);
  });

  it('shares nothing between two documents', () => {
    const a = newCompanyDocument(new ObjectId(), GROUP, { name: 'A' }, NOW);
    const b = newCompanyDocument(new ObjectId(), GROUP, { name: 'B' }, NOW);
    (a['settings'] as { global: { discountLines: boolean } }).global.discountLines = true;
    assert.equal((b['settings'] as { global: { discountLines: boolean } }).global.discountLines, false);
  });

  it('refuses a missing name, an unknown field and a group given by the input', () => {
    assert.throws(() => newCompanyDocument(new ObjectId(), GROUP, {} as never, NOW), invalid('name'));
    assert.throws(() => newCompanyDocument(new ObjectId(), GROUP, { name: 'a', groupId: new ObjectId() } as never, NOW), invalid('groupId'));
    assert.throws(() => newCompanyDocument(new ObjectId(), GROUP, { name: 'a', settings: {} } as never, NOW), invalid('settings'));
  });
});

describe('legacy write: defaults of a new place', () => {
  const place = (): Record<string, unknown> => newPlaceDocument(new ObjectId(), GROUP, { name: 'Shop', companyId: COMPANY }, NOW);

  it('builds one complete template with every block the POS and the legacy read', () => {
    const document = place();
    for (const block of [
      'openingTime', 'platform', 'server', 'general', 'paymentTypes', 'receipt', 'prebilling', 'ordering', 'roomsSettings', 'selfOrdering', 'advancedReport', 'appointment',
      'deliveryTakeAway', 'delivery', 'externalDisplay', 'integrations', 'medias', 'devices', 'rooms', 'storages', 'printStations', 'productionCenter',
    ]) {
      assert.ok(block in document, block);
    }
    assert.equal(Object.keys(document['general'] as object).length, 31);
    assert.equal(Object.keys(document['receipt'] as object).length, 24);
    assert.equal(Object.keys(document['prebilling'] as object).length, 12);
    assert.equal(Object.keys(document['ordering'] as object).length, 74);
    for (const optional of ['kiosk', 'fidelity', 'tgm', 'payments', 'plan']) {
      assert.ok(!(optional in document), optional);
    }
    assert.deepEqual([document['groupId'], document['companyId'], document['status'], document['trash'], document['expirationDate'], document['insertDate'], document['updateDate']], [GROUP, COMPANY, true, false, null, NOW, NOW]);
  });

  it('has a time zone, seven opening days and a reachable cash storage', () => {
    const document = place();
    assert.equal(document['timezone'], DEFAULT_TIMEZONE);
    assert.equal(DEFAULT_TIMEZONE, 'Europe/Rome');
    const week = (document['openingTime'] as { weekGeneric: Record<string, unknown> }).weekGeneric;
    assert.deepEqual(Object.keys(week), ['0', '1', '2', '3', '4', '5', '6']);
    for (const day of Object.values(week)) {
      assert.deepEqual(day, { active: false, values: [] });
    }
    const storages = document['storages'] as Array<Record<string, unknown>>;
    assert.equal(storages.length, 1);
    assert.ok(storages[0]!['id'] instanceof ObjectId);
    assert.deepEqual([storages[0]!['name'], storages[0]!['cash'], storages[0]!['ecommerce']], [DEFAULT_STORAGE_NAME, true, false]);
    assert.notDeepEqual(place()['storages'], document['storages']);
  });

  it('keeps the legacy readers happy: server, reservations of the integration service, appointments', () => {
    const document = place();
    assert.deepEqual(document['server'], { ip: null });
    const reservation = (document['roomsSettings'] as { reservation: Record<string, Record<string, unknown>> }).reservation;
    for (const key of ['emailNotification', 'email', 'emailConfirmedStatus', 'emailRefusedStatus', 'emailChangeStatus']) {
      assert.equal(reservation[key]!['status'], false, key);
      assert.equal(reservation[key]!['templateId'], null, key);
    }
    assert.equal((document['appointment'] as { email: { templateId: unknown } }).email.templateId, null);
    assert.deepEqual((document['openingTime'] as { daySpecial: unknown }).daySpecial, {});
    const integrations = document['integrations'] as Record<string, Record<string, unknown>>;
    for (const name of ['floodPay', 'bizerba', 'googleMaps', 'reserveWithGoogle', 'easyappear', 'leggimenu', 'yellgo', 'plateform', 'cooperto', 'dojo', 'satispay', 'qodeup', 'tomatoai', 'keenon', 'tsh', 'phlex']) {
      assert.equal(integrations[name]!['status'], false, name);
    }
    assert.deepEqual(Object.keys(integrations['floodPay']!), ['status', 'stripe', 'qrCodePayment', 'tapToPay']);
  });

  it('does not reproduce the fields the legacy copied by mistake', () => {
    const document = place();
    assert.deepEqual(document['platform'], { sentry: false });
    const reservation = (document['roomsSettings'] as { reservation: Record<string, unknown> }).reservation;
    assert.equal(reservation['suspendedToday'], false);
    assert.equal(reservation['untilHours'], null);
    assert.deepEqual(reservation['webWidget'], { status: false, color: '#000000', brightness: 'light' });
    assert.deepEqual((document['integrations'] as { floodPay: { stripe: unknown } }).floodPay.stripe, { publicKey: null, privateKey: null, webhookPrivateKey: null });
  });

  it('takes the owned fields from the caller and names the first storage', () => {
    const document = newPlaceDocument(new ObjectId(), GROUP, { name: 'Shop', companyId: COMPANY, timezone: 'Europe/London', status: false, countryCode: 'GB', storageName: 'Main' }, NOW);
    assert.deepEqual([document['timezone'], document['status'], document['countryCode']], ['Europe/London', false, 'GB']);
    assert.equal((document['storages'] as Array<Record<string, unknown>>)[0]!['name'], 'Main');
  });

  it('shares nothing between two documents and refuses invalid input', () => {
    const a = place();
    const b = place();
    (a['general'] as { logs: boolean }).logs = true;
    assert.equal((b['general'] as { logs: boolean }).logs, false);
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a' } as never, NOW), invalid('companyId'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { companyId: COMPANY } as never, NOW), invalid('name'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, devices: [] } as never, NOW), invalid('devices'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, storageName: '' }, NOW), invalid('storageName'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, storageName: 3 as never }, NOW), invalid('storageName'));
  });
});

describe('legacy write: version', () => {
  const base = { _id: COMPANY, name: 'a', code: 'x', status: true, trash: false, devices: [1], updateDate: NOW };

  it('is stable and URL safe, and changes with an owned field, its type, its presence or the kind', () => {
    assert.match(versionOf('companies', base), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(versionOf('companies', base), versionOf('companies', { ...base }));
    assert.notEqual(versionOf('companies', base), versionOf('companies', { ...base, name: 'b' }));
    assert.notEqual(versionOf('companies', base), versionOf('companies', { ...base, trash: true }));
    assert.notEqual(versionOf('companies', base), versionOf('companies', { ...base, _id: new ObjectId() }));
    assert.notEqual(versionOf('companies', { ...base, code: new Double(1) }), versionOf('companies', { ...base, code: 1 }));
    assert.notEqual(versionOf('companies', { ...base, code2: null }), versionOf('companies', base));
    assert.notEqual(versionOf('companies', base), versionOf('places', base));
  });

  it('does not depend on the parts the service does not own, on updateDate or on the order of the keys', () => {
    const place = { _id: COMPANY, companyId: COMPANY, name: 'a', devices: [{ info: 1 }], rooms: [], integrations: { x: 1 }, updateDate: NOW };
    const same = versionOf('places', place);
    assert.equal(versionOf('places', { ...place, devices: [{ info: 2 }], rooms: [{ tables: [] }], integrations: {}, unknown: 1, updateDate: new Date() }), same);
    assert.equal(versionOf('places', { updateDate: NOW, integrations: { x: 1 }, rooms: [], devices: [{ info: 1 }], name: 'a', companyId: COMPANY, _id: COMPANY }), same);
    assert.notEqual(versionOf('places', { ...place, companyId: new ObjectId() }), same);
  });
});

describe('legacy write: Reserve with Google record', () => {
  const rwg = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: true,
    category: 'restaurant',
    name: 'Shop',
    telephone: '+39000',
    url: 'https://example.test',
    geo: { latitude: 41.9, longitude: 12.5, address: { streetAddress: 'Via 1', locality: 'Roma', postalCode: '00100', country: 'IT' } },
    ...overrides,
  });
  const placeOf = (reserveWithGoogle: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ _id: new ObjectId(), companyId: COMPANY, integrations: { reserveWithGoogle }, ...extra });

  it('builds the record of the legacy from an active and complete integration', () => {
    const place = placeOf(rwg());
    assert.deepEqual(reserveWithGoogleRecord(place, GROUP), {
      groupId: GROUP,
      companyId: COMPANY,
      placeId: place['_id'],
      category: 'restaurant',
      name: 'Shop',
      telephone: '+39000',
      url: 'https://example.test',
      geo: { latitude: 41.9, longitude: 12.5, address: { streetAddress: 'Via 1', locality: 'Roma', postalCode: '00100', country: 'IT' } },
    });
  });

  it('falls back to null for the telephone and the url', () => {
    const record = reserveWithGoogleRecord(placeOf(rwg({ telephone: '', url: undefined })), GROUP)!;
    assert.deepEqual([record['telephone'], record['url']], [null, null]);
  });

  it('gives nothing for no place, an inactive or incomplete integration, a missing block or a company that is not an ObjectId', () => {
    assert.equal(reserveWithGoogleRecord(null, GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ status: false })), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ category: null })), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ name: '' })), GROUP), null);
    for (const [key, value] of [['latitude', 0], ['latitude', null], ['longitude', null]] as const) {
      assert.equal(reserveWithGoogleRecord(placeOf(rwg({ geo: { ...(rwg()['geo'] as object), [key]: value } })), GROUP), null, key);
    }
    for (const key of ['streetAddress', 'locality', 'postalCode', 'country']) {
      const geo = rwg()['geo'] as { address: object };
      assert.equal(reserveWithGoogleRecord(placeOf(rwg({ geo: { ...geo, address: { ...geo.address, [key]: null } } })), GROUP), null, key);
    }
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ geo: { latitude: 1, longitude: 1 } })), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ geo: null })), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg({ geo: 'x' })), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(undefined), GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(null), GROUP), null);
    assert.equal(reserveWithGoogleRecord({ _id: COMPANY, companyId: COMPANY }, GROUP), null);
    assert.equal(reserveWithGoogleRecord({ _id: COMPANY, companyId: COMPANY, integrations: null }, GROUP), null);
    assert.equal(reserveWithGoogleRecord(placeOf(rwg(), { companyId: COMPANY.toHexString() }), GROUP), null);
  });
});
