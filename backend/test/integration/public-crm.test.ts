import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld, MadeKey } from '../helpers/api-keys.ts';
import { legacyCompany, legacyContact } from '../helpers/contacts.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { legacyFullProduct, placeEntry } from '../helpers/products.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: KeysWorld;
let all: MadeKey;
let restricted: MadeKey;
let contactsRead: MadeKey;
let contactsWrite: MadeKey;
let cardsRead: MadeKey;
let cardsWrite: MadeKey;
let cardsBoth: MadeKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const contacts = () => db('contacts');
const cards = () => db('fidelity_cards');
const movements = () => db('fidelity_cards_movements');
const call = (key: MadeKey | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => world.asKey(key?.secret, path, headers, method, body);
const get = (path: string, key: MadeKey = all) => call(key, 'GET', path);
const send = (key: MadeKey, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(key, method, path, body, headers);
const tagOf = (reply: { headers: Headers }) => reply.headers.get('etag')!;
const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((item) => item.id);
const entries = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const stored = (collection: ReturnType<typeof contacts>, id: string | ObjectId) => collection.findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const createContact = (body: Document = {}, key: MadeKey = all, headers: Record<string, string> = {}) => send(key, 'POST', '/contacts', { person: { firstName: 'Mario' }, ...body }, { 'idempotency-key': randomUUID(), ...headers });
const createCard = (body: Document = {}, key: MadeKey = all, headers: Record<string, string> = {}) => send(key, 'POST', '/fidelity-cards', { code: `C-${randomUUID().slice(0, 8)}`, cardTypeId: types.prepaid, ...body }, { 'idempotency-key': randomUUID(), ...headers });
const adjust = (id: string, body: Document, key: MadeKey = all, headers: Record<string, string> = {}) => send(key, 'POST', `/fidelity-cards/${id}/adjustments`, body, { 'idempotency-key': randomUUID(), ...headers });
const types = { prepaid: '', plain: '', collection: '' };
const seed = async (overrides: Document = {}, index = 0): Promise<ObjectId> => {
  const document = legacyContact(overrides);
  await db('contacts', index).insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCompany = async (overrides: Document = {}): Promise<ObjectId> => {
  const document = legacyCompany(overrides);
  await contacts().insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCard = async (overrides: Document = {}): Promise<ObjectId> => {
  const _id = new ObjectId();
  await cards().insertOne({ _id, code: `SEED-${hex(_id)}`, cardTypeId: types.prepaid, status: true, balance: new Double(10), pointsCollections: { [types.collection]: 50 }, insertDate: new Date('2024-01-01T00:00:00Z'), updateDate: new Date('2024-01-01T00:00:00Z'), legacyExtra: 1, ...overrides });
  return _id;
};
/** Every key of a value, at any depth. */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : []);
const PRIVATE_CONTACT_KEYS = ['priceListId', 'eInvoicing', 'notes', 'note', 'supplierPriceLists', 'services', 'account', 'warnings', 'trashedAt', 'password', 'tokens', 'listId', 'fattura_elettronica', 'legacyExtra'];

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY: '1000000', PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_DAILY_QUOTA: '100000', PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA: '100000' } });
  const psa = world.office.cluster.psa;
  const made = async (path: string, body: Document) => {
    const reply = await world.as.call(psa, 'POST', `/groups/${hex(gid())}${path}`, body, { 'idempotency-key': randomUUID() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.data.id as string;
  };
  types.collection = await made('/fidelity/points-collections', { name: 'Attiva' });
  types.prepaid = await made('/fidelity/card-types', { name: 'Prepagata', prepaid: { enabled: true }, pointsCollect: { enabled: true, collectionIds: [types.collection] } });
  types.plain = await made('/fidelity/card-types', { name: 'Semplice' });
  const own = world.group(0).ownPlaceId;
  all = await world.makeKey(0, { name: 'All', permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'] });
  restricted = await world.makeKey(0, { name: 'Restricted', permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'], restrictions: { placeIds: [hex(own)] } });
  contactsRead = await world.makeKey(0, { name: 'Contacts read', permissions: ['contacts:read'] });
  contactsWrite = await world.makeKey(0, { name: 'Contacts write', permissions: ['contacts:write'] });
  cardsRead = await world.makeKey(0, { name: 'Cards read', permissions: ['fidelityCards:read'] });
  cardsWrite = await world.makeKey(0, { name: 'Cards write', permissions: ['fidelityCards:write'] });
  cardsBoth = await world.makeKey(0, { name: 'Cards both', permissions: ['fidelityCards:read', 'fidelityCards:write'] });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([contacts().deleteMany({}), db('contacts_groups').deleteMany({}), cards().deleteMany({}), movements().deleteMany({}), db('contacts', 1).deleteMany({})]);
  await world.setPublicApi(0, { enabled: true });
  world.office.activity.entries.length = 0;
});

describe('the contacts and the cards of the public API: who may call them', () => {
  it('answers 401 to every wrong credential and to a key that is revoked, expired or of a group without the public API', async () => {
    const storeKey = await world.activate(world.group(0).ownPlaceId);
    const tokens = await world.office.tokens('user-001');
    const id = hex(new ObjectId());
    const paths = ['/contacts', `/contacts/${id}`, '/contact-groups', `/contact-groups/${id}`, '/fidelity-cards', `/fidelity-cards/${id}`, `/fidelity-cards/${id}/movements`];
    for (const path of paths) {
      assert.equal((await call(undefined, 'GET', path)).status, 401, path);
      assert.equal((await world.asKey(`fc_pk_${'A'.repeat(43)}`, path)).status, 401, path); // gitleaks:allow (fake test value)
      assert.equal((await world.asKey(storeKey.key, path)).status, 401, `${path} with a store key`);
      assert.equal((await world.asKey(tokens.accessToken, path)).status, 401, `${path} with a user token`);
      const bearer = await fetch(`${world.office.app.baseUrl}/public/v1${path}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      assert.equal(bearer.status, 401, `${path} with a Bearer token`);
    }
    const revoked = await world.makeKey(0, { name: 'Revoked', permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'] });
    const expiring = await world.makeKey(0, { name: 'Expiring', permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'], expiresAt: new Date(world.office.clock.now() + 3600_000).toISOString() });
    assert.equal((await get('/contacts', revoked)).status, 200);
    assert.equal((await world.as.call(world.office.cluster.psa, 'POST', world.keysPath(0, `/${revoked.id}/revoke`))).status, 200);
    await ctx.databases.common().collection('apiKeys').updateOne({ _id: new ObjectId(expiring.id) }, { $set: { expiresAt: new Date(world.office.clock.now()) } });
    for (const key of [revoked, expiring]) {
      for (const path of paths) {
        assert.equal((await get(path, key)).status, 401, path);
      }
      assert.equal((await createContact({}, key)).status, 401);
      assert.equal((await createCard({}, key)).status, 401);
    }
    await world.setPublicApi(0, { enabled: false });
    assert.equal((await get('/contacts')).status, 401);
    assert.equal((await get('/fidelity-cards')).status, 401);
    assert.equal(await contacts().countDocuments({}), 0);
    assert.equal(await cards().countDocuments({}), 0);
  });

  it('answers 403 to a key without the permission of the route, and the write permissions never imply the read ones', async () => {
    const places = await world.makeKey(0, { name: 'Places', permissions: ['places:read', 'catalog:read', 'catalog:write'] });
    const id = hex(new ObjectId());
    const reads = ['/contacts', `/contacts/${id}`, '/contact-groups', `/contact-groups/${id}`];
    const cardReads = ['/fidelity-cards', `/fidelity-cards/${id}`, `/fidelity-cards/${id}/movements`];
    for (const path of reads) {
      for (const key of [contactsWrite, cardsRead, cardsWrite, places]) {
        assert.equal((await get(path, key)).status, 403, path);
      }
    }
    for (const path of cardReads) {
      for (const key of [contactsRead, contactsWrite, cardsWrite, places]) {
        assert.equal((await get(path, key)).status, 403, path);
      }
    }
    const contactWrites = [['POST', '/contacts', { person: { firstName: 'x' } }], ['PATCH', `/contacts/${id}`, { code: 'x' }], ['POST', `/contacts/${id}/trash`, undefined], ['POST', `/contacts/${id}/restore`, undefined]] as const;
    const cardWrites = [['POST', '/fidelity-cards', { code: 'x', cardTypeId: types.plain }], ['PATCH', `/fidelity-cards/${id}`, { enabled: false }], ['POST', `/fidelity-cards/${id}/adjustments`, { balanceDelta: 1 }]] as const;
    for (const [method, path, body] of contactWrites) {
      for (const key of [contactsRead, cardsRead, cardsWrite, places]) {
        assert.equal((await send(key, method, path, body, { 'idempotency-key': randomUUID(), 'if-match': '"x"' })).status, 403, `${method} ${path}`);
      }
    }
    for (const [method, path, body] of cardWrites) {
      for (const key of [contactsRead, contactsWrite, cardsRead, places]) {
        assert.equal((await send(key, method, path, body, { 'idempotency-key': randomUUID(), 'if-match': '"x"' })).status, 403, `${method} ${path}`);
      }
    }
    assert.equal(await contacts().countDocuments({}), 0);
    assert.equal(await cards().countDocuments({}), 0);
  });

  it('has no route to delete for good, to adjust the points of a contact, to import or export, or to write the groups of contacts', async () => {
    const id = hex(new ObjectId());
    for (const [method, path] of [['DELETE', `/contacts/${id}`], ['POST', '/contacts/trash'], ['POST', `/contacts/${id}/fidelity-cards/X/points-adjustments`], ['POST', '/contacts/import'], ['DELETE', `/fidelity-cards/${id}`], ['POST', '/contact-groups'], ['PATCH', `/contact-groups/${id}`], ['DELETE', `/contact-groups/${id}`], ['GET', '/sales']] as const) {
      const reply = await send(all, method, path, method === 'GET' ? undefined : {}, { 'idempotency-key': randomUUID(), 'if-match': '"x"' });
      assert.ok([404, 405].includes(reply.status), `${method} ${path}: ${String(reply.status)}`);
    }
  });
});

describe('the contacts of the public API: reading', () => {
  it('shows a contact field by field, with the tag of its version, and never what the key does not see', async () => {
    const group = new ObjectId();
    const company = await seedCompany({ fidelities: [{ code: 'CARD-1', points: 7 }] });
    await db('contacts_groups').insertOne({ _id: group, name: 'Vip', priceListId: 'secret-list', discountPercentage: 5 });
    const id = await seed({
      cGroupId: group,
      associatedCompanyId: company,
      listId: 'private-list',
      note: 'nota privata',
      companyLists: [{ id: 'sl-1', name: 'Listino fornitore', favorite: true }],
      services: [{ productId: new ObjectId(), duration: '00:30' }],
      fidelities: [{ code: 'CARD-1', points: 120 }, { code: 'ADV-1', points: 0 }],
    });
    const advanced = await seedCard({ code: 'ADV-1', balance: new Double(12.5), pointsCollections: { [types.collection]: 40 } });
    const reply = await get(`/contacts/${hex(id)}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.match(tagOf(reply), /^"[A-Za-z0-9_-]{43}"$/);
    assert.deepEqual(reply.body.data, {
      id: hex(id),
      code: 'K-1',
      customer: true,
      supplier: false,
      displayName: 'Mario Rossi',
      contactGroupId: hex(group),
      person: {
        firstName: 'Mario',
        lastName: 'Rossi',
        taxCode: 'RSSMRA80A01F205X',
        birthDate: '1980-01-01',
        address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', countryCode: 'IT', areaCode: 'MI' },
        phones: ['+39 02 123456'],
        emails: ['mario@example.test'],
        discountPercent: 10,
        associatedCompanyId: hex(company),
      },
      company: { name: '', vatNumber: '', taxCode: '', address: { street: '', postcode: '', city: '', countryCode: null, areaCode: null }, phones: [], emails: [], faxes: [], discountPercent: null },
      fidelityCards: [
        { code: 'CARD-1', advanced: false, points: 120 },
        { code: 'ADV-1', advanced: true, card: { cardId: hex(advanced), cardType: { id: types.prepaid, name: 'Prepagata' }, enabled: true, balance: 12.5, totalPoints: 40 } },
      ],
      trashed: false,
      createdAt: reply.body.data.createdAt,
      updatedAt: reply.body.data.updatedAt,
    });
    assert.deepEqual(keysOf(reply.body).filter((key) => PRIVATE_CONTACT_KEYS.includes(key)), []);
    assert.ok(!JSON.stringify(reply.body).includes('nota privata') && !JSON.stringify(reply.body).includes('Listino fornitore'));
    // The detail of an advanced card needs fidelityCards:read as well: without it the contact only says that the code is one.
    const blind = await get(`/contacts/${hex(id)}`, contactsRead);
    assert.deepEqual(blind.body.data.fidelityCards, [{ code: 'CARD-1', advanced: false, points: 120 }, { code: 'ADV-1', advanced: true }]);
    assert.equal(tagOf(blind), tagOf(reply));
    // A key limited to a place sees the contacts of the whole group, and a contact of another group is never found.
    assert.equal((await get(`/contacts/${hex(id)}`, restricted)).status, 200);
    const foreign = await seed({}, 1);
    assert.equal((await get(`/contacts/${hex(foreign)}`)).status, 404);
    assert.equal((await get(`/contacts/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/contacts/nope')).status, 422);
    assert.equal((await get(`/contacts/${hex(id)}?x=1`)).status, 422);
    assert.deepEqual(ids(await get('/contacts')).includes(hex(foreign)), false);
  });

  it('shows the code of a card that is a simple one with its points, and a company with its own data', async () => {
    const id = await seedCompany({ companyCode: 'IT01234567890', companyAddress: 'Via Po 2', companyCountryCode: 'IT', companyTelephone: ['011 1'], companyEmail: ['a@acme.test'], companyFax: ['011 2'], companyDiscount: new Double(3), fidelities: [] });
    const { data } = (await get(`/contacts/${hex(id)}`)).body;
    assert.equal(data.displayName, 'Acme Srl');
    assert.deepEqual(data.company, { name: 'Acme Srl', vatNumber: 'IT01234567890', taxCode: '', address: { street: 'Via Po 2', postcode: '', city: '', countryCode: 'IT', areaCode: null }, phones: ['011 1'], emails: ['a@acme.test'], faxes: ['011 2'], discountPercent: 3 });
    assert.deepEqual(data.fidelityCards, []);
  });

  it('lists the contacts that are not in the trash, filtered, searched, sorted and paged by cursor, whole', async () => {
    const group = new ObjectId();
    await db('contacts_groups').insertOne({ _id: group, name: 'Vip' });
    const [anna, bruno, supplier, other] = [
      await seed({ name: 'Anna', surname: 'Bianchi', contactCode: 'A-1', cGroupId: group, fidelities: [], updateDate: new Date('2026-01-03T00:00:00Z') }),
      await seed({ name: 'Bruno', surname: 'Verdi', contactCode: 'B-1', fidelities: [], updateDate: new Date('2026-01-01T00:00:00Z') }),
      await seedCompany({ companyName: 'Zeta Srl', customer: false, supplier: true, updateDate: new Date('2026-01-02T00:00:00Z') }),
      await seed({ name: 'Carla', surname: 'Neri', customer: false, supplier: false, fidelities: [], updateDate: new Date('2026-01-04T00:00:00Z') }),
    ];
    const trashed = await seed({ name: 'Dario', surname: 'Gialli', fidelities: [], trash: true, trashDate: new Date('2026-01-05T00:00:00Z'), updateDate: new Date('2026-01-05T00:00:00Z') });
    assert.deepEqual(ids(await get('/contacts')), [hex(anna), hex(bruno), hex(other), hex(supplier)], 'by display name, without the trash');
    assert.deepEqual(ids(await get('/contacts?kind=suppliers')), [hex(supplier)]);
    assert.deepEqual(ids(await get('/contacts?kind=others')), [hex(other)]);
    assert.deepEqual(ids(await get('/contacts?kind=customers&sort=-updatedAt')), [hex(anna), hex(bruno)]);
    assert.deepEqual(ids(await get(`/contacts?contactGroupId=${hex(group)}`)), [hex(anna)]);
    assert.deepEqual(ids(await get('/contacts?q=verdi')), [hex(bruno)]);
    assert.deepEqual(ids(await get('/contacts?trashed=true')), [hex(trashed)]);
    assert.deepEqual(ids(await get('/contacts?trashed=false')), [hex(anna), hex(bruno), hex(other), hex(supplier)]);
    const first = await get('/contacts?limit=3');
    assert.equal(first.body.data.length, 3);
    assert.ok(first.body.page.next);
    assert.deepEqual(keysOf(first.body).filter((key) => PRIVATE_CONTACT_KEYS.includes(key)), []);
    assert.equal(first.body.data[0].person.address.city, 'Milano', 'every contact comes whole');
    const second = await get(`/contacts?limit=3&cursor=${first.body.page.next}`);
    assert.deepEqual([...ids(first), ...ids(second)], [hex(anna), hex(bruno), hex(other), hex(supplier)]);
    assert.equal(second.body.page.next, null);
    assert.equal((await get('/contacts?limit=51')).status, 422);
    assert.equal((await get('/contacts?kind=x')).status, 422);
    assert.equal((await get('/contacts?cursor=nope')).status, 422);
    assert.equal((await get('/contacts?sort=priceListId')).status, 422);
    assert.equal((await get('/contacts?updatedSince=ieri')).status, 422);
    assert.equal((await get('/contacts?priceListId=x')).status, 422);
    assert.deepEqual(ids(await get('/contacts', restricted)).length, 4);
  });

  it('tells what changed from an instant on, in the order of the last change, the trash included, and a state when it is asked', async () => {
    const [old, recent, gone] = [
      await seed({ name: 'Vecchio', fidelities: [], updateDate: new Date('2026-01-01T00:00:00Z') }),
      await seed({ name: 'Recente', fidelities: [], updateDate: new Date('2026-01-10T00:00:00Z') }),
      await seed({ name: 'Rimosso', fidelities: [], trash: true, trashDate: new Date('2026-01-12T00:00:00Z'), updateDate: new Date('2026-01-12T00:00:00Z') }),
    ];
    assert.deepEqual(ids(await get('/contacts?updatedSince=2026-01-05')), [hex(recent), hex(gone)]);
    assert.deepEqual(ids(await get('/contacts?updatedSince=2026-01-05&sort=-updatedAt')), [hex(gone), hex(recent)]);
    assert.deepEqual(ids(await get('/contacts?updatedSince=2026-01-05&trashed=false')), [hex(recent)]);
    assert.deepEqual(ids(await get('/contacts?updatedSince=2026-01-05&trashed=true')), [hex(gone)]);
    assert.deepEqual(ids(await get('/contacts?updatedSince=2026-01-01T00:00:00.000Z')), [hex(old), hex(recent), hex(gone)]);
    assert.equal((await get('/contacts?updatedSince=2026-01-05')).body.data[1].trashed, true);
  });
});

describe('the groups of contacts of the public API', () => {
  it('shows the name and the discount of a group, never its price list, and lists them sorted and paged', async () => {
    const [vip, base] = [new ObjectId(), new ObjectId()];
    await db('contacts_groups').insertMany([
      { _id: vip, name: 'Vip', priceListId: 'secret-list', discountPercentage: new Double(5), insertDate: new Date('2026-01-01T00:00:00Z'), updateDate: new Date('2026-01-02T00:00:00Z') },
      { _id: base, name: 'Base', priceListId: null, discountPercentage: null, insertDate: new Date('2026-01-01T00:00:00Z'), updateDate: new Date('2026-01-03T00:00:00Z') },
    ]);
    const list = await get('/contact-groups');
    assert.deepEqual(list.body.data, [{ id: hex(base), name: 'Base', discountPercent: null }, { id: hex(vip), name: 'Vip', discountPercent: 5 }]);
    assert.deepEqual(keysOf(list.body).filter((key) => ['priceListId', 'contactsCount', 'createdAt', 'updatedAt'].includes(key)), []);
    assert.deepEqual(ids(await get('/contact-groups?sort=-name')), [hex(vip), hex(base)]);
    assert.deepEqual(ids(await get('/contact-groups?q=vi')), [hex(vip)]);
    const first = await get('/contact-groups?limit=1');
    assert.deepEqual([ids(first), ids(await get(`/contact-groups?limit=1&cursor=${first.body.page.next}`))], [[hex(base)], [hex(vip)]]);
    const one = await get(`/contact-groups/${hex(vip)}`, restricted);
    assert.deepEqual(one.body.data, { id: hex(vip), name: 'Vip', discountPercent: 5 });
    assert.ok(tagOf(one));
    assert.equal((await get(`/contact-groups/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/contact-groups/nope')).status, 422);
    assert.equal((await get('/contact-groups?limit=101')).status, 422);
    assert.equal((await get('/contact-groups?trashed=true')).status, 422);
  });
});

describe('the contacts of the public API: writing', () => {
  it('creates a contact, idempotently and bound to the key, and answers with its public representation, without warnings', async () => {
    const mark = world.office.activity.entries.length;
    await seed({ contactCode: 'DUP-1', code: 'RSSMRA80A01F205X', fidelities: [] });
    const body = { code: 'DUP-1', customer: true, person: { firstName: 'Luisa', lastName: 'Gialli', taxCode: 'rssmra80a01f205x', emails: ['luisa@example.test'] }, fidelityCards: [{ code: 'NEW-1' }] };
    const key = randomUUID();
    const first = await send(all, 'POST', '/contacts', body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.headers.get('location')!, new RegExp(`/public/v1/contacts/${first.body.data.id}$`));
    assert.ok(tagOf(first));
    assert.equal(first.body.data.person.taxCode, 'RSSMRA80A01F205X');
    assert.deepEqual(first.body.data.fidelityCards, [{ code: 'NEW-1', advanced: false, points: 0 }]);
    assert.deepEqual(keysOf(first.body).filter((name) => PRIVATE_CONTACT_KEYS.includes(name)), [], 'the duplicates of the code and the tax code are not told');
    assert.equal(await contacts().countDocuments({}), 2);
    const replay = await send(all, 'POST', '/contacts', body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body, tagOf(replay)], [201, first.body, tagOf(first)]);
    assert.equal(await contacts().countDocuments({}), 2, 'the same key writes once');
    assert.equal((await send(all, 'POST', '/contacts', { ...body, code: 'other' }, { 'idempotency-key': key })).status, 409);
    // Another key does not read what the first one was answered: its request is its own.
    const other = await send(restricted, 'POST', '/contacts', body, { 'idempotency-key': key });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.data.id, first.body.data.id);
    assert.equal(await contacts().countDocuments({}), 3);
    assert.equal((await send(all, 'POST', '/contacts', body)).status, 422, 'the key of idempotency is required');
    assert.equal((await send(all, 'POST', '/contacts', { person: {} }, { 'idempotency-key': randomUUID() })).status, 422, 'a contact has a name or a company name');
    const [event] = entries('contact.created', mark);
    assert.deepEqual([event!.actor.kind, event!.actor.id?.toHexString(), event!.metadata?.['keyHint']], ['apiKey', all.id, all.secret.slice(6, 12)]);
    assert.ok(event!.changes!.every((change) => change.redacted === true), 'the values are personal data: only the names of the fields are recorded');
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(all.secret));
    assert.equal((await stored(contacts(), first.body.data.id as string))!['priceListId' as never], undefined);
  });

  it('refuses the fields the key does not see, in the creation and in the modification, and writes nothing', async () => {
    const made = await createContact();
    const tag = tagOf(made);
    const hidden: Document[] = [
      { priceListId: 'x' },
      { notes: 'x' },
      { eInvoicing: { pec: 'a@pec.test' } },
      { account: { email: 'a@example.test' } },
      { services: [] },
      { company: { name: 'Acme', supplierPriceLists: [{ name: 'x' }] } },
      { warnings: [] },
      { trashed: true },
      { id: hex(new ObjectId()) },
      { createdAt: '2026-01-01' },
      { $set: { code: 'x' } },
      { person: { firstName: 'x', $where: '1' } },
      { 'person.firstName': 'x' },
    ];
    for (const body of hidden) {
      const create = await createContact(body);
      assert.equal(create.status, 422, JSON.stringify(body));
      const patched = await send(all, 'PATCH', `/contacts/${made.body.data.id}`, body, { 'if-match': tag });
      assert.equal(patched.status, 422, JSON.stringify(body));
    }
    assert.equal(await contacts().countDocuments({}), 1);
    assert.equal((await send(all, 'PATCH', `/contacts/${made.body.data.id}`, {}, { 'if-match': tag })).status, 422, 'at least one field');
  });

  it('modifies what the key sees and keeps, as they are, the fields it does not see', async () => {
    const mark = world.office.activity.entries.length;
    const company = await seedCompany({ fidelities: [] });
    const id = await seed({
      listId: 'private-list',
      note: 'nota privata',
      companyName: 'Acme Srl',
      companyLists: [{ id: 'sl-1', name: 'Listino fornitore', favorite: true }],
      services: [{ productId: new ObjectId(), duration: '00:30' }],
      fidelities: [{ code: 'CARD-1', points: 120 }],
    });
    const before = (await stored(contacts(), id))!;
    const read = await get(`/contacts/${hex(id)}`);
    const patched = await send(all, 'PATCH', `/contacts/${hex(id)}`, { person: { firstName: 'Marco', address: { city: 'Torino' }, associatedCompanyId: hex(company) }, company: { phones: ['011 9'] } }, { 'if-match': tagOf(read) });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.person.firstName, 'Marco');
    assert.deepEqual([patched.body.data.person.address.city, patched.body.data.person.address.street, patched.body.data.person.lastName], ['Torino', 'Via Roma 1', 'Rossi']);
    assert.notEqual(tagOf(patched), tagOf(read));
    const after = (await stored(contacts(), id))!;
    for (const field of ['listId', 'note', 'companyLists', 'services', 'fattura_elettronica', 'account', 'legacyExtra', 'fidelities', 'cGroup', 'companyName']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal(after['name'], 'Marco');
    assert.deepEqual(after['companyTelephone'], ['011 9']);
    // The stale tag is refused, a request that changes nothing writes nothing, and a missing tag is a validation error.
    assert.equal((await send(all, 'PATCH', `/contacts/${hex(id)}`, { code: 'X' }, { 'if-match': tagOf(read) })).status, 412);
    assert.equal((await send(all, 'PATCH', `/contacts/${hex(id)}`, { code: 'X' })).status, 422);
    assert.equal((await send(all, 'PATCH', `/contacts/${hex(id)}`, { code: 'X' }, { 'if-match': 'x' })).status, 422);
    const same = await send(all, 'PATCH', `/contacts/${hex(id)}`, { person: { firstName: 'Marco' } }, { 'if-match': tagOf(patched) });
    assert.equal(tagOf(same), tagOf(patched));
    assert.equal(entries('contact.updated', mark).length, 1);
    assert.equal(entries('contact.updated', mark)[0]!.metadata?.['keyHint'], all.secret.slice(6, 12));
    assert.equal((await send(all, 'PATCH', `/contacts/${hex(new ObjectId())}`, { code: 'X' }, { 'if-match': tagOf(patched) })).status, 404);
    assert.equal((await send(all, 'PATCH', `/contacts/${hex(id)}`, { contactGroupId: hex(new ObjectId()) }, { 'if-match': tagOf(patched) })).status, 422, 'a group of contacts that does not exist');
    // A key limited to a place changes any contact of the group.
    assert.equal((await send(restricted, 'PATCH', `/contacts/${hex(id)}`, { code: 'P-1' }, { 'if-match': tagOf(patched) })).status, 200);
  });

  it('sends a contact to the trash and takes it out, with the tag of its version, and never deletes one', async () => {
    const mark = world.office.activity.entries.length;
    const made = await createContact();
    const id = made.body.data.id as string;
    const trashed = await send(all, 'POST', `/contacts/${id}/trash`, undefined, { 'if-match': tagOf(made) });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    assert.equal(trashed.body.data.trashed, true);
    assert.equal(trashed.body.data.trashedAt, undefined);
    assert.equal((await send(all, 'POST', `/contacts/${id}/trash`, undefined, { 'if-match': tagOf(trashed) })).status, 409);
    assert.equal((await send(all, 'PATCH', `/contacts/${id}`, { code: 'x' }, { 'if-match': tagOf(trashed) })).status, 409, 'a contact in the trash is not modified');
    assert.deepEqual(ids(await get('/contacts')), []);
    assert.deepEqual(ids(await get('/contacts?updatedSince=2000-01-01')), [id]);
    assert.equal((await get(`/contacts/${id}`)).body.data.trashed, true);
    const restored = await send(all, 'POST', `/contacts/${id}/restore`, undefined, { 'if-match': tagOf(trashed) });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.trashed, false);
    assert.equal((await send(all, 'POST', `/contacts/${id}/restore`, undefined, { 'if-match': tagOf(restored) })).status, 409);
    assert.equal((await send(all, 'POST', `/contacts/${id}/trash`, undefined)).status, 422);
    assert.equal((await send(all, 'POST', `/contacts/${id}/trash`, undefined, { 'if-match': tagOf(made) })).status, 412);
    for (const action of ['contact.created', 'contact.trashed', 'contact.restored']) {
      assert.ok(entries(action, mark).length >= 1 && entries(action, mark).every((entry) => entry.actor.kind === 'apiKey' && entry.metadata?.['keyHint'] === all.secret.slice(6, 12)), action);
    }
    assert.equal(await contacts().countDocuments({}), 1);
  });

  it('knows the metadata the entries of the writes of a key carry', () => {
    for (const action of ['contact.created', 'contact.updated', 'contact.trashed', 'contact.restored', 'fidelityCard.created', 'fidelityCard.updated', 'fidelityCard.adjusted']) {
      assert.ok(ACTION_CATALOG.get(action)!.metadataKeys.includes('keyHint'), action);
    }
    for (const action of ['contact.deleted', 'contact.pointsAdjusted', 'fidelityCard.deleted']) {
      assert.ok(!ACTION_CATALOG.get(action)!.metadataKeys.includes('keyHint'), action);
    }
  });
});

describe('the advanced cards of the public API: reading', () => {
  it('shows a card with its points, its credit and the tag of its version, and names its contacts only to a key that reads them', async () => {
    const [mario, anna] = [await seed({ name: 'Mario', surname: 'Rossi', fidelities: [{ code: 'CARD-X', points: 0 }] }), await seed({ name: 'Anna', surname: 'Bianchi', fidelities: [{ code: ' CARD-X ', points: 0 }] })];
    const id = await seedCard({ code: 'CARD-X', balance: new Double(12.345), pointsCollections: { [types.collection]: 30, ghost: 5 } });
    const full = await get(`/fidelity-cards/${hex(id)}`);
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.match(tagOf(full), /^"[A-Za-z0-9_-]{43}"$/);
    assert.deepEqual(full.body.data, {
      id: hex(id),
      code: 'CARD-X',
      cardType: { id: types.prepaid, name: 'Prepagata', enabled: true, prepaid: true, pointsCollect: true },
      enabled: true,
      balance: 12.35,
      points: [{ collectionId: types.collection, name: 'Attiva', points: 30, active: true }],
      totalPoints: 30,
      contactsCount: 2,
      contacts: [{ id: hex(mario), displayName: 'Mario Rossi' }, { id: hex(anna), displayName: 'Anna Bianchi' }],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const blind = await get(`/fidelity-cards/${hex(id)}`, cardsRead);
    assert.equal(blind.status, 200);
    const { contacts: _named, ...unnamed } = full.body.data;
    assert.deepEqual(blind.body.data, unnamed);
    assert.ok(!('contacts' in blind.body.data));
    assert.equal(tagOf(blind), tagOf(full));
    assert.deepEqual(keysOf(full.body).filter((key) => ['cardTypeId', 'userId', 'status', 'pointsCollections', 'legacyExtra'].includes(key)), []);
    assert.equal((await get(`/fidelity-cards/${hex(id)}`, restricted)).status, 200, 'a key limited to a place reads the cards of the group');
    const gone = await seedCard({ code: 'GONE', cardTypeId: 'missing-type' });
    assert.equal((await get(`/fidelity-cards/${hex(gone)}`)).body.data.cardType, null);
    assert.equal((await get(`/fidelity-cards/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/fidelity-cards/nope')).status, 422);
    assert.equal((await get(`/fidelity-cards/${hex(id)}?x=1`)).status, 422);
    await db('fidelity_cards', 1).insertOne({ _id: new ObjectId(), code: 'FOREIGN', cardTypeId: 'x', status: true });
    assert.deepEqual((await get('/fidelity-cards?q=FOREIGN')).body.data, []);
  });

  it('lists the cards, filtered, searched by code (and by the name of a contact only for a key that reads the contacts), sorted and paged', async () => {
    await seed({ name: 'Mario', surname: 'Rossi', fidelities: [{ code: 'BBB', points: 0 }] });
    const [a, b, c] = [await seedCard({ code: 'AAA', cardTypeId: types.plain, balance: new Double(0), pointsCollections: {}, status: false }), await seedCard({ code: 'BBB' }), await seedCard({ code: 'CCC' })];
    assert.deepEqual(ids(await get('/fidelity-cards')), [hex(a), hex(b), hex(c)]);
    assert.deepEqual(ids(await get('/fidelity-cards?sort=-code')), [hex(c), hex(b), hex(a)]);
    assert.deepEqual(ids(await get(`/fidelity-cards?cardTypeId=${types.plain}`)), [hex(a)]);
    assert.deepEqual(ids(await get('/fidelity-cards?enabled=false')), [hex(a)]);
    assert.deepEqual(ids(await get('/fidelity-cards?enabled=true')), [hex(b), hex(c)]);
    assert.deepEqual(ids(await get('/fidelity-cards?q=ccc')), [hex(c)]);
    assert.deepEqual(ids(await get('/fidelity-cards?q=rossi')), [hex(b)], 'the name of a contact finds its card');
    assert.deepEqual(ids(await get('/fidelity-cards?q=rossi', cardsRead)), [], 'a key that may not read the contacts cannot look for them');
    assert.deepEqual(ids(await get('/fidelity-cards?q=bbb', cardsRead)), [hex(b)]);
    const row = (await get('/fidelity-cards?q=bbb')).body.data[0];
    assert.deepEqual(row, { id: hex(b), code: 'BBB', cardType: { id: types.prepaid, name: 'Prepagata' }, enabled: true, balance: 10, totalPoints: 50, contactsCount: 1, contact: { id: row.contact.id, displayName: 'Mario Rossi' }, createdAt: '2024-01-01T00:00:00.000Z' });
    const unread = (await get('/fidelity-cards?q=bbb', cardsRead)).body.data[0];
    assert.deepEqual(Object.keys(unread).sort(), ['balance', 'cardType', 'code', 'contactsCount', 'createdAt', 'enabled', 'id', 'totalPoints']);
    assert.equal((await get('/fidelity-cards?q=ccc')).body.data[0].contact, null);
    const first = await get('/fidelity-cards?limit=2');
    assert.deepEqual([...ids(first), ...ids(await get(`/fidelity-cards?limit=2&cursor=${first.body.page.next}`))], [hex(a), hex(b), hex(c)]);
    assert.equal((await get('/fidelity-cards?limit=101')).status, 422);
    assert.equal((await get('/fidelity-cards?enabled=x')).status, 422);
    assert.equal((await get('/fidelity-cards?sort=balance')).status, 422);
    assert.equal((await get('/fidelity-cards?contactId=x')).status, 422);
    assert.equal((await get('/fidelity-cards', restricted)).body.data.length, 3);
  });
});

describe('the advanced cards of the public API: writing', () => {
  it('creates a card with its credit and points as movements without a user, idempotently and bound to the key', async () => {
    const mark = world.office.activity.entries.length;
    const body = { code: 'NEW-1', cardTypeId: types.prepaid, initialBalance: 25.5, initialPoints: [{ collectionId: types.collection, points: 10 }] };
    const key = randomUUID();
    const first = await send(cardsBoth, 'POST', '/fidelity-cards', body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.headers.get('location')!, new RegExp(`/public/v1/fidelity-cards/${first.body.data.id}$`));
    assert.ok(tagOf(first));
    assert.equal(first.body.data.balance, 25.5);
    assert.equal(first.body.data.totalPoints, 10);
    assert.ok(!('contacts' in first.body.data), 'the contacts are not named to a key that does not read them');
    const rows = await movements().find({}, { ...EXACT_TYPES }).toArray();
    assert.deepEqual((plain(rows.map((row) => [row['userId'], row['type'], row['balance'], row['points'], row['cardCode']])) as unknown[]).sort(), [[null, 'manually', 0, 10, 'NEW-1'], [null, 'manually', 25.5, 0, 'NEW-1']]);
    assert.ok(rows.every((row) => row['userId'] === null && row['apiKeyId'] instanceof ObjectId && hex(row['apiKeyId']) === cardsBoth.id), 'the movements name the key, not a user');
    const replay = await send(cardsBoth, 'POST', '/fidelity-cards', body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body], [201, first.body]);
    assert.equal(await cards().countDocuments({}), 1);
    assert.equal(await movements().countDocuments({}), 2, 'the same key writes once');
    assert.equal((await send(cardsBoth, 'POST', '/fidelity-cards', { ...body, code: 'NEW-2' }, { 'idempotency-key': key })).status, 409);
    // Another key with the same Idempotency-Key is another request: here, the code is taken.
    const other = await send(all, 'POST', '/fidelity-cards', body, { 'idempotency-key': key });
    assert.equal(other.status, 409);
    assert.deepEqual(other.body.error.details, [{ field: 'code', issue: 'taken' }]);
    assert.equal((await send(cardsBoth, 'POST', '/fidelity-cards', body)).status, 422, 'the key of idempotency is required');
    const [event] = entries('fidelityCard.created', mark);
    assert.deepEqual([event!.actor.kind, event!.actor.id?.toHexString(), event!.metadata?.['keyHint']], ['apiKey', cardsBoth.id, cardsBoth.secret.slice(6, 12)]);
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(cardsBoth.secret));
  });

  it('refuses a type that does not exist, a credit on a card that is not prepaid, a code that is not valid and the fields that are not the key\'s', async () => {
    for (const [body, field] of [[{ cardTypeId: 'nope' }, 'cardTypeId'], [{ cardTypeId: types.plain, initialBalance: 5 }, 'initialBalance'], [{ initialPoints: [{ collectionId: 'nope', points: 1 }] }, 'initialPoints.0.collectionId']] as const) {
      const reply = await createCard(body as Document);
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.equal(reply.body.error.details[0].field, field);
    }
    for (const body of [{ code: '' }, { code: 'a|b' }, { initialBalance: 0 }, { initialBalance: 1.234 }, { userId: hex(new ObjectId()) }, { balance: 5 }, { id: 'x' }, { $set: { code: 'x' } }, { contactIds: ['nope'] }]) {
      assert.equal((await createCard(body)).status, 422, JSON.stringify(body));
    }
    assert.equal(await cards().countDocuments({}), 0);
    assert.equal(await movements().countDocuments({}), 0);
  });

  it('gives a card to contacts at its creation only to a key that may write the contacts', async () => {
    const mario = await seed({ name: 'Mario', surname: 'Rossi', fidelities: [] });
    for (const body of [{ contactIds: [hex(mario)] }, { contactIds: [] }]) {
      assert.equal((await createCard(body, cardsBoth)).status, 403, JSON.stringify(body));
      assert.equal((await createCard(body, cardsWrite)).status, 403, JSON.stringify(body));
    }
    assert.equal(await cards().countDocuments({}), 0);
    assert.deepEqual((await stored(contacts(), mario))!['fidelities'], []);
    const withContacts = await createCard({ code: 'LINK-1', contactIds: [hex(mario)] }, all);
    assert.equal(withContacts.status, 201, JSON.stringify(withContacts.body));
    assert.deepEqual(withContacts.body.data.contacts, [{ id: hex(mario), displayName: 'Mario Rossi' }]);
    assert.deepEqual(plain((await stored(contacts(), mario))!['fidelities']), [{ code: 'LINK-1', points: 0 }]);
    // The contact now says that the code is an advanced card, with its detail only to a key that reads the cards.
    assert.equal((await get(`/contacts/${hex(mario)}`)).body.data.fidelityCards[0].card.cardId, withContacts.body.data.id);
    assert.deepEqual((await get(`/contacts/${hex(mario)}`, contactsRead)).body.data.fidelityCards, [{ code: 'LINK-1', advanced: true }]);
    assert.equal((await createCard({ contactIds: [hex(new ObjectId())] }, all)).status, 422, 'a contact that does not exist');
    assert.equal((await createCard({ contactIds: [hex(mario)] }, contactsWrite)).status, 403, 'and the cards are the other key\'s');
  });

  it('changes the type and the state of a card with its tag, never its code', async () => {
    const mark = world.office.activity.entries.length;
    const made = await createCard({ code: 'UPD-1', initialPoints: [{ collectionId: types.collection, points: 5 }] });
    const id = made.body.data.id as string;
    const patched = await send(all, 'PATCH', `/fidelity-cards/${id}`, { enabled: false }, { 'if-match': tagOf(made) });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.enabled, false);
    assert.notEqual(tagOf(patched), tagOf(made));
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${id}`, { enabled: true }, { 'if-match': tagOf(made) })).status, 412);
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${id}`, { enabled: true })).status, 422);
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${id}`, { code: 'OTHER' }, { 'if-match': tagOf(patched) })).status, 422);
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${id}`, {}, { 'if-match': tagOf(patched) })).status, 422);
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${id}`, { cardTypeId: 'nope' }, { 'if-match': tagOf(patched) })).status, 422);
    assert.equal((await send(all, 'PATCH', `/fidelity-cards/${hex(new ObjectId())}`, { enabled: true }, { 'if-match': tagOf(patched) })).status, 404);
    const moved = await send(cardsBoth, 'PATCH', `/fidelity-cards/${id}`, { cardTypeId: types.plain, enabled: true }, { 'if-match': tagOf(patched) });
    assert.equal(moved.status, 200);
    const [event] = entries('fidelityCard.updated', mark);
    assert.deepEqual([event!.actor.kind, event!.metadata?.['keyHint']], ['apiKey', all.secret.slice(6, 12)]);
  });

  it('adjusts the credit and the points, never below zero, idempotently and bound to the key, with the key as the operator', async () => {
    const mark = world.office.activity.entries.length;
    const made = await createCard({ code: 'ADJ-1', initialBalance: 10, initialPoints: [{ collectionId: types.collection, points: 5 }] });
    const id = made.body.data.id as string;
    const key = randomUUID();
    const adjusted = await adjust(id, { balanceDelta: -4.5, pointsDeltas: [{ collectionId: types.collection, delta: 7 }], reason: 'rimborso' }, cardsBoth, { 'idempotency-key': key });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.deepEqual([adjusted.body.data.balance, adjusted.body.data.totalPoints], [5.5, 12]);
    assert.equal(tagOf(adjusted), tagOf(made), 'the credit and the points are not part of the version');
    const replay = await adjust(id, { balanceDelta: -4.5, pointsDeltas: [{ collectionId: types.collection, delta: 7 }], reason: 'rimborso' }, cardsBoth, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body], [200, adjusted.body]);
    assert.equal((await get(`/fidelity-cards/${id}`)).body.data.balance, 5.5, 'the same key adjusts once');
    assert.equal((await adjust(id, { balanceDelta: -1 }, cardsBoth, { 'idempotency-key': key })).status, 409, 'the same key with another body');
    // The same Idempotency-Key from another key is another request: it moves the credit once more.
    assert.equal((await adjust(id, { balanceDelta: -4.5, pointsDeltas: [{ collectionId: types.collection, delta: 7 }], reason: 'rimborso' }, all, { 'idempotency-key': key })).status, 200);
    assert.equal((await get(`/fidelity-cards/${id}`)).body.data.balance, 1);
    const short = await adjust(id, { balanceDelta: -5 });
    assert.equal(short.status, 409);
    assert.deepEqual(short.body.error.details, [{ field: 'balance', issue: 'insufficient' }]);
    assert.equal((await adjust(id, { pointsDeltas: [{ collectionId: types.collection, delta: -100 }] })).status, 409);
    assert.equal((await adjust(id, { balanceDelta: 0 })).status, 422);
    assert.equal((await adjust(id, {})).status, 422);
    assert.equal((await adjust(id, { balanceDelta: 1 }, all, { 'idempotency-key': 'not-a-uuid' })).status, 422);
    assert.equal((await send(all, 'POST', `/fidelity-cards/${id}/adjustments`, { balanceDelta: 1 })).status, 422, 'the key of idempotency is required');
    assert.equal((await adjust(hex(new ObjectId()), { balanceDelta: 1 })).status, 404);
    const plain = await createCard({ code: 'PLAIN-1', cardTypeId: types.plain });
    assert.equal((await adjust(plain.body.data.id as string, { balanceDelta: 1 })).status, 422, 'a credit on a card that is not prepaid');
    // Every movement of a key has no user.
    const rows = await movements().find({ cardCode: 'ADJ-1' }, { ...EXACT_TYPES }).toArray();
    assert.equal(rows.length, 6);
    assert.ok(rows.every((row) => row['userId'] === null && row['type'] === 'manually' && row['apiKeyId'] instanceof ObjectId && [all.id, cardsBoth.id].includes(hex(row['apiKeyId']))));
    const events = entries('fidelityCard.adjusted', mark);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.actor.kind === 'apiKey' && event.metadata?.['keyHint'] !== undefined));
    assert.deepEqual(events.map((event) => event.actor.id?.toHexString()).sort(), [all.id, cardsBoth.id].sort());
  });

  it('shows the movements of a card, newest first, with the name of the user who made one and none for a key', async () => {
    const office = await world.as.call(world.group(0).sa, 'POST', `/groups/${hex(gid())}/fidelity-cards`, { code: 'MOV-1', cardTypeId: types.prepaid, initialBalance: 20 }, { 'idempotency-key': randomUUID() });
    assert.equal(office.status, 201, JSON.stringify(office.body));
    const id = office.body.data.id as string;
    assert.equal((await adjust(id, { balanceDelta: 3, pointsDeltas: [{ collectionId: types.collection, delta: 2 }] })).status, 200);
    const reply = await get(`/fidelity-cards/${id}/movements`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.length, 3);
    const byOperator = reply.body.data.map((movement: { operator: unknown }) => movement.operator);
    assert.deepEqual(byOperator.filter((operator: { kind: string } | null) => operator?.kind === 'apiKey'), [{ kind: 'apiKey', name: 'All' }, { kind: 'apiKey', name: 'All' }]);
    const user = byOperator.find((operator: { kind: string } | null) => operator?.kind === 'user');
    assert.deepEqual(Object.keys(user).sort(), ['kind', 'name']);
    // A revoked key stays readable by its name, and a movement of a sale has no operator.
    assert.equal((await world.as.call(world.office.cluster.psa, 'POST', world.keysPath(0, `/${all.id}/revoke`))).status, 200);
    const sale = new ObjectId();
    await movements().insertOne({ userId: null, cardId: new ObjectId(id), cardCode: 'MOV-1', date: new Date('2000-01-01T00:00:00Z'), type: 'sale', balance: -1, pointsCollectionId: null, points: 0, _id: sale });
    const afterRevoke = await get(`/fidelity-cards/${id}/movements?limit=50`, cardsBoth);
    assert.deepEqual(afterRevoke.body.data.map((movement: { operator: unknown }) => movement.operator).filter((operator: unknown) => operator === null).length, 1);
    assert.equal(afterRevoke.body.data.filter((movement: { operator: { kind: string } | null }) => movement.operator?.kind === 'apiKey').length, 2);
    all = await world.makeKey(0, { name: 'All', permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'] });
    const withPoints = reply.body.data.find((movement: { collection: unknown }) => movement.collection !== null);
    assert.deepEqual(withPoints.collection, { id: types.collection, name: 'Attiva' });
    assert.deepEqual(Object.keys(withPoints).sort(), ['balance', 'collection', 'date', 'id', 'operator', 'points', 'type']);
    assert.deepEqual(keysOf(reply.body).filter((key) => ['userId', 'cardId', 'cardCode', 'pointsCollectionId'].includes(key)), []);
    const first = await get(`/fidelity-cards/${id}/movements?limit=2`);
    assert.equal(first.body.data.length, 2);
    assert.equal((await get(`/fidelity-cards/${id}/movements?cursor=${first.body.page.next}`)).body.data.length, 2);
    assert.equal((await get(`/fidelity-cards/${hex(new ObjectId())}/movements`)).status, 404);
    assert.equal((await get(`/fidelity-cards/${id}/movements?limit=101`)).status, 422);
    assert.equal((await get(`/fidelity-cards/${id}/movements?sort=date`)).status, 422);
  });
});

