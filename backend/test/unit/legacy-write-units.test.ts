import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { BSON, Double, Int32, ObjectId } from 'mongodb';
import { COMPANIES_OWNED_FIELDS, GROUPS_OWNED_FIELDS, GROUPS_PLACES_FIELD, PLACES_OWNED_FIELDS, COLLECTIONS } from '../../src/db/collections.ts';
import { DEFAULT_PLAN, DEFAULT_STORAGE_NAME, DEFAULT_TIMEZONE, companyContainerDefaults, newCompanyDocument, newPlaceDocument, placeContainerDefaults } from '../../src/shared/legacy-write/defaults.ts';
import { CrossClusterWriteError, InvalidWriteInputError, MalformedDocumentError } from '../../src/shared/legacy-write/errors.ts';
import { COMPANY_FIELD_KINDS, PLACE_FIELD_KINDS, checkChanges, checkFields, checkObjectId, requireFields } from '../../src/shared/legacy-write/fields.ts';
import { LIST_PATHS } from '../../src/shared/legacy-write/place-lists.ts';
import { SETTING_LEGACY_PATHS } from '../../src/shared/legacy-write/place-settings.ts';
import { reserveWithGoogleRecord } from '../../src/shared/legacy-write/reserve-with-google.ts';
import { normalizeVatNumber, vatNumberFilter } from '../../src/shared/legacy-write/vat.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

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

  it('owns the lists of items, the integrations and the dealer settings key by key, and never a whole block nor what the POS writes inside an item', () => {
    // The lists of items are owned as arrays (written item by item, over the stored ones); no other block is, and no unknown or unowned key.
    for (const field of ['devices', 'rooms', 'storages', 'printStations', 'productionCenter', 'server.ip', 'connectorAddress', 'platform.sentry']) {
      assert.ok(PLACES_OWNED_FIELDS.includes(field), field);
    }
    for (const field of ['integrations', 'integrations.floodPay', 'integrations.floodPay.stripe', 'server', 'platform', 'platform.ip', 'roomsSettings', 'general', 'ordering', 'receipt', 'openingTime', 'delivery', 'delivery.time', 'devices.info', 'rooms.view', 'groupId', '_id', 'insertDate', 'integrations.tsh.tshCategories', 'integrations.floodOrders']) {
      assert.ok(!PLACES_OWNED_FIELDS.includes(field), field);
    }
    // Every credential is owned once (the flag shares its path) and the keys of the integrations are leaves.
    assert.equal(new Set(PLACES_OWNED_FIELDS).size, PLACES_OWNED_FIELDS.length);
    assert.ok(PLACES_OWNED_FIELDS.filter((field) => field.startsWith('integrations.')).every((field) => field.split('.').length >= 3));
    for (const field of ['plan', 'status', 'expirationDate', 'platform.sentry', 'general.priceLists', 'openingTime.weekGeneric', 'openingTime.daySpecial', 'delivery.time.weekGeneric', 'delivery.time.daySpecial', 'timezone', 'invoicePS', 'listId', 'ecommerceListId', 'companyId', 'integrations.floodPay.stripe.privateKey', 'integrations.reserveWithGoogle.geo.address.country', 'integrations.tsh.categoriesMap']) {
      assert.ok(PLACES_OWNED_FIELDS.includes(field), field);
    }
    assert.equal(PLACES_OWNED_FIELDS.length, 17 + 1 + 5 + SETTING_LEGACY_PATHS.length + LIST_PATHS.length + 1);
    // The blocks are owned key by key, never as a whole: the keys the legacy or a later release adds to them survive.
    for (const field of ['settings', 'settings.global', 'settings.api', 'settings.ecommerce', 'fattura_elettronica', 'medias', 'medias.images', 'groupId', '_id', 'insertDate']) {
      assert.ok(!COMPANIES_OWNED_FIELDS.includes(field), field);
    }
    for (const field of ['invoicesPS', 'invoicesPSValues', 'banks', 'ticketsSuppliers', 'fattura_elettronica.hub', 'settings.global.lastInvoiceNumber', 'settings.api.cerved', 'settings.ecommerce.minAmount', 'medias.images.customersAppLogoDark']) {
      assert.ok(COMPANIES_OWNED_FIELDS.includes(field), field);
    }
    assert.equal(COMPANIES_OWNED_FIELDS.filter((field) => field.startsWith('fattura_elettronica.')).length, 16);
    assert.equal(COMPANIES_OWNED_FIELDS.filter((field) => field.startsWith('settings.global.')).length, 5);
    assert.equal(COMPANIES_OWNED_FIELDS.filter((field) => field.startsWith('settings.ecommerce.')).length, 27);
    assert.equal(COMPANIES_OWNED_FIELDS.filter((field) => field.startsWith('medias.images.')).length, 4);
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
    for (const field of ['integrations', 'integrations.floodOrders', 'integrations.tsh.tshCategories', 'server', 'trash', 'updateDate', 'groupId', '_id', 'unknown', 'toString', '__proto__', 'constructor']) {
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
    assert.deepEqual([company['invoicesPS'], company['invoicesPSValues'], company['ticketsSuppliers'], company['banks']], [null, [], [], []]);
    assert.deepEqual(company['medias'], { images: { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null } });
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

  it('builds one complete template in the form the old backoffice saves, with every block the POS and the legacy read', () => {
    const document = place();
    for (const block of [
      'openingTime', 'platform', 'server', 'connectorAddress', 'general', 'paymentTypes', 'receipt', 'prebilling', 'ordering', 'roomsSettings', 'selfOrdering', 'payments', 'advancedReport', 'appointment',
      'deliveryTakeAway', 'kiosk', 'fidelity', 'tgm', 'delivery', 'externalDisplay', 'integrations', 'medias', 'devices', 'rooms', 'storages', 'printStations', 'productionCenter',
    ]) {
      assert.ok(block in document, block);
    }
    for (const [block, size] of [['general', 31], ['receipt', 26], ['prebilling', 12], ['ordering', 74], ['roomsSettings', 31], ['kiosk', 40], ['deliveryTakeAway', 19], ['delivery', 8], ['appointment', 8], ['selfOrdering', 5], ['payments', 4], ['fidelity', 5], ['tgm', 5], ['externalDisplay', 5]] as const) {
      assert.equal(Object.keys(document[block] as object).length, size, block);
    }
    assert.equal(Object.keys((document['medias'] as { images: object }).images).length, 9);
    assert.deepEqual(
      [document['groupId'], document['companyId'], document['status'], document['plan'], document['trash'], document['expirationDate'], document['insertDate'], document['updateDate'], document['listId'], document['ecommerceListId'], document['invoicePS']],
      [GROUP, COMPANY, true, DEFAULT_PLAN, false, null, NOW, NOW, null, null, null],
    );
    assert.equal(DEFAULT_PLAN, 'basic');
    assert.equal(Object.keys(document).length, 49);
  });

  it('takes the differences between the insert of the legacy and the form of the backoffice from the form: numberFontSize, the non-fiscal taxes, one invoice copy, five exits, the deprecated keys', () => {
    const document = place();
    const ordering = document['ordering'] as Record<string, unknown>;
    assert.deepEqual([ordering['numberFontSize'], 'notesFontSize' in ordering], ['2-1', false]);
    const receipt = document['receipt'] as Record<string, unknown>;
    assert.deepEqual([receipt['noFiscalTaxes'], receipt['noFiscalTaxesTotal'], receipt['invoiceQt']], [false, false, 1]);
    const rooms = document['roomsSettings'] as Record<string, unknown>;
    assert.equal(rooms['exitsNumber'], 5);
    // The deprecated keys are computed from the blocks that replaced them, as the form does.
    assert.deepEqual([rooms['delivery'], rooms['deliveryAutoOrderingTime'], rooms['deliverySendPrebillingOnSave'], rooms['tableGroupName'], rooms['tableGroups']], [false, null, false, false, { status: false, name: false, autoCreateFirst: false, mergeProductsPrint: false }]);
    assert.equal((document['kiosk'] as Record<string, unknown>)['mode'], 'sale');
    assert.deepEqual(document['payments'], { defaultType: 'cash', cheque: false, tickets: false, paymentDiscount: false });
    assert.deepEqual(document['connectorAddress'], '');
    assert.equal(((document['prebilling'] as Record<string, unknown>)['sequentialNumberFontSize']), '1-1');
    assert.deepEqual((document['deliveryTakeAway'] as Record<string, unknown>)['deliveryListId'], '');
  });

  it('has a time zone, seven opening days and seven delivery days, and a reachable cash storage', () => {
    const document = place();
    assert.equal(document['timezone'], DEFAULT_TIMEZONE);
    assert.equal(DEFAULT_TIMEZONE, 'Europe/Rome');
    const weeks = [(document['openingTime'] as { weekGeneric: Record<string, unknown> }).weekGeneric, ((document['delivery'] as { time: { weekGeneric: Record<string, unknown> } }).time).weekGeneric];
    for (const week of weeks) {
      assert.deepEqual(Object.keys(week), ['0', '1', '2', '3', '4', '5', '6']);
      for (const day of Object.values(week)) {
        assert.deepEqual(day, { active: false, values: [] });
      }
    }
    assert.deepEqual([(document['openingTime'] as { daySpecial: unknown }).daySpecial, ((document['delivery'] as { time: { daySpecial: unknown } }).time).daySpecial], [{}, {}]);
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
    const integrations = document['integrations'] as Record<string, Record<string, unknown>>;
    for (const name of ['floodPay', 'bizerba', 'googleMaps', 'reserveWithGoogle', 'easyappear', 'leggimenu', 'yellgo', 'plateform', 'cooperto', 'dojo', 'satispay', 'qodeup', 'tomatoai', 'keenon', 'tsh', 'phlex']) {
      assert.equal(integrations[name]!['status'], false, name);
    }
    assert.deepEqual(Object.keys(integrations['floodPay']!), ['status', 'stripe', 'qrCodePayment', 'tapToPay']);
  });

  it('has no credential: every secret of the integrations is empty', () => {
    const secrets: unknown[] = [];
    const walk = (value: unknown, key: string): void => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.entries(value).forEach(([name, inner]) => walk(inner, name));
      } else if (['apiKey', 'privateKey', 'webhookPrivateKey', 'publicKey', 'appToken', 'password', 'username', 'secret', 'id', 'activationCode', 'keyId', 'storeId', 'structureId', 'propertyId'].includes(key)) {
        secrets.push(value);
      }
    };
    walk(place()['integrations'], 'integrations');
    assert.ok(secrets.length >= 14);
    assert.ok(secrets.every((secret) => secret === null));
  });

  it('does not reproduce the fields the legacy copied by mistake', () => {
    const document = place();
    assert.deepEqual(document['platform'], { sentry: false });
    const reservation = (document['roomsSettings'] as { reservation: Record<string, unknown> }).reservation;
    assert.equal(reservation['suspendedToday'], false);
    assert.equal(reservation['untilHours'], null);
    assert.deepEqual(reservation['webWidget'], { status: false, color: '#000000', brightness: 'light' });
    assert.deepEqual((document['integrations'] as { floodPay: { stripe: unknown } }).floodPay.stripe, { publicKey: null, privateKey: null, webhookPrivateKey: null });
    assert.equal('locationId' in ((document['integrations'] as { plateform: object }).plateform), false);
  });

  it('takes the owned fields from the caller, the dotted ones inside their block, and names the first storage', () => {
    const week = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((day) => [day, { active: true, values: [{ start: '09:00', end: '18:00' }] }]));
    const document = newPlaceDocument(
      new ObjectId(),
      GROUP,
      {
        name: 'Shop',
        companyId: COMPANY,
        timezone: 'Europe/London',
        status: false,
        plan: 'advanced',
        countryCode: 'GB',
        storageName: 'Main',
        expirationDate: new Date('2030-01-01T00:00:00.000Z'),
        'platform.sentry': true,
        'general.priceLists': [{ id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: null }],
        'openingTime.weekGeneric': week,
        'openingTime.daySpecial': { '2026-12-25': { closed: true, values: [] } },
        'delivery.time.weekGeneric': week,
        'delivery.time.daySpecial': {},
      },
      NOW,
    );
    assert.deepEqual([document['timezone'], document['status'], document['countryCode'], document['plan'], document['expirationDate']], ['Europe/London', false, 'GB', 'advanced', new Date('2030-01-01T00:00:00.000Z')]);
    assert.equal((document['storages'] as Array<Record<string, unknown>>)[0]!['name'], 'Main');
    assert.deepEqual(document['platform'], { sentry: true });
    assert.deepEqual((document['general'] as { priceLists: unknown }).priceLists, [{ id: 'a', allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    assert.equal(Object.keys(document['general'] as object).length, 31);
    assert.deepEqual((document['openingTime'] as { weekGeneric: unknown; daySpecial: unknown }), { weekGeneric: week, daySpecial: { '2026-12-25': { closed: true, values: [] } } });
    assert.deepEqual(((document['delivery'] as { time: { weekGeneric: unknown } }).time).weekGeneric, week);
  });

  it('gives the default of every key of a block a write completes', () => {
    assert.deepEqual(placeContainerDefaults('platform'), { sentry: false });
    assert.equal(Object.keys(placeContainerDefaults('general')).length, 31);
    assert.deepEqual(Object.keys(placeContainerDefaults('openingTime')), ['weekGeneric', 'daySpecial']);
    assert.deepEqual(Object.keys(placeContainerDefaults('delivery')), ['time', 'step', 'maxContemporary', 'radius', 'margin', 'minAmount', 'lat', 'lng']);
    assert.deepEqual(Object.keys(placeContainerDefaults('delivery.time')), ['weekGeneric', 'daySpecial']);
    assert.notEqual(placeContainerDefaults('general'), placeContainerDefaults('general'));
  });

  it('shares nothing between two documents and refuses invalid input', () => {
    const a = place();
    const b = place();
    (a['general'] as { logs: boolean }).logs = true;
    assert.equal((b['general'] as { logs: boolean }).logs, false);
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a' } as never, NOW), invalid('companyId'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { companyId: COMPANY } as never, NOW), invalid('name'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, 'devices.x': [] } as never, NOW), invalid('devices.x'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, 'platform.ip': true } as never, NOW), invalid('platform.ip'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, 'openingTime.weekGeneric': { '0': {} } } as never, NOW), invalid('openingTime.weekGeneric'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, storageName: '' }, NOW), invalid('storageName'));
    assert.throws(() => newPlaceDocument(new ObjectId(), GROUP, { name: 'a', companyId: COMPANY, storageName: 3 as never }, NOW), invalid('storageName'));
  });
});

describe('legacy write: version', () => {
  const base = { _id: COMPANY, name: 'a', code: 'x', status: true, trash: false, devices: [1], updateDate: NOW };

  it('is stable and URL safe, and changes with an owned field, its type, its presence or the kind', () => {
    assert.match(versionOf('companies', base, TEST_VERSION_KEY), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(versionOf('companies', base, TEST_VERSION_KEY), versionOf('companies', { ...base }, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', base, TEST_VERSION_KEY), versionOf('companies', { ...base, name: 'b' }, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', base, TEST_VERSION_KEY), versionOf('companies', { ...base, trash: true }, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', base, TEST_VERSION_KEY), versionOf('companies', { ...base, _id: new ObjectId() }, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', { ...base, code: new Double(1) }, TEST_VERSION_KEY), versionOf('companies', { ...base, code: 1 }, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', { ...base, code2: null }, TEST_VERSION_KEY), versionOf('companies', base, TEST_VERSION_KEY));
    assert.notEqual(versionOf('companies', base, TEST_VERSION_KEY), versionOf('places', base, TEST_VERSION_KEY));
  });

  it('does not depend on the parts the service does not own, on updateDate or on the order of the keys', () => {
    const place = { _id: COMPANY, companyId: COMPANY, name: 'a', devices: [{ id: 'd1', name: 'x', info: 1, status: { busy: true } }], rooms: [], integrations: { floodOrders: 1 }, updateDate: NOW };
    const same = versionOf('places', place, TEST_VERSION_KEY);
    // The `info` and the `status` of a device (the POS writes them), the keys of an item nobody owns and the integrations nobody owns are not part of the version.
    assert.equal(versionOf('places', { ...place, devices: [{ id: 'd1', name: 'x', info: 2, status: { busy: false }, unknownKey: 1 }], integrations: {}, unknown: 1, updateDate: new Date() }, TEST_VERSION_KEY), same);
    assert.equal(versionOf('places', { updateDate: NOW, integrations: { floodOrders: 1 }, rooms: [], devices: [{ status: 1, info: 1, name: 'x', id: 'd1' }], name: 'a', companyId: COMPANY, _id: COMPANY }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, companyId: new ObjectId() }, TEST_VERSION_KEY), same);
    // What the backend owns of a device is.
    assert.notEqual(versionOf('places', { ...place, devices: [{ id: 'd1', name: 'y' }] }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, devices: [{ id: 'd2', name: 'x' }] }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, devices: [] }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, devices: 'broken' }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, devices: [7] }, TEST_VERSION_KEY), same);
    // The rooms are hashed whole: a write of the POS to them changes the version, whatever key it writes.
    assert.notEqual(versionOf('places', { ...place, rooms: [{ id: 'r', view: { subtables: { 'a-1': { x: 1 } } } }] }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, rooms: [{ tables: [] }] }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('places', { ...place, storages: [{ id: 's1', name: 'x', cash: true, ecommerce: false, unknownKey: 1 }] }, TEST_VERSION_KEY), versionOf('places', { ...place, storages: [{ id: 's1', name: 'x', cash: true, ecommerce: false }] }, TEST_VERSION_KEY));
  });
});

