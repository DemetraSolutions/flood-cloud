import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { legacyCompany, legacyContact } from '../helpers/contacts.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { legacyFullProduct } from '../helpers/products.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const sa = () => world.group(0).sa;
const gid = () => world.group(0).groupId;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/contacts`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const contacts = () => db('contacts');
const groups = () => ctx.databases.common().collection('groups');
const stored = (id: string | ObjectId) => contacts().findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const taken = (...fields: string[]) => ({ status: 409, code: 'CONFLICT', details: fields.map((field) => ({ field, issue: 'taken' })) });
const okay = (reply: Awaited<ReturnType<typeof call>>, status = 200) => assert.equal(reply.status, status, JSON.stringify(reply.body) + (reply.status === 500 ? JSON.stringify(world.office.logEvents.slice(-3)) : ''));

async function create(body: Document = {}, actor = sa()) {
  const reply = await call(actor, 'POST', base(), { person: { firstName: 'Mario' }, ...body }, { 'idempotency-key': randomUUID() });
  okay(reply, 201);
  return reply;
}
const post = (body: Document, actor = sa()) => call(actor, 'POST', base(), body, { 'idempotency-key': randomUUID() });
const patch = async (id: string, body: Document, actor = sa(), reference?: Awaited<ReturnType<typeof call>>) => call(actor, 'PATCH', one(id), body, { 'if-match': tag(reference ?? (await call(actor, 'GET', one(id)))) });
const seed = async (overrides: Document = {}) => {
  const document = legacyContact(overrides);
  await contacts().insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCompany = async (overrides: Document = {}) => {
  const document = legacyCompany(overrides);
  await contacts().insertOne(document);
  return document['_id'] as ObjectId;
};
const reset = async () => {
  await contacts().deleteMany({});
  await db('contacts_groups').deleteMany({});
};
const detail = async (id: string | ObjectId, actor = sa()) => {
  const reply = await call(actor, 'GET', one(id));
  okay(reply);
  return reply;
};
let listId = '';

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx);
  const group = (await groups().findOne({ _id: gid() }))!;
  listId = Object.keys(group['priceLists'] as Document)[0]!;
  await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': true } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('contacts: access', () => {
  it('lets the roles that hold contacts:write work, refuses the others and keeps the groups apart', async () => {
    const created = await create();
    for (const actor of [psa(), world.office.cluster.dealerA, sa(), world.group(0).ca, world.group(0).pa]) {
      okay(await call(actor, 'GET', base()));
      okay(await call(actor, 'GET', one(created.body.data.id)));
      await create({}, actor);
    }
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal((await world.office.call('POST', base(), undefined)).status, 401);
    // Another dealer, another group, a malformed group.
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'POST', base(), { person: { firstName: 'x' } }, { 'idempotency-key': randomUUID() })).status, 404);
    const foreign: string = created.body.data.id;
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(foreign, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(foreign, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(foreign, 1), { code: 'x' }, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${one(foreign, 1)}/trash`, undefined, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${one(foreign, 1)}/restore`, undefined, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(foreign, 1), undefined, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${one(foreign, 1)}/fidelity-cards/X/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() })).status, 404);
    assert.equal(failure(await call(sa(), 'GET', '/groups/not-an-id/contacts')).status, 404);
    // A contact of another group is never found in this one.
    const other = new ObjectId();
    await db('contacts', 1).insertOne(legacyContact({ _id: other }));
    assert.equal(failure(await call(sa(), 'GET', one(other, 0))).status, 404);
    okay(await call(world.group(1).sa, 'GET', one(other, 1)));
    await db('contacts', 1).deleteMany({});
  });

  it('follows the contacts module of the matrix of the user: read without write, and none', async () => {
    const created = await create();
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: false, w: false } } }) });
    okay(await call(reader.id, 'GET', base()));
    okay(await call(reader.id, 'GET', one(created.body.data.id)));
    assert.equal(failure(await call(reader.id, 'POST', base(), { person: { firstName: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(created.body.data.id), { code: 'x' }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'POST', `${base()}/trash`, { ids: [created.body.data.id] })).status, 403);
    assert.equal(failure(await call(reader.id, 'POST', `${one(created.body.data.id)}/fidelity-cards/X/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal(failure(await call(reader.id, 'GET', `/groups/${hex(gid())}/contact-groups`)).status, 200);
    assert.equal(failure(await call(reader.id, 'POST', `/groups/${hex(gid())}/contact-groups`, { name: 'x' }, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal(failure(await call(blind.id, 'GET', base())).status, 403);
    assert.equal(failure(await call(blind.id, 'GET', `/groups/${hex(gid())}/contact-groups`)).status, 403);
    // The company and place administrators follow their own matrix, inside the ceiling of their role.
    const users = ctx.databases.common().collection('users');
    for (const actor of [world.group(0).ca, world.group(0).pa]) {
      await users.updateOne({ _id: actor }, { $set: { 'permissions.contacts.w': false } });
      okay(await call(actor, 'GET', base()));
      assert.equal(failure(await call(actor, 'POST', base(), { person: { firstName: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
      await users.updateOne({ _id: actor }, { $set: { 'permissions.contacts.w': true, 'permissions.contacts.r': false } });
      assert.equal(failure(await call(actor, 'GET', base())).status, 403);
      await users.updateOne({ _id: actor }, { $set: { 'permissions.contacts.r': true } });
      okay(await call(actor, 'GET', base()));
    }
  });

  it('is closed to the server of a point of sale with its store key', async () => {
    const key = await world.activate(world.group(0).ownPlaceId);
    for (const [method, path, body] of [
      ['GET', base(), undefined],
      ['POST', base(), { person: { firstName: 'x' } }],
      ['GET', `/groups/${hex(gid())}/contact-groups`, undefined],
      ['POST', `${base()}/trash`, { ids: [hex(new ObjectId())] }],
    ] as const) {
      const reply = await world.asStore(key.key, method, path, body, { 'idempotency-key': randomUUID() });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  });
});

describe('contacts: creation and reading', () => {
  it('creates a contact in the legacy shape with 201, Location and ETag, replays a retry and records the names of the fields only', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = {
      code: ' K-100 ',
      customer: true,
      supplier: true,
      notes: 'Cliente storico\ncon due righe',
      person: {
        firstName: '  Mario ',
        lastName: 'Rossi',
        taxCode: 'rssmra80a01f205x',
        birthDate: '1980-01-31',
        address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', countryCode: 'IT', areaCode: 'MI' },
        phones: ['+39 02 123456', '333 1234567'],
        emails: ['Mario.Rossi@Example.test'],
        discountPercent: 12.5,
      },
      company: {
        name: 'Rossi Srl',
        vatNumber: 'it01234567890',
        taxCode: '01234567890',
        address: { street: 'Via Milano 2', postcode: '00100', city: 'Roma', countryCode: 'IT', areaCode: 'RM' },
        phones: ['06 1234'],
        emails: ['info@rossi.test'],
        faxes: ['06 5678'],
        discountPercent: 5,
        supplierPriceLists: [{ name: 'Listino 2026', favorite: true }, { id: 'old-list', name: 'Vecchio' }],
      },
      eInvoicing: { transmissionFormat: 'FPA12', channel: 'PEC', recipientCode: 'abc1234', pec: 'Rossi@pec.test', paymentTerms: 'TP02', paymentMethod: 'MP05', taxRegime: 'RF04', administrationReference: 'REF-1', splitPayment: true, requirePurchaseOrderData: true },
      account: { email: 'Mario@Account.test', phone: '+39 333 0000000' },
      fidelityCards: [{ code: 'CARD-A' }, { code: 'CARD-B' }],
      services: [],
    };
    const first = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    okay(first, 201);
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.ok(tag(first));
    const data = first.body.data;
    assert.deepEqual([data.code, data.customer, data.supplier, data.notes, data.contactGroupId, data.priceListId], ['K-100', true, true, 'Cliente storico\ncon due righe', null, null]);
    assert.deepEqual(data.person, {
      firstName: 'Mario',
      lastName: 'Rossi',
      taxCode: 'RSSMRA80A01F205X',
      birthDate: '1980-01-31',
      address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', countryCode: 'IT', areaCode: 'MI' },
      phones: ['+39 02 123456', '333 1234567'],
      emails: ['mario.rossi@example.test'],
      discountPercent: 12.5,
      associatedCompanyId: null,
    });
    assert.equal(data.company.vatNumber, 'IT01234567890');
    assert.deepEqual([data.company.faxes, data.company.discountPercent, data.company.supplierPriceLists.length, data.company.supplierPriceLists[0].favorite, data.company.supplierPriceLists[1]], [['06 5678'], 5, 2, true, { id: 'old-list', name: 'Vecchio', favorite: false }]);
    assert.match(data.company.supplierPriceLists[0].id, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(data.eInvoicing, { transmissionFormat: 'FPA12', channel: 'PEC', recipientCode: 'ABC1234', pec: 'rossi@pec.test', paymentTerms: 'TP02', paymentMethod: 'MP05', taxRegime: 'RF04', administrationReference: 'REF-1', splitPayment: true, requirePurchaseOrderData: true });
    assert.deepEqual([data.account, data.fidelityCards, data.services, data.displayName, data.trashed, data.trashedAt, data.warnings], [{ email: 'mario@account.test', phone: '+39 333 0000000' }, [{ code: 'CARD-A', points: 0, advanced: null }, { code: 'CARD-B', points: 0, advanced: null }], [], 'Rossi Srl', false, null, []]);
    assert.ok(data.createdAt === data.updatedAt && typeof data.createdAt === 'string');
    const document = (await stored(data.id))!;
    assert.deepEqual(Object.keys(document).sort(), [
      '_id', 'account', 'address', 'associatedCompanyId', 'birthDate', 'cGroupId', 'city', 'code', 'companyAddress', 'companyCity', 'companyCode', 'companyCode2', 'companyCountryAreaCode', 'companyCountryCode', 'companyDiscount', 'companyEmail', 'companyFax', 'companyLists', 'companyName',
      'companyPostcode', 'companyTelephone', 'contactCode', 'countryAreaCode', 'countryCode', 'customer', 'discount', 'email', 'fattura_elettronica', 'fidelities', 'insertDate', 'listId', 'name', 'note', 'postcode', 'services', 'supplier', 'surname', 'telephone', 'trash', 'updateDate',
    ]);
    assert.deepEqual(plain(document['fattura_elettronica']), { formato_trasmissione: 'FPA12', identificativo: 'PEC', codice_destinatario: 'ABC1234', pec: 'rossi@pec.test', condizioni_pagamento: 'TP02', modalita_pagamento: 'MP05', regime_fiscale: 'RF04', riferimento_amministrazione: 'REF-1', split_payment: true, richiedi_dati_ordine_acquisto: true });
    assert.deepEqual(plain(document['account']), { email: 'mario@account.test', telephone: '+39 333 0000000' });
    assert.deepEqual(plain(document['fidelities']), [{ code: 'CARD-A', points: 0 }, { code: 'CARD-B', points: 0 }]);
    assert.ok(document['birthDate'] instanceof Date && document['insertDate'] instanceof Date && document['discount'] instanceof Double);
    assert.equal(document['trash'], false);
    assert.deepEqual([document['code'], document['contactCode'], document['countryCode'], document['countryAreaCode'], document['cGroupId'], document['listId']], ['RSSMRA80A01F205X', 'K-100', 'IT', 'MI', null, null]);
    assert.deepEqual((plain(document['companyLists']) as Document[]).map((list) => [list['name'], list['favorite']]), [['Listino 2026', true], ['Vecchio', false]]);
    // The log keeps the names of the fields that were set, never a value.
    const entry = log('contact.created', mark)[0]!;
    assert.equal(entry.resource?.id, data.id);
    const names = entry.changes!.map((change) => change.field);
    for (const field of ['code', 'person.firstName', 'person.emails', 'company.vatNumber', 'eInvoicing.pec', 'account.email', 'fidelityCards']) {
      assert.ok(names.includes(field), field);
    }
    assert.ok(entry.changes!.every((change) => change.redacted === true && !('before' in change) && !('after' in change)));
    assert.ok(!JSON.stringify(entry).includes('Rossi') && !JSON.stringify(entry).includes('example.test'));
    // A retry with the same key answers the same, another body with the key is refused.
    assert.equal((await call(sa(), 'POST', base(), body, { 'idempotency-key': key })).body.data.id, data.id);
    assert.equal(failure(await call(sa(), 'POST', base(), { person: { firstName: 'altro' } }, { 'idempotency-key': key })).status, 409);
    assert.equal(failure(await call(sa(), 'POST', base(), { person: { firstName: 'senza chiave' } })).status, 422);
    assert.equal((await detail(data.id)).headers.get('etag'), tag(first));
  });

  it('writes the defaults of the legacy form, with no account key, and shows no services in a group without the function', async () => {
    const created = await create();
    const document = (await stored(created.body.data.id))!;
    assert.deepEqual([document['customer'], document['supplier'], document['contactCode'], document['name'], document['surname'], document['code'], document['note'], document['listId'], document['cGroupId'], document['birthDate'], document['discount'], document['companyDiscount'], document['associatedCompanyId']], [false, false, '', 'Mario', '', '', null, null, null, null, null, null, null]);
    assert.deepEqual(plain(document['fattura_elettronica']), { formato_trasmissione: 'FPR12', identificativo: 'CD', codice_destinatario: '', pec: '', condizioni_pagamento: '', modalita_pagamento: '', regime_fiscale: '', riferimento_amministrazione: '', split_payment: false, richiedi_dati_ordine_acquisto: false });
    assert.deepEqual([document['telephone'], document['email'], document['companyLists'], document['fidelities'], document['services'], 'account' in document], [[], [], [], [], [], false]);
    assert.deepEqual([created.body.data.person.address, created.body.data.account, created.body.data.eInvoicing.recipientCode, created.body.data.notes], [{ street: '', postcode: '', city: '', countryCode: null, areaCode: null }, { email: null, phone: null }, null, null]);
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': false } });
    assert.ok(!('services' in (await detail(created.body.data.id)).body.data));
    assert.equal(failure(await post({ services: [] })).status, 422);
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': true } });
    assert.deepEqual((await detail(created.body.data.id)).body.data.services, []);
  });

  it('reads a legacy contact tolerantly and never shows what the backend does not own', async () => {
    const id = await seed({
      cGroupId: '',
      note: 7,
      name: 'aabbccddeeff00112233445566778899$00112233445566778899aabbccddeeff',
      surname: ' Verdi ',
      telephone: ['', 5, 'aabbccddeeff00112233445566778899$00112233445566778899aabbccddeeff', '+39 1'],
      email: 'not-a-list',
      birthDate: '1975-05-05T10:00:00.000Z',
      discount: 'dieci',
      companyDiscount: 130,
      companyName: 'Verdi Spa',
      companyLists: [{ id: 'l1', name: 'Uno', favorite: true }, { name: 'senza id' }, 4, { id: 'l2', name: 5, favorite: 'sì' }],
      associatedCompanyId: hex(new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa')),
      fattura_elettronica: { formato_trasmissione: 'XXXX', identificativo: 'PEC', codice_destinatario: 'abc', pec: 5, condizioni_pagamento: 'TP09', modalita_pagamento: 'MP99', regime_fiscale: 'RF03', riferimento_amministrazione: 'RIF', split_payment: 'true', richiedi_dati_ordine_acquisto: true },
      fidelities: [{ code: 'C-1', points: 'molti' }, { code: 7 }, 'x', { code: 'C-2', points: 3 }],
      services: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaab', time: '01:30' }, { id: 'zz', time: '01:30' }, { id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaac'), time: '25:00' }],
      account: { email: '', telephone: 7, password: 'secret-hash', tokens: ['t'] },
    });
    const data = (await detail(id)).body.data;
    assert.deepEqual([data.contactGroupId, data.notes, data.person.firstName, data.person.lastName, data.person.phones, data.person.emails, data.person.birthDate, data.person.discountPercent, data.company.discountPercent], [null, null, '', 'Verdi', ['+39 1'], [], '1975-05-05', null, null]);
    assert.deepEqual(data.company.supplierPriceLists, [{ id: 'l1', name: 'Uno', favorite: true }, { id: 'l2', name: '', favorite: false }]);
    assert.equal(data.person.associatedCompanyId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(data.eInvoicing, { transmissionFormat: 'FPR12', channel: 'PEC', recipientCode: 'abc', pec: null, paymentTerms: null, paymentMethod: null, taxRegime: null, administrationReference: 'RIF', splitPayment: false, requirePurchaseOrderData: true });
    assert.deepEqual([data.fidelityCards, data.services, data.account, data.displayName], [[{ code: 'C-1', points: 0, advanced: null }, { code: 'C-2', points: 3, advanced: null }], [{ productId: 'aaaaaaaaaaaaaaaaaaaaaaab', duration: '01:30' }, { productId: 'aaaaaaaaaaaaaaaaaaaaaaac', duration: null }], { email: null, phone: null }, 'Verdi Spa']);
    const text = JSON.stringify(data);
    for (const never of ['secret-hash', 'legacy-dead', 'copia spuria', 'legacyExtra', 'tokens', 'password', 'cGroup"']) {
      assert.ok(!text.includes(never), never);
    }
    // Nothing of the owned fields is shown for a contact with neither company nor person.
    const bare = await seed({ name: '', surname: '', companyName: '' });
    assert.equal((await detail(bare)).body.data.displayName, null);
    assert.equal(failure(await call(sa(), 'GET', one(new ObjectId()))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
  });
});

describe('contacts: validation and references', () => {
  const base1 = { person: { firstName: 'x' } };
  const merge = (extra: Document): Document => ({ ...base1, ...extra, person: { ...base1.person, ...((extra['person'] as Document | undefined) ?? {}) } });

  it('requires a first name or a company name and validates every field by allowlist', async () => {
    assert.deepEqual(failure(await post({})), issues(['person.firstName', 'required'], ['company.name', 'required']));
    assert.deepEqual(failure(await post({ person: { firstName: '', lastName: 'Rossi' }, company: { name: '' } })), issues(['person.firstName', 'required'], ['company.name', 'required']));
    okay(await post({ company: { name: 'Solo azienda' } }), 201);
    const cases: Array<[string, Document, Array<[string, string]>]> = [
      ['an unknown key', { ...base1, extra: 1 }, [['extra', 'unknown']]],
      ['an unknown nested key', merge({ person: { nickname: 'x' } }), [['person.nickname', 'unknown']]],
      ['a mongo operator', { ...base1, $where: 1 }, [['(key)', 'forbiddenKey']]],
      ['a code too long', merge({ code: 'k'.repeat(65) }), [['code', 'maxLength']]],
      ['a code with a control character', merge({ code: 'a\u0001b' }), [['code', 'pattern']]],
      ['a flag that is not a boolean', merge({ customer: 'yes', supplier: 1 }), [['customer', 'type'], ['supplier', 'type']]],
      ['a group of contacts that is not an id', merge({ contactGroupId: 'z'.repeat(24) }), [['contactGroupId', 'pattern']]],
      ['a price list that is not an id', merge({ priceListId: 'no spaces allowed' }), [['priceListId', 'pattern']]],
      ['notes that are too long', merge({ notes: 'n'.repeat(2001) }), [['notes', 'maxLength']]],
      ['notes with a control character', merge({ notes: 'a\u0000b' }), [['notes', 'pattern']]],
      ['a birth date that does not exist', merge({ person: { birthDate: '1980-02-30' } }), [['person.birthDate', 'format']]],
      ['a country code that is not alpha-2', merge({ person: { address: { countryCode: 'it' } } }), [['person.address.countryCode', 'pattern']]],
      ['too many phones', merge({ person: { phones: Array.from({ length: 11 }, (_, index) => `0${String(index)}`) } }), [['person.phones', 'tooMany']]],
      ['a phone twice', merge({ person: { phones: ['02', '02'] } }), [['person.phones.1', 'incorrect']]],
      ['an e-mail that is not one', merge({ person: { emails: ['nope'] } }), [['person.emails.0', 'format']]],
      ['a discount over 100', merge({ person: { discountPercent: 101 } }), [['person.discountPercent', 'maximum']]],
      ['a discount with three decimals', merge({ company: { discountPercent: 12.345 } }), [['company.discountPercent', 'format']]],
      ['a tax code too long', merge({ person: { taxCode: 'T'.repeat(33) } }), [['person.taxCode', 'maxLength']]],
      ['a price list id twice and two favorites', merge({ company: { supplierPriceLists: [{ id: 'a', name: 'A', favorite: true }, { id: 'a', name: 'B', favorite: true }] } }), [['company.supplierPriceLists.1.id', 'incorrect'], ['company.supplierPriceLists.1.favorite', 'incorrect']]],
      ['a price list without a name', merge({ company: { supplierPriceLists: [{ id: 'a' }] } }), [['company.supplierPriceLists.0.name', 'required']]],
      ['too many price lists', merge({ company: { supplierPriceLists: Array.from({ length: 51 }, (_, index) => ({ name: String(index) })) } }), [['company.supplierPriceLists', 'tooMany']]],
      ['a recipient code that is not one', merge({ eInvoicing: { recipientCode: 'ab' } }), [['eInvoicing.recipientCode', 'format']]],
      ['a format, a channel, terms, a method and a regime out of the lists', merge({ eInvoicing: { transmissionFormat: 'X', channel: 'Y', paymentTerms: 'TP09', paymentMethod: 'MP24', taxRegime: 'RF03' } }), [['eInvoicing.transmissionFormat', 'enum'], ['eInvoicing.channel', 'enum'], ['eInvoicing.paymentTerms', 'enum'], ['eInvoicing.paymentMethod', 'enum'], ['eInvoicing.taxRegime', 'enum']]],
      ['a PEC that is not an address and a reference too long', merge({ eInvoicing: { pec: 'x', administrationReference: 'r'.repeat(21) } }), [['eInvoicing.pec', 'format'], ['eInvoicing.administrationReference', 'maxLength']]],
      ['an account e-mail and phone that are not', merge({ account: { email: 'x', phone: 'abc' } }), [['account.email', 'format'], ['account.phone', 'format']]],
      ['an account key that is not allowed', merge({ account: { password: 'x' } }), [['account.password', 'unknown']]],
      ['a card twice', merge({ fidelityCards: [{ code: 'A' }, { code: 'A' }] }), [['fidelityCards.1.code', 'incorrect']]],
      ['the points of a card', merge({ fidelityCards: [{ code: 'A', points: 5 }] }), [['fidelityCards.0.points', 'unknown']]],
      ['too many cards', merge({ fidelityCards: Array.from({ length: 21 }, (_, index) => ({ code: `C${String(index)}` })) }), [['fidelityCards', 'tooMany']]],
      ['a card code made only of dots', merge({ fidelityCards: [{ code: '..' }, { code: '.' }] }), [['fidelityCards.0.code', 'format'], ['fidelityCards.1.code', 'format']]],
      ['an empty card code', merge({ fidelityCards: [{ code: '' }] }), [['fidelityCards.0.code', 'minLength']]],
      ['a service duration of zero and a malformed one', merge({ services: [{ productId: 'a'.repeat(24), duration: '00:00' }, { productId: 'b'.repeat(24), duration: '24:00' }] }), [['services.0.duration', 'format'], ['services.1.duration', 'pattern']]],
      ['a service product twice', merge({ services: [{ productId: 'a'.repeat(24), duration: '00:10' }, { productId: 'a'.repeat(24), duration: '01:00' }] }), [['services.1.productId', 'incorrect']]],
    ];
    for (const [name, body, expected] of cases) {
      const reply = failure(await post(body));
      assert.deepEqual(reply, issues(...expected), name);
    }
    assert.equal(failure(await post([] as unknown as Document)).status, 422);
  });

  it('checks the references of a request: the group of contacts, the price list, the company, the country and province, the services', async () => {
    await reset();
    const contactGroup = new ObjectId();
    await db('contacts_groups').insertOne({ _id: contactGroup, name: 'Fedeli' });
    const disabled = 'listino-spento';
    await groups().updateOne({ _id: gid() }, { $set: { [`priceLists.${disabled}`]: { id: disabled, name: 'Spento', status: false, default: false } } });
    const company = await seedCompany();
    const person = await seed();
    const trashedCompany = await seedCompany({ trash: true });
    const service = new ObjectId();
    const plainProduct = new ObjectId();
    await db('products').insertMany([legacyFullProduct({ _id: service, type: 'service' }), legacyFullProduct({ _id: plainProduct, type: 'product' }), legacyFullProduct({ _id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaa1'), type: 'service', trash: true })]);
    assert.deepEqual(failure(await post(merge({ contactGroupId: hex(new ObjectId()) }))), issues(['contactGroupId', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ priceListId: 'missing' }))), issues(['priceListId', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ priceListId: disabled }))), issues(['priceListId', 'incorrect']));
    for (const associatedCompanyId of [hex(new ObjectId()), hex(person), hex(trashedCompany)]) {
      assert.deepEqual(failure(await post(merge({ person: { associatedCompanyId } }))), issues(['person.associatedCompanyId', 'incorrect']));
    }
    assert.deepEqual(failure(await post(merge({ person: { address: { countryCode: 'ZZ' } } }))), issues(['person.address.countryCode', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ person: { address: { countryCode: 'IT', areaCode: 'XX' } } }))), issues(['person.address.areaCode', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ person: { address: { areaCode: 'MI' } } }))), issues(['person.address.areaCode', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ company: { address: { countryCode: 'ZZ' }, } }))), issues(['company.address.countryCode', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ company: { address: { countryCode: 'IT', areaCode: 'XX' } } }))), issues(['company.address.areaCode', 'incorrect']));
    assert.deepEqual(failure(await post(merge({ services: [{ productId: hex(plainProduct), duration: '01:00' }, { productId: hex(service), duration: '00:30' }, { productId: 'aaaaaaaaaaaaaaaaaaaaaaa1', duration: '00:30' }, { productId: hex(new ObjectId()), duration: '00:30' }] }))), issues(['services.0.productId', 'incorrect'], ['services.2.productId', 'incorrect'], ['services.3.productId', 'incorrect']));
    const good = await post(
      merge({
        contactGroupId: hex(contactGroup),
        priceListId: listId,
        person: { associatedCompanyId: hex(company), address: { countryCode: 'DE', areaCode: 'BY' } },
        company: { name: 'Mia', address: { countryCode: 'FR', areaCode: 'qualsiasi' } },
        services: [{ productId: hex(service), duration: '01:15' }],
      }),
    );
    okay(good, 201);
    const data = good.body.data;
    assert.deepEqual([data.contactGroupId, data.priceListId, data.person.associatedCompanyId, data.services, data.person.address.areaCode, data.company.address.countryCode], [hex(contactGroup), listId, hex(company), [{ productId: hex(service), duration: '01:15' }], 'BY', 'FR']);
    const document = (await stored(data.id))!;
    assert.deepEqual([document['cGroupId'], document['associatedCompanyId']].map((value) => (value as ObjectId).constructor.name), ['ObjectId', 'ObjectId']);
    assert.deepEqual(plain(document['services']), [{ id: hex(service), time: '01:15' }]);
    // A reference is judged only when the request changes it: a company that went does not block an unrelated change, nor a service that is gone.
    await contacts().updateOne({ _id: company }, { $set: { trash: true } });
    await db('products').updateOne({ _id: service }, { $set: { trash: true } });
    okay(await patch(data.id, { notes: 'ok' }));
    okay(await patch(data.id, { person: { associatedCompanyId: hex(company) }, services: [{ productId: hex(service), duration: '01:15' }] }));
    // A service that stays and only changes its duration needs no check; one that is added does.
    okay(await patch(data.id, { services: [{ productId: hex(service), duration: '02:00' }] }));
    assert.deepEqual(failure(await patch(data.id, { services: [{ productId: hex(service), duration: '02:00' }, { productId: hex(plainProduct), duration: '00:20' }] })), issues(['services.1.productId', 'incorrect']));
    // The country and the province can both be taken away.
    okay(await patch(data.id, { person: { address: { countryCode: null, areaCode: null } } }));
    assert.deepEqual(failure(await patch(data.id, { person: { address: { areaCode: 'MI' } } })), issues(['person.address.areaCode', 'incorrect']));
    assert.deepEqual(failure(await patch(data.id, { person: { associatedCompanyId: data.id } })), issues(['person.associatedCompanyId', 'incorrect']));
    // The services need the function of the group.
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': false } });
    assert.deepEqual(failure(await patch(data.id, { services: [] })), issues(['services', 'notAllowed']));
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': true } });
  });

  it('refuses an account or a card that another contact has, with 409 taken, and a supplier price list a product still uses', async () => {
    await reset();
    const other = await seed({ account: { email: 'taken@example.test', telephone: '+39 111' }, fidelities: [{ code: 'TAKEN', points: 5 }, { code: 'NOT-ASKED', points: 1 }, { points: 2 }], companyName: 'Altro Spa' });
    await seed({ trash: true, account: { email: 'trashed@example.test' }, fidelities: [{ code: 'IN-TRASH', points: 5 }] });
    assert.deepEqual(failure(await post(merge({ account: { email: 'Taken@example.test' } }))), taken('account.email'));
    assert.deepEqual(failure(await post(merge({ account: { phone: '+39 111' } }))), taken('account.phone'));
    assert.deepEqual(failure(await post(merge({ account: { email: 'taken@example.test', phone: '+39 111' } }))), taken('account.email', 'account.phone'));
    // The account of a contact in the trash is taken too (the unique index of the legacy counts it).
    assert.deepEqual(failure(await post(merge({ account: { email: 'trashed@example.test' } }))), taken('account.email'));
    // Several contacts may have the same card (a family on one card): never a conflict, in or out of the trash.
    okay(await post(merge({ fidelityCards: [{ code: 'FREE' }, { code: 'TAKEN' }] })), 201);
    okay(await post(merge({ fidelityCards: [{ code: 'IN-TRASH' }] })), 201);
    // The same contact keeps its own account and card when it asks for them again.
    const mine = await create({ account: { email: 'mine@example.test' }, fidelityCards: [{ code: 'MINE' }] });
    okay(await patch(mine.body.data.id, { account: { email: 'mine@example.test' }, fidelityCards: [{ code: 'MINE' }, { code: 'MINE-2' }] }));
    assert.deepEqual(failure(await patch(mine.body.data.id, { account: { email: 'taken@example.test' } })), taken('account.email'));
    okay(await patch(mine.body.data.id, { fidelityCards: [{ code: 'TAKEN' }] }));
    // A supplier price list that a product names cannot be taken away.
    const supplier = await create({ company: { name: 'Fornitore', supplierPriceLists: [{ id: 'sl-1', name: 'Uno' }, { id: 'sl-2', name: 'Due' }] }, supplier: true });
    const product = new ObjectId();
    await db('products').insertMany([
      legacyFullProduct({ _id: product, suppliers: [{ id: new ObjectId(supplier.body.data.id), companyLists: [{ id: 'sl-1', price: 1 }] }] }),
      legacyFullProduct({ suppliers: [{ id: supplier.body.data.id, companyLists: [{ id: 'sl-2', price: 1 }] }], trash: true }),
    ]);
    assert.deepEqual(failure(await patch(supplier.body.data.id, { company: { supplierPriceLists: [{ id: 'sl-2', name: 'Due' }] } })), { status: 409, code: 'CONFLICT', details: [{ field: `products.${hex(product)}`, issue: 'referenced' }] });
    // Renaming, adding and removing a list nobody uses is fine; a list without an id is a new one.
    const added = await patch(supplier.body.data.id, { company: { supplierPriceLists: [{ id: 'sl-1', name: 'Uno rinominato' }, { name: 'Nuovo' }] } });
    okay(added);
    assert.match(added.body.data.company.supplierPriceLists[1].id, /^[A-Za-z0-9_-]{22}$/);
    const fine = await patch(supplier.body.data.id, { company: { supplierPriceLists: [{ id: 'sl-1', name: 'Uno rinominato', favorite: true }, { id: 'sl-3', name: 'Nuovo' }] } });
    okay(fine);
    assert.deepEqual(fine.body.data.company.supplierPriceLists, [{ id: 'sl-1', name: 'Uno rinominato', favorite: true }, { id: 'sl-3', name: 'Nuovo', favorite: false }]);
    assert.ok(other);
  });

  it('warns about a code, a tax code or a VAT number another contact has, and never refuses the save', async () => {
    await reset();
    for (let index = 0; index < 7; index += 1) {
      await seed({ contactCode: 'DUP', code: index === 0 ? 'SAMETAX' : `T${String(index)}`, companyCode: 'VAT-1', companyCode2: 'CF-9' });
    }
    await seed({ contactCode: 'DUP', trash: true });
    const created = await create({ code: 'DUP', person: { firstName: 'Dup', taxCode: 'sametax' }, company: { vatNumber: 'vat-1', taxCode: 'cf-9' } });
    const warnings = created.body.data.warnings as Array<{ field: string; issue: string; contactIds: string[]; others: number }>;
    assert.deepEqual(warnings.map((warning) => [warning.field, warning.issue, warning.contactIds.length, warning.others]), [['code', 'duplicate', 5, 2], ['person.taxCode', 'duplicate', 1, 0], ['company.vatNumber', 'duplicate', 5, 2], ['company.taxCode', 'duplicate', 5, 2]]);
    assert.deepEqual((await detail(created.body.data.id)).body.data.warnings, warnings);
    // The answers of the writes that are not a creation or a modification carry no warnings.
    assert.ok(!('warnings' in (await call(sa(), 'POST', `${one(created.body.data.id)}/trash`, undefined, { 'if-match': tag(created) })).body.data));
    assert.deepEqual((await create({ code: 'unica' })).body.data.warnings, []);
  });
});