describe('the contacts and the cards of the public API: the limit of the writes', () => {
  it('is one budget of writes per key, shared by the contacts and the cards, with 429 before the body is read, and the reads are not limited', async () => {
    const small = await openTestDatabases();
    const keys = await startKeysWorld(small, { env: { RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await keys.makeKey(0, { permissions: ['contacts:read', 'contacts:write', 'fidelityCards:read', 'fidelityCards:write'] });
      const first = await keys.asKey(key.secret, '/contacts', { 'idempotency-key': randomUUID() }, 'POST', { person: { firstName: 'Uno' } });
      const second = await keys.asKey(key.secret, '/contacts', { 'idempotency-key': randomUUID() }, 'POST', { person: { firstName: 'Due' } });
      const third = await keys.asKey(key.secret, '/fidelity-cards', { 'idempotency-key': randomUUID() }, 'POST', { code: 'X', cardTypeId: 'y' });
      assert.deepEqual([first.status, second.status, third.status], [201, 201, 429]);
      assert.ok(third.headers.get('retry-after'));
      assert.equal((await keys.asKey(key.secret, '/fidelity-cards', { 'idempotency-key': randomUUID(), 'content-type': 'text/plain' }, 'POST')).status, 429);
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await keys.asKey(key.secret, '/contacts')).status, 200);
      }
    } finally {
      await keys.office.close();
      await small.cleanup();
    }
  });
});

