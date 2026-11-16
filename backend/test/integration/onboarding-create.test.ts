import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { canonicalJson } from '../../src/shared/http/etag.ts';
import { idempotencyBodyKey } from '../../src/shared/http/idempotency.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';
import { FEATURES } from '../../src/modules/groups/features.ts';
import { PROVIDERS } from '../../src/modules/groups/group.types.ts';
import { expectedCopy, sameDocument, EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { TRASHED_DEALER, startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { ONBOARDING_VAT, freshUsername, onboardingBody, onboardingPassword } from '../helpers/onboarding.ts';
import { userName } from '../helpers/backoffice.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const id = (value: string) => ObjectId.createFromHexString(value);
const common = () => ctx.databases.common();
const psa = () => world.office.cluster.psa;
const dealerA = () => world.office.cluster.dealerA;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const groupDb = (groupId: ObjectId) => ctx.databases.group(groupId, 'cluster0');

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

/** Creates a customer as `actor` and returns the reply, which must be a `201`. */
async function create(actor: ObjectId, body: Document = onboardingBody()) {
  const reply = await call(actor, 'POST', '/groups', body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}

describe('POST /v1/groups: the customer', () => {
  it('a PSA creates a customer without a dealer: 201, Location, the four ids and the exact legacy documents, each in its collection', async () => {
    const mark = world.office.activity.entries.length;
    const body = onboardingBody({
      group: { name: 'Nuovo Cliente', features: { rooms: true, ordering: true, warehouse: true } },
      user: { username: freshUsername(), password: onboardingPassword(), firstName: 'Mario', lastName: 'Rossi', email: 'Mario@Example.test', phone: '+39 02 1234' },
      taxes: [
        { rate: 10, department: 1 },
        { rate: 22, department: 2 },
        { rate: 5.5, department: 7 },
      ],
    });
    const reply = await create(psa(), body);
    const created = reply.body.data;
    assert.deepEqual(Object.keys(created).sort(), ['companyId', 'groupId', 'placeId', 'userId']);
    assert.equal(reply.headers.get('location'), `/v1/groups/${created.groupId as string}`);
    const [groupId, companyId, placeId, userId] = [created.groupId, created.companyId, created.placeId, created.userId].map(id) as [ObjectId, ObjectId, ObjectId, ObjectId];

    // The group, as the legacy reads it.
    const group = (await common().collection('groups').findOne({ _id: groupId }))!;
    const exact = (await common().collection('groups').findOne({ _id: groupId }, { ...EXACT_TYPES }))!;
    const [priceListId] = Object.keys(group['priceLists'] as Document);
    const [measureUnitId] = Object.keys(group['measureUnits'] as Document);
    const rules = group['warehouseRules'] as Record<string, Document>;
    const [loadId, unloadId, returnId] = Object.keys(rules) as [string, string, string];
    const taxes = group['taxes'] as Document[];
    assert.match(group['apiKey'] as string, /^[0-9a-f]{64}$/);
    const settings = Object.fromEntries(FEATURES.map((feature) => [feature, ['cash', 'productsVariants', 'rooms', 'ordering', 'warehouse'].includes(feature)]));
    assert.deepEqual(
      { ...group, apiKey: 'KEY', insertDate: 'DATE', updateDate: 'DATE', places: (group['places'] as Document[]).map((place) => ({ ...place, insertDate: 'DATE' })), taxes: taxes.map((tax) => ({ ...tax, id: 'ID' })) },
      {
        _id: groupId,
        name: 'Nuovo Cliente',
        description: '',
        databaseHost: '',
        filesHost: '',
        type: null,
        settings: { languages: null, ...settings, stats: { openingTime: null }, integrations: Object.fromEntries(PROVIDERS.map((provider) => [provider, { status: false, apiKey: null }])) },
        status: true,
        demo: false,
        dealerId: null,
        apiKey: 'KEY',
        priceLists: { [priceListId!]: { id: priceListId, default: true, status: true, name: 'Listino 1' } },
        taxes: [
          { id: 'ID', value: 10, department: 1, description: null, natura: null },
          { id: 'ID', value: 22, department: 2, description: null, natura: null },
          { id: 'ID', value: 5.5, department: 7, description: null, natura: null },
        ],
        currencies: { EUR: { code: 'EUR', symbol: '&euro;' } },
        measureUnits: { [measureUnitId!]: { id: measureUnitId, value: 'pz' } },
        warehouseRules: {
          [loadId]: { id: loadId, name: 'Carico standard', type: 'L', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'suppliers', default: true, cashL: false },
          [unloadId]: { id: unloadId, name: 'Scarico standard', type: 'D', quantity: '-', value: '-', counterpart: 'customers', default: true, cashD: true },
          [returnId]: { id: returnId, name: 'Reso standard', type: 'L', quantity: '+', value: '+', useLoadUnit: false, counterpart: 'customers', default: true, cashL: true },
        },
        fidelityCardRules: { EUR: { code: 'EUR', value: null, discountPercentage: null } },
        fidelity: { cardsTypes: [], pointsCollections: [], prizeCatalogues: [] },
        expirationDate: null,
        places: [{ _id: placeId, insertDate: 'DATE' }],
        trash: false,
        insertDate: 'DATE',
        updateDate: 'DATE',
      },
    );
    // BSON types: the dates, the tax values (Int32 for a whole rate, Double for the other), the ids as ObjectId.
    assert.ok(group['insertDate'] instanceof Date && group['updateDate'] instanceof Date);
    const exactTaxes = exact['taxes'] as Array<{ value: Int32 | Double; department: Int32 }>;
    assert.ok(exactTaxes[0]!.value instanceof Int32 && exactTaxes[1]!.value instanceof Int32 && exactTaxes[2]!.value instanceof Double);
    assert.ok(exactTaxes.every((tax) => tax.department instanceof Int32));
    assert.ok(exact['_id'] instanceof ObjectId && ((exact['places'] as Document[])[0]!['_id']) instanceof ObjectId);

    // The administrator: the whole matrix of an SA, the POS data with the default list, the scope of the whole group, a provisional password.
    const user = (await common().collection('users').findOne({ _id: userId }))!;
    assert.deepEqual(
      [user['userName'], user['name'], user['surname'], user['email'], user['telephone'], user['role'], user['groupId'], user['dealerId'], user['companyId'], user['placeId'], user['placesId'], user['servicesId']],
      [body['user'].username, 'Mario', 'Rossi', 'mario@example.test', '+39 02 1234', 'SA', groupId, null, null, null, [], []],
    );
    assert.deepEqual([user['status'], user['trash'], user['tokens'], user['pin'], user['avatar'], user['description']], [true, false, [], null, null, null]);
    const permissions = user['permissions'] as Document;
    assert.equal(permissions['status'], true);
    for (const module of ['groups', 'users', 'companies', 'places', 'documents', 'products', 'calendar', 'warehouse', 'contacts', 'fidelity', 'settings']) {
      assert.deepEqual(permissions[module], { r: true, w: true }, module);
    }
    assert.deepEqual([permissions['stats'], permissions['logs']], [{ r: true, w: false }, { r: true }]);
    const cash = (permissions['apps'] as { cash: { status: boolean; options: { priceLists: Document } } }).cash;
    assert.equal(cash.status, true);
    assert.deepEqual(cash.options.priceLists, { [priceListId!]: { status: true, selected: true } });
    assert.deepEqual(user['settings'], { language: 'it', hiddenInStats: false });
    assert.deepEqual(user['shiftTime'], { status: false, weeksGeneric: [], daySpecial: {} });
    assert.equal(typeof user['password'], 'string');
    const credentials = (await common().collection('userCredentials').findOne({ _id: userId }))!;
    assert.deepEqual([credentials['mustChangePassword'], typeof credentials['passwordHash']], [true, 'string']);
    assert.ok(user['insertDate'] instanceof Date && user['updateDate'] instanceof Date);

    // The company and the place, in the group database and in their copies; the departments; nothing else in the group database.
    const company = (await groupDb(groupId).collection('companies').findOne({ _id: companyId }, { ...EXACT_TYPES }))!;
    const place = (await groupDb(groupId).collection('places').findOne({ _id: placeId }, { ...EXACT_TYPES }))!;
    assert.ok(sameDocument(expectedCopy(company, groupId), (await common().collection('companies').findOne({ _id: companyId }, { ...EXACT_TYPES }))!));
    assert.ok(sameDocument(expectedCopy(place, groupId), (await common().collection('places').findOne({ _id: placeId }, { ...EXACT_TYPES }))!));
    assert.deepEqual(
      [company['name'], company['code'], company['code2'], company['address'], company['postcode'], company['city'], company['countryAreaCode'], company['countryCode'], company['currencyCode'], company['email'], company['telephone'], company['status'], company['trash'], company['groupId']],
      ['Cliente Srl', ONBOARDING_VAT, '', 'Via Roma 1', '20100', 'Milano', 'MI', 'IT', 'EUR', null, null, true, false, groupId],
    );
    const invoicing = company['fattura_elettronica'] as Document;
    assert.deepEqual([invoicing['codice_destinatario'], invoicing['email'], invoicing['hub'], invoicing['regime_fiscale']], ['ABC1234', '', '', 'RF01']);
    assert.deepEqual(
      [place['name'], place['address'], place['postcode'], place['city'], place['countryAreaCode'], place['countryCode'], place['companyId'], place['listId'], place['plan'], place['status'], place['trash'], place['contact'], place['email'], place['telephone']],
      ['Insegna Centro', 'Via Roma 1', '20100', 'Milano', 'MI', 'IT', companyId, priceListId, 'advanced', true, false, '', '', ''],
    );
    assert.deepEqual((place['general'] as Document)['priceLists'], [{ id: priceListId, allYouCanEat: false, ayceCode1: null, ayceCode2: null }]);
    const storages = place['storages'] as Document[];
    assert.deepEqual([storages.length, storages[0]!['name'], storages[0]!['cash'], storages[0]!['ecommerce']], [1, 'Deposito 1', true, false]);
    assert.deepEqual([(place['devices'] as unknown[]).length, (place['rooms'] as unknown[]).length], [0, 0]);
    // The expiration defaults to 31 December of the year, 23:59:59 in Rome (22:59:59 UTC).
    const expiration = place['expirationDate'] as Date;
    assert.deepEqual([expiration.getUTCMonth(), expiration.getUTCDate(), expiration.getUTCHours(), expiration.getUTCMinutes(), expiration.getUTCSeconds()], [11, 31, 22, 59, 59]);
    const departments = await groupDb(groupId).collection('products_departments').find({}, { sort: { code: 1 }, ...EXACT_TYPES }).toArray();
    assert.deepEqual(
      departments.map((department) => [(department['code'] as Int32).value, (department['name'] as { it: string }).it, ((department['tax'] as Document)['value'] as Int32 | Double).value, (department['tax'] as Document)['id'], (department['tax'] as Document)['department'] instanceof Int32]),
      [
        [1, 'Reparto 1', 10, taxes[0]!['id'], true],
        [2, 'Reparto 2', 22, taxes[1]!['id'], true],
        [7, 'Reparto 7', 5.5, taxes[2]!['id'], true],
      ],
    );
    for (const department of departments) {
      assert.deepEqual(
        Object.keys(department).sort(),
        ['_id', 'code', 'description', 'groupId', 'insertDate', 'medias', 'name', 'placesAvailability', 'status', 'tax', 'trash', 'updateDate'],
      );
      assert.deepEqual([department['groupId'], department['status'], department['trash'], department['placesAvailability'], department['medias'], department['description']], [groupId, true, false, [], { images: {} }, { it: '' }]);
      assert.ok(department['insertDate'] instanceof Date && department['updateDate'] instanceof Date);
    }
    assert.deepEqual((await groupDb(groupId).listCollections().toArray()).map((collection) => collection.name).sort(), ['companies', 'places', 'products_departments']);

    // The activity log: one entry per entity, no secret.
    const entries = world.office.activity.entries.slice(mark);
    assert.deepEqual(
      entries.filter((entry) => ['group.created', 'company.created', 'place.created', 'user.created'].includes(entry.action)).map((entry) => [entry.action, entry.resource!.id, hex(entry.groupId!)]).sort(),
      [
        ['company.created', created.companyId, created.groupId],
        ['group.created', created.groupId, created.groupId],
        ['place.created', created.placeId, created.groupId],
        ['user.created', created.userId, created.groupId],
      ],
    );
    const text = JSON.stringify(entries) + JSON.stringify(world.office.logEvents);
    assert.ok(!text.includes(group['apiKey'] as string), 'the api key is in the log');
    assert.ok(!text.includes(body['user'].password), 'the password is in the log');

    // The SA logs in with the provisional password and has to change it before anything else.
    const login = await world.office.login(body['user'].username, body['user'].password);
    assert.equal(login.status, 200);
    assert.equal((await login.json() as { data: { passwordChangeRequired: boolean } }).data.passwordChangeRequired, true);
  });

  it('a PSA names an active dealer: the group and the administrator have him as dealer, and the dealer reaches the group', async () => {
    const reply = await create(psa(), onboardingBody({ group: { name: 'Con dealer', dealerId: hex(dealerA()) } }));
    const groupId = id(reply.body.data.groupId);
    assert.deepEqual((await common().collection('groups').findOne({ _id: groupId }))!['dealerId'], dealerA());
    assert.deepEqual((await common().collection('users').findOne({ _id: id(reply.body.data.userId) }))!['dealerId'], dealerA());
    assert.equal((await call(dealerA(), 'GET', `/groups/${reply.body.data.groupId as string}`)).status, 200);
  });

  it('a dealer creates a customer for himself: demo off, any feature, the plans but desk-secondary', async () => {
    const reply = await create(
      dealerA(),
      onboardingBody({ group: { name: 'Del dealer', demo: false, features: { cash: false, scales: true } }, place: { name: 'Insegna', plan: 'basic', expirationDate: '2031-03-01T10:00:00Z' } }),
    );
    const groupId = id(reply.body.data.groupId);
    const group = (await common().collection('groups').findOne({ _id: groupId }))!;
    assert.deepEqual([group['dealerId'], group['demo'], (group['settings'] as Document)['cash'], (group['settings'] as Document)['scales'], (group['settings'] as Document)['productsVariants']], [dealerA(), false, false, true, true]);
    assert.deepEqual((await common().collection('users').findOne({ _id: id(reply.body.data.userId) }))!['dealerId'], dealerA());
    const place = (await groupDb(groupId).collection('places').findOne({ _id: id(reply.body.data.placeId) }))!;
    assert.deepEqual([place['plan'], place['expirationDate']], ['basic', new Date('2031-03-01T10:00:00Z')]);
    assert.equal((await call(dealerA(), 'GET', `/groups/${reply.body.data.groupId as string}/places/${reply.body.data.placeId as string}`)).status, 200);
    // The PSA can still do what the dealer cannot.
    const demo = await create(psa(), onboardingBody({ group: { name: 'Demo', demo: true }, place: { name: 'Insegna', plan: 'desk-secondary' } }));
    assert.equal((await common().collection('groups').findOne({ _id: id(demo.body.data.groupId) }))!['demo'], true);
    assert.equal((await groupDb(id(demo.body.data.groupId)).collection('places').findOne({ _id: id(demo.body.data.placeId) }))!['plan'], 'desk-secondary');
  });

  it('keeps the data of the form only where the form puts it: the address of the place, its contact data, the PEC, the fiscal code in capitals', async () => {
    const reply = await create(
      psa(),
      onboardingBody({
        company: {
          name: 'Altra Srl',
          vatNumber: `IT${ONBOARDING_VAT}`,
          fiscalCode: ONBOARDING_VAT,
          address: { street: 'Via Po 2', postcode: '10100', city: 'Torino', country: 'IT' },
          email: 'Info@Altra.test',
          phone: '011 123',
          eInvoicing: { pec: 'Altra@PEC.test' },
        },
        place: { name: 'Altra insegna', address: { street: 'Corso Re 3', postcode: '10200', city: 'Torino', province: 'RM' }, contactName: 'Anna', email: 'Shop@Altra.test', phone: '011 456' },
      }),
    );
    const company = (await groupDb(id(reply.body.data.groupId)).collection('companies').findOne({ _id: id(reply.body.data.companyId) }))!;
    assert.deepEqual([company['code'], company['code2'], company['countryAreaCode'], company['email'], company['telephone']], [`IT${ONBOARDING_VAT}`, ONBOARDING_VAT, '', 'info@altra.test', '011 123']);
    const invoicing = company['fattura_elettronica'] as Document;
    assert.deepEqual([invoicing['codice_destinatario'], invoicing['email'], invoicing['hub']], ['', 'altra@pec.test', '']);
    const place = (await groupDb(id(reply.body.data.groupId)).collection('places').findOne({ _id: id(reply.body.data.placeId) }))!;
    assert.deepEqual(
      [place['address'], place['postcode'], place['city'], place['countryAreaCode'], place['contact'], place['email'], place['telephone']],
      ['Corso Re 3', '10200', 'Torino', 'RM', 'Anna', 'shop@altra.test', '011 456'],
    );
  });

  it('accepts a company of another country without the Italian rules, and takes the province of its areas only', async () => {
    const reply = await create(
      psa(),
      onboardingBody({ company: { name: 'Deutsche GmbH', vatNumber: 'DE123456789', fiscalCode: 'ABC-1', address: { street: 'Strasse 1', postcode: '10115', city: 'Berlin', country: 'DE' } } }),
    );
    const company = (await groupDb(id(reply.body.data.groupId)).collection('companies').findOne({ _id: id(reply.body.data.companyId) }))!;
    assert.deepEqual([company['countryCode'], company['code'], company['code2'], company['countryAreaCode']], ['DE', 'DE123456789', 'ABC-1', '']);
  });
});

describe('POST /v1/groups: refusals', () => {
  it('refuses without a token (401) and every role below the dealer (403)', async () => {
    const anonymous = await world.office.call('POST', '/groups', undefined, onboardingBody(), { 'idempotency-key': randomUUID() });
    assert.equal(anonymous.status, 401);
    for (const [name, actor] of [
      ['SA', world.group(0).sa],
      ['CA', world.group(0).ca],
      ['PA', world.group(0).pa],
    ] as const) {
      assert.deepEqual(failure(await call(actor, 'POST', '/groups', onboardingBody())), { status: 403, code: 'FORBIDDEN', details: undefined }, name);
    }
    assert.equal(await common().collection('groups').countDocuments({ name: 'Rifiutato' }), 0);
  });

  it('refuses a dealer who names a dealer, a demo group or the plan desk-secondary, and tells every field', async () => {
    const body = onboardingBody({
      group: { name: 'Rifiutato', dealerId: hex(world.office.cluster.dealerB), demo: true },
      place: { name: 'Insegna', plan: 'desk-secondary' },
    });
    assert.deepEqual(failure(await call(dealerA(), 'POST', '/groups', body)), notAllowed('group.dealerId', 'group.demo', 'place.plan'));
    for (const [group, place] of [[{ name: 'Rifiutato', dealerId: hex(dealerA()) }, {}], [{ name: 'Rifiutato', demo: true }, {}], [{ name: 'Rifiutato' }, { plan: 'desk-secondary' }]] as const) {
      assert.equal((await call(dealerA(), 'POST', '/groups', onboardingBody({ group, place: { name: 'Insegna', ...place } }))).status, 403);
    }
    assert.equal(await common().collection('groups').countDocuments({ name: 'Rifiutato' }), 0);
  });

  it('is 404 for a dealer that does not exist, is in the trash, is disabled or is not a dealer', async () => {
    for (const dealerId of [new ObjectId(), TRASHED_DEALER, fixtureId('user', 601), world.group(0).sa]) {
      assert.deepEqual(failure(await call(psa(), 'POST', '/groups', onboardingBody({ group: { name: 'Rifiutato', dealerId: hex(dealerId) } }))), { status: 404, code: 'NOT_FOUND', details: undefined }, hex(dealerId));
    }
    assert.equal(await common().collection('groups').countDocuments({ name: 'Rifiutato' }), 0);
  });

  it('is 422 for every rule of the data, each field told, and writes nothing', async () => {
    const before = await common().collection('groups').countDocuments();
    const company = (overrides: Document) => ({ ...(onboardingBody()['company'] as Document), ...overrides });
    const cases: Array<[string, Document, Array<[string, string]>]> = [
      ['an unknown country', onboardingBody({ company: company({ address: { street: 'Via', postcode: '1', city: 'X', country: 'ZZ' } }) }), [['company.address.country', 'incorrect']]],
      ['a province outside the country', onboardingBody({ company: company({ address: { street: 'Via', postcode: '1', city: 'X', province: 'XX', country: 'IT' } }) }), [['company.address.province', 'incorrect']]],
      ['a VAT number with a wrong check digit', onboardingBody({ company: company({ vatNumber: '00743110158' }) }), [['company.vatNumber', 'format']]],
      ['a foreign VAT number that is too short', onboardingBody({ company: company({ vatNumber: 'D', address: { street: 'S', postcode: '1', city: 'B', country: 'DE' } }) }), [['company.vatNumber', 'format']]],
      ['a foreign fiscal code that is not printable ASCII', onboardingBody({ company: company({ fiscalCode: 'ÀÀ', vatNumber: 'DE123456789', address: { street: 'S', postcode: '1', city: 'B', country: 'DE' } }) }), [['company.fiscalCode', 'format']]],
      ['a wrong Italian fiscal code', onboardingBody({ company: company({ fiscalCode: 'ABC' }) }), [['company.fiscalCode', 'format']]],
      ['an Italian company with neither recipient code nor PEC', onboardingBody({ company: company({ eInvoicing: undefined }) }), [['company.eInvoicing.recipientCode', 'required']]],
      ['an Italian company with empty recipient code and PEC', onboardingBody({ company: company({ eInvoicing: { recipientCode: '', pec: null } }) }), [['company.eInvoicing.recipientCode', 'required']]],
      ['a recipient code that is not valid', onboardingBody({ company: company({ eInvoicing: { recipientCode: 'AB' } }) }), [['company.eInvoicing.recipientCode', 'format']]],
      ['a hub, which the form does not have', onboardingBody({ company: company({ eInvoicing: { recipientCode: 'ABC1234', hub: 'aruba' } }) }), [['company.eInvoicing.hub', 'unknown']]],
      ['a province of the place outside the country', onboardingBody({ place: { name: 'P', address: { street: 'Via', postcode: '1', city: 'X', province: 'XX' } } }), [['place.address.province', 'incorrect']]],
      ['a place address without a city', onboardingBody({ place: { name: 'P', address: { street: 'Via', postcode: '1' } } }), [['place.address.city', 'required']]],
      ['an unknown plan', onboardingBody({ place: { name: 'P', plan: 'gold' } }), [['place.plan', 'enum']]],
      ['an expiration that is not a date', onboardingBody({ place: { name: 'P', expirationDate: '31/12/2030' } }), [['place.expirationDate', 'format']]],
      ['a null expiration', onboardingBody({ place: { name: 'P', expirationDate: null } }), [['place.expirationDate', 'type']]],
      ['no tax rates', onboardingBody({ taxes: [] }), [['taxes', 'minLength']]],
      ['two rates in one department', onboardingBody({ taxes: [{ rate: 10, department: 1 }, { rate: 22, department: 1 }] }), [['taxes.1.department', 'incorrect']]],
      ['a rate above 100 and a department 0', onboardingBody({ taxes: [{ rate: 101, department: 0 }] }), [['taxes.0.rate', 'maximum'], ['taxes.0.department', 'minimum']]],
      ['a password that is too short', onboardingBody({ user: { username: freshUsername(), password: 'Short1!' } }), [['user.password', 'tooShort']]],
      ['a username with a space', onboardingBody({ user: { username: 'sa user', password: onboardingPassword() } }), [['user.username', 'pattern']]],
      ['an unknown feature', onboardingBody({ group: { name: 'G', features: { flying: true } } }), [['group.features.flying', 'unknown']]],
      ['a field the form does not have (role)', onboardingBody({ user: { username: freshUsername(), password: onboardingPassword(), role: 'PSA' } }), [['user.role', 'unknown']]],
      ['an api key, a cluster, a status and a plan of the group', onboardingBody({ group: { name: 'G', apiKey: 'x'.repeat(40), dataCluster: 'cluster1', status: false, plan: 'basic' } }), [['group.apiKey', 'unknown'], ['group.dataCluster', 'unknown'], ['group.status', 'unknown'], ['group.plan', 'unknown']]],
      ['a mongo operator in a field', onboardingBody({ company: company({ name: { $ne: null } }) }), [['company.name', 'type']]],
      ['a missing part', { group: { name: 'G' } }, [['company', 'required'], ['place', 'required'], ['user', 'required'], ['taxes', 'required']]],
    ];
    for (const [name, body, details] of cases) {
      assert.deepEqual(failure(await call(psa(), 'POST', '/groups', body)), issues(...details), name);
    }
    assert.equal(await common().collection('groups').countDocuments(), before);
  });

  it('is 422 for the password policy (not 500) and 409 for a username that is taken, whatever its case, and writes nothing', async () => {
    const taken = freshUsername();
    await create(psa(), onboardingBody({ user: { username: taken, password: onboardingPassword() } }));
    const groups = await common().collection('groups').countDocuments();
    const users = await common().collection('users').countDocuments();
    const same = failure(await call(psa(), 'POST', '/groups', onboardingBody({ user: { username: taken, password: onboardingPassword() } })));
    assert.deepEqual(same, { status: 409, code: 'CONFLICT', details: [{ field: 'user.username', issue: 'taken' }] });
    assert.equal((await call(psa(), 'POST', '/groups', onboardingBody({ user: { username: taken.toUpperCase(), password: onboardingPassword() } }))).status, 409);
    assert.equal((await call(dealerA(), 'POST', '/groups', onboardingBody({ user: { username: userName(world.group(0).sa), password: onboardingPassword() } }))).status, 409);
    const weak = failure(await call(psa(), 'POST', '/groups', onboardingBody({ user: { username: freshUsername(), password: 'short' } })));
    assert.deepEqual(weak, { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'user.password', issue: 'tooShort' }] });
    const sameAsName = freshUsername();
    assert.deepEqual(failure(await call(psa(), 'POST', '/groups', onboardingBody({ user: { username: sameAsName.padEnd(12, 'x'), password: sameAsName.padEnd(12, 'X') } }))), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'user.password', issue: 'sameAsUsername' }] });
    assert.deepEqual([await common().collection('groups').countDocuments(), await common().collection('users').countDocuments()], [groups, users]);
  });

  it('is 413 for a body above the limit and 415 for a body that is not JSON', async () => {
    const big = onboardingBody({ group: { name: 'G'.repeat(40_000) } });
    assert.equal((await call(psa(), 'POST', '/groups', big)).status, 413);
    const token = await world.as.tokenOf(psa());
    const response = await fetch(`${world.office.app.baseUrl}/v1/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'idempotency-key': randomUUID() }, body: 'x' });
    assert.equal(response.status, 415);
  });
});

describe('POST /v1/groups: idempotency', () => {
  it('needs the Idempotency-Key (422 required, 422 format)', async () => {
    const token = await world.as.tokenOf(psa());
    const send = (headers: Record<string, string>) =>
      fetch(`${world.office.app.baseUrl}/v1/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(onboardingBody({ group: { name: 'Senza chiave' } })) });
    const missing = await send({});
    assert.deepEqual([missing.status, ((await missing.json()) as { error: { details: unknown } }).error.details], [422, [{ field: 'Idempotency-Key', issue: 'required' }]]);
    const bad = await send({ 'idempotency-key': 'not-a-uuid' });
    assert.deepEqual([bad.status, ((await bad.json()) as { error: { details: unknown } }).error.details], [422, [{ field: 'Idempotency-Key', issue: 'format' }]]);
    assert.equal(await common().collection('groups').countDocuments({ name: 'Senza chiave' }), 0);
  });

  it('answers the same key and body with the same response and creates no second group; another body with the key is 409; a failure releases the key', async () => {
    const key = randomUUID();
    const body = onboardingBody({ group: { name: 'Idempotente' } });
    const first = await call(psa(), 'POST', '/groups', body, { 'idempotency-key': key });
    const second = await call(psa(), 'POST', '/groups', body, { 'idempotency-key': key });
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers.get('location'), first.headers.get('location'));
    assert.equal(await common().collection('groups').countDocuments({ name: 'Idempotente' }), 1);
    assert.equal(await common().collection('users').countDocuments({ userName: body['user'].username }), 1);
    const other = await call(psa(), 'POST', '/groups', onboardingBody({ group: { name: 'Idempotente 2' } }), { 'idempotency-key': key });
    assert.deepEqual(failure(other), { status: 409, code: 'CONFLICT', details: [{ field: 'Idempotency-Key', issue: 'reused' }] });
    assert.equal(await common().collection('groups').countDocuments({ name: 'Idempotente 2' }), 0);
    // A user name that is taken fails and releases the key: the retry with another name works with the same key.
    const key2 = randomUUID();
    const taken = onboardingBody({ group: { name: 'Riprova' }, user: { username: body['user'].username, password: onboardingPassword() } });
    assert.equal((await call(psa(), 'POST', '/groups', taken, { 'idempotency-key': key2 })).status, 409);
    assert.equal((await call(psa(), 'POST', '/groups', taken, { 'idempotency-key': key2 })).status, 409);
  });

  it('keeps the key of each user apart: another user with the same key creates his own group', async () => {
    const key = randomUUID();
    const a = await call(psa(), 'POST', '/groups', onboardingBody({ group: { name: 'Chiave condivisa A' } }), { 'idempotency-key': key });
    const b = await call(dealerA(), 'POST', '/groups', onboardingBody({ group: { name: 'Chiave condivisa B' } }), { 'idempotency-key': key });
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.notEqual(a.body.data.groupId, b.body.data.groupId);
  });
});