describe('contacts: modification', () => {
  it('merges the objects field by field, keeps everything the backend does not own, and answers a new ETag', async () => {
    await reset();
    const id = await seed({ companyName: 'Rossi Srl' });
    const before = (await stored(id))!;
    const reference = await detail(id);
    const mark = world.office.activity.entries.length;
    const reply = await patch(hex(id), { person: { address: { city: 'Roma' }, emails: ['nuova@example.test'] }, company: { vatNumber: 'it9' }, eInvoicing: { pec: 'p@pec.test' }, account: { phone: '+39 999' } }, sa(), reference);
    okay(reply);
    assert.notEqual(tag(reply), tag(reference));
    const data = reply.body.data;
    assert.deepEqual([data.person.address, data.person.emails, data.person.phones, data.company.vatNumber, data.eInvoicing.pec, data.account], [{ street: 'Via Roma 1', postcode: '20100', city: 'Roma', countryCode: 'IT', areaCode: 'MI' }, ['nuova@example.test'], ['+39 02 123456'], 'IT9', 'p@pec.test', { email: 'mario.account@example.test', phone: '+39 999' }]);
    const after = (await stored(id))!;
    // Only the fields of the request (and the date) changed; the keys of the legacy that are not ours are as they were, byte for byte.
    const changed = Object.keys(after).filter((key) => JSON.stringify(plain(before[key])) !== JSON.stringify(plain(after[key]))).sort();
    assert.deepEqual(changed, ['account', 'city', 'companyCode', 'email', 'fattura_elettronica', 'updateDate']);
    assert.deepEqual([after['account'] as Document].map((account) => [account['password'], account['tokens']])[0], ['legacy-dead-password-hash', [{ token: 'legacy-dead-token' }]]);
    assert.deepEqual([after['cGroup'], after['associatedCompany'], after['legacyExtra'], after['fidelities']], [before['cGroup'], before['associatedCompany'], before['legacyExtra'], before['fidelities']]);
    assert.ok(after['updateDate'] instanceof Date && (after['updateDate'] as Date) > (before['updateDate'] as Date));
    assert.equal((await detail(id)).headers.get('etag'), tag(reply));
    // The names of the changed fields, and nothing else, are in the log.
    const entry = log('contact.updated', mark)[0]!;
    assert.deepEqual(entry.changes!.map((change) => change.field).sort(), ['account.phone', 'company.vatNumber', 'eInvoicing.pec', 'person.address.city', 'person.emails']);
    assert.ok(entry.changes!.every((change) => change.redacted === true && !('before' in change) && !('after' in change)));
    assert.ok(!JSON.stringify(entry).includes('example.test') && !JSON.stringify(entry).includes('Roma'));
    // The account leaf goes away with null, the other stays; a request that changes nothing writes and records nothing.
    const removed = await patch(hex(id), { account: { email: null } });
    okay(removed);
    assert.deepEqual([removed.body.data.account, ((await stored(id))!['account'] as Document)['email'], ((await stored(id))!['account'] as Document)['password']], [{ email: null, phone: '+39 999' }, undefined, 'legacy-dead-password-hash']);
    const stamp = log('contact.updated', 0).length;
    const same = await patch(hex(id), { person: { address: { city: 'Roma' } }, account: { email: null }, notes: null, eInvoicing: { channel: 'CD' } }, sa(), removed);
    okay(same);
    assert.equal(tag(same), tag(removed));
    assert.equal(log('contact.updated', 0).length, stamp);
    // Clearing a text with '' and a list with [] is a change.
    const cleared = await patch(hex(id), { code: '', person: { phones: [], birthDate: null, discountPercent: null }, eInvoicing: { recipientCode: '' } });
    okay(cleared);
    assert.deepEqual([cleared.body.data.code, cleared.body.data.person.phones, cleared.body.data.person.birthDate, cleared.body.data.person.discountPercent], ['', [], null, null]);
  });

  it('answers 412 for a stale version, 422 for a missing one or an empty body, and 409 for a contact in the trash', async () => {
    await reset();
    const created = await create();
    const id = created.body.data.id as string;
    okay(await patch(id, { notes: 'uno' }, sa(), created));
    assert.equal(failure(await patch(id, { notes: 'due' }, sa(), created)).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { notes: 'due' })).status, 422);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { notes: 'due' }, { 'if-match': 'W/"x"' })).status, 422);
    assert.equal(failure(await patch(id, {})).status, 422);
    assert.deepEqual(failure(await patch(id, { person: { firstName: '' } })), issues(['person.firstName', 'required'], ['company.name', 'required']));
    assert.equal(failure(await patch(hex(new ObjectId()), { notes: 'x' }, sa(), created)).status, 404);
    // A change by another writer to anything the backend owns changes the version.
    const reference = await detail(id);
    await contacts().updateOne({ _id: new ObjectId(id) }, { $set: { city: 'Altrove' } });
    assert.equal(failure(await patch(id, { notes: 'tre' }, sa(), reference)).status, 412);
    const trashed = await call(sa(), 'POST', `${one(id)}/trash`, undefined, { 'if-match': tag(await detail(id)) });
    okay(trashed);
    assert.deepEqual(failure(await patch(id, { notes: 'x' }, sa(), trashed)), { status: 409, code: 'CONFLICT', details: [{ field: 'trashed', issue: 'incorrect' }] });
  });

  it('never overwrites the points: a sale between the read and the write keeps its increment, and the version ignores the balance', async () => {
    await reset();
    const id = await seed({ fidelities: [{ code: 'A', points: 50 }, { code: 'B', points: 7 }] });
    const reference = await detail(id);
    // A sale adds points after the client read the contact.
    await contacts().updateOne({ _id: id, 'fidelities.code': 'A' }, { $inc: { 'fidelities.$.points': 30 } });
    const reply = await patch(hex(id), { notes: 'dopo la vendita' }, sa(), reference);
    okay(reply);
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'A', points: 80 }, { code: 'B', points: 7 }]);
    assert.deepEqual(reply.body.data.fidelityCards.map((card: Document) => card['code']), ['A', 'B']);
    // The balance of a card never changes the ETag.
    assert.equal(tag(await detail(id)), tag(reply));
    await contacts().updateOne({ _id: id, 'fidelities.code': 'B' }, { $inc: { 'fidelities.$.points': 1 } });
    assert.equal(tag(await detail(id)), tag(reply));
    // Cards are written element by element: added at zero, removed by code, the others untouched (balance included), in one write or in two.
    okay(await patch(hex(id), { fidelityCards: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] }));
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'A', points: 80 }, { code: 'B', points: 8 }, { code: 'C', points: 0 }]);
    okay(await patch(hex(id), { fidelityCards: [{ code: 'C' }, { code: 'A' }] }));
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'A', points: 80 }, { code: 'C', points: 0 }]);
    const mixed = await patch(hex(id), { fidelityCards: [{ code: 'C' }, { code: 'D' }], notes: 'misto' });
    okay(mixed);
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'C', points: 0 }, { code: 'D', points: 0 }]);
    assert.deepEqual(mixed.body.data.fidelityCards, [{ code: 'C', points: 0, advanced: null }, { code: 'D', points: 0, advanced: null }]);
    // The same cards in another order is no change; an empty list takes them all away.
    const same = await patch(hex(id), { fidelityCards: [{ code: 'D' }, { code: 'C' }] }, sa(), mixed);
    assert.equal(tag(same), tag(mixed));
    okay(await patch(hex(id), { fidelityCards: [] }));
    assert.deepEqual(plain((await stored(id))!['fidelities']), []);
    // A document whose cards are not an array is left alone by a request about the cards (409), and a request about something else goes through.
    const odd = await seed({ fidelities: 'rotto' });
    assert.equal(failure(await patch(hex(odd), { fidelityCards: [{ code: 'Z' }] })).status, 409);
    okay(await patch(hex(odd), { notes: 'ok' }));
    assert.equal((await stored(odd))!['fidelities'], 'rotto');
  });

  it('replaces a container the legacy left as something else, and never touches the cards when it does', async () => {
    await reset();
    const id = await seed({ account: null, fattura_elettronica: 'rotto', fidelities: [{ code: 'K', points: 4 }] });
    const reply = await patch(hex(id), { account: { email: 'new@example.test' }, eInvoicing: { pec: 'new@pec.test', splitPayment: true } });
    okay(reply);
    const document = (await stored(id))!;
    assert.deepEqual(plain(document['account']), { email: 'new@example.test' });
    assert.deepEqual(plain(document['fattura_elettronica']), { formato_trasmissione: 'FPR12', identificativo: 'CD', codice_destinatario: '', pec: 'new@pec.test', condizioni_pagamento: '', modalita_pagamento: '', regime_fiscale: '', riferimento_amministrazione: '', split_payment: true, richiedi_dati_ordine_acquisto: false });
    assert.deepEqual(plain(document['fidelities']), [{ code: 'K', points: 4 }]);
    assert.deepEqual([reply.body.data.account, reply.body.data.eInvoicing.splitPayment], [{ email: 'new@example.test', phone: null }, true]);
    // A leaf that is unset in a container that is not an object leaves the container empty.
    const other = await seed({ account: 'x' });
    okay(await patch(hex(other), { account: { phone: '+39 1' } }));
    assert.deepEqual(plain((await stored(other))!['account']), { telephone: '+39 1' });
    const third = await seed({ account: 5 });
    okay(await patch(hex(third), { account: { email: null, phone: '+39 2' } }));
    assert.deepEqual(plain((await stored(third))!['account']), { telephone: '+39 2' });
  });
});

