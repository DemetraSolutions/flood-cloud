import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { ACTIVITY_ALERT_ACTIONS } from '../../src/shared/activity-log/catalog.ts';
import { createBackofficeModules } from '../../src/composition.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger, testConfig } from '../helpers/app.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { legacyPermissions, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { throughRealLog } from '../helpers/real-log.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

/** The contacts, their groups and the advanced loyalty cards for the server of a point of sale (step K5): every behaviour goes through `/v1/store-context/…` with a store key, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const own = () => world.group(0).ownPlaceId;
const gid = () => world.group(0).groupId;
const psa = () => world.office.cluster.psa;
const users = () => ctx.databases.common().collection('users');
const copies = () => ctx.databases.common().collection('places');
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const contacts = (index = 0) => db('contacts', index);
const cards = (index = 0) => db('fidelity_cards', index);
const movements = (index = 0) => db('fidelity_cards_movements', index);
const contactGroups = (index = 0) => db('contacts_groups', index);
const CONTACTS = '/store-context/contacts';
const GROUPS = '/store-context/contact-groups';
const CARDS = '/store-context/fidelity-cards';
const operator = (id: ObjectId): Record<string, string> => ({ 'x-operator-id': hex(id) });
const get = (path: string, key = store.key) => world.asStore(key, 'GET', path);
let clerk: ObjectId;
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who: ObjectId = clerk, key = store.key) => world.asStore(key, method, path, body, { ...operator(who), ...headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => send('POST', path, body, { 'idempotency-key': randomUUID(), ...headers });
const tagOf = (reply: { headers: Headers }) => reply.headers.get('etag')!;
const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((item) => item.id);
const entries = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const at = (days: number) => new Date(Date.UTC(2026, 0, days));
const FAKE_TAG = `"${'A'.repeat(43)}"`;
const kinds = { active: '', second: '', prepaid: '', plain: '', both: '' };

/** Pages of a list read to the end, following the cursor. */
async function pagesOf(path: string, size = 2): Promise<Array<{ data: Array<{ id: string }>; page: { limit: number; next: string | null } }>> {
  const pages = [];
  let next: string | null = null;
  do {
    const reply = await get(`${path}${path.includes('?') ? '&' : '?'}${next === null ? '' : `cursor=${next}&`}limit=${String(size)}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    pages.push(reply.body);
    next = reply.body.page.next;
  } while (next !== null);
  return pages;
}

const user = async (n: number, overrides: Document = {}, contactsFlags: Document = { r: true, w: true }): Promise<ObjectId> => {
  const document = legacyUser(n, { groupId: gid(), dealerId: world.group(0).dealerId, role: 'PA', placeId: own(), placesId: [own()], permissions: legacyPermissions({ status: false, modules: { contacts: contactsFlags } }), ...overrides });
  await users().deleteOne({ _id: document['_id'] });
  await users().insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCard = async (overrides: Document = {}): Promise<ObjectId> => {
  const _id = new ObjectId();
  await cards().insertOne({ _id, code: `CARD-${hex(_id)}`, cardTypeId: kinds.prepaid, status: true, balance: new Double(10), pointsCollections: { [kinds.active]: 50 }, insertDate: at(1), updateDate: at(1), ...overrides });
  return _id;
};
const seedContact = async (overrides: Document = {}): Promise<ObjectId> => {
  const document = legacyContact(overrides);
  await contacts().insertOne(document);
  return document['_id'] as ObjectId;
};

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { STORE_CREDIT_ALERT_PER_OPERATION: '100', STORE_CREDIT_ALERT_PER_DAY: '300' } });
  const create = async (path: string, body: Document) => {
    const reply = await world.as.call(psa(), 'POST', `/groups/${hex(gid())}${path}`, body, { 'idempotency-key': randomUUID() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.data.id as string;
  };
  kinds.active = await create('/fidelity/points-collections', { name: 'Attiva' });
  kinds.second = await create('/fidelity/points-collections', { name: 'Seconda' });
  kinds.prepaid = await create('/fidelity/card-types', { name: 'Prepagata', prepaid: { enabled: true }, pointsCollect: { enabled: true, collectionIds: [kinds.active, kinds.second] } });
  kinds.plain = await create('/fidelity/card-types', { name: 'Semplice' });
  kinds.both = await create('/fidelity/card-types', { name: 'Solo punti', pointsCollect: { enabled: true, collectionIds: [kinds.active] } });
  store = await world.activate(own());
  clerk = await user(801);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([contacts().deleteMany({}), contacts(1).deleteMany({}), cards().deleteMany({}), cards(1).deleteMany({}), movements().deleteMany({}), contactGroups().deleteMany({}), contactGroups(1).deleteMany({})]);
  await copies().updateMany({}, { $set: { trash: false, status: true } });
});

describe('the contacts of the store: reading', () => {
  it('gives the contacts of the whole group, whole, as the backoffice shows them, with the advanced cards in detail and never the password or the tokens', async () => {
    const advanced = await seedCard({ code: 'ADV-1', balance: new Double(12.5) });
    const mario = await seedContact({ contactCode: 'K-1', fidelities: [{ code: 'ADV-1', points: 0 }, { code: 'SIMPLE-1', points: 7 }] });
    const trashed = await seedContact({ contactCode: 'K-2', name: 'Cestino', trash: true });
    const foreign = new ObjectId();
    await contacts(1).insertOne(legacyContact({ _id: foreign, name: 'Altro gruppo' }));
    const listed = await get(CONTACTS);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(ids(listed), [hex(mario)], 'not the one in the trash, not the one of another group, no filter of the place');
    assert.deepEqual(listed.body.page, { limit: 25, next: null });
    assert.ok(!/password|tokens|legacy-dead|legacyExtra|copia spuria|"cGroup"|"associatedCompany"/.test(JSON.stringify(listed.body)), 'nothing of the account credentials nor of the denormalized copies');
    const item = listed.body.data[0];
    assert.deepEqual(item.fidelityCards[0], { code: 'ADV-1', points: 0, advanced: { cardId: hex(advanced), cardType: { id: kinds.prepaid, name: 'Prepagata' }, enabled: true, balance: 12.5, totalPoints: 50 } });
    assert.deepEqual(item.fidelityCards[1], { code: 'SIMPLE-1', points: 7, advanced: null });
    // The detail is the one of the backoffice, with its version, and the list item is the detail without the warnings.
    const detail = await get(`${CONTACTS}/${hex(mario)}`);
    assert.equal(detail.status, 200);
    const asBackoffice = await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/contacts/${hex(mario)}`);
    assert.deepEqual(detail.body, asBackoffice.body);
    assert.equal(tagOf(detail), tagOf(asBackoffice));
    const { warnings: _warnings, ...withoutWarnings } = detail.body.data;
    assert.deepEqual(item, withoutWarnings);
    assert.ok(!/password|tokens|legacy-dead|copia spuria|"cGroup"|"associatedCompany"/.test(JSON.stringify(detail.body)));
    assert.equal((await get(`${CONTACTS}/${hex(trashed)}`)).status, 200, 'a trashed contact can still be read by id');
    assert.equal((await get(`${CONTACTS}/${hex(foreign)}`)).status, 404, 'a contact of another group does not exist');
    assert.equal((await get(`${CONTACTS}/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get(`${CONTACTS}/nope`)).status, 422);
  });

  it('searches, filters, pages and gives the changes since an instant, the trashed ones included, oldest first', async () => {
    const a = await seedContact({ name: 'Anna', surname: 'Bianchi', contactCode: 'A', updateDate: at(1) });
    const b = await seedContact({ name: 'Bruno', surname: 'Verdi', contactCode: 'B', updateDate: at(2), customer: false, supplier: true });
    const c = await seedContact({ name: 'Carla', surname: 'Neri', contactCode: 'C', updateDate: at(3), trash: true });
    const d = await seedContact({ name: 'Dario', surname: 'Rossi', contactCode: 'D', updateDate: at(4) });
    assert.deepEqual(ids(await get(`${CONTACTS}?q=bru`)), [hex(b)]);
    assert.deepEqual(ids(await get(`${CONTACTS}?q=Bruno%20Verdi`)), [hex(b)], 'the name and the surname, together');
    assert.deepEqual(ids(await get(`${CONTACTS}?q=B&kind=suppliers`)), [hex(b)]);
    assert.deepEqual(ids(await get(`${CONTACTS}?kind=suppliers`)), [hex(b)]);
    assert.deepEqual(ids(await get(`${CONTACTS}?sort=-lastName`)), [hex(b), hex(d), hex(a)]);
    assert.deepEqual(ids(await get(`${CONTACTS}?trashed=true`)), [hex(c)]);
    const since = await get(`${CONTACTS}?updatedSince=2026-01-03T00:00:00.000Z`);
    assert.deepEqual(ids(since), [hex(c), hex(d)], 'the trashed contact is how the store learns what to drop, oldest change first');
    assert.equal(since.body.data[0].trashed, true);
    assert.deepEqual(ids(await get(`${CONTACTS}?updatedSince=2026-01-03T00:00:00.000Z&trashed=false`)), [hex(d)]);
    const pages = await pagesOf(CONTACTS);
    assert.deepEqual(pages.map((page) => page.data.length), [2, 1]);
    assert.deepEqual(pages.flatMap((page) => page.data.map((item) => item.id)), [hex(a), hex(b), hex(d)]);
    const sincePages = await pagesOf(`${CONTACTS}?updatedSince=2026-01-01`);
    assert.deepEqual(sincePages.flatMap((page) => page.data.map((item) => item.id)), [hex(a), hex(b), hex(c), hex(d)]);
    for (const query of ['limit=51', 'limit=0', 'placeId=x', 'companyId=x', 'groupId=x', 'updatedSince=yesterday', 'cursor=zz', 'kind=all&kind=all', 'q=', 'trashed=maybe', 'contactGroupId=zz']) {
      assert.equal((await get(`${CONTACTS}?${query}`)).status, 422, query);
    }
    assert.equal((await get(`${CONTACTS}?limit=50`)).status, 200);
    const groupId = new ObjectId();
    const inGroup = await seedContact({ name: 'Elena', cGroupId: groupId });
    assert.deepEqual(ids(await get(`${CONTACTS}?contactGroupId=${hex(groupId)}`)), [hex(inGroup)]);
  });
});

describe('the contacts of the store: writing', () => {
  it('creates a contact with the operator, answers 201 with its link and version, replays a retry and records the store as the actor and the operator apart', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { code: 'NEW-1', customer: true, person: { firstName: 'Luca', lastName: 'Gialli', emails: ['luca@example.test'] }, fidelityCards: [{ code: 'SIMPLE-9' }], notes: 'dal negozio', eInvoicing: { recipientCode: 'ABCDEFG', pec: 'luca@pec.example.test' }, account: { email: 'luca.account@example.test' } };
    const created = await send('POST', CONTACTS, body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/v1${CONTACTS}/${id}`);
    assert.match(tagOf(created), /^"/);
    assert.equal(created.body.data.notes, 'dal negozio');
    assert.deepEqual([created.body.data.eInvoicing.recipientCode, created.body.data.account.email], ['ABCDEFG', 'luca.account@example.test']);
    assert.ok(!/password|tokens|copia spuria|"cGroup"|"associatedCompany"/.test(JSON.stringify(created.body)));
    const replay = await send('POST', CONTACTS, body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body, tagOf(replay)], [201, created.body, tagOf(created)]);
    assert.equal(await contacts().countDocuments({ contactCode: 'NEW-1' }), 1, 'one contact, however many times it is sent');
    assert.equal((await send('POST', CONTACTS, { ...body, code: 'other' }, { 'idempotency-key': key })).status, 409);
    const [event] = entries('contact.created', mark);
    assert.ok(event);
    assert.deepEqual([event.actor.kind, event.actor.id?.toHexString(), event.actor.role], ['store', store.keyId, undefined]);
    assert.equal(event.metadata?.['operatorId'], hex(clerk));
    assert.equal(event.groupId?.toHexString(), hex(gid()));
    // The key belongs to the store key that sent it: a user with the same key is another request.
    const asUser = await world.as.call(world.group(0).sa, 'POST', `/groups/${hex(gid())}/contacts`, { ...body, account: undefined }, { 'idempotency-key': key });
    assert.equal(asUser.status, 201);
    assert.notEqual(asUser.body.data.id, id);
    assert.equal((await send('POST', CONTACTS, body)).status, 422, 'the Idempotency-Key is required');
    assert.equal((await post(CONTACTS, { ...body, price: 1 })).status, 422, 'an unknown field');
    assert.equal((await post(CONTACTS, { account: { password: 'x' } })).status, 422, 'the password of the account is nobody\'s to write');
    assert.equal((await post(CONTACTS, {})).status, 422, 'a contact needs a name');
  });

  it('changes a contact with the version it read, 412 on a stale one, and links and unlinks card codes, advanced ones included', async () => {
    const advanced = await seedCard({ code: 'ADV-2' });
    const id = await seedContact({ fidelities: [{ code: 'SIMPLE-1', points: 4 }] });
    const current = await get(`${CONTACTS}/${hex(id)}`);
    const mark = world.office.activity.entries.length;
    const linked = await send('PATCH', `${CONTACTS}/${hex(id)}`, { fidelityCards: [{ code: 'SIMPLE-1' }, { code: 'ADV-2' }], notes: 'nota' }, { 'if-match': tagOf(current) });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(linked.body.data.fidelityCards.map((card: { code: string; points: number; advanced: { cardId: string } | null }) => [card.code, card.points, card.advanced?.cardId ?? null]), [['SIMPLE-1', 4, null], ['ADV-2', 0, hex(advanced)]]);
    assert.notEqual(tagOf(linked), tagOf(current));
    assert.equal(entries('contact.updated', mark)[0]!.metadata?.['operatorId'], hex(clerk));
    assert.deepEqual([entries('contact.updated', mark)[0]!.actor.kind], ['store']);
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(id)}`, { notes: 'stale' }, { 'if-match': tagOf(current) })).status, 412);
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(id)}`, { notes: 'no version' })).status, 422);
    const unlinked = await send('PATCH', `${CONTACTS}/${hex(id)}`, { fidelityCards: [{ code: 'SIMPLE-1' }] }, { 'if-match': tagOf(linked) });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
    assert.deepEqual(unlinked.body.data.fidelityCards.map((card: { code: string }) => card.code), ['SIMPLE-1']);
    assert.equal((await cards().findOne({ _id: advanced }))!['code'], 'ADV-2', 'the card itself is untouched');
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(new ObjectId())}`, { notes: 'x' }, { 'if-match': FAKE_TAG })).status, 404);
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(id)}`, { password: 'x' }, { 'if-match': tagOf(unlinked) })).status, 422);
  });

  it('moves a contact to the trash and has no way to restore one, to delete one for good or to trash many', async () => {
    const id = await seedContact();
    const current = await get(`${CONTACTS}/${hex(id)}`);
    const mark = world.office.activity.entries.length;
    const trashed = await send('POST', `${CONTACTS}/${hex(id)}/trash`, undefined, { 'if-match': tagOf(current) });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    assert.equal(trashed.body.data.trashed, true);
    assert.equal(entries('contact.trashed', mark)[0]!.metadata?.['operatorId'], hex(clerk));
    assert.equal((await send('POST', `${CONTACTS}/${hex(id)}/trash`, undefined, { 'if-match': tagOf(trashed) })).status, 409);
    assert.equal((await send('POST', `${CONTACTS}/${hex(id)}/trash`)).status, 422);
    for (const [method, path] of [['POST', `${CONTACTS}/${hex(id)}/restore`], ['DELETE', `${CONTACTS}/${hex(id)}`], ['POST', `${CONTACTS}/trash`], ['DELETE', CONTACTS], ['POST', `${GROUPS}`], ['PATCH', `${GROUPS}/${hex(id)}`], ['DELETE', `${GROUPS}/${hex(id)}`], ['GET', `${GROUPS}/${hex(id)}`]] as const) {
      const reply = await send(method, path, method === 'POST' ? {} : undefined, { 'if-match': tagOf(trashed), 'idempotency-key': randomUUID() });
      assert.ok([404, 405].includes(reply.status), `${method} ${path}: ${String(reply.status)}`);
    }
    assert.equal(await contacts().countDocuments({ _id: id, trash: true }), 1, 'still there, in the trash');
    assert.equal((await send('POST', `${CONTACTS}/${hex(new ObjectId())}/trash`, undefined, { 'if-match': FAKE_TAG })).status, 404);
  });

  it('adjusts the points of a simple card with the operator, replays a retry, refuses an advanced card and a balance below zero, and records the operator', async () => {
    await seedCard({ code: 'ADV-3' });
    const id = await seedContact({ fidelities: [{ code: 'SIMPLE-1', points: 10 }, { code: 'ADV-3', points: 0 }] });
    const path = `${CONTACTS}/${hex(id)}/fidelity-cards/SIMPLE-1/points-adjustments`;
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const first = await send('POST', path, { delta: -4, reason: 'premio' }, { 'idempotency-key': key });
    assert.deepEqual([first.status, first.body.data], [200, { code: 'SIMPLE-1', points: 6 }]);
    const replay = await send('POST', path, { delta: -4, reason: 'premio' }, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body], [200, first.body], 'a retry is not applied twice');
    assert.equal((await contacts().findOne({ _id: id }))!['fidelities'][0].points, 6);
    const [event] = entries('contact.pointsAdjusted', mark);
    assert.deepEqual([event!.actor.kind, event!.actor.id?.toHexString(), event!.metadata?.['operatorId'], event!.metadata?.['delta']], ['store', store.keyId, hex(clerk), -4]);
    assert.equal((await post(path, { delta: -7 })).status, 409, 'not below zero');
    assert.equal((await post(`${CONTACTS}/${hex(id)}/fidelity-cards/ADV-3/points-adjustments`, { delta: 1 })).status, 409, 'the points of an advanced card are its own');
    assert.equal((await post(`${CONTACTS}/${hex(id)}/fidelity-cards/NOPE/points-adjustments`, { delta: 1 })).status, 404);
    assert.equal((await send('POST', path, { delta: 1 })).status, 422, 'the Idempotency-Key is required');
    const dots = await post(`${CONTACTS}/${hex(id)}/fidelity-cards/${'a'.repeat(65)}/points-adjustments`, { delta: 1 });
    assert.deepEqual([dots.status, dots.body.error.details[0].field], [422, 'code'], 'the code is judged by the builder, before the operator and the body');
    assert.equal((await post(path, { delta: 0 })).status, 422);
    assert.equal((await post(path, { delta: 1, extra: 1 })).status, 422);
  });
});

