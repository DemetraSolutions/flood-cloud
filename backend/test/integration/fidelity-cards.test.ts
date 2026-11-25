import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const sa = () => world.group(0).sa;
const psa = () => world.office.cluster.psa;
const gid = () => world.group(0).groupId;
const group = (rest = '') => `/groups/${hex(gid())}${rest}`;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/fidelity-cards`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const cards = () => db('fidelity_cards');
const movements = () => db('fidelity_cards_movements');
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const okay = (reply: Awaited<ReturnType<typeof call>>, status = 200) => assert.equal(reply.status, status, JSON.stringify(reply.body));
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const stored = (id: string | ObjectId) => cards().findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const post = (body: Document, actor = sa()) => call(actor, 'POST', base(), body, { 'idempotency-key': randomUUID() });
const patch = async (id: string, body: Document, reference?: Awaited<ReturnType<typeof call>>) => call(sa(), 'PATCH', one(id), body, { 'if-match': tag(reference ?? (await call(sa(), 'GET', one(id)))) });
const adjust = (id: string, body: Document, actor = sa(), key: string = randomUUID()) => call(actor, 'POST', `${one(id)}/adjustments`, body, { 'idempotency-key': key });
const detail = async (id: string) => {
  const reply = await call(sa(), 'GET', one(id));
  okay(reply);
  return reply;
};
const num = (value: unknown): unknown => (value instanceof Double || value instanceof Int32 ? value.valueOf() : value);
const reset = async () => {
  await cards().deleteMany({});
  await movements().deleteMany({});
  await db('contacts').deleteMany({});
};
const seed = async (overrides: Document = {}) => {
  const _id = new ObjectId();
  await cards().insertOne({ _id, code: `SEED-${hex(_id)}`, cardTypeId: ids.prepaid, status: true, balance: new Double(10), pointsCollections: { [ids.active]: 50 }, insertDate: new Date('2024-01-01T00:00:00Z'), updateDate: new Date('2024-01-01T00:00:00Z'), legacyExtra: 1, ...overrides });
  return _id;
};
const ids = { active: '', disabled: '', expired: '', foreign: '', prepaid: '', plain: '', both: '' };

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx);
  const create = async (path: string, body: Document) => {
    const reply = await call(psa(), 'POST', group(path), body, { 'idempotency-key': randomUUID() });
    okay(reply, 201);
    return reply.body.data.id as string;
  };
  ids.active = await create('/fidelity/points-collections', { name: 'Attiva' });
  ids.disabled = await create('/fidelity/points-collections', { name: 'Spenta', enabled: false });
  ids.expired = await create('/fidelity/points-collections', { name: 'Scaduta', dateTo: '2020-01-01T00:00:00Z' });
  ids.foreign = await create('/fidelity/points-collections', { name: 'Fuori tipo' });
  ids.prepaid = await create('/fidelity/card-types', { name: 'Prepagata', prepaid: { enabled: true }, pointsCollect: { enabled: true, collectionIds: [ids.active, ids.disabled, ids.expired] } });
  ids.plain = await create('/fidelity/card-types', { name: 'Semplice' });
  ids.both = await create('/fidelity/card-types', { name: 'Solo punti', pointsCollect: { enabled: true, collectionIds: [ids.active] } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('fidelity cards: access', () => {
  it('follows fidelity:read and fidelity:update, keeps the groups apart and is closed to a store key', async () => {
    await reset();
    const created = await post({ code: 'ACC-1', cardTypeId: ids.prepaid });
    okay(created, 201);
    const id = created.body.data.id as string;
    for (const actor of [psa(), world.office.cluster.dealerA, sa(), world.group(0).ca, world.group(0).pa]) {
      okay(await call(actor, 'GET', base()));
    }
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(id, 1))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', '/groups/x/fidelity-cards')).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('nope'))).status, 422);
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { fidelity: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { fidelity: { r: false, w: false } } }) });
    okay(await call(reader.id, 'GET', base()));
    okay(await call(reader.id, 'GET', `${one(id)}/movements`));
    for (const [method, path, body] of [['POST', base(), { code: 'X', cardTypeId: ids.plain }], ['PATCH', one(id), { enabled: false }], ['DELETE', one(id), undefined], ['POST', `${one(id)}/adjustments`, { balanceDelta: 1 }]] as const) {
      assert.equal(failure(await call(reader.id, method, path, body, { 'if-match': tag(created), 'idempotency-key': randomUUID() })).status, 403, `${method} ${path}`);
    }
    assert.equal(failure(await call(blind.id, 'GET', base())).status, 403);
    const key = await world.activate(world.group(0).ownPlaceId);
    for (const [method, path, body] of [['GET', base(), undefined], ['POST', base(), { code: 'S', cardTypeId: ids.plain }], ['GET', one(id), undefined], ['PATCH', one(id), { enabled: false }], ['DELETE', one(id), undefined], ['POST', `${one(id)}/adjustments`, { balanceDelta: 1 }], ['GET', `${one(id)}/movements`, undefined]] as const) {
      assert.equal((await world.asStore(key.key, method, path, body, { 'if-match': tag(created), 'idempotency-key': randomUUID() })).status, 403, `${method} ${path}`);
    }
  });
});

describe('fidelity cards: creation and reading', () => {
  it('creates a card with its credit, its points and its contacts, as movements of the operator, and shows it with its ETag', async () => {
    await reset();
    const [first, second] = [new ObjectId(), new ObjectId()];
    await db('contacts').insertMany([legacyContact({ _id: first, name: 'Anna', surname: 'Bianchi', fidelities: [] }), legacyContact({ _id: second, name: '', surname: '', companyName: 'Zeta Srl', fidelities: undefined }), legacyContact({ trash: true, fidelities: [] })]);
    const before = (await db('contacts').findOne({ _id: first }))!['updateDate'] as Date;
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const body = { code: ' FAM-1 ', cardTypeId: ids.prepaid, initialBalance: 12.5, initialPoints: [{ collectionId: ids.active, points: 100 }, { collectionId: ids.disabled, points: 5 }], contactIds: [hex(first), hex(second)] };
    const reply = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    okay(reply, 201);
    assert.equal(reply.headers.get('location'), `/v1${base()}/${reply.body.data.id as string}`);
    const data = reply.body.data;
    assert.deepEqual([data.code, data.cardTypeId, data.enabled, data.balance, data.totalPoints, data.contactsCount], ['FAM-1', ids.prepaid, true, 12.5, 100, 2]);
    assert.deepEqual(data.cardType, { id: ids.prepaid, name: 'Prepagata', enabled: true, prepaid: true, pointsCollect: true });
    assert.deepEqual(data.points, [{ collectionId: ids.active, name: 'Attiva', points: 100, active: true }, { collectionId: ids.disabled, name: 'Spenta', points: 5, active: false }]);
    assert.deepEqual(data.contacts, [{ id: hex(first), displayName: 'Anna Bianchi' }, { id: hex(second), displayName: 'Zeta Srl' }]);
    const document = (await stored(data.id))!;
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'balance', 'cardTypeId', 'code', 'insertDate', 'pointsCollections', 'status', 'updateDate']);
    assert.ok(document['balance'] instanceof Double);
    assert.deepEqual(plain(document['pointsCollections']), { [ids.active]: 100, [ids.disabled]: 5 });
    const history = await movements().find({ cardId: new ObjectId(data.id) }).sort({ _id: 1 }).toArray();
    assert.deepEqual(history.map((entry) => [entry['type'], entry['balance'], entry['points'], entry['pointsCollectionId'], entry['cardCode']]), [['manually', 12.5, 0, null, 'FAM-1'], ['manually', 0, 100, ids.active, 'FAM-1'], ['manually', 0, 5, ids.disabled, 'FAM-1']]);
    assert.ok(history.every((entry) => (entry['userId'] as ObjectId).equals(sa()) && entry['date'] instanceof Date && (entry['cardId'] as ObjectId).equals(new ObjectId(data.id))));
    // The contacts have the code, with zero points, and a new date; the one in the trash does not.
    for (const contact of [first, second]) {
      const linked = (await db('contacts').findOne({ _id: contact }))!;
      assert.deepEqual(plain(linked['fidelities']), [{ code: 'FAM-1', points: 0 }]);
    }
    assert.ok(((await db('contacts').findOne({ _id: first }))!['updateDate'] as Date) > before);
    assert.equal((await db('contacts').find({ 'fidelities.code': 'FAM-1' }).toArray()).length, 2);
    const entry = log('fidelityCard.created', mark)[0]!;
    assert.deepEqual(entry.metadata, { contactsCount: 2 });
    assert.ok(!JSON.stringify(entry).includes('Bianchi') && !JSON.stringify(entry).includes('Zeta'));
    assert.equal((await call(sa(), 'POST', base(), body, { 'idempotency-key': key })).body.data.id, data.id);
    assert.equal(tag(await detail(data.id)), tag(reply));
    // The contact now shows the card as an advanced one.
    const shown = await call(sa(), 'GET', `/groups/${hex(gid())}/contacts/${hex(first)}`);
    assert.deepEqual(shown.body.data.fidelityCards, [{ code: 'FAM-1', points: 0, advanced: { cardId: data.id, cardType: { id: ids.prepaid, name: 'Prepagata' }, enabled: true, balance: 12.5, totalPoints: 100 } }]);
    // A card with only a code and a type has no movement, no contact, and a credit of zero.
    const bare = await post({ code: 'BARE', cardTypeId: ids.plain, enabled: false });
    okay(bare, 201);
    assert.deepEqual([bare.body.data.enabled, bare.body.data.balance, bare.body.data.points, bare.body.data.contacts, bare.body.data.contactsCount], [false, 0, [], [], 0]);
    assert.equal(await movements().countDocuments({ cardCode: 'BARE' }), 0);
    assert.equal(log('fidelityCard.created', mark)[1]!.metadata!['contactsCount'], 0);
  });

  it('refuses what is not valid: the code, the type, the credit and the points where the type does not allow them, the contacts', async () => {
    await reset();
    const contact = new ObjectId();
    await db('contacts').insertOne(legacyContact({ _id: contact, fidelities: [] }));
    const cases: Array<[string, Document, Array<[string, string]>]> = [
      ['an empty body', {}, [['code', 'required'], ['cardTypeId', 'required']]],
      ['a code of dots', { code: '..', cardTypeId: ids.plain }, [['code', 'format']]],
      ['a code too long', { code: 'c'.repeat(65), cardTypeId: ids.plain }, [['code', 'maxLength']]],
      ['an unknown key', { code: 'x', cardTypeId: ids.plain, balance: 5 }, [['balance', 'unknown']]],
      ['a type that does not exist', { code: 'x', cardTypeId: 'nessuno' }, [['cardTypeId', 'incorrect']]],
      ['a type that is not an id', { code: 'x', cardTypeId: 'no spaces' }, [['cardTypeId', 'pattern']]],
      ['a credit on a type that is not prepaid', { code: 'x', cardTypeId: ids.plain, initialBalance: 5 }, [['initialBalance', 'notAllowed']]],
      ['points on a type that does not collect them', { code: 'x', cardTypeId: ids.plain, initialPoints: [{ collectionId: ids.active, points: 5 }] }, [['initialPoints.0.collectionId', 'notAllowed']]],
      ['points on a collection that is not the type\'s', { code: 'x', cardTypeId: ids.prepaid, initialPoints: [{ collectionId: ids.foreign, points: 5 }, { collectionId: 'sparita', points: 5 }] }, [['initialPoints.0.collectionId', 'notAllowed'], ['initialPoints.1.collectionId', 'incorrect']]],
      ['a credit of zero, over the limit or with three decimals', { code: 'x', cardTypeId: ids.prepaid, initialBalance: 0 }, [['initialBalance', 'minimum']]],
      ['a credit over the limit', { code: 'x', cardTypeId: ids.prepaid, initialBalance: 1_000_001 }, [['initialBalance', 'maximum']]],
      ['a credit with three decimals', { code: 'x', cardTypeId: ids.prepaid, initialBalance: 1.005 }, [['initialBalance', 'format']]],
      ['points that are not positive whole numbers', { code: 'x', cardTypeId: ids.prepaid, initialPoints: [{ collectionId: ids.active, points: 0 }, { collectionId: ids.disabled, points: 1.5 }] }, [['initialPoints.0.points', 'minimum'], ['initialPoints.1.points', 'type']]],
      ['a collection twice', { code: 'x', cardTypeId: ids.prepaid, initialPoints: [{ collectionId: ids.active, points: 1 }, { collectionId: ids.active, points: 2 }] }, [['initialPoints.1.collectionId', 'incorrect']]],
      ['a contact that does not exist or is in the trash', { code: 'x', cardTypeId: ids.plain, contactIds: [hex(contact), hex(new ObjectId())] }, [['contactIds.1', 'incorrect']]],
      ['a contact twice', { code: 'x', cardTypeId: ids.plain, contactIds: [hex(contact), hex(contact)] }, [['contactIds.1', 'incorrect']]],
      ['too many contacts', { code: 'x', cardTypeId: ids.plain, contactIds: Array.from({ length: 21 }, () => hex(new ObjectId())) }, [['contactIds', 'tooMany']]],
    ];
    for (const [name, body, expected] of cases) {
      assert.deepEqual(failure(await post(body)), issues(...expected), name);
    }
    okay(await post({ code: 'DUP', cardTypeId: ids.plain }), 201);
    assert.deepEqual(failure(await post({ code: 'DUP', cardTypeId: ids.plain })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'taken' }] });
    assert.equal(await cards().countDocuments({ code: 'x' }), 0);
    assert.equal(failure(await call(sa(), 'POST', base(), { code: 'N', cardTypeId: ids.plain })).status, 422);
  });

  it('reads a legacy card tolerantly and shows only what the group describes', async () => {
    await reset();
    const id = await seed({ code: 'LEG-1', cardTypeId: 'tipo-sparito', balance: 'molto', pointsCollections: { [ids.active]: 'tanti', [ids.expired]: 7, sconosciuta: 9, [ids.disabled]: 3 }, status: 'sì' });
    const data = (await detail(hex(id))).body.data;
    assert.deepEqual([data.cardType, data.cardTypeId, data.enabled, data.balance, data.totalPoints], [null, 'tipo-sparito', false, null, 0]);
    assert.deepEqual(data.points, [{ collectionId: ids.active, name: 'Attiva', points: 0, active: true }, { collectionId: ids.disabled, name: 'Spenta', points: 3, active: false }, { collectionId: ids.expired, name: 'Scaduta', points: 7, active: false }]);
    assert.ok(!JSON.stringify(data).includes('legacyExtra') && !JSON.stringify(data).includes('sconosciuta'));
    const odd = await seed({ code: 5, cardTypeId: 7, balance: new Double(1.005), pointsCollections: 'x' });
    const row = (await call(sa(), 'GET', base())).body.data.find((item: Document) => item['id'] === hex(odd));
    assert.deepEqual([row.code, row.cardType, row.totalPoints, row.contact, row.contactsCount, row.balance], ['', null, 0, null, 0, 1]);
    assert.equal(failure(await call(sa(), 'GET', one(new ObjectId()))).status, 404);
    // A card whose code is not a text: shown with an empty code, its history and its deletion look for that.
    const detailOdd = await call(sa(), 'GET', one(odd));
    assert.equal(detailOdd.body.data.code, '');
    assert.equal((await call(sa(), 'GET', `${one(odd)}/movements`)).body.data.length, 0);
    assert.equal((await call(sa(), 'DELETE', one(odd), undefined, { 'if-match': tag(detailOdd) })).status, 204);
  });

  it('shows the contacts that already had the code once, and links only the ones that did not', async () => {
    await reset();
    const [had, fresh] = [new ObjectId(), new ObjectId()];
    await db('contacts').insertMany([legacyContact({ _id: had, name: 'Prima', fidelities: [{ code: 'PRE-1', points: 4 }] }), legacyContact({ _id: fresh, name: 'Dopo', fidelities: [] })]);
    const created = await post({ code: 'PRE-1', cardTypeId: ids.plain, contactIds: [hex(had), hex(fresh)] });
    okay(created, 201);
    assert.deepEqual([created.body.data.contactsCount, created.body.data.contacts.map((contact: Document) => contact['displayName'])], [2, ['Prima Rossi', 'Dopo Rossi']]);
    assert.deepEqual(plain((await db('contacts').findOne({ _id: had }))!['fidelities']), [{ code: 'PRE-1', points: 4 }]);
    assert.equal(log('fidelityCard.created', 0).at(-1)!.metadata!['contactsCount'], 1);
  });

  it('shares a card among several contacts and finds them by their code', async () => {
    await reset();
    const id = await seed({ code: 'FAMIGLIA' });
    await db('contacts').insertMany([
      legacyContact({ name: 'Zeno', surname: 'Rossi', fidelities: [{ code: ' FAMIGLIA ', points: 1 }] }),
      legacyContact({ name: 'Anna', surname: 'Rossi', fidelities: [{ code: 'FAMIGLIA', points: 2 }, { points: 1 }, 'x'] }),
      legacyContact({ name: 'Cestinato', fidelities: [{ code: 'FAMIGLIA', points: 2 }], trash: true }),
      legacyContact({ name: 'Rotto', fidelities: { code: 'FAMIGLIA' } }),
    ]);
    const data = (await detail(hex(id))).body.data;
    assert.deepEqual([data.contactsCount, data.contacts.map((contact: Document) => contact['displayName']).sort()], [2, ['Anna Rossi', 'Zeno Rossi']]);
    const rows = (await call(sa(), 'GET', base())).body.data;
    assert.deepEqual([rows[0].contactsCount, rows[0].contact !== null], [1, true]);
  });
});

describe('fidelity cards: lists', () => {
  const codes = (reply: Awaited<ReturnType<typeof call>>) => (reply.body.data as Array<Document>).map((row) => row['code']);

  it('lists, filters and searches by code and by the name of a contact, and sorts before it cuts the page', async () => {
    await reset();
    const created = new Date('2024-02-01T00:00:00Z');
    for (const [index, code] of ['B-2', 'a-1', 'C-3', 'D-4'].entries()) {
      await seed({ code, cardTypeId: index === 3 ? ids.plain : ids.prepaid, status: index !== 2, insertDate: new Date(created.getTime() + index * 1000), updateDate: new Date(created.getTime() - index * 1000) });
    }
    await db('contacts').insertMany([legacyContact({ name: 'Maria', surname: 'Verdi', fidelities: [{ code: 'C-3', points: 0 }, { code: 'D-4', points: 0 }] }), legacyContact({ name: 'Marco', fidelities: [{ code: 'D-4', points: 0 }] }), legacyContact({ name: 'Mariano', fidelities: [{ points: 1 }] }), legacyContact({ name: 'Marina', fidelities: 'rotto' })]);
    const list = (query = '') => call(sa(), 'GET', `${base()}${query}`);
    assert.deepEqual(codes(await list()), ['B-2', 'C-3', 'D-4', 'a-1']);
    assert.deepEqual(codes(await list('?sort=-code')), ['a-1', 'D-4', 'C-3', 'B-2']);
    assert.deepEqual(codes(await list('?sort=createdAt')), ['B-2', 'a-1', 'C-3', 'D-4']);
    assert.deepEqual(codes(await list('?sort=-updatedAt')), ['B-2', 'a-1', 'C-3', 'D-4']);
    assert.deepEqual(codes(await list(`?cardTypeId=${ids.plain}`)), ['D-4']);
    assert.deepEqual(codes(await list('?enabled=false')), ['C-3']);
    assert.deepEqual(codes(await list('?enabled=true&sort=code')), ['B-2', 'D-4', 'a-1']);
    assert.deepEqual(codes(await list('?q=A-1')), ['a-1']);
    assert.deepEqual(codes(await list('?q=verdi')), ['C-3', 'D-4']);
    assert.deepEqual(codes(await list('?q=mar')), ['C-3', 'D-4']);
    assert.deepEqual(codes(await list(`?q=${encodeURIComponent('.*')}`)), []);
    assert.deepEqual(codes(await list('?q=nessuno')), []);
    const row = (await list('?q=maria')).body.data.find((item: Document) => item['code'] === 'C-3');
    assert.deepEqual(Object.keys(row).sort(), ['balance', 'cardType', 'code', 'contact', 'contactsCount', 'createdAt', 'enabled', 'id', 'totalPoints']);
    assert.deepEqual([row.cardType, row.contact.displayName, row.contactsCount, row.balance, row.totalPoints, row.enabled], [{ id: ids.prepaid, name: 'Prepagata' }, 'Maria Verdi', 1, 10, 50, false]);
    // The page is cut after the sort: walking the pages gives the whole sorted list.
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const reply = await list(`?limit=3&sort=-code${cursor === null ? '' : `&cursor=${cursor}`}`);
      seen.push(...codes(reply));
      cursor = reply.body.page.next;
      if (cursor === null) {
        break;
      }
    }
    assert.deepEqual(seen, ['a-1', 'D-4', 'C-3', 'B-2']);
    for (const query of ['limit=0', 'limit=101', 'sort=balance', `q=${'a'.repeat(101)}`, 'q=', 'q[$ne]=x', 'enabled=maybe', 'cardTypeId=no spaces', 'cursor=!', 'x=1']) {
      assert.equal(failure(await list(`?${query}`)).status, 422, query);
    }
  });
});

describe('fidelity cards: modification', () => {
  it('changes the type and the state with If-Match, never the code, and writes nothing for a request that changes nothing', async () => {
    await reset();
    const created = await post({ code: 'MOD-1', cardTypeId: ids.prepaid });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const reply = await patch(id, { cardTypeId: ids.both, enabled: false }, created);
    okay(reply);
    assert.deepEqual([reply.body.data.cardTypeId, reply.body.data.enabled], [ids.both, false]);
    assert.notEqual(tag(reply), tag(created));
    assert.deepEqual(log('fidelityCard.updated', mark)[0]!.changes!.map((change) => [change.field, change.before, change.after]).sort(), [['cardTypeId', ids.prepaid, ids.both], ['enabled', true, false]]);
    assert.equal(tag(await detail(id)), tag(reply));
    const same = await patch(id, { cardTypeId: ids.both, enabled: false }, reply);
    assert.equal(tag(same), tag(reply));
    assert.equal(log('fidelityCard.updated', mark).length, 1);
    assert.deepEqual(failure(await patch(id, { code: 'ALTRO' })), issues(['code', 'notAllowed']));
    assert.deepEqual(failure(await patch(id, { cardTypeId: 'sparito' })), issues(['cardTypeId', 'incorrect']));
    assert.equal(failure(await patch(id, { enabled: true }, created)).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: true })).status, 422);
    assert.equal(failure(await patch(id, {})).status, 422);
    assert.equal(failure(await patch(hex(new ObjectId()), { enabled: true }, created)).status, 404);
    assert.equal((await stored(id))!['code'], 'MOD-1');
  });

  it('keeps the credit and the points a sale moves between the read and the write, and never changes the version with them', async () => {
    await reset();
    const id = hex(await seed({ code: 'SALE-1' }));
    const reference = await detail(id);
    await cards().updateOne({ _id: new ObjectId(id) }, { $inc: { balance: 5, [`pointsCollections.${ids.active}`]: 20 } });
    okay(await patch(id, { enabled: false }, reference));
    const after = (await stored(id))!;
    assert.deepEqual([num(after['balance']), plain(after['pointsCollections'])], [15, { [ids.active]: 70 }]);
    assert.equal(tag(await detail(id)), tag(await detail(id)));
    const version = tag(await detail(id));
    await cards().updateOne({ _id: new ObjectId(id) }, { $inc: { balance: 1 } });
    assert.equal(tag(await detail(id)), version);
    await cards().updateOne({ _id: new ObjectId(id) }, { $set: { status: true } });
    assert.notEqual(tag(await detail(id)), version);
  });
});

describe('fidelity cards: adjustments', () => {
  it('adds and takes away credit and points atomically, with a movement for each, and never below zero', async () => {
    await reset();
    const id = hex(await seed({ code: 'ADJ-1', balance: new Double(10), pointsCollections: { [ids.active]: 5 } }));
    const version = tag(await detail(id));
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const first = await adjust(id, { balanceDelta: 2.5, pointsDeltas: [{ collectionId: ids.active, delta: -5 }, { collectionId: ids.disabled, delta: 7 }], reason: 'cassa' }, sa(), key);
    okay(first);
    assert.deepEqual([first.body.data.balance, first.body.data.points.map((item: Document) => [item['collectionId'], item['points']])], [12.5, [[ids.active, 0], [ids.disabled, 7]]]);
    assert.equal(tag(first), version);
    const entry = log('fidelityCard.adjusted', mark)[0]!;
    assert.deepEqual(entry.metadata, { reason: 'cassa' });
    assert.deepEqual(entry.changes!.map((change) => [change.field, change.before, change.after]).sort(), [['balance', 10, 12.5], [`points.${ids.active}`, 5, 0], [`points.${ids.disabled}`, 0, 7]].sort());
    const history = await movements().find({ cardCode: 'ADJ-1' }).sort({ _id: 1 }).toArray();
    assert.deepEqual(history.map((item) => [item['balance'], item['points'], item['pointsCollectionId']]), [[2.5, 0, null], [0, -5, ids.active], [0, 7, ids.disabled]]);
    assert.ok(history.every((item) => (item['userId'] as ObjectId).equals(sa()) && item['type'] === 'manually' && item['date'] instanceof Date));
    // The same key and body answer the same and move nothing twice.
    assert.deepEqual((await adjust(id, { balanceDelta: 2.5, pointsDeltas: [{ collectionId: ids.active, delta: -5 }, { collectionId: ids.disabled, delta: 7 }], reason: 'cassa' }, sa(), key)).body.data.balance, 12.5);
    assert.equal(await movements().countDocuments({ cardCode: 'ADJ-1' }), 3);
    assert.equal(failure(await adjust(id, { balanceDelta: 1 }, sa(), key)).status, 409);
    // Down to zero is fine, below is not; a collection the card has no key for starts at the delta.
    okay(await adjust(id, { balanceDelta: -12.5 }));
    assert.deepEqual(failure(await adjust(id, { balanceDelta: -0.01 })), { status: 409, code: 'CONFLICT', details: [{ field: 'balance', issue: 'insufficient' }] });
    assert.deepEqual(failure(await adjust(id, { balanceDelta: -1, pointsDeltas: [{ collectionId: ids.active, delta: -1 }, { collectionId: ids.expired, delta: 3 }] })), { status: 409, code: 'CONFLICT', details: [{ field: 'balance', issue: 'insufficient' }, { field: `points.${ids.active}`, issue: 'insufficient' }] });
    assert.equal(num((await stored(id))!['balance']), 0);
    assert.equal(await movements().countDocuments({ cardCode: 'ADJ-1' }), 4);
    okay(await adjust(id, { pointsDeltas: [{ collectionId: ids.expired, delta: 3 }] }));
    assert.deepEqual(plain((await stored(id))!['pointsCollections']), { [ids.active]: 0, [ids.disabled]: 7, [ids.expired]: 3 });
    // A card that is switched off can still be adjusted, and nothing but the points and the credit changes.
    await patch(id, { enabled: false });
    okay(await adjust(id, { balanceDelta: 1 }));
    assert.equal(log('fidelityCard.adjusted', mark)[1]!.metadata!['reason'], null);
  });

  it('refuses a credit on a type that is not prepaid, points on a collection that is not the type\'s, an empty or invalid body, and values that are not numbers', async () => {
    await reset();
    const plainCard = hex(await seed({ cardTypeId: ids.plain }));
    const prepaid = hex(await seed({ code: 'BAD-1', balance: 'x', pointsCollections: { [ids.active]: 'y' } }));
    const gone = hex(await seed({ code: 'BAD-2', cardTypeId: 'sparito' }));
    assert.deepEqual(failure(await adjust(plainCard, { balanceDelta: 1 })), issues(['balanceDelta', 'notAllowed']));
    assert.deepEqual(failure(await adjust(plainCard, { pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })), issues(['pointsDeltas.0.collectionId', 'notAllowed']));
    assert.deepEqual(failure(await adjust(gone, { balanceDelta: 1, pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })), issues(['balanceDelta', 'notAllowed'], ['pointsDeltas.0.collectionId', 'notAllowed']));
    assert.deepEqual(failure(await adjust(prepaid, { pointsDeltas: [{ collectionId: ids.foreign, delta: 1 }] })), issues(['pointsDeltas.0.collectionId', 'notAllowed']));
    for (const [body, field, issue] of [
      [{}, '(body)', 'required'],
      [{ reason: 'solo motivo' }, '(body)', 'required'],
      [{ balanceDelta: 0 }, 'balanceDelta', 'incorrect'],
      [{ balanceDelta: 0.001 }, 'balanceDelta', 'format'],
      [{ balanceDelta: 1_000_001 }, 'balanceDelta', 'maximum'],
      [{ balanceDelta: -1_000_001 }, 'balanceDelta', 'minimum'],
      [{ pointsDeltas: [] }, 'pointsDeltas', 'minLength'],
      [{ pointsDeltas: [{ collectionId: ids.active, delta: 0 }] }, 'pointsDeltas.0.delta', 'incorrect'],
      [{ pointsDeltas: [{ collectionId: ids.active, delta: 1.5 }] }, 'pointsDeltas.0.delta', 'type'],
      [{ pointsDeltas: [{ collectionId: ids.active, delta: 1 }, { collectionId: ids.active, delta: 2 }] }, 'pointsDeltas.1.collectionId', 'incorrect'],
      [{ balanceDelta: 1, reason: 'r'.repeat(201) }, 'reason', 'maxLength'],
      [{ balanceDelta: 1, reason: '' }, 'reason', 'minLength'],
      [{ balanceDelta: 1, extra: true }, 'extra', 'unknown'],
    ] as Array<[Document, string, string]>) {
      assert.deepEqual(failure(await adjust(prepaid, body)), issues([field, issue]), JSON.stringify(body));
    }
    // Credit and points that are not numbers are never adjusted: not even upwards for the points.
    assert.equal(failure(await adjust(prepaid, { balanceDelta: -1 })).status, 409);
    assert.deepEqual(failure(await adjust(prepaid, { balanceDelta: -1, pointsDeltas: [{ collectionId: ids.active, delta: -1 }] })).details, [{ field: 'balance', issue: 'insufficient' }, { field: `points.${ids.active}`, issue: 'insufficient' }]);
    assert.equal(failure(await adjust(prepaid, { pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })).status, 409);
    assert.equal(failure(await adjust(hex(new ObjectId()), { balanceDelta: 1 })).status, 404);
    assert.equal(failure(await call(sa(), 'POST', `${one(prepaid)}/adjustments`, { balanceDelta: 1 })).status, 422);
    assert.equal(failure(await adjust(prepaid, { balanceDelta: 1 }, world.group(1).sa)).status, 404);
    const odd = hex(await seed({ code: 'ODD', pointsCollections: null }));
    await cards().updateOne({ _id: new ObjectId(odd) }, { $unset: { balance: '' } });
    assert.equal(failure(await adjust(odd, { pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })).status, 409);
    okay(await adjust(odd, { balanceDelta: 3 }));
    assert.equal(num((await stored(odd))!['balance']), 3);
  });
});

describe('fidelity cards: movements and deletion', () => {
  it('lists the movements newest first by the card or by its code, with the collection and the operator', async () => {
    await reset();
    const id = await seed({ code: 'HIST-1' });
    const user = world.group(0).sa;
    const stranger = new ObjectId();
    const keyId = new ObjectId();
    const ghostKey = new ObjectId();
    await ctx.databases.common().collection('apiKeys').insertOne({ _id: keyId, groupId: gid(), name: 'Webshop', status: 'revoked' });
    await movements().insertMany([
      { userId: user, cardId: id, cardCode: 'HIST-1', date: new Date('2024-01-01T00:00:00Z'), type: 'manually', balance: 5, pointsCollectionId: null, points: 0 },
      { userId: stranger, cardId: new ObjectId(), cardCode: 'HIST-1', date: new Date('2024-01-02T00:00:00Z'), type: 'sale', balance: -1, pointsCollectionId: ids.active, points: 3 },
      { userId: 'testo', cardId: id, cardCode: 'ALTRO', date: new Date('2024-01-03T00:00:00Z'), type: 5, balance: 'x', pointsCollectionId: 'sparita', points: 'y' },
      { userId: null, apiKeyId: keyId, cardId: id, cardCode: 'HIST-1', date: new Date('2024-01-05T00:00:00Z'), type: 'manually', balance: 2, pointsCollectionId: null, points: 0 },
      { userId: null, apiKeyId: ghostKey, cardId: id, cardCode: 'HIST-1', date: new Date('2024-01-06T00:00:00Z'), type: 'manually', balance: 2, pointsCollectionId: null, points: 0 },
      { userId: user, cardId: new ObjectId(), cardCode: 'NON-MIA', date: new Date('2024-01-04T00:00:00Z'), type: 'manually', balance: 1, pointsCollectionId: null, points: 0 },
    ]);
    const reply = await call(sa(), 'GET', `${one(id)}/movements`);
    okay(reply);
    const rows = reply.body.data as Array<Document>;
    assert.deepEqual(rows.slice(0, 2).map((row) => row['operator']), [{ kind: 'apiKey', id: hex(ghostKey), name: null }, { kind: 'apiKey', id: hex(keyId), name: 'Webshop' }]);
    rows.splice(0, 2);
    assert.deepEqual(rows.map((row) => row['date']), ['2024-01-03T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-01T00:00:00.000Z']);
    assert.deepEqual(rows[0], { id: rows[0]!['id'], date: '2024-01-03T00:00:00.000Z', type: null, balance: null, points: null, collection: { id: 'sparita', name: null }, operator: null });
    assert.deepEqual(rows[1]!['operator'], { kind: 'user', id: hex(stranger), name: null });
    assert.deepEqual([rows[1]!['collection'], rows[1]!['type'], rows[1]!['points']], [{ id: ids.active, name: 'Attiva' }, 'sale', 3]);
    assert.equal((rows[2]!['operator'] as Document)['id'], hex(user));
    assert.equal((rows[2]!['operator'] as Document)['kind'], 'user');
    assert.equal(typeof (rows[2]!['operator'] as Document)['name'] === 'string' || (rows[2]!['operator'] as Document)['name'] === null, true);
    const page = await call(sa(), 'GET', `${one(id)}/movements?limit=2`);
    assert.equal(page.body.data.length, 2);
    const next = await call(sa(), 'GET', `${one(id)}/movements?limit=2&cursor=${page.body.page.next as string}`);
    const last = await call(sa(), 'GET', `${one(id)}/movements?limit=2&cursor=${next.body.page.next as string}`);
    assert.deepEqual([next.body.data.length, last.body.data.length, last.body.page.next], [2, 1, null]);
    for (const query of ['limit=0', 'sort=date', 'q=x', 'cursor=!']) {
      assert.equal(failure(await call(sa(), 'GET', `${one(id)}/movements?${query}`)).status, 422, query);
    }
    assert.equal(failure(await call(sa(), 'GET', `${one(new ObjectId())}/movements`)).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', `${one(id, 0)}/movements`)).status, 404);
  });

  it('deletes only a card without history: no contact (in the trash too) and no movement', async () => {
    await reset();
    const created = await post({ code: 'DEL-1', cardTypeId: ids.plain });
    const id = created.body.data.id as string;
    const remove = async (reference?: Awaited<ReturnType<typeof call>>) => call(sa(), 'DELETE', one(id), undefined, { 'if-match': tag(reference ?? (await call(sa(), 'GET', one(id)))) });
    assert.equal(failure(await call(sa(), 'DELETE', one(id))).status, 422);
    okay(await patch(id, { enabled: false }));
    assert.equal(failure(await remove(created)).status, 412);
    const trashed = await db('contacts').insertOne(legacyContact({ fidelities: [{ code: ' DEL-1 ', points: 0 }], trash: true }));
    assert.deepEqual(failure(await remove()), { status: 409, code: 'CONFLICT', details: [{ field: `contacts.${hex(trashed.insertedId)}`, issue: 'referenced' }] });
    await db('contacts').deleteMany({});
    await movements().insertOne({ userId: sa(), cardId: new ObjectId(id), cardCode: 'DEL-1', date: new Date(), type: 'manually', balance: 1, pointsCollectionId: null, points: 0 });
    assert.deepEqual(failure(await remove()), { status: 409, code: 'CONFLICT', details: [{ field: 'movements', issue: 'referenced' }] });
    await movements().deleteMany({});
    await movements().insertOne({ userId: sa(), cardId: new ObjectId(), cardCode: 'DEL-1', date: new Date(), type: 'sale', balance: 1, pointsCollectionId: null, points: 0 });
    assert.equal(failure(await remove()).status, 409);
    await movements().deleteMany({});
    const mark = world.office.activity.entries.length;
    assert.equal((await remove()).status, 204);
    assert.equal(await stored(id), null);
    assert.deepEqual(log('fidelityCard.deleted', mark)[0]!.changes!.map((change) => change.field).sort(), ['cardTypeId', 'code', 'enabled']);
    assert.equal(failure(await remove(created)).status, 404);
  });

  it('keeps the card types and the points collections cards use: 409 referenced with the cards, and deletes the others', async () => {
    await reset();
    const card = await seed({ code: 'USE-1', cardTypeId: ids.plain, pointsCollections: { [ids.foreign]: 4 } });
    const removeCatalog = (path: string, id: string) => call(psa(), 'DELETE', group(`/fidelity/${path}/${id}`));
    assert.deepEqual(failure(await removeCatalog('card-types', ids.plain)), { status: 409, code: 'CONFLICT', details: [{ field: `fidelityCards.${hex(card)}`, issue: 'referenced' }] });
    assert.deepEqual(failure(await removeCatalog('points-collections', ids.foreign)), { status: 409, code: 'CONFLICT', details: [{ field: `fidelityCards.${hex(card)}`, issue: 'referenced' }] });
    await cards().updateOne({ _id: card }, { $set: { [`pointsCollections.${ids.foreign}`]: 0, cardTypeId: ids.prepaid } });
    assert.equal((await removeCatalog('points-collections', ids.foreign)).status, 204);
    assert.equal((await removeCatalog('card-types', ids.plain)).status, 204);
    ids.foreign = '';
    ids.plain = '';
  });
});

describe('fidelity cards: after the security review', () => {
  it('refuses to move a card with credit to a type that has none, and lets one without credit go', async () => {
    await reset();
    const rich = await post({ code: 'RICH', cardTypeId: ids.prepaid, initialBalance: 5 });
    const id = rich.body.data.id as string;
    assert.deepEqual(failure(await patch(id, { cardTypeId: ids.both })), { status: 409, code: 'CONFLICT', details: [{ field: 'balance', issue: 'notEmpty' }] });
    assert.equal((await stored(id))!['cardTypeId'], ids.prepaid);
    okay(await adjust(id, { balanceDelta: -5 }));
    okay(await patch(id, { cardTypeId: ids.both }));
    const unset = hex(await seed({ code: 'NOBAL' }));
    await cards().updateOne({ _id: new ObjectId(unset) }, { $unset: { balance: '' } });
    okay(await patch(unset, { cardTypeId: ids.both }));
    // From a type without credit to a prepaid one is never refused.
    okay(await patch(unset, { cardTypeId: ids.prepaid }));
  });

  it('modifies and adjusts a card whose code the legacy stored as something that is not a text', async () => {
    await reset();
    const id = hex(await seed({ code: 7 }));
    okay(await patch(id, { enabled: false }));
    okay(await adjust(id, { balanceDelta: 1 }));
    assert.equal(num((await stored(id))!['balance']), 11);
  });

  it('adds money in the database, to two decimals, as a Double', async () => {
    await reset();
    const id = (await post({ code: 'ROUND', cardTypeId: ids.prepaid })).body.data.id as string;
    for (const delta of [0.1, 0.2, 0.01, 0.07]) {
      okay(await adjust(id, { balanceDelta: delta }));
    }
    const card = (await stored(id))!;
    assert.ok(card['balance'] instanceof Double);
    assert.equal(num(card['balance']), 0.38);
    okay(await adjust(id, { balanceDelta: -0.38 }));
    assert.equal(num((await stored(id))!['balance']), 0);
  });

  it('never adds to a credit or points that are not finite numbers or are a list', async () => {
    await reset();
    for (const [index, balance] of [Number.NaN, Number.POSITIVE_INFINITY, [5], [1, 2], 'x'].entries()) {
      const id = hex(await seed({ code: `BAD-${String(index)}`, balance }));
      assert.equal(failure(await adjust(id, { balanceDelta: 1 })).status, 409, String(index));
      assert.equal(failure(await adjust(id, { balanceDelta: -1 })).status, 409, String(index));
    }
    for (const [index, points] of [Number.NaN, Number.POSITIVE_INFINITY, [3]].entries()) {
      const id = hex(await seed({ code: `BADP-${String(index)}`, pointsCollections: { [ids.active]: points } }));
      assert.equal(failure(await adjust(id, { pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })).status, 409, String(index));
      assert.equal(failure(await adjust(id, { pointsDeltas: [{ collectionId: ids.active, delta: -1 }] })).status, 409, String(index));
    }
    const list = hex(await seed({ code: 'LISTOK', pointsCollections: [{ x: 1 }] }));
    assert.equal(failure(await adjust(list, { pointsDeltas: [{ collectionId: ids.active, delta: 1 }] })).status, 409);
  });

  it('shows a contact whose caller may not read the cards only that a code is an advanced card', async () => {
    await reset();
    const card = await post({ code: 'HIDE-1', cardTypeId: ids.prepaid, initialBalance: 3 });
    const contact = new ObjectId();
    await db('contacts').insertOne(legacyContact({ _id: contact, fidelities: [{ code: 'HIDE-1', points: 2 }, { code: 'SEMPLICE', points: 1 }] }));
    const noCards = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: true, w: true }, fidelity: { r: false, w: false } } }) });
    const path = `/groups/${hex(gid())}/contacts/${hex(contact)}`;
    const hidden = await call(noCards.id, 'GET', path);
    okay(hidden);
    assert.deepEqual(hidden.body.data.fidelityCards, [
      { code: 'HIDE-1', points: 2, advanced: { cardId: null, cardType: null, enabled: null, balance: null, totalPoints: null } },
      { code: 'SEMPLICE', points: 1, advanced: null },
    ]);
    assert.ok(!JSON.stringify(hidden.body).includes(card.body.data.id as string));
    const shown = await call(sa(), 'GET', path);
    assert.equal(shown.body.data.fidelityCards[0].advanced.cardId, card.body.data.id);
    // The cards keep showing id and name of their contacts.
    assert.equal((await detail(card.body.data.id)).body.data.contacts[0].id, hex(contact));
  });

  it('refuses a public API key on the routes of the cards, as a Bearer and as an X-Api-Key', async () => {
    const id = hex(await seed({ code: 'KEYS' }));
    for (const [method, path] of [['GET', base()], ['GET', one(id)], ['POST', `${one(id)}/adjustments`], ['GET', `${one(id)}/movements`]] as const) {
      const bearer = await world.office.call(method, path, 'fc_pk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
      assert.equal(bearer.status, 401, `${method} ${path}`);
      const publicKey = await world.office.publicCall(method, path.replace('/groups', '/fidelity-groups'), 'fc_pk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
      assert.ok(publicKey.status === 401 || publicKey.status === 404, `${method} ${path}`);
    }
  });
});