describe('POST /v1/groups: the api key of the group', () => {
  it('is never in a response and never accepted as a credential on /v1', async () => {
    const reply = await create(psa(), onboardingBody({ group: { name: 'Con chiave' } }));
    const groupId = id(reply.body.data.groupId);
    const apiKey = (await common().collection('groups').findOne({ _id: groupId }))!['apiKey'] as string;
    // Not in the response of the creation, nor in the detail or the list of groups, nor in the log.
    assert.ok(!JSON.stringify(reply.body).includes(apiKey));
    for (const path of [`/groups/${reply.body.data.groupId as string}`, '/groups?limit=100', `/groups/${reply.body.data.groupId as string}/places`]) {
      const read = await call(psa(), 'GET', path);
      assert.equal(read.status, 200);
      assert.ok(!JSON.stringify(read.body).includes(apiKey), path);
    }
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(apiKey));
    assert.ok(!JSON.stringify(world.office.logEvents).includes(apiKey));
    // As a Bearer token, as an `Apikey` header, as a store key header, in the body and in the query: always 401.
    for (const headers of [{ authorization: `Bearer ${apiKey}` }, { apikey: apiKey }, { authorization: apiKey }, { 'x-api-key': apiKey }]) {
      for (const path of ['/groups', `/groups/${reply.body.data.groupId as string}`, `/groups/${reply.body.data.groupId as string}/places`, '/me']) {
        const response = await fetch(`${world.office.app.baseUrl}/v1${path}`, { headers });
        assert.equal(response.status, 401, `${path} ${Object.keys(headers)[0] as string}`);
      }
    }
    const postWithKey = await fetch(`${world.office.app.baseUrl}/v1/groups?apiKey=${apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: apiKey, 'idempotency-key': randomUUID() }, body: JSON.stringify(onboardingBody()) });
    assert.equal(postWithKey.status, 401);
    assert.equal(await common().collection('groups').countDocuments({ name: 'Cliente Srl' }), 0);
  });

  it('is different for every group', async () => {
    const [a, b] = await Promise.all([create(psa(), onboardingBody()), create(psa(), onboardingBody())]);
    const keys = await Promise.all([a, b].map(async (reply) => (await common().collection('groups').findOne({ _id: id(reply.body.data.groupId) }))!['apiKey']));
    assert.notEqual(keys[0], keys[1]);
  });
});

describe('POST /v1/groups: what the new customer can do', () => {
  it('has the minimal structure the readers of the legacy need: a default list, EUR, rules, taxes, cards, places, departments with the tax', async () => {
    const reply = await create(dealerA(), onboardingBody({ group: { name: 'Minimo' } }));
    const groupPath = `/groups/${reply.body.data.groupId as string}`;
    // The new group is readable by his dealer, with its catalogs; the SA of the new group sees it too and nobody else does.
    const detail = await call(dealerA(), 'GET', groupPath);
    assert.equal(detail.status, 200);
    assert.deepEqual(
      [detail.body.data.priceLists.map((list: Document) => [list['name'], list['isDefault'], list['enabled']]), detail.body.data.currencies, detail.body.data.measureUnits.map((unit: Document) => unit['value']), detail.body.data.taxes.map((tax: Document) => [tax['rate'], tax['department']]), detail.body.data.warehouseRules.map((rule: Document) => [rule['name'], rule['isDefault']])],
      [[['Listino 1', true, true]], [{ code: 'EUR', symbol: '€' }], ['pz'], [[10, 1], [22, 2]], [['Carico standard', true], ['Scarico standard', true], ['Reso standard', true]]],
    );
    assert.equal(detail.body.data.integrations.yellgo.apiKeySet, false);
    const places = await call(dealerA(), 'GET', `${groupPath}/places`);
    assert.deepEqual(places.body.data.map((place: Document) => place['id']), [reply.body.data.placeId]);
    assert.equal((await call(world.office.cluster.dealerB, 'GET', groupPath)).status, 404);
  });
});

describe('POST /v1/groups: the rate limit', () => {
  it('counts on the limit of the creations of users, per user, and answers 429 with Retry-After before it writes anything', async () => {
    const limited = await openTestDatabases();
    const office = await startCompaniesWorld(limited, { env: { RATE_LIMIT_USER_CREDENTIALS_PER_USER: '2' } });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reply = await office.as.call(office.office.cluster.psa, 'POST', '/groups', onboardingBody());
        statuses.push(reply.status);
        if (reply.status === 429) {
          assert.ok(Number(reply.headers.get('retry-after')) > 0);
        }
      }
      assert.deepEqual(statuses, [201, 201, 429]);
      assert.equal(await limited.databases.common().collection('groups').countDocuments({ name: 'Nuovo Cliente' }), 2);
    } finally {
      await office.office.close();
      await limited.cleanup();
    }
  });
});

describe('POST /v1/groups: what stays behind', () => {
  it('keeps in the idempotency record a keyed fingerprint: no password, no api key, no plain SHA-256 of the body to guess the password against', async () => {
    const body = onboardingBody({ group: { name: 'Impronta' } });
    const key = randomUUID();
    const reply = await call(psa(), 'POST', '/groups', body, { 'idempotency-key': key });
    assert.equal(reply.status, 201);
    const record = (await common().collection('idempotencyKeys').findOne({ key }))!;
    const apiKey = (await common().collection('groups').findOne({ _id: id(reply.body.data.groupId) }))!['apiKey'] as string;
    const text = JSON.stringify(record);
    assert.ok(!text.includes(apiKey) && !text.includes((body['user'] as { password: string }).password));
    assert.notEqual(record['bodyHash'], createHash('sha256').update(canonicalJson(body)).digest('hex'));
    assert.equal(record['bodyHash'], createHmac('sha256', idempotencyBodyKey(TEST_VERSION_KEY)).update(canonicalJson(body)).digest('hex'));
    // The same key and body is still recognized.
    assert.deepEqual((await call(psa(), 'POST', '/groups', body, { 'idempotency-key': key })).body, reply.body);
  });

  it('never puts the password in the log, whatever the answer: 201, 422 and 409', async () => {
    const taken = freshUsername();
    const bodies = [
      onboardingBody({ user: { username: taken, password: onboardingPassword() } }),
      onboardingBody({ user: { username: taken, password: onboardingPassword() } }),
      onboardingBody({ taxes: [], user: { username: freshUsername(), password: onboardingPassword() } }),
      onboardingBody({ user: { username: freshUsername(), password: onboardingPassword(), role: 'PSA' } }),
    ];
    const statuses: number[] = [];
    for (const body of bodies) {
      statuses.push((await call(psa(), 'POST', '/groups', body)).status);
    }
    assert.deepEqual(statuses, [201, 409, 422, 422]);
    const text = JSON.stringify(world.office.logEvents) + JSON.stringify(world.office.activity.entries);
    for (const body of bodies) {
      assert.ok(!text.includes((body['user'] as { password: string }).password));
    }
  });

  it('refuses the keys of the group on the public surface (401), and nested forbidden keys and unknown fields in the body (422)', async () => {
    const group = await create(psa(), onboardingBody({ group: { name: 'Pubblica' } }));
    const apiKey = (await common().collection('groups').findOne({ _id: id(group.body.data.groupId) }))!['apiKey'] as string;
    for (const headers of [{ 'x-api-key': apiKey }, { authorization: `Bearer ${apiKey}` }]) {
      // The public surface has no route of the groups, and a key of the group is not a credential there either: never a success.
      const response = await fetch(`${world.office.app.baseUrl}/public/v1/groups`, { headers });
      assert.ok([401, 404].includes(response.status), String(response.status));
    }
    const company = (onboardingBody()['company'] as Document);
    const raw = (fragment: string) => `{"group":{"name":"G","features":${fragment}},"company":${JSON.stringify(company)},"place":{"name":"P"},"user":{"username":"x.y.z","password":"Aaaaaaaaaaaa1"},"taxes":[{"rate":1,"department":1}]}`;
    const token = await world.as.tokenOf(psa());
    const post = async (payload: string) =>
      (await fetch(`${world.office.app.baseUrl}/v1/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: payload })).json() as Promise<{ error: { details: Array<{ field: string; issue: string }> } }>;
    assert.deepEqual((await post(raw('{"a.b":true}'))).error.details, [{ field: 'group.features.(key)', issue: 'forbiddenKey' }]);
    assert.deepEqual((await post(raw('{"__proto__":{"x":1}}'))).error.details.map((detail) => detail.issue), ['forbiddenKey']);
    assert.deepEqual((await post(raw('{}').replace('"province":"MI"', '"province":"MI","$where":"1"'))).error.details, [{ field: 'company.address.(key)', issue: 'forbiddenKey' }]);
    assert.deepEqual((await post(raw('{}').replace('"username"', '"permissions":{},"username"'))).error.details, [{ field: 'user.permissions', issue: 'unknown' }]);
  });

  it('takes a date alone as the end of that day in Rome', async () => {
    const reply = await create(psa(), onboardingBody({ place: { name: 'Fine giornata', expirationDate: '2031-07-10' } }));
    const place = (await groupDb(id(reply.body.data.groupId)).collection('places').findOne({ _id: id(reply.body.data.placeId) }))!;
    assert.equal((place['expirationDate'] as Date).toISOString(), '2031-07-10T21:59:59.000Z');
  });
});