describe('the groups of contacts of the store', () => {
  it('reads them page after page, by name, searched and since an instant, and never writes them', async () => {
    const now = at(1);
    const rows = [
      { _id: new ObjectId(), name: 'Alfa', priceListId: null, discountPercentage: new Double(5), insertDate: now, updateDate: at(1) },
      { _id: new ObjectId(), name: 'Beta', priceListId: null, discountPercentage: null, insertDate: now, updateDate: at(3) },
      { _id: new ObjectId(), name: 'Gamma', priceListId: null, discountPercentage: null, insertDate: now, updateDate: at(2) },
    ];
    await contactGroups().insertMany(rows);
    await contactGroups(1).insertOne({ _id: new ObjectId(), name: 'Altro gruppo', priceListId: null, discountPercentage: null, insertDate: now, updateDate: now });
    const listed = await get(GROUPS);
    assert.deepEqual(listed.body.data.map((item: { name: string }) => item.name), ['Alfa', 'Beta', 'Gamma']);
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    assert.deepEqual([listed.body.data[0].discountPercent, listed.body.data[0].priceListId], [5, null]);
    assert.deepEqual((await get(`${GROUPS}?q=bet`)).body.data.map((item: { name: string }) => item.name), ['Beta']);
    const since = await get(`${GROUPS}?updatedSince=2026-01-02T00:00:00.000Z`);
    assert.deepEqual(since.body.data.map((item: { name: string }) => item.name), ['Gamma', 'Beta'], 'oldest change first');
    assert.deepEqual((await pagesOf(GROUPS)).map((page) => page.data.length), [2, 1]);
    assert.deepEqual((await get(`${GROUPS}?sort=-name&updatedSince=2026-01-01`)).body.data.map((item: { name: string }) => item.name), ['Gamma', 'Beta', 'Alfa']);
    for (const query of ['limit=101', 'updatedSince=x', 'placeId=x', 'cursor=zz']) {
      assert.equal((await get(`${GROUPS}?${query}`)).status, 422, query);
    }
  });
});