describe('legacy write: the key of the version', () => {
  it('signs the version with a secret key: another key gives another version, and a credential or an address cannot be checked without it', () => {
    const place = { _id: COMPANY, companyId: COMPANY, name: 'a', integrations: { dojo: { apiKey: 'fake-secret-1' } }, server: { ip: '10.0.0.1' }, devices: [{ id: 'd', automaticCashPassword: 'fake-pass' }] };
    const other = Buffer.alloc(32, 9);
    const version = versionOf('places', place, TEST_VERSION_KEY);
    assert.notEqual(versionOf('places', place, other), version);
    assert.equal(versionOf('places', place, TEST_VERSION_KEY), version);
    // The version still follows the credential and the address (a concurrent change is a 412)...
    assert.notEqual(versionOf('places', { ...place, integrations: { dojo: { apiKey: 'fake-secret-2' } } }, TEST_VERSION_KEY), version);
    // ...but it is not the plain hash of them: nobody without the key can recompute it to guess the value.
    const plain = createHash('sha256').update(BSON.serialize({ parts: [] })).digest('base64url');
    assert.notEqual(version, plain);
    assert.equal(createHmac('sha256', other).update('x').digest('base64url').length, 43);
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

describe('legacy write: the keys of the blocks of a company', () => {
  const BANK = { id: 'a', name: 'Bank', iban: 'IT60X0542811101000000123456', abi: '', cab: '', bic: '', default: true };
  it('checks every owned key of the blocks by its own kind', () => {
    const ok = {
      invoicesPS: 'suffix',
      invoicesPSValues: [{ name: 'A', cash: true }],
      banks: [BANK],
      ticketsSuppliers: [{ id: 'x', name: 'Y', cuts: [5, null, 7.5] }],
      'fattura_elettronica.hub': '',
      'fattura_elettronica.regime_fiscale': 'RF01',
      'settings.global.enableLoginSignup': true,
      'settings.global.lastInvoiceNumber': 2_147_483_647,
      'settings.api.cerved': false,
      'settings.ecommerce.status': true,
      'settings.ecommerce.listId': '',
      'settings.ecommerce.minAmount': { EUR: { code: 'EUR', value: 5 }, XXX: 5 },
      'settings.ecommerce.showProductRemainingQuantity': 2.5,
      'medias.images.externalUrl': 'https://example.test/a.png',
      'medias.images.customersAppLogoLight': null,
    };
    assert.deepEqual(checkFields(COMPANY_FIELD_KINDS, ok), ok);
    assert.deepEqual(checkFields(COMPANY_FIELD_KINDS, { invoicesPS: null, 'settings.global.lastInvoiceNumber': null, banks: [], ticketsSuppliers: [], invoicesPSValues: [] }), { invoicesPS: null, 'settings.global.lastInvoiceNumber': null, banks: [], ticketsSuppliers: [], invoicesPSValues: [] });
  });

  it('refuses a value of the wrong kind for the keys of the blocks, naming the field only', () => {
    const bad: Array<[string, unknown]> = [
      ['invoicesPS', 'middle'],
      ['invoicesPS', true],
      ['invoicesPSValues', {}],
      ['invoicesPSValues', [{ name: 'A' }]],
      ['invoicesPSValues', [{ name: 'A', cash: 'yes' }]],
      ['invoicesPSValues', [{ name: 'A', cash: true, extra: 1 }]],
      ['invoicesPSValues', [null]],
      ['banks', [{ ...BANK, default: 1 }]],
      ['banks', [{ ...BANK, abi: null }]],
      ['banks', 'x'],
      ['ticketsSuppliers', [{ id: 'x', name: 'Y', cuts: 5 }]],
      ['ticketsSuppliers', [{ id: 'x', name: 'Y', cuts: [-1] }]],
      ['ticketsSuppliers', [{ id: 'x', name: 'Y', cuts: ['5'] }]],
      ['ticketsSuppliers', [{ id: 'x', name: 'Y', cuts: [Number.NaN] }]],
      ['fattura_elettronica.hub', null],
      ['fattura_elettronica.rea_numero', 5],
      ['settings.global.lastInvoiceNumber', 2_147_483_648],
      ['settings.global.lastInvoiceNumber', -1],
      ['settings.global.lastInvoiceNumber', 1.5],
      ['settings.global.lastInvoiceNumber', '1'],
      ['settings.global.discountLines', 'true'],
      ['settings.ecommerce.status', 1],
      ['settings.ecommerce.listId', null],
      ['settings.ecommerce.minAmount', []],
      ['settings.ecommerce.minAmount', null],
      ['settings.ecommerce.minAmount', { $set: 1 }],
      ['settings.ecommerce.showProductRemainingQuantity', -1],
      ['settings.ecommerce.showProductRemainingQuantity', Number.POSITIVE_INFINITY],
      ['medias.images.customersAppLogoLight', { _id: 'x' }],
      ['medias.images.externalUrl', null],
    ];
    for (const [field, value] of bad) {
      assert.throws(() => checkFields(COMPANY_FIELD_KINDS, { [field]: value }), invalid(field), field);
    }
    for (const field of ['settings', 'settings.global', 'settings.ecommerce.unknown', 'fattura_elettronica', 'fattura_elettronica.password', 'medias', 'medias.images', 'settings.integrations.x']) {
      assert.throws(() => checkFields(COMPANY_FIELD_KINDS, { [field]: {} }), invalid(field), field);
    }
  });

  it('accepts a logo as null or as the descriptor the legacy Media Manager stores, and nothing else', () => {
    const descriptor = (): Record<string, unknown> => ({
      _id: 'a'.repeat(24),
      dirname: '/media/image',
      basename: 'logo-1a2b3c4d.png',
      extension: 'png',
      filename: 'Logo',
      mimetype: 'image/png',
      filectime: new Double(1_731_490_000_123),
      mmThumb: {},
      type: 'image',
      title: 'Logo',
      alt: 'Logo',
    });
    const field = 'medias.images.customersAppLogoDark';
    assert.deepEqual(checkFields(COMPANY_FIELD_KINDS, { [field]: null }), { [field]: null });
    assert.equal(Object.keys(checkFields(COMPANY_FIELD_KINDS, { [field]: descriptor() })).length, 1);
    assert.equal(Object.keys(checkFields(COMPANY_FIELD_KINDS, { [field]: { ...descriptor(), filectime: 1_731_490_000_123 } })).length, 1, 'a plain number is accepted too');
    const without = (key: string) => Object.fromEntries(Object.entries(descriptor()).filter(([name]) => name !== key));
    const reordered = (() => {
      const { _id, ...rest } = descriptor();
      return { ...rest, _id };
    })();
    const bad: unknown[] = [
      {},
      [],
      'logo.png',
      without('mmThumb'),
      without('alt'),
      { ...descriptor(), extra: 1 },
      reordered,
      { ...descriptor(), _id: 'xyz' },
      { ...descriptor(), _id: 5 },
      { ...descriptor(), _id: 'A'.repeat(24) },
      { ...descriptor(), filectime: '1' },
      { ...descriptor(), filectime: Number.NaN },
      { ...descriptor(), filectime: new Double(Number.POSITIVE_INFINITY) },
      { ...descriptor(), mmThumb: { x: 1 } },
      { ...descriptor(), mmThumb: [] },
      { ...descriptor(), mmThumb: null },
      { ...descriptor(), type: 'video' },
      { ...descriptor(), basename: 5 },
      { ...descriptor(), title: null },
    ];
    for (const value of bad) {
      assert.throws(() => checkFields(COMPANY_FIELD_KINDS, { [field]: value }), invalid(field));
    }
  });

  it('has an error for a stored block that is not an object, with the name of the block only', () => {
    const error = new MalformedDocumentError('settings.global');
    assert.equal(error.name, 'MalformedDocumentError');
    assert.equal(error.path, 'settings.global');
    assert.ok(error instanceof Error);
  });

  it('builds a new company with the keys of the blocks at their place and every sibling default kept', () => {
    const company = newCompanyDocument(
      new ObjectId(),
      GROUP,
      { name: 'Acme', 'fattura_elettronica.hub': 'aruba', 'settings.ecommerce.status': true, 'settings.ecommerce.minAmount': { EUR: { code: 'EUR', value: 5 } }, 'settings.global.lastInvoiceNumber': 7, 'medias.images.externalUrl': 'https://example.test', banks: [{ id: 'b', name: '', iban: 'x', abi: '', cab: '', bic: '', default: false }], invoicesPS: 'prefix', status: false },
      NOW,
    );
    const invoicing = company['fattura_elettronica'] as Record<string, unknown>;
    assert.deepEqual([invoicing['hub'], invoicing['regime_fiscale'], invoicing['codice_eori']], ['aruba', 'RF01', '']);
    const settings = company['settings'] as { global: Record<string, unknown>; ecommerce: Record<string, unknown> };
    assert.deepEqual([settings.ecommerce['status'], settings.ecommerce['listId'], settings.ecommerce['minAmount'], settings.global['lastInvoiceNumber'], settings.global['discountLines']], [true, '', { EUR: { code: 'EUR', value: 5 } }, 7, false]);
    assert.equal(((company['medias'] as { images: Record<string, unknown> }).images)['externalUrl'], 'https://example.test');
    assert.deepEqual([company['invoicesPS'], (company['banks'] as unknown[]).length, company['status'], company['expirationDate']], ['prefix', 1, false, null]);
    assert.equal(Object.keys(settings.ecommerce).length, 27);
  });

  it('gives a fresh copy of the default of a block', () => {
    const first = companyContainerDefaults('settings.ecommerce');
    assert.equal(Object.keys(first).length, 27);
    (first['minAmount'] as Record<string, unknown>)['EUR'] = 1;
    assert.deepEqual(companyContainerDefaults('settings.ecommerce')['minAmount'], {});
    assert.deepEqual(Object.keys(companyContainerDefaults('fattura_elettronica')).length, 16);
    assert.deepEqual(companyContainerDefaults('settings.api'), { cerved: false });
    assert.deepEqual(Object.keys(companyContainerDefaults('settings.global')).length, 5);
    assert.deepEqual(Object.keys(companyContainerDefaults('medias.images')).length, 4);
  });
});

describe('legacy write: version of the keys of the blocks', () => {
  const base = { _id: COMPANY, name: 'a', settings: { global: { lastInvoiceNumber: new Int32(5) }, ecommerce: { status: true } }, fattura_elettronica: { hub: 'aruba' }, banks: [{ id: 'a' }] };
  it('changes with an owned key of a block, its type, its presence and a whole array', () => {
    const same = versionOf('companies', base, TEST_VERSION_KEY);
    assert.equal(versionOf('companies', { ...base }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('companies', { ...base, settings: { ...base.settings, ecommerce: { status: false } } }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('companies', { ...base, settings: { ...base.settings, global: { lastInvoiceNumber: new Double(5) } } }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('companies', { ...base, fattura_elettronica: {} }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('companies', { ...base, banks: [{ id: 'b' }] }, TEST_VERSION_KEY), same);
    // Absent is not null.
    assert.notEqual(versionOf('companies', { ...base, fattura_elettronica: { hub: null } }, TEST_VERSION_KEY), same);
    assert.notEqual(versionOf('companies', { ...base, fattura_elettronica: { hub: null } }, TEST_VERSION_KEY), versionOf('companies', { ...base, fattura_elettronica: {} }, TEST_VERSION_KEY));
  });
  it('does not change with the keys of a block the service does not own, and reads a path through something that is not an object as absent', () => {
    const same = versionOf('companies', base, TEST_VERSION_KEY);
    assert.equal(versionOf('companies', { ...base, settings: { ...base.settings, integrations: { x: 1 }, global: { lastInvoiceNumber: new Int32(5), unknownKey: 1 } }, fattura_elettronica: { hub: 'aruba', extra: 'x' }, other: 1 }, TEST_VERSION_KEY), same);
    const absent = versionOf('companies', { _id: COMPANY, name: 'a' }, TEST_VERSION_KEY);
    for (const settings of [null, 'x', [], { global: null }, { global: 'x' }, { global: [] }]) {
      assert.equal(versionOf('companies', { _id: COMPANY, name: 'a', settings }, TEST_VERSION_KEY), absent, JSON.stringify(settings));
    }
  });
});

describe('legacy write: VAT number normalization', () => {
  it('trims, upper-cases, removes the spaces and drops the IT prefix of eleven digits only', () => {
    assert.equal(normalizeVatNumber(' it 0111 4601 006 '), '01114601006');
    assert.equal(normalizeVatNumber('IT01114601006'), '01114601006');
    assert.equal(normalizeVatNumber('01114601006'), '01114601006');
    assert.equal(normalizeVatNumber('IT0111460100'), 'IT0111460100');
    assert.equal(normalizeVatNumber('ITABCDEFGHIJK'), 'ITABCDEFGHIJK');
    assert.equal(normalizeVatNumber('de 123 456 789'), 'DE123456789');
    assert.equal(normalizeVatNumber('   '), '');
    // Only spaces and tabs are removed, the same two characters the database pattern allows: a Unicode space or an invisible character stays and so never matches.
    assert.equal(normalizeVatNumber('DE\u00A0123'), 'DE\u00A0123');
    assert.equal(normalizeVatNumber('DE\t1 2'), 'DE12');
  });
  it('builds a filter that matches every written form of the number and nothing else', () => {
    const matches = (normalized: string, stored: string): boolean => {
      const { $regex, $options } = (vatNumberFilter(normalized)['code'] as { $regex: string; $options: string });
      return new RegExp($regex, $options).test(stored);
    };
    for (const stored of ['01114601006', 'IT01114601006', ' it 01114601006 ', 'IT 0111 4601 006', '0111 46010 06']) {
      assert.ok(matches('01114601006', stored), stored);
    }
    for (const stored of ['01114601007', 'DE01114601006', '011146010061', '1114601006', '']) {
      assert.equal(matches('01114601006', stored), false, stored);
    }
    assert.ok(matches('DE123456789', 'de 123456789'));
    assert.equal(matches('DE123456789', 'DE\u00A0123456789'), false);
    assert.equal(matches('DE123456789', 'DE\u200B123456789'), false);
    assert.equal(matches('DE123456789', '123456789'), false);
    // Characters of a pattern are literals.
    assert.ok(matches('A.B+C', 'a.b+c'));
    assert.equal(matches('A.B+C', 'aXbbC'), false);
  });
});
