import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { legacyContact } from '../helpers/contacts.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const sa = () => world.group(0).sa;
const gid = () => world.group(0).groupId;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/contact-groups`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const groups = () => ctx.databases.common().collection('groups');
const stored = (id: string | ObjectId) => db('contacts_groups').findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const okay = (reply: Awaited<ReturnType<typeof call>>, status = 200) => assert.equal(reply.status, status, JSON.stringify(reply.body));
const post = (body: Document, actor = sa()) => call(actor, 'POST', base(), body, { 'idempotency-key': randomUUID() });
const patch = async (id: string, body: Document, reference?: Awaited<ReturnType<typeof call>>, actor = sa()) => call(actor, 'PATCH', one(id), body, { 'if-match': tag(reference ?? (await call(actor, 'GET', one(id)))) });
let listId = '';

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  const group = (await groups().findOne({ _id: gid() }))!;
  listId = Object.keys(group['priceLists'] as Document)[0]!;
  await groups().updateOne({ _id: gid() }, { $set: { 'priceLists.spento': { id: 'spento', name: 'Spento', status: false, default: false } } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('contact groups', () => {
  it('creates a group with 201, Location and ETag in the legacy shape, replays a retry and records the values', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const first = await call(sa(), 'POST', base(), { name: '  Fedeli ', priceListId: listId, discountPercent: 7.5 }, { 'idempotency-key': key });
    okay(first, 201);
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.deepEqual({ ...first.body.data, id: 'x', createdAt: 'x', updatedAt: 'x' }, { id: 'x', name: 'Fedeli', priceListId: listId, discountPercent: 7.5, createdAt: 'x', updatedAt: 'x' });
    const document = (await stored(first.body.data.id))!;
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'discountPercentage', 'insertDate', 'name', 'priceListId', 'updateDate']);
    assert.ok(document['discountPercentage'] instanceof Double && document['insertDate'] instanceof Date);
    assert.equal(log('contactGroup.created', mark).length, 1);
    assert.deepEqual(log('contactGroup.created', mark)[0]!.changes!.map((change) => [change.field, change.after]).sort(), [['discountPercent', 7.5], ['name', 'Fedeli'], ['priceListId', listId]]);
    assert.equal((await call(sa(), 'POST', base(), { name: '  Fedeli ', priceListId: listId, discountPercent: 7.5 }, { 'idempotency-key': key })).body.data.id, first.body.data.id);
    assert.equal(tag(await call(sa(), 'GET', one(first.body.data.id))), tag(first));
    const bare = await post({ name: 'Fedeli' });
    okay(bare, 201);
    assert.deepEqual([bare.body.data.priceListId, bare.body.data.discountPercent], [null, null]);
    assert.equal((await stored(bare.body.data.id))!['discountPercentage'], null);
    assert.equal(failure(await call(sa(), 'POST', base(), { name: 'x' })).status, 422);
  });

  it('refuses what is not valid, and a price list that does not exist or is disabled', async () => {
    const cases: Array<[Document, string, string]> = [
      [{}, 'name', 'required'],
      [{ name: '' }, 'name', 'minLength'],
      [{ name: 'n'.repeat(101) }, 'name', 'maxLength'],
      [{ name: 'a\u0001' }, 'name', 'pattern'],
      [{ name: 'x', discountPercent: 100.5 }, 'discountPercent', 'maximum'],
      [{ name: 'x', discountPercent: 1.234 }, 'discountPercent', 'format'],
      [{ name: 'x', priceListId: 'no spaces' }, 'priceListId', 'pattern'],
      [{ name: 'x', trash: true }, 'trash', 'unknown'],
    ];
    for (const [body, field, issue] of cases) {
      assert.deepEqual(failure(await post(body)), { status: 422, code: 'VALIDATION_ERROR', details: [{ field, issue }] }, field);
    }
    for (const priceListId of ['inesistente', 'spento']) {
      assert.deepEqual(failure(await post({ name: 'x', priceListId })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'priceListId', issue: 'incorrect' }] });
    }
  });

  it('lists with a cursor, sorts by name or by date, searches the name literally, and shows the count of contacts only in the detail', async () => {
    await db('contacts_groups').deleteMany({});
    const ids: ObjectId[] = [];
    for (const [index, name] of ['Beta', 'alfa', 'Gamma (2)', 'Delta', 'Alfa Due'].entries()) {
      const _id = new ObjectId();
      ids.push(_id);
      await db('contacts_groups').insertOne({ _id, name, priceListId: null, discountPercentage: 5, insertDate: new Date(2024, 0, 1), updateDate: new Date(Date.UTC(2024, 0, index + 1)) });
    }
    await db('contacts_groups').insertOne({ _id: new ObjectId(), name: 7, discountPercentage: 'x', priceListId: '' });
    const names = async (query: string) => ((await call(sa(), 'GET', `${base()}${query}`)).body.data as Array<Document>).map((row) => row['name']);
    assert.deepEqual(await names(''), ['', 'Alfa Due', 'Beta', 'Delta', 'Gamma (2)', 'alfa']);
    assert.deepEqual(await names('?sort=-name&limit=2'), ['alfa', 'Gamma (2)']);
    assert.deepEqual(await names('?sort=updatedAt'), ['', 'Beta', 'alfa', 'Gamma (2)', 'Delta', 'Alfa Due']);
    assert.deepEqual(await names('?q=ALFA'), ['Alfa Due', 'alfa']);
    assert.deepEqual(await names(`?q=${encodeURIComponent('(2)')}`), ['Gamma (2)']);
    assert.deepEqual(await names(`?q=${encodeURIComponent('.*')}`), []);
    const first = await call(sa(), 'GET', `${base()}?limit=4`);
    assert.equal(first.body.data.length, 4);
    const second = await call(sa(), 'GET', `${base()}?limit=4&cursor=${first.body.page.next as string}`);
    assert.equal(second.body.data.length, 2);
    assert.equal(second.body.page.next, null);
    assert.ok(!('contactsCount' in first.body.data[0]));
    const odd = (first.body.data as Array<Document>).find((row) => row['name'] === '');
    assert.deepEqual([odd?.['priceListId'], odd?.['discountPercent']], [null, null]);
    for (const query of ['limit=0', 'limit=101', 'sort=other', 'cursor=!', 'x=1']) {
      assert.equal(failure(await call(sa(), 'GET', `${base()}?${query}`)).status, 422, query);
    }
    // The detail counts the contacts that are not in the trash.
    await db('contacts').deleteMany({});
    await db('contacts').insertMany([legacyContact({ cGroupId: ids[0] }), legacyContact({ cGroupId: hex(ids[0]!) }), legacyContact({ cGroupId: ids[0], trash: true }), legacyContact({ cGroupId: ids[1] })]);
    const detail = await call(sa(), 'GET', one(ids[0]!));
    assert.equal(detail.body.data.contactsCount, 2);
    assert.equal(failure(await call(sa(), 'GET', one(new ObjectId()))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('x'))).status, 422);
    await db('contacts').deleteMany({});
  });

  it('modifies with If-Match, writes only the fields that change, and records the values', async () => {
    const created = await post({ name: 'Base', priceListId: listId, discountPercent: 10 });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const before = (await stored(id))!;
    const reply = await patch(id, { name: 'Nuovo', discountPercent: null }, created);
    okay(reply);
    assert.deepEqual([reply.body.data.name, reply.body.data.discountPercent, reply.body.data.priceListId, reply.body.data.contactsCount], ['Nuovo', null, listId, 0]);
    assert.notEqual(tag(reply), tag(created));
    const after = (await stored(id))!;
    assert.deepEqual([after['priceListId'], after['discountPercentage'], after['insertDate']], [listId, null, before['insertDate']]);
    assert.ok((after['updateDate'] as Date) > (before['updateDate'] as Date));
    assert.equal(tag(await call(sa(), 'GET', one(id))), tag(reply));
    assert.deepEqual(log('contactGroup.updated', mark)[0]!.changes!.map((change) => [change.field, change.before, change.after]).sort(), [['discountPercent', 10, null], ['name', 'Base', 'Nuovo']]);
    // A request that changes nothing writes and records nothing; a discount is a Double.
    const same = await patch(id, { name: 'Nuovo', priceListId: listId }, reply);
    assert.equal(tag(same), tag(reply));
    assert.equal(log('contactGroup.updated', mark).length, 1);
    okay(await patch(id, { discountPercent: 12.5, priceListId: null }));
    assert.ok((await stored(id))!['discountPercentage'] instanceof Double);
    assert.equal(failure(await patch(id, { name: 'Vecchio' }, created)).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { name: 'x' })).status, 422);
    assert.equal(failure(await patch(id, {})).status, 422);
    assert.equal(failure(await patch(hex(new ObjectId()), { name: 'x' }, created)).status, 404);
    assert.equal(failure(await patch(id, { priceListId: 'spento' })).status, 422);
    // A price list that was disabled since does not block an unrelated change.
    await db('contacts_groups').updateOne({ _id: new ObjectId(id) }, { $set: { priceListId: 'spento' } });
    okay(await patch(id, { priceListId: 'spento', name: 'Ancora' }));
    assert.equal(failure(await patch(id, { priceListId: 'sparito' })).status, 422);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(id, 1), { name: 'x' }, { 'if-match': tag(created) })).status, 404);
  });

  it('deletes a group with If-Match unless a contact (in the trash too) or a promotion uses it', async () => {
    const created = await post({ name: 'Da togliere' });
    const id = created.body.data.id as string;
    const remove = async (reference?: Awaited<ReturnType<typeof call>>) => call(sa(), 'DELETE', one(id), undefined, { 'if-match': tag(reference ?? (await call(sa(), 'GET', one(id)))) });
    assert.equal(failure(await call(sa(), 'DELETE', one(id))).status, 422);
    await db('contacts').deleteMany({});
    const user = await db('contacts').insertOne(legacyContact({ cGroupId: hex(new ObjectId(id)), trash: true }));
    assert.deepEqual(failure(await remove()), { status: 409, code: 'CONFLICT', details: [{ field: `contacts.${hex(user.insertedId)}`, issue: 'referenced' }] });
    await db('contacts').deleteMany({});
    await groups().updateOne({ _id: gid() }, { $set: { promotions: [{ id: 'promo-g', name: 'Promo', status: true, conditions: { contactsGroupsIds: [id] }, actions: {} }] } });
    assert.deepEqual(failure(await remove()), { status: 409, code: 'CONFLICT', details: [{ field: 'promotions.promo-g', issue: 'referenced' }] });
    await groups().updateOne({ _id: gid() }, { $unset: { promotions: '' } });
    const mark = world.office.activity.entries.length;
    okay(await patch(id, { name: 'Cambiato' }));
    assert.equal(failure(await remove(created)).status, 412);
    assert.equal((await remove()).status, 204);
    assert.equal(await stored(id), null);
    assert.equal(log('contactGroup.deleted', mark).length, 1);
    assert.deepEqual(log('contactGroup.deleted', mark)[0]!.changes!.map((change) => change.field).sort(), ['discountPercent', 'name', 'priceListId']);
    assert.equal(failure(await remove(created)).status, 404);
  });

  it('is of the group: the same permissions as the contacts, and never another group', async () => {
    const created = await post({ name: 'Mio' });
    const id = created.body.data.id as string;
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(id, 1), undefined, { 'if-match': tag(created) })).status, 404);
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, world.group(0).ca, world.group(0).pa]) {
      okay(await call(actor, 'GET', base()));
      okay(await post({ name: 'Di un altro ruolo' }, actor), 201);
    }
    const users = ctx.databases.common().collection('users');
    await users.updateOne({ _id: world.group(0).pa }, { $set: { 'permissions.contacts.w': false } });
    assert.equal(failure(await post({ name: 'x' }, world.group(0).pa)).status, 403);
    assert.equal(failure(await call(world.group(0).pa, 'DELETE', one(id), undefined, { 'if-match': tag(created) })).status, 403);
    await users.updateOne({ _id: world.group(0).pa }, { $set: { 'permissions.contacts.w': true } });
  });
});