describe('the advanced cards of the store: reading', () => {
  it('gives the cards of the whole group whole, with the points by collection and the contacts that have each code, never another group\'s', async () => {
    const card = await seedCard({ code: 'ADV-A', balance: new Double(8.5), pointsCollections: { [kinds.active]: 30, [kinds.second]: 4 }, updateDate: at(2) });
    const holder = await seedContact({ name: 'Anna', surname: 'Verdi', companyName: '', fidelities: [{ code: 'ADV-A', points: 0 }] });
    await seedContact({ name: 'Trash', fidelities: [{ code: 'ADV-A', points: 0 }], trash: true });
    await cards(1).insertOne({ _id: new ObjectId(), code: 'FOREIGN', cardTypeId: 'x', status: true, balance: new Double(1), pointsCollections: {}, insertDate: at(1), updateDate: at(1) });
    const listed = await get(CARDS);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(ids(listed), [hex(card)]);
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    const item = listed.body.data[0];
    assert.deepEqual([item.code, item.balance, item.totalPoints, item.enabled, item.cardType.name], ['ADV-A', 8.5, 34, true, 'Prepagata']);
    assert.deepEqual(item.points.map((points: { collectionId: string; points: number }) => [points.collectionId, points.points]).sort(), [[kinds.active, 30], [kinds.second, 4]].sort());
    assert.deepEqual([item.contactsCount, item.contacts], [1, [{ id: hex(holder), displayName: item.contacts[0].displayName }]]);
    // The detail is the one of the backoffice, with its version, and the movements are its history.
    const detail = await get(`${CARDS}/${hex(card)}`);
    const asBackoffice = await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/fidelity-cards/${hex(card)}`);
    assert.deepEqual(detail.body, asBackoffice.body);
    assert.equal(tagOf(detail), tagOf(asBackoffice));
    assert.deepEqual(item, detail.body.data);
    assert.equal((await get(`${CARDS}/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get(`${CARDS}/zz`)).status, 422);
  });

  it('looks a card up by its code, equal and tolerant of the spaces around a stored one, and gives the changes since an instant', async () => {
    const spaced = await seedCard({ code: '  SP-1 ', updateDate: at(3) });
    const plain = await seedCard({ code: 'PL-1', updateDate: at(1), cardTypeId: kinds.plain, balance: undefined, pointsCollections: undefined });
    const off = await seedCard({ code: 'OFF-1', updateDate: at(2), status: false });
    assert.deepEqual(ids(await get(`${CARDS}?code=SP-1`)), [hex(spaced)]);
    assert.deepEqual(ids(await get(`${CARDS}?code=%20SP-1%20`)), [hex(spaced)]);
    assert.deepEqual(ids(await get(`${CARDS}?code=SP`)), [], 'equal, never a part of the code');
    assert.deepEqual(ids(await get(`${CARDS}?code=sp-1`)), [], 'and case is the code\'s own');
    assert.deepEqual(ids(await get(`${CARDS}?code=.*`)), [], 'the text is literal');
    assert.deepEqual(ids(await get(`${CARDS}?sort=code`)), [hex(spaced), hex(off), hex(plain)]);
    assert.deepEqual(ids(await get(`${CARDS}?enabled=false`)), [hex(off)]);
    assert.deepEqual(ids(await get(`${CARDS}?cardTypeId=${kinds.plain}`)), [hex(plain)]);
    assert.deepEqual(ids(await get(`${CARDS}?updatedSince=2026-01-02T00:00:00.000Z`)), [hex(off), hex(spaced)], 'oldest change first');
    assert.deepEqual(ids(await get(`${CARDS}?updatedSince=2026-01-02&sort=-code`)), [hex(off), hex(spaced)]);
    assert.equal((await pagesOf(CARDS)).flatMap((page) => page.data).length, 3);
    assert.deepEqual((await pagesOf(`${CARDS}?updatedSince=2026-01-01`)).flatMap((page) => page.data.map((item) => item.id)), [hex(plain), hex(off), hex(spaced)]);
    const withoutCredit = (await get(`${CARDS}?code=PL-1`)).body.data[0];
    assert.deepEqual([withoutCredit.balance, withoutCredit.points, withoutCredit.totalPoints], [null, [], 0]);
    for (const query of ['limit=101', 'q=x', 'updatedSince=x', 'code=', 'enabled=maybe', 'placeId=x', 'sort=balance']) {
      assert.equal((await get(`${CARDS}?${query}`)).status, 422, query);
    }
  });

  it('keeps the credit and the points out of the incremental download: a movement does not move updateDate', async () => {
    const card = await seedCard({ code: 'STALE-1', updateDate: at(1) });
    const done = await post(`${CARDS}/${hex(card)}/adjustments`, { balanceDelta: 5 });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.balance, 15);
    assert.deepEqual(ids(await get(`${CARDS}?updatedSince=2026-01-02`)), [], 'documented limit: the balance is read with the card, not with the changes');
    assert.equal((await get(`${CARDS}?code=STALE-1`)).body.data[0].balance, 15);
  });

  it('gives the movements of a card, newest first, with the operator who made them', async () => {
    const card = await seedCard({ code: 'MOV-1' });
    const other = await seedCard({ code: 'MOV-2' });
    await post(`${CARDS}/${hex(card)}/adjustments`, { balanceDelta: 2, pointsDeltas: [{ collectionId: kinds.active, delta: 3 }], reason: 'x' });
    await post(`${CARDS}/${hex(other)}/adjustments`, { balanceDelta: 1 });
    const listed = await get(`${CARDS}/${hex(card)}/movements`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data.length, 2);
    assert.deepEqual(listed.body.data.map((row: { type: string; operator: { kind: string; id: string; store?: true } }) => [row.type, row.operator.kind, row.operator.id, row.operator.store]), [['manually', 'user', hex(clerk), true], ['manually', 'user', hex(clerk), true]]);
    assert.ok((await movements().find({ cardCode: 'MOV-1' }).toArray()).every((row) => hex(row['storeKeyId'] as ObjectId) === store.keyId && !('apiKeyId' in row)), 'the store key is kept in the movement');
    // A movement made in the backoffice has no store.
    await world.as.call(world.group(0).sa, 'POST', `/groups/${hex(gid())}/fidelity-cards/${hex(card)}/adjustments`, { balanceDelta: 1 }, { 'idempotency-key': randomUUID() });
    const mixed = (await get(`${CARDS}/${hex(card)}/movements`)).body.data as Array<{ operator: { id: string; store?: true } }>;
    assert.deepEqual(mixed.map((row) => [row.operator.id === hex(clerk), row.operator.store]), [[false, undefined], [true, true], [true, true]]);
    assert.deepEqual((await pagesOf(`${CARDS}/${hex(card)}/movements`, 1)).map((page) => page.data.length), [1, 1, 1]);
    assert.equal((await get(`${CARDS}/${hex(new ObjectId())}/movements`)).status, 404);
    assert.equal((await get(`${CARDS}/${hex(card)}/movements?limit=101`)).status, 422);
    assert.equal((await get(`${CARDS}/${hex(card)}/movements?updatedSince=2026-01-01`)).status, 422);
  });
});