describe('the contacts and the cards of the public API: the codes of the advanced cards', () => {
  it('asks fidelityCards:write too to give a contact the code of an advanced card or to take it away, and the contacts:write alone for a simple one', async () => {
    const mark = world.office.activity.entries.length;
    await seedCard({ code: 'ADV-1' });
    const readsCards = await world.makeKey(0, { name: 'Contacts and cards read', permissions: ['contacts:write', 'fidelityCards:read'] });
    const id = await seed({ name: 'Mario', fidelities: [{ code: 'SIMPLE-1', points: 5 }, { code: 'ADV-1', points: 0 }] });
    const patch = (key: MadeKey, body: Document, tag: string) => send(key, 'PATCH', `/contacts/${hex(id)}`, body, { 'if-match': tag });
    const tag = async () => tagOf(await get(`/contacts/${hex(id)}`));
    for (const key of [contactsWrite, readsCards]) {
      assert.equal((await patch(key, { fidelityCards: [{ code: 'SIMPLE-1' }] }, await tag())).status, 403, 'taking the advanced code away');
      assert.equal((await patch(key, { fidelityCards: [{ code: 'SIMPLE-1' }, { code: 'ADV-1' }, { code: 'NEW' }] }, await tag())).status, 200, 'the codes as they are, and a new simple one');
    }
    assert.deepEqual(plain((await stored(contacts(), id))!['fidelities']), [{ code: 'SIMPLE-1', points: 5 }, { code: 'ADV-1', points: 0 }, { code: 'NEW', points: 0 }]);
    await seedCard({ code: 'ADV-2' });
    for (const key of [contactsWrite, readsCards]) {
      assert.equal((await patch(key, { fidelityCards: [{ code: 'SIMPLE-1' }, { code: 'ADV-1' }, { code: 'NEW' }, { code: 'ADV-2' }] }, await tag())).status, 403, 'adding an advanced code');
      assert.equal((await createContact({ fidelityCards: [{ code: 'ADV-2' }] }, key)).status, 403, 'creating with an advanced code');
    }
    assert.equal(await contacts().countDocuments({}), 1);
    assert.deepEqual(plain((await stored(contacts(), id))!['fidelities']), [{ code: 'SIMPLE-1', points: 5 }, { code: 'ADV-1', points: 0 }, { code: 'NEW', points: 0 }]);
    assert.equal((await createContact({ fidelityCards: [{ code: 'SIMPLE-2' }] }, contactsWrite)).status, 201);
    const allowed = await patch(all, { fidelityCards: [{ code: 'SIMPLE-1' }, { code: 'NEW' }, { code: 'ADV-2' }] }, await tag());
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal((await createContact({ fidelityCards: [{ code: 'ADV-1' }] }, all)).status, 201);
    assert.ok(entries('contact.updated', mark).every((entry) => entry.actor.kind === 'apiKey'));
  });
});