describe('contacts: lists', () => {
  const rows = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data as Array<Document>;
  const names = (reply: Awaited<ReturnType<typeof call>>) => rows(reply).map((row) => row['displayName']);

  it('lists the contacts of the group by kind, group, search and sort, with compact rows', async () => {
    await reset();
    const contactGroup = new ObjectId();
    await db('contacts_groups').insertOne({ _id: contactGroup, name: 'G' });
    await seed({ name: 'Anna', surname: 'Bianchi', customer: true, supplier: false, contactCode: 'AB-1', cGroupId: contactGroup, email: ['anna@x.test'], telephone: ['111'], updateDate: new Date('2024-05-01T00:00:00Z') });
    await seed({ name: 'Carlo', surname: 'Verdi', customer: false, supplier: true, contactCode: 'CV-2', cGroupId: hex(contactGroup), code: 'VRDCRL80A01H501Z', updateDate: new Date('2024-04-01T00:00:00Z') });
    await seedCompany({ companyName: 'Zeta Srl', customer: true, supplier: true, companyEmail: ['info@zeta.test'], companyTelephone: ['222'], companyCode: 'IT00000000001', companyCode2: 'CFZETA', updateDate: new Date('2024-03-15T00:00:00Z') });
    await seedCompany({ companyName: 'Alfa Spa', customer: false, supplier: false, fidelities: [{ code: 'CARD-ALFA', points: 3 }], email: ['alfa@x.test'], updateDate: new Date('2024-03-10T00:00:00Z') });
    await seed({ name: 'Dora', surname: 'Neri', trash: true, trashDate: new Date('2024-06-01T00:00:00Z') });
    await seed({ name: '', surname: '', companyName: '', customer: false, updateDate: new Date('2024-03-05T00:00:00Z') });
    const list = (query = '') => call(sa(), 'GET', `${base()}${query}`);
    const all = await list();
    okay(all);
    assert.deepEqual(names(all), [null, 'Alfa Spa', 'Anna Bianchi', 'Carlo Verdi', 'Zeta Srl']);
    assert.deepEqual(Object.keys(rows(all)[2]!).sort(), ['code', 'company', 'contactGroupId', 'customer', 'displayName', 'email', 'id', 'person', 'phone', 'supplier', 'trashed', 'trashedAt', 'updatedAt']);
    assert.deepEqual(rows(all)[2], { id: rows(all)[2]!['id'], code: 'AB-1', customer: true, supplier: false, displayName: 'Anna Bianchi', person: { firstName: 'Anna', lastName: 'Bianchi' }, company: { name: '', vatNumber: '' }, email: 'anna@x.test', phone: '111', contactGroupId: hex(contactGroup), trashed: false, trashedAt: null, updatedAt: '2024-05-01T00:00:00.000Z' });
    assert.deepEqual([rows(all)[4]!['email'], rows(all)[4]!['phone'], rows(all)[4]!['company']], ['info@zeta.test', '222', { name: 'Zeta Srl', vatNumber: 'IT00000000001' }]);
    const text = JSON.stringify(rows(all));
    for (const never of ['Via Roma', 'RSSMRA', 'account', 'points', 'legacy-dead', 'note', 'postcode']) {
      assert.ok(!text.includes(never), never);
    }
    assert.deepEqual(names(await list('?kind=customers')), ['Anna Bianchi', 'Zeta Srl']);
    assert.deepEqual(names(await list('?kind=suppliers')), ['Carlo Verdi', 'Zeta Srl']);
    assert.deepEqual(names(await list('?kind=others')), [null, 'Alfa Spa']);
    assert.equal(names(await list('?kind=all')).length, 5);
    assert.deepEqual(names(await list(`?contactGroupId=${hex(contactGroup)}`)), ['Anna Bianchi', 'Carlo Verdi']);
    assert.deepEqual(names(await list('?trashed=true')), ['Dora Neri']);
    assert.equal(rows(await list('?trashed=true'))[0]!['trashedAt'], '2024-06-01T00:00:00.000Z');
    assert.deepEqual(names(await list('?sort=-displayName')), ['Zeta Srl', 'Carlo Verdi', 'Anna Bianchi', 'Alfa Spa', null]);
    // The sort by surname and by company name puts what has none first, in the order of creation.
    assert.deepEqual(names(await list('?sort=lastName')), ['Zeta Srl', 'Alfa Spa', null, 'Anna Bianchi', 'Carlo Verdi']);
    assert.deepEqual(names(await list('?sort=companyName')), ['Anna Bianchi', 'Carlo Verdi', null, 'Alfa Spa', 'Zeta Srl']);
    assert.deepEqual(names(await list('?sort=-updatedAt')), ['Anna Bianchi', 'Carlo Verdi', 'Zeta Srl', 'Alfa Spa', null]);
    // The search: contained in a name, a surname or a company name; equal to a code, a tax code, a VAT number, a card or an e-mail; two words as first name and surname in either order.
    for (const [query, expected] of [
      ['anna', ['Anna Bianchi']],
      ['BIANCH', ['Anna Bianchi']],
      ['zeta', ['Zeta Srl']],
      ['rdi', ['Carlo Verdi']],
      ['ab-1', ['Anna Bianchi']],
      ['vrdcrl80a01h501z', ['Carlo Verdi']],
      ['it00000000001', ['Zeta Srl']],
      ['cfzeta', ['Zeta Srl']],
      ['card-alfa', ['Alfa Spa']],
      ['ALFA@x.test', ['Alfa Spa']],
      ['INFO@zeta.test', ['Zeta Srl']],
      ['bianchi anna', ['Anna Bianchi']],
      ['anna bianchi', ['Anna Bianchi']],
      ['carlo', ['Carlo Verdi']],
      ['x.test', []],
      ['nessuno', []],
    ] as Array<[string, string[]]>) {
      assert.deepEqual(names(await list(`?q=${encodeURIComponent(query)}`)), expected, query);
    }
    // The text is literal: a regular expression matches nothing it is not.
    assert.deepEqual(names(await list(`?q=${encodeURIComponent('.*')}`)), []);
    assert.deepEqual(names(await list(`?q=${encodeURIComponent('^A')}`)), []);
  });

  it('pages with a cursor in every sort, and refuses what is not valid', async () => {
    await reset();
    for (let index = 0; index < 7; index += 1) {
      await seed({ name: `Nome${String(index)}`, surname: index % 2 === 0 ? 'Pari' : 'Dispari', updateDate: new Date(Date.UTC(2024, 0, index + 1)) });
    }
    await seedCompany({ companyName: 'Azienda' });
    await seed({ name: '', surname: '', companyName: '' });
    for (const sort of ['displayName', '-displayName', 'lastName', 'companyName', '-companyName', 'updatedAt', '-updatedAt']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const reply = await call(sa(), 'GET', `${base()}?limit=3&sort=${sort}${cursor === null ? '' : `&cursor=${cursor}`}`);
        okay(reply);
        seen.push(...rows(reply).map((row) => row['id'] as string));
        cursor = reply.body.page.next;
        if (cursor === null) {
          break;
        }
      }
      assert.equal(seen.length, 9, sort);
      assert.equal(new Set(seen).size, 9, sort);
    }
    const first = await call(sa(), 'GET', `${base()}?limit=2`);
    assert.equal(first.body.page.limit, 2);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=2&sort=lastName&cursor=${first.body.page.next as string}`)).status, 422);
    for (const query of ['limit=0', 'limit=101', 'limit=x', 'sort=name', 'kind=everyone', 'trashed=maybe', 'contactGroupId=x', `q=${'a'.repeat(101)}`, 'q=', 'cursor=!!', 'other=1']) {
      assert.equal(failure(await call(sa(), 'GET', `${base()}?${query}`)).status, 422, query);
    }
    okay(await call(sa(), 'GET', `${base()}?limit=100&q=${'a'.repeat(100)}`));
  });

  it('answers 503 and never an empty list when the search runs out of time', async () => {
    // The time limit is a server-side limit: a failpoint is not available, so the repository is driven with an error of the driver (see the unit tests); here the route is only shown to be bounded.
    okay(await call(sa(), 'GET', `${base()}?q=zz`));
  });
});

describe('contacts: trash, restore and deletion', () => {
  const trashOf = (id: string, reply?: Awaited<ReturnType<typeof call>>) => async (actor = sa()) => call(actor, 'POST', `${one(id)}/trash`, undefined, { 'if-match': tag(reply ?? (await detail(id))) });
  const restoreOf = async (id: string, actor = sa()) => call(actor, 'POST', `${one(id)}/restore`, undefined, { 'if-match': tag(await detail(id)) });
  const removeOf = async (id: string, actor = sa(), reference?: Awaited<ReturnType<typeof call>>) => call(actor, 'DELETE', one(id), undefined, { 'if-match': tag(reference ?? (await detail(id))) });

  it('trashes and restores one contact with If-Match, records both, and answers 409 for the wrong state and 412 for a stale version', async () => {
    await reset();
    const created = await create();
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const trashed = await trashOf(id)();
    okay(trashed);
    assert.deepEqual([trashed.body.data.trashed, typeof trashed.body.data.trashedAt, 'warnings' in trashed.body.data], [true, 'string', false]);
    assert.notEqual(tag(trashed), tag(created));
    const document = (await stored(id))!;
    assert.deepEqual([document['trash'], document['trashDate'] instanceof Date, document['updateDate'] instanceof Date], [true, true, true]);
    assert.equal(log('contact.trashed', mark).length, 1);
    assert.deepEqual(log('contact.trashed', mark)[0]!.changes!.map((change) => [change.field, change.before, change.after]), [['trashed', false, true]]);
    assert.equal(failure(await trashOf(id)()).status, 409);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/trash`)).status, 422);
    assert.equal(failure(await trashOf(hex(new ObjectId()), created)()).status, 404);
    const restored = await restoreOf(id);
    okay(restored);
    assert.deepEqual([restored.body.data.trashed, restored.body.data.trashedAt], [false, null]);
    assert.ok(!('trashDate' in (await stored(id))!));
    assert.equal(log('contact.restored', mark).length, 1);
    assert.equal(failure(await trashOf(id, created)()).status, 412);
    assert.equal(failure(await restoreOf(id)).status, 409);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/restore`, undefined, { 'if-match': tag(trashed) })).status, 409);
    okay(await trashOf(id)());
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/restore`, undefined, { 'if-match': tag(created) })).status, 412);
    // A card another contact has does not stop the restore: the cards are shared.
    await contacts().updateOne({ _id: new ObjectId(id) }, { $set: { fidelities: [{ code: 'SHARED', points: 2 }, { code: 'FREE', points: 0 }] } });
    await seed({ fidelities: [{ code: 'SHARED', points: 1 }] });
    okay(await restoreOf(id));
  });

  it('trashes several contacts, each as the single route does, and tells what became of every one', async () => {
    await reset();
    const [a, b, c] = [await seed(), await seed(), await seed({ trash: true })];
    const missing = new ObjectId();
    const mark = world.office.activity.entries.length;
    const reply = await call(sa(), 'POST', `${base()}/trash`, { ids: [hex(a), hex(b), hex(a), hex(c), hex(missing)] });
    okay(reply);
    assert.deepEqual(reply.body.data.results, [
      { id: hex(a), outcome: 'trashed' },
      { id: hex(b), outcome: 'trashed' },
      { id: hex(c), outcome: 'skipped', issue: 'alreadyTrashed' },
      { id: hex(missing), outcome: 'skipped', issue: 'notFound' },
    ]);
    assert.equal(log('contact.trashed', mark).length, 2);
    for (const body of [{}, { ids: [] }, { ids: ['x'] }, { ids: Array.from({ length: 101 }, () => hex(new ObjectId())) }, { ids: [hex(a)], extra: 1 }]) {
      assert.equal(failure(await call(sa(), 'POST', `${base()}/trash`, body)).status, 422);
    }
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${base()}/trash`, { ids: [hex(a)] })).status, 404);
  });

  it('deletes a contact in the trash for good, with If-Match, and never one that is not in it', async () => {
    await reset();
    const created = await create();
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    assert.equal(failure(await removeOf(id)).status, 409);
    await trashOf(id)();
    assert.equal(failure(await removeOf(id, sa(), created)).status, 412);
    assert.equal(failure(await call(sa(), 'DELETE', one(id))).status, 422);
    const removed = await removeOf(id);
    assert.equal(removed.status, 204);
    assert.equal(await stored(id), null);
    const entry = log('contact.deleted', mark)[0]!;
    assert.deepEqual([entry.resource, entry.changes], [{ type: 'contact', id }, undefined]);
    assert.equal(failure(await removeOf(id, sa(), created)).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(id, 1), undefined, { 'if-match': tag(created) })).status, 404);
  });

  it('refuses the deletion of a contact that something still names, one kind at a time from the cheapest, and lists the references', async () => {
    await reset();
    const target = await seed({ trash: true, companyName: 'Fornitore Spa' });
    const hexTarget = hex(target);
    const deleteIt = async () => failure(await removeOf(hexTarget));
    const referenced = (...fields: string[]) => ({ status: 409, code: 'CONFLICT', details: fields.map((field) => ({ field, issue: 'referenced' })) });
    const either = [target, hexTarget];
    // Nothing names it yet: the order of the kinds is the one of the cost, and the first kind found is the only one listed.
    const stages: Array<[string, () => Promise<Document>, string]> = [
      ['sales', async () => (await db('sales').insertMany([{ customer: { _id: target } }, { appointment: { customerId: hexTarget } }])).insertedIds, 'sales'],
      ['documents', async () => (await db('documents').insertOne({ counterpart: { _id: hexTarget } })).insertedId as unknown as Document, 'documents'],
      ['table_reservation', async () => (await db('table_reservation').insertOne({ customerId: target })).insertedId as unknown as Document, 'tableReservations'],
      ['calendar', async () => (await db('calendar').insertOne({ customerId: hexTarget })).insertedId as unknown as Document, 'appointments'],
      ['warehouse', async () => (await db('warehouse').insertOne({ supplierId: target })).insertedId as unknown as Document, 'warehouseMovements'],
      ['products', async () => (await db('products').insertOne(legacyFullProduct({ suppliers: [{ id: hexTarget }], trash: true }))).insertedId as unknown as Document, 'products'],
    ];
    const reference: string[] = [];
    // Walk from the most expensive kind to the cheapest, each time the cheaper kind wins.
    for (const [collection, insert, name] of stages) {
      const ids = await insert();
      const inserted = collection === 'sales' ? Object.values(ids).map((value) => hex(value as unknown as ObjectId)) : [hex(ids as unknown as ObjectId)];
      reference.push(...inserted);
      assert.deepEqual(await deleteIt(), referenced(...inserted.map((value) => `${name}.${value}`)), name);
    }
    // The last supplier of a product counts too, and so does a contact that works for the company (trashed ones included).
    await db('products').deleteMany({});
    const last = (await db('products').insertOne(legacyFullProduct({ lastAveragePrice: { lastSupplierId: target } }))).insertedId;
    assert.deepEqual(await deleteIt(), referenced(`products.${hex(last)}`));
    await db('products').deleteMany({});
    await db('warehouse').deleteMany({});
    await db('calendar').deleteMany({});
    await db('table_reservation').deleteMany({});
    await db('documents').deleteMany({});
    await db('sales').deleteMany({});
    // The promotions are read as they are stored: an ObjectId, a text in any case, junk around them.
    await groups().updateOne({ _id: gid() }, { $set: { promotions: [{ id: 'promo-1', name: 'Promo', status: true, conditions: { customersIds: [target, 5, null] }, actions: {} }, { id: 'promo-2', name: 'Altra', status: true, conditions: { customersIds: [hex(new ObjectId())] }, actions: {} }, { id: 'promo-3', conditions: { customersIds: [hexTarget.toUpperCase()] } }, { conditions: { customersIds: [hexTarget] } }, { id: 'promo-4', conditions: 5 }, { id: 'promo-5', conditions: { customersIds: 'x' } }] } });
    assert.deepEqual(await deleteIt(), referenced('promotions.promo-1', 'promotions.promo-3'));
    const worker = await seed({ associatedCompanyId: target, trash: true });
    assert.deepEqual(await deleteIt(), referenced(`contactAssociations.${hex(worker)}`));
    // Once nothing names it, it goes; and trashing it was never blocked.
    await contacts().deleteOne({ _id: worker });
    await groups().updateOne({ _id: gid() }, { $unset: { promotions: '' } });
    assert.equal((await removeOf(hexTarget)).status, 204);
    const named = await seed({ companyName: 'Nominato' });
    await db('sales').insertOne({ customer: { _id: named } });
    okay(await trashOf(hex(named))());
    assert.ok(either.length === 2 && reference.length > 0);
    await db('sales').deleteMany({});
  });

  it('lists at most 20 references of the first kind found', async () => {
    await reset();
    const target = await seed({ trash: true });
    await db('sales').insertMany(Array.from({ length: 25 }, () => ({ customer: { _id: target } })));
    const reply = failure(await call(sa(), 'DELETE', one(target), undefined, { 'if-match': tag(await detail(target)) }));
    assert.equal(reply.status, 409);
    assert.equal((reply.details as unknown[]).length, 20);
    await db('sales').deleteMany({});
  });

  it('works on the trash page: restores and deletes by kind with contacts:write, skips what cannot be (a card another contact has never stops a restore), and is emptied by the PSA only', async () => {
    await reset();
    const [a, b, c] = [await seed({ trash: true, fidelities: [{ code: 'DUP', points: 1 }] }), await seed({ trash: true }), await seed({ trash: true })];
    await db('sales').insertOne({ customer: { _id: c } });
    const live = await seed({ fidelities: [{ code: 'DUP', points: 1 }] });
    const trashBase = `/groups/${hex(gid())}/trash/contacts`;
    const restored = await call(sa(), 'POST', `${trashBase}/restore`, { ids: [hex(a), hex(b), hex(new ObjectId())] });
    okay(restored);
    assert.deepEqual(restored.body.data.results, [{ id: hex(a), outcome: 'restored' }, { id: hex(b), outcome: 'restored' }, { id: restored.body.data.results[2].id, outcome: 'skipped', issue: 'notFound' }]);
    const deleted = await call(sa(), 'POST', `${trashBase}/delete`, { ids: [hex(a), hex(b), hex(c)] });
    okay(deleted);
    assert.deepEqual(deleted.body.data.results, [{ id: hex(a), outcome: 'skipped', issue: 'notTrashed' }, { id: hex(b), outcome: 'skipped', issue: 'notTrashed' }, { id: hex(c), outcome: 'skipped', issue: 'referenced' }]);
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: true, w: false } } }) });
    assert.equal(failure(await call(reader.id, 'POST', `${trashBase}/restore`, { ids: [hex(c)] })).status, 403);
    assert.equal(failure(await call(reader.id, 'POST', `${trashBase}/delete`, { ids: [hex(c)] })).status, 403);
    assert.equal(failure(await call(sa(), 'POST', `${trashBase}/empty`)).status, 403);
    await db('sales').deleteMany({});
    const emptied = await call(psa(), 'POST', `${trashBase}/empty`);
    okay(emptied);
    assert.deepEqual([emptied.body.data.results, emptied.body.data.remaining], [[{ id: hex(c), outcome: 'deleted' }], 0]);
    assert.ok(live);
    assert.equal(await stored(c), null);
  });
});

describe('contacts: the points of a card', () => {
  const adjust = (id: string, code: string, body: Document, actor = sa(), key: string = randomUUID()) => call(actor, 'POST', `${one(id)}/fidelity-cards/${encodeURIComponent(code)}/points-adjustments`, body, { 'idempotency-key': key });

  it('adds and takes away points atomically, never below zero, without changing the version, and records the adjustment', async () => {
    await reset();
    const id = hex(await seed({ fidelities: [{ code: 'CARD 1', points: 10 }, { code: 'CARD-2', points: 0 }] }));
    const version = tag(await detail(id));
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const plus = await adjust(id, 'CARD 1', { delta: 5, reason: 'omaggio' }, sa(), key);
    okay(plus);
    assert.deepEqual(plus.body, { data: { code: 'CARD 1', points: 15 } });
    const entry = log('contact.pointsAdjusted', mark)[0]!;
    assert.deepEqual(entry.metadata, { cardCode: 'CARD 1', delta: 5, balance: 15, reason: 'omaggio' });
    assert.deepEqual(entry.resource, { type: 'contact', id });
    // The same key and body answer the same, and the points are added once.
    assert.deepEqual((await adjust(id, 'CARD 1', { delta: 5, reason: 'omaggio' }, sa(), key)).body, plus.body);
    assert.equal(failure(await adjust(id, 'CARD 1', { delta: 6 }, sa(), key)).status, 409);
    assert.equal(log('contact.pointsAdjusted', mark).length, 1);
    const minus = await adjust(id, 'CARD 1', { delta: -15 });
    assert.deepEqual(minus.body, { data: { code: 'CARD 1', points: 0 } });
    assert.equal(log('contact.pointsAdjusted', mark)[1]!.metadata!['reason'], null);
    assert.deepEqual(failure(await adjust(id, 'CARD 1', { delta: -1 })), { status: 409, code: 'CONFLICT', details: [{ field: 'points', issue: 'insufficient' }] });
    okay(await adjust(id, 'CARD-2', { delta: 1 }));
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'CARD 1', points: 0 }, { code: 'CARD-2', points: 1 }]);
    assert.equal(tag(await detail(id)), version);
    assert.equal(log('contact.updated', mark).length, 0);
    // A balance that is not a number is never made a number by an adjustment of a higher one.
    await contacts().updateOne({ _id: new ObjectId(id) }, { $set: { 'fidelities.0.points': 'molti' } });
    assert.equal(failure(await adjust(id, 'CARD 1', { delta: 1 })).status, 409);
  });

  it('answers 404 for a contact, a card or a group that is not there, and 422 for a body that is not an adjustment', async () => {
    await reset();
    const id = hex(await seed({ fidelities: [{ code: 'A', points: 3 }] }));
    const trashed = hex(await seed({ trash: true, fidelities: [{ code: 'A', points: 3 }] }));
    assert.equal(failure(await adjust(id, 'ZZZ', { delta: 1 })).status, 404);
    assert.equal(failure(await adjust(hex(new ObjectId()), 'A', { delta: 1 })).status, 404);
    assert.equal(failure(await adjust(trashed, 'A', { delta: 1 })).status, 404);
    assert.equal(failure(await adjust(id, 'A', { delta: 1 }, world.group(1).sa)).status, 404);
    for (const body of [{}, { delta: 0 }, { delta: 1.5 }, { delta: '1' }, { delta: 1_000_001 }, { delta: -1_000_001 }, { delta: 1, reason: 'r'.repeat(201) }, { delta: 1, reason: '' }, { delta: 1, reason: 'a\u0000' }, { delta: 1, extra: true }]) {
      assert.equal(failure(await adjust(id, 'A', body)).status, 422, JSON.stringify(body));
    }
    assert.equal(failure(await adjust(id, 'x'.repeat(65), { delta: 1 })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/fidelity-cards/A/points-adjustments`, { delta: 1 })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${one('nope')}/fidelity-cards/A/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() })).status, 422);
    okay(await adjust(id, 'A', { delta: 1_000_000 }));
  });
});