describe('the advanced cards of the store: writing', () => {
  it('creates a card with its credit, its points and the contacts that get its code, with the operator as the user of the movements', async () => {
    const mario = await seedContact({ name: 'Mario', fidelities: [] });
    const luigi = await seedContact({ name: 'Luigi', fidelities: [] });
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { code: 'NEW-CARD', cardTypeId: kinds.prepaid, initialBalance: 20, initialPoints: [{ collectionId: kinds.active, points: 15 }], contactIds: [hex(mario), hex(luigi)] };
    const created = await send('POST', CARDS, body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/v1${CARDS}/${id}`);
    assert.deepEqual([created.body.data.balance, created.body.data.totalPoints, created.body.data.contactsCount, created.body.data.enabled], [20, 15, 2, true]);
    const replay = await send('POST', CARDS, body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body, tagOf(replay)], [201, created.body, tagOf(created)]);
    assert.equal(await cards().countDocuments({ code: 'NEW-CARD' }), 1);
    const history = await movements().find({ cardCode: 'NEW-CARD' }).toArray();
    assert.equal(history.length, 2);
    for (const row of history) {
      assert.equal(hex(row['userId'] as ObjectId), hex(clerk), 'the operator is the user of the movement');
      assert.ok(!('apiKeyId' in row));
    }
    assert.deepEqual(((await contacts().findOne({ _id: mario }))!['fidelities'] as Array<{ code: string }>).map((card) => card.code), ['NEW-CARD']);
    const [event] = entries('fidelityCard.created', mark);
    assert.deepEqual([event!.actor.kind, event!.actor.id?.toHexString(), event!.metadata?.['operatorId'], event!.metadata?.['contactsCount']], ['store', store.keyId, hex(clerk), 2]);
    assert.equal((await post(CARDS, { ...body })).status, 409, 'the code is taken');
    assert.equal((await send('POST', CARDS, { ...body, code: 'X' })).status, 422, 'the Idempotency-Key is required');
    assert.equal((await post(CARDS, { code: 'Y', cardTypeId: 'nope' })).status, 422);
    assert.equal((await post(CARDS, { code: 'Y', cardTypeId: kinds.plain, initialBalance: 1 })).status, 422);
    assert.equal((await post(CARDS, { code: 'Y', cardTypeId: kinds.prepaid, contactIds: [hex(new ObjectId())] })).status, 422);
    assert.equal((await post(CARDS, { code: 'Y', cardTypeId: kinds.prepaid, extra: 1 })).status, 422);
  });

  it('changes the type and the state with the version it read, and never deletes a card', async () => {
    const card = await seedCard({ code: 'UPD-1', balance: new Double(0), pointsCollections: {} });
    const current = await get(`${CARDS}/${hex(card)}`);
    const mark = world.office.activity.entries.length;
    const changed = await send('PATCH', `${CARDS}/${hex(card)}`, { enabled: false, cardTypeId: kinds.plain }, { 'if-match': tagOf(current) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual([changed.body.data.enabled, changed.body.data.cardType.id], [false, kinds.plain]);
    assert.equal(entries('fidelityCard.updated', mark)[0]!.metadata?.['operatorId'], hex(clerk));
    assert.equal((await send('PATCH', `${CARDS}/${hex(card)}`, { enabled: true }, { 'if-match': tagOf(current) })).status, 412);
    assert.equal((await send('PATCH', `${CARDS}/${hex(card)}`, { enabled: true })).status, 422);
    assert.equal((await send('PATCH', `${CARDS}/${hex(card)}`, { code: 'NEW' }, { 'if-match': tagOf(changed) })).status, 422, 'the code never changes');
    for (const [method, path] of [['DELETE', `${CARDS}/${hex(card)}`], ['DELETE', CARDS]] as const) {
      assert.ok([404, 405].includes((await send(method, path, undefined, { 'if-match': tagOf(changed) })).status), `${method} ${path}`);
    }
    assert.equal(await cards().countDocuments({ _id: card }), 1);
  });

  it('adjusts the credit and the points, replays a retry, refuses a balance below zero and records the operator in the movements and in the log', async () => {
    const card = await seedCard({ code: 'ADJ-1' });
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { balanceDelta: -4.5, pointsDeltas: [{ collectionId: kinds.active, delta: 5 }], reason: 'cassa' };
    const first = await send('POST', `${CARDS}/${hex(card)}/adjustments`, body, { 'idempotency-key': key });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.data.balance, first.body.data.totalPoints], [5.5, 55]);
    const replay = await send('POST', `${CARDS}/${hex(card)}/adjustments`, body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body], [200, first.body]);
    assert.equal(await movements().countDocuments({ cardCode: 'ADJ-1' }), 2, 'written once');
    assert.ok((await movements().find({ cardCode: 'ADJ-1' }).toArray()).every((row) => hex(row['userId'] as ObjectId) === hex(clerk)));
    const [event] = entries('fidelityCard.adjusted', mark);
    assert.deepEqual([event!.actor.kind, event!.metadata?.['operatorId'], event!.metadata?.['reason']], ['store', hex(clerk), 'cassa']);
    const short = await post(`${CARDS}/${hex(card)}/adjustments`, { balanceDelta: -100 });
    assert.deepEqual([short.status, short.body.error.details], [409, [{ field: 'balance', issue: 'insufficient' }]]);
    assert.equal((await post(`${CARDS}/${hex(card)}/adjustments`, { pointsDeltas: [{ collectionId: kinds.second, delta: -1 }] })).status, 409);
    assert.equal((await post(`${CARDS}/${hex(card)}/adjustments`, { pointsDeltas: [{ collectionId: 'unknown', delta: 1 }] })).status, 422);
    assert.equal((await post(`${CARDS}/${hex(new ObjectId())}/adjustments`, { balanceDelta: 1 })).status, 404);
    assert.equal((await send('POST', `${CARDS}/${hex(card)}/adjustments`, { balanceDelta: 1 })).status, 422, 'the Idempotency-Key is required');
    assert.equal((await post(`${CARDS}/${hex(card)}/adjustments`, {})).status, 422);
  });
});

describe('the contacts of the store: the activity log as it is stored', () => {
  it('keeps the store as the actor and the operator in the metadata of every write, with nothing redacted and nothing refused by the real log', async () => {
    const mark = world.office.activity.entries.length;
    const contact = await post(CONTACTS, { person: { firstName: 'Log' }, fidelityCards: [{ code: 'LOG-S' }] });
    await send('PATCH', `${CONTACTS}/${contact.body.data.id}`, { notes: 'x' }, { 'if-match': tagOf(contact) });
    await post(`${CONTACTS}/${contact.body.data.id}/fidelity-cards/LOG-S/points-adjustments`, { delta: 3 });
    const card = await post(CARDS, { code: 'LOG-C', cardTypeId: kinds.prepaid, initialBalance: 1 });
    const updated = await send('PATCH', `${CARDS}/${card.body.data.id}`, { enabled: false }, { 'if-match': tagOf(card) });
    assert.equal(updated.status, 200);
    await post(`${CARDS}/${card.body.data.id}/adjustments`, { balanceDelta: 1 });
    const trashed = await send('POST', `${CONTACTS}/${contact.body.data.id}/trash`, undefined, { 'if-match': tagOf((await get(`${CONTACTS}/${contact.body.data.id}`))) });
    assert.equal(trashed.status, 200);
    const { stored, refused } = await throughRealLog(ctx, world.office.activity.entries.slice(mark));
    assert.deepEqual(refused, []);
    assert.ok(stored.length >= 7);
    for (const entry of stored) {
      assert.equal(entry['actor'].kind, 'store', entry['action']);
      assert.equal(entry['metadata']['operatorId'], hex(clerk), entry['action']);
    }
    assert.ok(!JSON.stringify(stored).includes('REDACTED'));
  });
});

describe('the contacts of the store: the operator', () => {
  const REFUSED = { status: 403, body: { error: { code: 'OPERATOR_NOT_ALLOWED', message: 'Operator not allowed' } } };
  it('is one answer, byte for byte, for a missing, malformed, unknown, foreign, trashed, disabled and unauthorized operator, on every write, and nothing is written', async () => {
    const productsOnly = await user(811, {}, { r: true, w: false });
    const noMatrix = await user(812, { permissions: null });
    const disabled = await user(813, { status: false });
    const trashedUser = await user(814, { trash: true });
    const card = await seedCard({ code: 'GUARD-1' });
    const contact = await seedContact({ fidelities: [{ code: 'SIMPLE-1', points: 5 }] });
    const before = { contacts: await contacts().countDocuments(), cards: await cards().countDocuments(), movements: await movements().countDocuments(), contact: await contacts().findOne({ _id: contact }), card: await cards().findOne({ _id: card }) };
    const writes: Array<[string, string, unknown]> = [
      ['POST', CONTACTS, { person: { firstName: 'X' } }],
      ['PATCH', `${CONTACTS}/${hex(contact)}`, { notes: 'x' }],
      ['POST', `${CONTACTS}/${hex(contact)}/trash`, undefined],
      ['POST', `${CONTACTS}/${hex(contact)}/fidelity-cards/SIMPLE-1/points-adjustments`, { delta: 1 }],
      ['POST', CARDS, { code: 'G-NEW', cardTypeId: kinds.plain }],
      ['PATCH', `${CARDS}/${hex(card)}`, { enabled: false }],
      ['POST', `${CARDS}/${hex(card)}/adjustments`, { balanceDelta: 1 }],
    ];
    const cases: Array<[string, Record<string, string>]> = [
      ['missing', {}],
      ['malformed', { 'x-operator-id': 'zz' }],
      ['unknown', operator(new ObjectId())],
      ['of another group', operator(world.group(1).pa)],
      ['a PSA', operator(psa())],
      ['trashed', operator(trashedUser)],
      ['disabled', operator(disabled)],
      ['without the write flag of the contacts', operator(productsOnly)],
      ['without a matrix', operator(noMatrix)],
    ];
    const answers = new Set<string>();
    for (const [method, path, body] of writes) {
      for (const [name, headers] of cases) {
        limiter.reset();
        const mark = world.office.activity.entries.length;
        const reply = await world.asStore(store.key, method, path, body, { 'if-match': FAKE_TAG, 'idempotency-key': randomUUID(), ...headers });
        answers.add(JSON.stringify({ status: reply.status, body: reply.body }));
        assert.deepEqual({ status: reply.status, body: reply.body }, REFUSED, `${method} ${path}: ${name}`);
        assert.equal(reply.headers.get('etag'), null);
        const [event] = entries('store.operatorRejected', mark);
        assert.ok(event, `${method} ${path}: ${name}`);
        assert.deepEqual([event.category, event.outcome, event.actor.kind, event.actor.id?.toHexString()], ['security', 'denied', 'store', store.keyId]);
      }
    }
    assert.equal(answers.size, 1, 'nothing tells one refusal from another');
    assert.deepEqual({ contacts: await contacts().countDocuments(), cards: await cards().countDocuments(), movements: await movements().countDocuments(), contact: await contacts().findOne({ _id: contact }), card: await cards().findOne({ _id: card }) }, before, 'nothing was written');
    // The user who may write the contacts but not the products is let in, and the reads ask for no operator.
    const allowed = await world.asStore(store.key, 'POST', CONTACTS, { person: { firstName: 'Ok' } }, { ...operator(clerk), 'idempotency-key': randomUUID() });
    assert.equal(allowed.status, 201);
    const mark = world.office.activity.entries.length;
    assert.equal((await get(CONTACTS)).status, 200);
    assert.equal((await get(CARDS)).status, 200);
    assert.equal((await get(GROUPS)).status, 200);
    assert.equal(entries('store.operatorRejected', mark).length, 0);
  });

  it('lets in the users of its set that may write the contacts: a place administrator, an employee, the administrator of the company and of the group', async () => {
    const employee = await user(821, { role: 'E' });
    // The matrix of the company and of the group administrator of the fixture is fixed here: the flag of the contacts is the only thing that lets them in.
    const ca = world.group(0).ca;
    const sa0 = world.group(0).sa;
    const matrixOf = (flags: Document) => legacyPermissions({ status: false, modules: { contacts: flags } });
    await users().updateOne({ _id: ca }, { $set: { permissions: matrixOf({ r: true, w: true }) } });
    await users().updateOne({ _id: sa0 }, { $set: { permissions: matrixOf({ r: true, w: true }) } });
    for (const who of [clerk, employee, ca, sa0]) {
      const reply = await send('POST', CONTACTS, { person: { firstName: 'Op' } }, { 'idempotency-key': randomUUID() }, who);
      assert.equal(reply.status, 201, `${hex(who)}: ${JSON.stringify(reply.body)}`);
    }
    await users().updateOne({ _id: ca }, { $set: { permissions: matrixOf({ r: true, w: false }) } });
    assert.equal((await send('POST', CONTACTS, { person: { firstName: 'Op' } }, { 'idempotency-key': randomUUID() }, ca)).status, 403, 'the same user without the flag');
    const sa = await user(822, { role: 'SA', placeId: null, placesId: [], companyId: null });
    assert.equal((await send('POST', CONTACTS, { person: { firstName: 'Sa' } }, { 'idempotency-key': randomUUID() }, sa)).status, 201);
  });
});

describe('the contacts of the store: who may call it and when', () => {
  it('is refused to a user (403), to a missing, forged or public key (401) and to a store that is not operational (STORE_DISABLED), and a store key does not reach the routes of the users', async () => {
    const token = await world.as.tokenOf(world.group(0).sa);
    const some = hex(new ObjectId());
    const all: Array<[string, string, unknown?]> = [
      ['GET', CONTACTS], ['POST', CONTACTS, { person: { firstName: 'x' } }], ['GET', `${CONTACTS}/${some}`], ['PATCH', `${CONTACTS}/${some}`, { notes: 'x' }], ['POST', `${CONTACTS}/${some}/trash`],
      ['POST', `${CONTACTS}/${some}/fidelity-cards/A/points-adjustments`, { delta: 1 }], ['GET', GROUPS],
      ['GET', CARDS], ['POST', CARDS, { code: 'x', cardTypeId: 'y' }], ['GET', `${CARDS}/${some}`], ['PATCH', `${CARDS}/${some}`, { enabled: true }], ['POST', `${CARDS}/${some}/adjustments`, { balanceDelta: 1 }], ['GET', `${CARDS}/${some}/movements`],
    ];
    for (const [method, path, body] of all) {
      const asUser = await world.office.call(method, path, token, body, { ...operator(clerk), 'idempotency-key': randomUUID() });
      assert.deepEqual([asUser.status, ((await asUser.json()) as { error: { code: string } }).error.code], [403, 'FORBIDDEN'], `${method} ${path}`);
      assert.equal((await world.asStore(undefined, method, path, body)).status, 401, `${method} ${path}`);
      assert.equal((await world.asStore(`fc_sk_${'x'.repeat(43)}`, method, path, body)).status, 401);
      assert.equal((await world.asStore(`fc_pk_${'a'.repeat(43)}`, method, path, body, operator(clerk))).status, 401, 'a public API key is not a store key');
    }
    // The routes of the backoffice stay shut to a store key.
    const g = `/groups/${hex(gid())}`;
    for (const [method, path] of [['GET', `${g}/contacts`], ['POST', `${g}/contacts`], ['GET', `${g}/contacts/${some}`], ['PATCH', `${g}/contacts/${some}`], ['DELETE', `${g}/contacts/${some}`], ['GET', `${g}/contact-groups`], ['GET', `${g}/fidelity-cards`], ['POST', `${g}/fidelity-cards`], ['DELETE', `${g}/fidelity-cards/${some}`], ['POST', `${g}/fidelity-cards/${some}/adjustments`]] as const) {
      assert.equal((await send(method, path, method === 'GET' ? undefined : {})).status, 403, `${method} ${path}`);
    }
    // A new activation revokes the old key; a place that is disabled makes the store not operational, for a read and for a write.
    const old = store;
    store = await world.activate(own());
    try {
      assert.equal((await get(CONTACTS, old.key)).status, 401);
      assert.equal((await send('POST', CONTACTS, { person: { firstName: 'x' } }, { 'idempotency-key': randomUUID() }, clerk, old.key)).status, 401);
      assert.equal((await get(CARDS)).status, 200);
      await copies().updateOne({ _id: own() }, { $set: { status: false } });
      const blocked = [await get(CONTACTS), await get(GROUPS), await get(CARDS), await post(CONTACTS, { person: { firstName: 'x' } }), await post(CARDS, { code: 'x', cardTypeId: 'y' })];
      assert.deepEqual(blocked.map((reply) => reply.body.error.code), Array(5).fill('STORE_DISABLED'));
    } finally {
      await copies().updateOne({ _id: own() }, { $set: { status: true } });
    }
  });

  it('keeps the answers of an Idempotency-Key to the store key that sent it', async () => {
    const key = randomUUID();
    const body = { person: { firstName: 'Una volta' } };
    const first = await send('POST', CONTACTS, body, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    store = await world.activate(own());
    const second = await send('POST', CONTACTS, body, { 'idempotency-key': key });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.data.id, first.body.data.id, 'not a replay of the answer of another key');
  });

  it('limits the writes per store key apart from the reads, with 429, and the isolation of the groups holds for the reads and the writes', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_STORE_CATALOG_WRITE_PER_STORE: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const group = office.group(0);
      const smallUser = legacyUser(831, { groupId: group.groupId, dealerId: group.dealerId, role: 'PA', placeId: group.ownPlaceId, placesId: [group.ownPlaceId], permissions: legacyPermissions({ status: false, modules: { contacts: { r: true, w: true } } }) });
      await small.databases.common().collection('users').insertOne(smallUser);
      const key = await office.activate(group.ownPlaceId);
      const write = () => office.asStore(key.key, 'POST', CONTACTS, { person: { firstName: 'x' } }, { ...operator(smallUser['_id'] as ObjectId), 'idempotency-key': randomUUID() });
      const statuses = [(await write()).status, (await write()).status];
      const limited = await write();
      assert.deepEqual([...statuses, limited.status, limited.body.error.code], [201, 201, 429, 'RATE_LIMITED']);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await office.asStore(key.key, 'GET', CONTACTS)).status, 200, 'the reads are not counted');
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('never reaches what is in another group, by id, by code or through a contact', async () => {
    const foreignCard = new ObjectId();
    await cards(1).insertOne({ _id: foreignCard, code: 'THEIRS', cardTypeId: kinds.prepaid, status: true, balance: new Double(9), pointsCollections: {}, insertDate: at(1), updateDate: at(1) });
    const foreignContact = new ObjectId();
    await contacts(1).insertOne(legacyContact({ _id: foreignContact, fidelities: [{ code: 'THEIRS', points: 2 }] }));
    assert.equal((await get(`${CARDS}/${hex(foreignCard)}`)).status, 404);
    assert.equal((await get(`${CARDS}/${hex(foreignCard)}/movements`)).status, 404);
    assert.deepEqual(ids(await get(`${CARDS}?code=THEIRS`)), []);
    assert.equal((await send('PATCH', `${CARDS}/${hex(foreignCard)}`, { enabled: false }, { 'if-match': FAKE_TAG })).status, 404);
    assert.equal((await post(`${CARDS}/${hex(foreignCard)}/adjustments`, { balanceDelta: 1 })).status, 404);
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(foreignContact)}`, { notes: 'x' }, { 'if-match': FAKE_TAG })).status, 404);
    assert.equal((await post(`${CONTACTS}/${hex(foreignContact)}/fidelity-cards/THEIRS/points-adjustments`, { delta: 1 })).status, 404);
    assert.equal((await post(CARDS, { code: 'MINE', cardTypeId: kinds.prepaid, contactIds: [hex(foreignContact)] })).status, 422);
    assert.equal((await cards(1).findOne({ _id: foreignCard }))!['balance'].valueOf(), 9);
  });

  it('opens to a store key the routes of the contacts and the cards, and no deletion', () => {
    const modules = createBackofficeModules({ config: testConfig(), databases: ctx.databases, activityLog: memoryActivityLog(), logger: memoryLogger().logger, rateLimiter: memoryRateLimiter() });
    const open = modules.routes.filter((route) => route.auth.kind === 'store').map((route) => `${route.method} ${route.path}`).filter((route) => /contacts|contact-groups|fidelity-cards/.test(route)).sort();
    assert.deepEqual(open, [
      'GET /store-context/contact-groups',
      'GET /store-context/contacts',
      'GET /store-context/contacts/:contactId',
      'GET /store-context/fidelity-cards',
      'GET /store-context/fidelity-cards/:cardId',
      'GET /store-context/fidelity-cards/:cardId/movements',
      'PATCH /store-context/contacts/:contactId',
      'PATCH /store-context/fidelity-cards/:cardId',
      'POST /store-context/contacts',
      'POST /store-context/contacts/:contactId/fidelity-cards/:code/points-adjustments',
      'POST /store-context/contacts/:contactId/trash',
      'POST /store-context/fidelity-cards',
      'POST /store-context/fidelity-cards/:cardId/adjustments',
    ]);
    for (const route of modules.routes.filter((candidate) => candidate.auth.kind === 'store' && candidate.method !== 'GET' && /contacts|fidelity-cards/.test(candidate.path))) {
      assert.equal(typeof (route.auth as { operator?: unknown }).operator, 'function', `${route.method} ${route.path} verifies the operator`);
    }
    assert.ok(!open.some((route) => route.startsWith('DELETE')), 'a store deletes nothing');
  });
});