describe('the contacts and the cards of the public API: a restricted key stays restricted elsewhere', () => {
  it('sees every contact and card of the group and, in the same suite, only its own places, companies and products', async () => {
    const own = world.group(0).ownPlaceId;
    const elsewhere = world.group(0).otherPlaceId;
    const companyOfOwn = (await ctx.databases.common().collection('places').findOne({ _id: own }))!['companyId'] as ObjectId;
    const narrow = await world.makeKey(0, { name: 'Narrow', permissions: ['places:read', 'companies:read', 'catalog:read', 'contacts:read', 'fidelityCards:read'], restrictions: { placeIds: [hex(own)] } });
    const products = ctx.databases.group(gid(), 'cluster0').collection('products');
    await products.deleteMany({});
    const mine = legacyFullProduct({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own)] });
    const theirs = legacyFullProduct({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(elsewhere)] });
    await products.insertMany([mine, theirs]);
    await seed({ fidelities: [] });
    await seedCard();
    try {
      assert.equal((await get('/contacts', narrow)).body.data.length, 1);
      assert.equal((await get('/fidelity-cards', narrow)).body.data.length, 1);
      assert.deepEqual(ids(await get('/places', narrow)), [hex(own)]);
      assert.ok((await get('/companies', narrow)).body.data.every((company: { id: string }) => company.id === hex(companyOfOwn)));
      assert.equal((await get(`/places/${hex(elsewhere)}`, narrow)).status, 404);
      assert.deepEqual(ids(await get('/products', narrow)), [hex(mine['_id'] as ObjectId)]);
      assert.equal((await get(`/products/${hex(theirs['_id'] as ObjectId)}`, narrow)).status, 404);
    } finally {
      await products.deleteMany({});
    }
  });
});