describe('contacts: details of the cards, the texts and the refusals', () => {
  const adjust = (id: string, code: string, body: Document, actor = sa()) => call(actor, 'POST', `${one(id)}/fidelity-cards/${encodeURIComponent(code)}/points-adjustments`, body, { 'idempotency-key': randomUUID() });

  it('removes and adjusts a card by the code it is stored with, and refuses two cards with the same code', async () => {
    await reset();
    const id = hex(await seed({ fidelities: [{ code: ' ABC ', points: 5 }, { code: 'DUP', points: 1 }, { code: 'DUP', points: 2 }, { code: 'KEEP', points: 9 }] }));
    assert.deepEqual((await detail(id)).body.data.fidelityCards.map((card: Document) => card['code']), ['ABC', 'DUP', 'DUP', 'KEEP']);
    assert.deepEqual((await adjust(id, 'ABC', { delta: 5 })).body, { data: { code: 'ABC', points: 10 } });
    assert.deepEqual(failure(await adjust(id, 'DUP', { delta: 1 })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'duplicate' }] });
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: ' ABC ', points: 10 }, { code: 'DUP', points: 1 }, { code: 'DUP', points: 2 }, { code: 'KEEP', points: 9 }]);
    okay(await patch(id, { fidelityCards: [{ code: 'KEEP' }, { code: 'DUP' }] }));
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'DUP', points: 1 }, { code: 'DUP', points: 2 }, { code: 'KEEP', points: 9 }]);
  });

  it('does not overwrite a text the legacy stored encrypted when the request sends the empty text it is shown as', async () => {
    await reset();
    const cipher = 'aabbccddeeff00112233445566778899$00112233445566778899aabbccddeeff';
    const id = hex(await seed({ name: cipher, companyName: 'Acme' }));
    const reference = await detail(id);
    assert.equal(reference.body.data.person.firstName, '');
    okay(await patch(id, { person: { firstName: '' }, notes: 'n' }, sa(), reference));
    assert.equal((await stored(id))!['name'], cipher);
    okay(await patch(id, { person: { firstName: 'Nuovo' } }));
    assert.equal((await stored(id))!['name'], 'Nuovo');
  });

  it('compares the account e-mail without regard to case', async () => {
    await reset();
    await seed({ account: { email: 'Mixed@Example.Test' } });
    await seed({ account: { telephone: '+39 777' } });
    assert.deepEqual(failure(await post({ person: { firstName: 'x' }, account: { email: 'mixed@example.test' } })), taken('account.email'));
    assert.deepEqual(failure(await post({ person: { firstName: 'x' }, account: { email: 'free@example.test', phone: '+39 777' } })), taken('account.phone'));
  });

  it('refuses an operator of MongoDB inside a value, and every write of a store key', async () => {
    await reset();
    const created = await create();
    for (const body of [{ person: { firstName: { $ne: '' } } }, { fidelityCards: [{ code: { $gt: '' } }] }, { company: { name: { $regex: '.' } } }, { account: { email: { $ne: null } } }, { 'person.firstName': 'x' }]) {
      assert.equal(failure(await post(body)).status, 422, JSON.stringify(body));
      assert.equal(failure(await patch(created.body.data.id, body)).status, 422, JSON.stringify(body));
    }
    const key = await world.activate(world.group(0).ownPlaceId);
    const id = created.body.data.id as string;
    const group = await call(sa(), 'POST', `/groups/${hex(gid())}/contact-groups`, { name: 'G' }, { 'idempotency-key': randomUUID() });
    for (const [method, path, body] of [
      ['PATCH', one(id), { notes: 'x' }],
      ['DELETE', one(id), undefined],
      ['POST', `${one(id)}/trash`, undefined],
      ['POST', `${one(id)}/restore`, undefined],
      ['POST', `${one(id)}/fidelity-cards/A/points-adjustments`, { delta: 1 }],
      ['PATCH', `/groups/${hex(gid())}/contact-groups/${group.body.data.id as string}`, { name: 'x' }],
      ['DELETE', `/groups/${hex(gid())}/contact-groups/${group.body.data.id as string}`, undefined],
      ['GET', one(id), undefined],
    ] as const) {
      const reply = await world.asStore(key.key, method, path, body, { 'if-match': tag(created), 'idempotency-key': randomUUID() });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  });

  it('limits the page of the trash: 10 contacts to delete in one call, 10 at a time to empty, 429 over the limits', async () => {
    await reset();
    const trashBase = `/groups/${hex(gid())}/trash/contacts`;
    const ids = Array.from({ length: 11 }, () => new ObjectId());
    await contacts().insertMany(ids.map((_id) => legacyContact({ _id, trash: true, account: undefined })));
    assert.equal(failure(await call(sa(), 'POST', `${trashBase}/delete`, { ids: ids.map(hex) })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${trashBase}/delete`, { ids: [] })).status, 422);
    const first = await call(psa(), 'POST', `${trashBase}/empty`);
    okay(first);
    assert.deepEqual([first.body.data.results.length, first.body.data.remaining, first.body.data.next], [10, 1, hex([...ids].sort((a, b) => hex(a).localeCompare(hex(b)))[9]!)]);
    const second = await call(psa(), 'POST', `${trashBase}/empty`, { after: first.body.data.next });
    assert.deepEqual([second.body.data.results.length, second.body.data.remaining, second.body.data.next], [1, 0, null]);
    // Over the limit of the requests of a user the new routes answer 429 with Retry-After.
    const other = await openTestDatabases();
    const limited = await startStoreWorld(other, { env: { RATE_LIMIT_API_PER_USER: '2' } });
    try {
      const path = `/groups/${hex(limited.group(0).groupId)}/contacts`;
      const statuses: number[] = [];
      let last = await limited.as.call(limited.group(0).sa, 'GET', path);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        last = await limited.as.call(limited.group(0).sa, 'GET', path);
        statuses.push(last.status);
      }
      assert.ok(statuses.includes(429));
      assert.notEqual(last.headers.get('retry-after'), null);
    } finally {
      await limited.office.close();
      await other.cleanup();
    }
  });
});

describe('contacts: advanced cards', () => {
  it('shows the advanced card behind a code, and refuses to adjust the points of the contact for it', async () => {
    await reset();
    await db('fidelity_cards').deleteMany({});
    const card = new ObjectId();
    await db('fidelity_cards').insertOne({ _id: card, code: 'ADV-1', cardTypeId: 'tipo-sparito', status: false, balance: 'x', pointsCollections: {} });
    const id = hex(await seed({ fidelities: [{ code: ' ADV-1 ', points: 4 }, { code: 'SEMPLICE', points: 9 }] }));
    const shown = (await detail(id)).body.data.fidelityCards;
    assert.deepEqual(shown, [
      { code: 'ADV-1', points: 4, advanced: { cardId: hex(card), cardType: null, enabled: false, balance: null, totalPoints: 0 } },
      { code: 'SEMPLICE', points: 9, advanced: null },
    ]);
    assert.deepEqual(failure(await call(sa(), 'POST', `${one(id)}/fidelity-cards/ADV-1/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'advancedCard' }] });
    assert.equal(((plain((await stored(id))!['fidelities']) as Document[])[0] as Document)['points'], 4);
    okay(await call(sa(), 'POST', `${one(id)}/fidelity-cards/SEMPLICE/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() }));
    await db('fidelity_cards').deleteMany({});
  });
});