describe('the contacts of the store: alerts and traces', () => {
  const alerts = (mark: number) => world.office.activity.entries.slice(mark).filter((entry) => ['store.creditAlert', 'store.advancedCardRelinked'].includes(entry.action));
  const hour = () => Math.floor(Date.now() / 3_600_000);
  const DAY = 86_400;

  it('raises the alerts of the store as alerts of the activity log, visible to the administrators of the group', () => {
    assert.ok(ACTIVITY_ALERT_ACTIONS.includes('store.creditAlert') && ACTIVITY_ALERT_ACTIONS.includes('store.advancedCardRelinked'));
    assert.ok(!(ACTIVITY_ALERT_ACTIONS as readonly string[]).includes('store.contactsRead'), 'the trace of the reads is not an alert');
  });

  it('alerts when a credit is above the limit of one operation or the credits of the key in a day are over the daily limit, once, and refuses nothing', async () => {
    const mark = world.office.activity.entries.length;
    const big = await post(CARDS, { code: 'BIG-1', cardTypeId: kinds.prepaid, initialBalance: 150 });
    assert.equal(big.status, 201, 'nothing is refused');
    const [first] = alerts(mark);
    assert.deepEqual([first!.action, first!.actor.kind, first!.actor.id?.toHexString(), first!.metadata], ['store.creditAlert', 'store', store.keyId, { reason: 'operation', threshold: 100, amount: 150, cardId: big.body.data.id, operatorId: hex(clerk) }]);
    assert.equal(first!.category, 'security');
    assert.equal(first!.groupId?.toHexString(), hex(gid()));
    // Credits within the limit of one operation, a debit and points do not raise the first alert; the day does at its limit, once.
    const card = big.body.data.id as string;
    const before = alerts(mark).length;
    for (const body of [{ balanceDelta: 100 }, { balanceDelta: -50 }, { pointsDeltas: [{ collectionId: kinds.active, delta: 5 }] }]) {
      assert.equal((await post(`${CARDS}/${card}/adjustments`, body)).status, 200);
    }
    assert.equal(alerts(mark).length, before, 'no alert for 100 (the limit is exceeded, not reached), a debit or points');
    const crossing = await post(`${CARDS}/${card}/adjustments`, { balanceDelta: 90 });
    assert.equal(crossing.status, 200);
    const daily = alerts(mark).filter((entry) => entry.metadata?.['reason'] === 'daily');
    assert.equal(daily.length, 1, '150 + 100 + 90 is over 300 only now');
    assert.deepEqual(daily[0]!.metadata, { reason: 'daily', threshold: 300, amount: 90, cardId: card, operatorId: hex(clerk) });
    await post(`${CARDS}/${card}/adjustments`, { balanceDelta: 90 });
    assert.equal(alerts(mark).filter((entry) => entry.metadata?.['reason'] === 'daily').length, 1, 'once for the day');
    const above = await post(`${CARDS}/${card}/adjustments`, { balanceDelta: 101 });
    assert.equal(above.status, 200);
    assert.equal(alerts(mark).filter((entry) => entry.metadata?.['reason'] === 'operation').length, 2, 'a credit of 101 is above 100');
    // A key that did not add credit has its own day.
    limiter.reset();
    const next = alerts(mark).length;
    await post(`${CARDS}/${card}/adjustments`, { balanceDelta: 10 });
    assert.equal(alerts(mark).length, next);
  });

  it('writes the alerts so that the real log accepts them', async () => {
    const mark = world.office.activity.entries.length;
    const holder = await seedContact({ fidelities: [{ code: 'RL-ADV', points: 0 }] });
    await seedCard({ code: 'RL-ADV' });
    const other = await seedContact({ name: 'Altro', fidelities: [] });
    const current = await get(`${CONTACTS}/${hex(other)}`);
    const created = await post(CARDS, { code: 'RL-BIG', cardTypeId: kinds.prepaid, initialBalance: 500 });
    assert.equal(created.status, 201);
    assert.equal((await send('PATCH', `${CONTACTS}/${hex(other)}`, { fidelityCards: [{ code: 'RL-ADV' }] }, { 'if-match': tagOf(current) })).status, 200);
    assert.equal((await get(CONTACTS)).status, 200);
    void holder;
    const { stored, refused } = await throughRealLog(ctx, world.office.activity.entries.slice(mark));
    assert.deepEqual(refused, []);
    const actions = stored.map((entry) => entry['action'] as string);
    assert.ok(actions.includes('store.creditAlert') && actions.includes('store.advancedCardRelinked'));
  });

  it('alerts when a store links to a contact an advanced card other contacts already have, in a modification and in a creation, and not otherwise', async () => {
    const card = await seedCard({ code: 'FAM-1' });
    await seedCard({ code: 'SOLO-1' });
    const mother = await seedContact({ name: 'Madre', fidelities: [{ code: 'FAM-1', points: 0 }] });
    const son = await seedContact({ name: 'Figlio', fidelities: [] });
    const mark = world.office.activity.entries.length;
    const current = await get(`${CONTACTS}/${hex(son)}`);
    const linked = await send('PATCH', `${CONTACTS}/${hex(son)}`, { fidelityCards: [{ code: 'FAM-1' }] }, { 'if-match': tagOf(current) });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const [event] = alerts(mark);
    assert.deepEqual([event!.action, event!.actor.kind, event!.metadata], ['store.advancedCardRelinked', 'store', { contactId: hex(son), cardId: hex(card), otherContacts: 1, operatorId: hex(clerk) }]);
    assert.ok(!JSON.stringify(event).includes('FAM-1'), 'never the code');
    // Not an alert: a change that does not touch the codes, the same code again, a simple code, an advanced card nobody has.
    const same = await send('PATCH', `${CONTACTS}/${hex(son)}`, { fidelityCards: [{ code: 'FAM-1' }], notes: 'x' }, { 'if-match': tagOf(linked) });
    assert.equal(same.status, 200);
    const notes = await send('PATCH', `${CONTACTS}/${hex(son)}`, { notes: 'y' }, { 'if-match': tagOf(same) });
    const simple = await send('PATCH', `${CONTACTS}/${hex(son)}`, { fidelityCards: [{ code: 'FAM-1' }, { code: 'SIMPLE' }] }, { 'if-match': tagOf(notes) });
    const unheld = await send('PATCH', `${CONTACTS}/${hex(son)}`, { fidelityCards: [{ code: 'FAM-1' }, { code: 'SOLO-1' }] }, { 'if-match': tagOf(simple) });
    assert.equal(unheld.status, 200, JSON.stringify(unheld.body));
    assert.equal(alerts(mark).length, 1);
    // A new contact with the code of the family is one too.
    const created = await post(CONTACTS, { person: { firstName: 'Nipote' }, fidelityCards: [{ code: 'FAM-1' }] });
    assert.equal(created.status, 201);
    const second = alerts(mark);
    assert.deepEqual([second.length, second[1]!.metadata?.['otherContacts'], second[1]!.metadata?.['contactId']], [2, 2, created.body.data.id]);
    void mother;
  });

  it('writes the trace of the contacts a key read in the hours before, once an hour, with the count only', async () => {
    await seedContact({ name: 'Uno' });
    await seedContact({ name: 'Due' });
    const mark = world.office.activity.entries.length;
    const counter = (index: number) => `${store.keyId}:${String(index)}`;
    const trace = () => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.contactsRead');
    // Nothing read before: the first read opens the hour and tells nothing.
    assert.equal((await get(CONTACTS)).status, 200);
    assert.equal(trace().length, 0);
    // Reads of the hours before that the key did not tell yet are told by the first read of an hour, together, once.
    limiter.reset();
    const h = hour();
    await limiter.consume('storeContactsRead:count', counter(h - 1), 1_000_000_000, 30 * DAY, 7);
    await limiter.consume('storeContactsRead:count', counter(h - 5), 1_000_000_000, 30 * DAY, 3);
    const read = await get(CONTACTS);
    assert.equal(read.status, 200);
    const [entry] = trace();
    assert.equal(trace().length, 1);
    assert.deepEqual([entry!.category, entry!.actor.kind, entry!.actor.id?.toHexString(), entry!.metadata?.['count'], typeof entry!.metadata?.['hour']], ['security', 'store', store.keyId, 10, 'string']);
    assert.ok(!JSON.stringify(entry).match(/Uno|Due|name|surname/), 'a count and nothing else');
    // At most once an hour: more reads, the detail too, tell nothing more, and what was told is not told again.
    const one = (await get(CONTACTS)).body.data[0].id as string;
    assert.equal((await get(`${CONTACTS}/${one}`)).status, 200);
    assert.equal(trace().length, 1);
    assert.equal((await get(`${CONTACTS}?q=nobody-at-all`)).status, 200);
    assert.equal(trace().length, 1, 'a read of no contact counts nothing');
    // The entry is not an alert and is the store key's, in the group of the key.
    assert.equal(entry!.groupId?.toHexString(), hex(gid()));
    limiter.reset();
    await limiter.consume('storeContactsRead:count', counter(h - 2), 1_000_000_000, 30 * DAY, 4);
    await limiter.consume('storeContactsRead:told', counter(h - 2), 1, 30 * DAY);
    assert.equal((await get(CONTACTS)).status, 200);
    assert.equal(trace().length, 1, 'an hour already told is not told twice');
  });
});
