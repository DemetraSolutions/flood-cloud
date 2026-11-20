import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser as addBackofficeUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { LEGACY_MODULE_NAMES, fixtureId, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { TEST_CLUSTER, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const PASSWORD = `Prov-${randomBytes(8).toString('hex')}-pass`;
const users = () => ctx.databases.common().collection('users');
const g0 = () => office.cluster.groups[0]!;
const g1 = () => office.cluster.groups[1]!;
const hex = (id: ObjectId) => id.toHexString();
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);
const stored = async (id: ObjectId): Promise<Document> => (await users().findOne({ _id: id }))!;
const idOf = (reply: { body: { data: { id: string } } }) => ObjectId.createFromHexString(reply.body.data.id);
const path = (id?: ObjectId, group = g0()) => `/groups/${hex(group.groupId)}/users${id === undefined ? '' : `/${hex(id)}`}`;
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
let sequence = 0;
const name = (): string => `data-${String(sequence++)}`;
const body = (overrides: Document = {}): Document => ({ username: name(), password: PASSWORD, role: 'E', placeIds: [hex(place(1))], ...overrides });
const failure = (reply: Awaited<ReturnType<typeof as.call>>) => as.failure(reply);
const full = { r: true, w: true };
const everything = (status = true) => legacyPermissions({ status, modules: Object.fromEntries(LEGACY_MODULE_NAMES.map((module) => [module, module === 'logs' ? { r: true } : full])) });
/** A user of the first group; an SA with the whole matrix and no POS grant unless told otherwise. */
const fresh = async (overrides: Document = {}) => (await addBackofficeUser(ctx, office, { permissions: everything(), ...overrides })).id;
const freshPa = (overrides: Document = {}) => fresh({ role: 'PA', companyId: company(1), placeId: place(1), placesId: [place(1)], ...overrides });
/** A CA or PA of the first group who may manage permissions and holds the given POS sub values. */
const limitedActor = (role: 'CA' | 'PA', cash: { sub?: Document; options?: Document; status?: boolean } = {}, manage = true) =>
  role === 'CA'
    ? fresh({ role, companyId: company(1), placeId: null, placesId: [], permissions: { ...legacyPermissions({ status: manage, modules: everything().modules ?? {}, sub: cash.sub ?? {}, options: cash.options ?? {}, cashStatus: cash.status ?? true }), ...Object.fromEntries(LEGACY_MODULE_NAMES.map((module) => [module, module === 'logs' ? { r: true } : full])) } })
    : freshPa({ permissions: { ...legacyPermissions({ status: manage, sub: cash.sub ?? {}, options: cash.options ?? {}, cashStatus: cash.status ?? true }), ...Object.fromEntries(LEGACY_MODULE_NAMES.map((module) => [module, module === 'logs' ? { r: true } : full])) } });

// A tiny valid-looking picture for each type, and what is not one.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(24)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), randomBytes(4), Buffer.from('WEBP'), randomBytes(16)]);
const dataUrl = (type: string, bytes: Buffer): string => `data:image/${type};base64,${bytes.toString('base64')}`;

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  await ctx.databases.common().collection('groups').updateOne({ _id: g0().groupId }, { $set: { 'settings.services': true, productsFavorites: [{ id: 'fav-1', name: 'Bar', favorites: [] }] } });
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

/** The permissions and POS data a new user of a role gets in the legacy form (A3 of the analysis), written out by hand. */
const A3: Record<string, Record<string, string>> = {
  SA: { groups: 'rw', users: 'rw', companies: 'rw', places: 'rw', documents: 'rw', products: 'rw', calendar: 'rw', warehouse: 'rw', contacts: 'rw', fidelity: 'rw', settings: 'rw', stats: 'r', logs: 'r' },
  CA: { groups: '-', users: 'rw', companies: 'rw', places: 'rw', documents: 'rw', products: 'rw', calendar: 'rw', warehouse: 'rw', contacts: 'rw', fidelity: '-', settings: '-', stats: 'r', logs: 'r' },
  PA: { groups: '-', users: 'rw', companies: '-', places: 'rw', documents: 'rw', products: 'rw', calendar: 'rw', warehouse: 'rw', contacts: 'rw', fidelity: '-', settings: '-', stats: 'r', logs: 'r' },
  E: { groups: '-', users: '-', companies: '-', places: 'r', documents: '-', products: 'r', calendar: '-', warehouse: '-', contacts: 'rw', fidelity: '-', settings: '-', stats: '-', logs: '-' },
  PSA: { groups: 'rw', users: 'rw', companies: 'rw', places: 'rw', documents: '-', products: '-', calendar: '-', warehouse: '-', contacts: '-', fidelity: '-', settings: '-', stats: '-', logs: 'r' },
};
A3['D'] = A3['PSA']!;

function expectedPermissions(role: string, priceLists: Document): Document {
  const table = A3[role]!;
  const modules = Object.fromEntries(Object.entries(table).map(([module, cell]) => [module, module === 'logs' ? { r: cell !== '-' } : { r: cell !== '-', w: cell === 'rw' }]));
  const startsWithPos = role !== 'PSA' && role !== 'D';
  const result = legacyPermissions({
    status: false,
    modules,
    cashStatus: startsWithPos,
    sub: startsWithPos ? { discount: true, prices: true, invoices: true, freeSale: true } : {},
    options: { priceLists },
  });
  // The keys of the legacy that a new document does not carry.
  delete result['hiddenInStats'];
  const cash = (result['apps'] as { cash: { sub: Document; options: Document } }).cash;
  delete cash.sub['productsStatus'];
  delete cash.options['service'];
  return result;
}

describe('POST: the complete legacy document of every role', () => {
  const groupPriceLists = async (group = g0()): Promise<Document> => {
    const lists = ((await ctx.databases.common().collection('groups').findOne({ _id: group.groupId }))!['priceLists'] ?? {}) as Document;
    return Object.fromEntries(Object.entries(lists).map(([id, list]) => [id, { status: true, selected: (list as Document)['default'] === true }]));
  };

  const cases: Array<[string, Document]> = [
    ['SA', { role: 'SA', placeIds: undefined }],
    ['CA', { role: 'CA', placeIds: undefined, companyIds: [hex(company(1))] }],
    ['PA', { role: 'PA' }],
    ['E', { role: 'E' }],
  ];
  for (const [role, request] of cases) {
    it(`gives a ${role} every key the legacy form writes, with the defaults of the form and the price lists of the group`, async () => {
      const username = name();
      const reply = await as.call(g0().sa, 'POST', path(), body({ ...request, username }));
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const document = await stored(idOf(reply));
      assert.deepEqual(document['permissions'], expectedPermissions(role, await groupPriceLists()));
      assert.deepEqual([document['avatar'], document['pin'], document['description'], document['servicesId'], document['name'], document['surname'], document['email'], document['telephone']], [null, null, null, [], null, null, null, null]);
      assert.deepEqual(document['settings'], { language: 'it', theme: 'system', hiddenInStats: false });
      assert.deepEqual(document['shiftTime'], { status: false, weeksGeneric: [], daySpecial: {} });
      assert.deepEqual(reply.body.data.pos.options.priceLists.length, 1);
      assert.deepEqual(reply.body.data.pos.options.priceLists[0].isDefault, true);
      assert.deepEqual([reply.body.data.pinSet, reply.body.data.hasAvatar, reply.body.data.description, reply.body.data.serviceIds], [false, false, null, []]);
    });
  }

  for (const role of ['PSA', 'D']) {
    it(`gives a ${role} the complete document too, with the app off, no grant and no price list`, async () => {
      const reply = await as.call(office.cluster.psa, 'POST', '/users', { username: name(), password: PASSWORD, role });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const document = await stored(idOf(reply));
      assert.deepEqual(document['permissions'], expectedPermissions(role, {}));
      assert.deepEqual([document['groupId'], document['servicesId'], document['shiftTime']], [null, [], { status: false, weeksGeneric: [], daySpecial: {} }]);
    });
  }

  it('lets the values of the request replace the defaults, and writes them as the legacy does', async () => {
    const reply = await as.call(
      g0().sa,
      'POST',
      path(),
      body({
        role: 'PA',
        description: 'Cashier',
        pin: '4321',
        avatar: dataUrl('png', PNG),
        hiddenInStats: true,
        permissions: { canManagePermissions: true, modules: { documents: { w: false }, stats: { w: true }, logs: { r: false }, settings: { r: true } } },
        pos: {
          enabled: true,
          grants: { discount: false, rider: true, printPrebill: true, discountMaxPercentage: 25, servicePercentage: 10, automaticCash: { glory: { deposit: true } } },
          options: { darkMode: true, side: 'sx', template: null, productsFontSize: 'l', roomsTablesColumns: 6, favoritesId: 'fav-1', priceLists: [], quickDiscount: 5 },
        },
        shiftTime: {
          enabled: true,
          weeks: [{ from: null, to: null, days: { '1': { active: true, slots: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] } } }, { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z', days: {} }],
          specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }],
        },
        serviceIds: [],
      }),
    );
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const document = await stored(idOf(reply));
    const permissions = document['permissions'] as Document;
    assert.deepEqual([permissions['documents'], permissions['stats'], permissions['logs'], permissions['settings'], permissions['status']], [{ r: true, w: false }, { r: true, w: true }, { r: false }, { r: true, w: false }, true]);
    const cash = (permissions['apps'] as Document)['cash'] as { sub: Document; options: Document; status: boolean };
    assert.deepEqual([cash.sub['discount'], cash.sub['rider'], cash.sub['preblling'], cash.sub['discountMaxPercentage'], cash.sub['service'], (cash.sub['automaticCash'] as Document)['glory']], [false, true, true, 25, 10, { withdrawal: false, deposit: true, archive: false, archiveAll: false, unlockNote: false, unlockCoin: false, collectVerify: false }]);
    assert.deepEqual([cash.options['darkMode'], cash.options['side'], cash.options['template'], cash.options['productsFontSize'], cash.options['roomsTablesColumns'], cash.options['favoritesId'], cash.options['priceLists'], cash.options['quickDiscount']], [true, 'sx', null, 'l', 6, 'fav-1', {}, 5]);
    assert.deepEqual([document['description'], document['pin'], document['avatar'], (document['settings'] as Document)['hiddenInStats']], ['Cashier', '4321', dataUrl('png', PNG), true]);
    const shift = document['shiftTime'] as { status: boolean; weeksGeneric: Array<{ start: Date | null; end: Date | null; days: Document }>; daySpecial: Document };
    assert.equal(shift.status, true);
    assert.deepEqual([shift.weeksGeneric[0]!.start, shift.weeksGeneric[1]!.start], [null, new Date('2026-06-01T00:00:00.000Z')]);
    assert.deepEqual(shift.weeksGeneric[0]!.days['1'], { active: true, values: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] });
    assert.deepEqual(Object.keys(shift.weeksGeneric[0]!.days), ['0', '1', '2', '3', '4', '5', '6']);
    assert.deepEqual(shift.daySpecial, { '2026-12-25': { free: true, values: [] } });
    // The response shows the picture and whether there is a PIN, never the PIN; the log keeps neither.
    const data = reply.body.data;
    assert.deepEqual([data.pinSet, data.hasAvatar, data.avatar, data.pos.options.favoritesId, data.shiftTime.weeks[1].from], [true, true, dataUrl('png', PNG), 'fav-1', '2026-06-01T00:00:00.000Z']);
    // Quoted: a hex id or a date can contain the digits, never a whole string value equal to the PIN.
    assert.ok(!JSON.stringify(reply.body).includes('"4321"'));
    const logged = JSON.stringify(office.activity.entries.at(-1));
    assert.ok(!logged.includes('"4321"') && !logged.includes(dataUrl('png', PNG)));
    assert.ok(logged.includes('"pinSet"') && logged.includes('avatarHash'));
  });
});

describe('POST: what is refused', () => {
  const post = async (overrides: Document, actor = g0().sa) => failure(await as.call(actor, 'POST', path(), body(overrides)));

  it('refuses a picture that is not a small PNG, JPEG or WebP, whatever the prefix says', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`;
    for (const avatar of [svg, dataUrl('png', JPEG), dataUrl('jpeg', WEBP), dataUrl('webp', PNG), 'data:image/png;base64,@@@@', 'data:image/png;base64,iVBORw0K=', 'https://x.test/a.png', '']) {
      assert.deepEqual(await post({ avatar }), invalid(['avatar', 'format']), avatar.slice(0, 40));
    }
    assert.deepEqual(await post({ avatar: 5 }), invalid(['avatar', 'type']));
    const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024 + 1 - PNG.length)]);
    assert.deepEqual(await post({ avatar: dataUrl('png', big) }), invalid(['avatar', 'maximum']));
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ avatar: dataUrl('webp', WEBP) }))).status, 201);
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ avatar: dataUrl('jpeg', JPEG) }))).status, 201);
    const exact = Buffer.concat([PNG, Buffer.alloc(200 * 1024 - PNG.length)]);
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ avatar: dataUrl('png', exact) }))).status, 201);
  });

  it('refuses a PIN, notes or POS values out of their shape', async () => {
    for (const pin of ['12', '1234567', 'abcd', '12 34', 1234]) {
      assert.equal((await post({ pin })).status, 422, String(pin));
    }
    assert.deepEqual(await post({ description: 'x'.repeat(1001) }), invalid(['description', 'maxLength']));
    assert.deepEqual(await post({ pos: { grants: { discountMaxPercentage: 101 } } }), invalid(['pos.grants.discountMaxPercentage', 'maximum']));
    assert.deepEqual(await post({ pos: { grants: { preblling: true } } }), invalid(['pos.grants.preblling', 'unknown']));
    assert.deepEqual(await post({ pos: { options: { side: 'up', roomsTablesColumns: 7, roomsGridZoomHandheld: 4, productsFontSize: 'L' } } }), invalid(['pos.options.side', 'enum'], ['pos.options.productsFontSize', 'enum'], ['pos.options.roomsTablesColumns', 'enum'], ['pos.options.roomsGridZoomHandheld', 'enum']));
    assert.deepEqual(await post({ pos: { options: { roomsTablesColumns: '6' } } }), invalid(['pos.options.roomsTablesColumns', 'type']));
    assert.deepEqual(await post({ permissions: { modules: { logs: { w: true } } } }), invalid(['permissions.modules.logs.w', 'unknown']));
    assert.deepEqual(await post({ serviceIds: ['zz'] }), invalid(['serviceIds.0', 'format']));
  });

  it('refuses price lists and favorites that are not the group\'s, repeated, or with two defaults', async () => {
    const own = Object.keys(((await ctx.databases.common().collection('groups').findOne({ _id: g0().groupId }))!['priceLists'] ?? {}) as Document)[0]!;
    const list = (priceListId: string, isDefault = false) => ({ priceListId, enabled: true, isDefault });
    assert.deepEqual(await post({ pos: { options: { priceLists: [list('nope'), list(own, true), list(own, true)], favoritesId: 'nope', defaultPriceListId: 'nope' } } }), invalid(
      ['pos.options.priceLists.0.priceListId', 'incorrect'],
      ['pos.options.priceLists.2.priceListId', 'incorrect'],
      ['pos.options.priceLists.2.isDefault', 'incorrect'],
      ['pos.options.favoritesId', 'incorrect'],
      ['pos.options.defaultPriceListId', 'incorrect'],
    ));
    // The favorites list of another group does not count, and a platform user has no lists at all.
    await ctx.databases.common().collection('groups').updateOne({ _id: g1().groupId }, { $set: { productsFavorites: [{ id: 'fav-other', name: 'x', favorites: [] }] } });
    assert.deepEqual(await post({ pos: { options: { favoritesId: 'fav-other' } } }), invalid(['pos.options.favoritesId', 'incorrect']));
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'POST', '/users', { username: name(), password: PASSWORD, role: 'D', pos: { options: { favoritesId: 'fav-1' } } })), invalid(['pos.options.favoritesId', 'incorrect']));
  });

  it('refuses invalid shifts, field by field', async () => {
    const week = (from: string | null, to: string | null, slots = [{ start: '09:00', end: '13:00' }]) => ({ from, to, days: { '1': { active: true, slots } } });
    assert.deepEqual(await post({ shiftTime: { weeks: [week(null, null, [{ start: '13:00', end: '09:00' }])] } }), invalid(['shiftTime.weeks.0.days.1.slots.0.end', 'incorrect']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week(null, null, [{ start: '9:00', end: '13:00' }])] } }), invalid(['shiftTime.weeks.0.days.1.slots.0.start', 'pattern']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week(null, null), week(null, null)] } }), invalid(['shiftTime.weeks.1', 'incorrect']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'), week('2026-01-15T00:00:00.000Z', '2026-03-01T00:00:00.000Z')] } }), invalid(['shiftTime.weeks.1', 'incorrect']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week('2026-01-01T00:00:00.000Z', null)] } }), invalid(['shiftTime.weeks.0.to', 'required']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week('2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')] } }), invalid(['shiftTime.weeks.0.to', 'incorrect']));
    assert.deepEqual(await post({ shiftTime: { specialDays: [{ date: '2026-02-30', dayOff: true, slots: [] }] } }), invalid(['shiftTime.specialDays.0.date', 'format']));
    assert.deepEqual(await post({ shiftTime: { specialDays: [{ date: '2026-12-25T10:00:00.000Z', dayOff: true, slots: [] }] } }), invalid(['shiftTime.specialDays.0.date', 'format']));
    assert.deepEqual(await post({ shiftTime: { specialDays: [{ date: 5, dayOff: true, slots: [] }] } }), invalid(['shiftTime.specialDays.0.date', 'type']));
    assert.deepEqual(await post({ shiftTime: { specialDays: [{ date: '2026-12-25', dayOff: true, slots: [] }, { date: '2026-12-25', dayOff: false, slots: [] }] } }), invalid(['shiftTime.specialDays.1.date', 'incorrect']));
    assert.deepEqual(await post({ shiftTime: { weeks: Array.from({ length: 21 }, () => week(null, null)) } }), invalid(['shiftTime.weeks', 'tooMany']));
    assert.deepEqual(await post({ shiftTime: { weeks: [week(null, null, Array.from({ length: 11 }, () => ({ start: '08:00', end: '09:00' })))] } }), invalid(['shiftTime.weeks.0.days.1.slots', 'tooMany']));
    assert.deepEqual(await post({ shiftTime: { weeks: [{ from: null, to: null, days: { '7': { active: true, slots: [] } } }] } }), invalid(['shiftTime.weeks.0.days.(key)', 'unknown']));
  });
});

describe('POST: the services a user provides', () => {
  const products = () => ctx.databases.group(g0().groupId, TEST_CLUSTER).collection('products');
  let service: ObjectId;
  let second: ObjectId;
  let goods: ObjectId;
  let trashed: ObjectId;
  let foreign: ObjectId;

  before(async () => {
    [service, second, goods, trashed, foreign] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
    await products().insertMany([
      { _id: service, type: 'service', name: { it: 'Taglio' } },
      { _id: second, type: 'service', name: { en: 'Colour' } },
      { _id: goods, type: 'product', name: { it: 'Shampoo' } },
      { _id: trashed, type: 'service', trash: true, name: { it: 'Vecchio' } },
    ]);
    await ctx.databases.group(g1().groupId, TEST_CLUSTER).collection('products').insertOne({ _id: foreign, type: 'service', name: { it: 'Altrove' } });
  });

  const post = async (overrides: Document, group = g0(), actor = g0().sa) => as.call(actor, 'POST', path(undefined, group), body({ placeIds: [hex(group === g0() ? place(1) : place(3))], ...overrides }));

  it('stores the services of the group for an SA, CA or PA and shows them', async () => {
    const created = await post({ role: 'PA', serviceIds: [hex(service), hex(second)] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.data.serviceIds, [hex(service), hex(second)]);
    assert.deepEqual(((await stored(idOf(created)))['servicesId'] as ObjectId[]).map(hex), [hex(service), hex(second)]);
    assert.equal((await post({ role: 'SA', placeIds: undefined, serviceIds: [hex(service)] })).status, 201);
  });

  it('refuses ids that are not services of the group, repeated ids, an employee and a group without the feature', async () => {
    assert.deepEqual(failure(await post({ role: 'PA', serviceIds: [hex(goods), hex(trashed), hex(foreign), hex(new ObjectId())] })), invalid(['serviceIds.0', 'incorrect'], ['serviceIds.1', 'incorrect'], ['serviceIds.2', 'incorrect'], ['serviceIds.3', 'incorrect']));
    assert.deepEqual(failure(await post({ role: 'PA', serviceIds: [hex(service), hex(service)] })), invalid(['serviceIds.1', 'incorrect']));
    assert.deepEqual(failure(await post({ role: 'E', serviceIds: [hex(service)] })), invalid(['serviceIds', 'notAllowed']));
    assert.deepEqual(failure(await post({ role: 'PA', serviceIds: [hex(foreign)] }, g1(), g1().sa)), invalid(['serviceIds', 'notAllowed']));
    assert.equal((await post({ role: 'E', serviceIds: [] })).status, 201, 'an empty list is always fine');
  });

  it('changes and clears them on a user, and does not check again what he already has', async () => {
    const id = await freshPa({ servicesId: [service] });
    const reply = await as.call(g0().sa, 'PATCH', path(id), { serviceIds: [hex(second)] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(((await stored(id))['servicesId'] as ObjectId[]).map(hex), [hex(second)]);
    // A service that was trashed since stays on the user; an unrelated change does not fail because of it.
    await products().updateOne({ _id: second }, { $set: { trash: true } });
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { serviceIds: [hex(second)], description: 'x' })).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { serviceIds: [hex(second), hex(goods)] })), invalid(['serviceIds.1', 'incorrect']));
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { serviceIds: [] })).status, 200);
    assert.deepEqual((await stored(id))['servicesId'], []);
    await products().updateOne({ _id: second }, { $unset: { trash: '' } });
  });
});

describe('PATCH: by path, keeping what the backend does not manage', () => {
  it('writes each value at its own path and leaves the residual keys and the other values as they are', async () => {
    const id = await freshPa({ permissions: { ...everything(), hiddenInStats: true, apps: { cash: { status: true, sub: { discounts: true, productsStatus: false, rider: true, deleteTableProductReason: false }, options: { service: 3, side: 'dx', receipts: false } } } }, shiftTime: { ststus: false, extra: 1, daySpecial: {}, weeksGeneric: [] } });
    const before = await stored(id);
    const reply = await as.call(g0().sa, 'PATCH', path(id), {
      description: 'Notes',
      hiddenInStats: true,
      pos: { enabled: false, grants: { discount: true, printReceipt: true, discountMaxPercentage: 12.5, automaticCash: { cashMatic: { change: true } } }, options: { side: 'sx', darkMode: true } },
      shiftTime: { enabled: true, specialDays: [{ date: '2026-01-01', dayOff: true, slots: [] }] },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(id);
    const cash = ((after['permissions'] as Document)['apps'] as Document)['cash'] as { status: boolean; sub: Document; options: Document };
    const was = ((before['permissions'] as Document)['apps'] as Document)['cash'] as { status: boolean; sub: Document; options: Document };
    assert.deepEqual([cash.status, cash.sub['discount'], cash.sub['receipt'], cash.sub['discountMaxPercentage'], (cash.sub['automaticCash'] as Document)['cashMatic']], [false, true, true, 12.5, { change: true }]);
    assert.deepEqual([cash.options['side'], cash.options['darkMode'], cash.options['service'], cash.options['receipts']], ['sx', true, 3, false]);
    assert.deepEqual([cash.sub['discounts'], cash.sub['productsStatus'], cash.sub['rider'], cash.sub['deleteTableProductReason']], [true, false, true, false]);
    assert.deepEqual(cash.sub['posClosure'], was.sub['posClosure']);
    assert.equal(((after['permissions'] as Document)['hiddenInStats']), true, 'the leftover of the old form stays');
    assert.deepEqual([after['description'], (after['settings'] as Document)['hiddenInStats']], ['Notes', true]);
    assert.deepEqual(after['shiftTime'], { ststus: false, extra: 1, daySpecial: { '2026-01-01': { free: true, values: [] } }, weeksGeneric: [], status: true });
    for (const field of ['userName', 'password', 'pin', 'role', 'groupId', 'placesId']) {
      assert.deepEqual(after[field], before[field], field);
    }
    // The POS grants changed: a change of permissions, which empties the legacy tokens (D-11).
    assert.deepEqual([(before['tokens'] as unknown[]).length > 0, after['tokens']], [true, []]);
    assert.deepEqual(reply.body.data.pos.grants.discountMaxPercentage, 12.5);
  });

  it('treats a change of the POS app or grants as a change of permissions (event, sessions and legacy tokens), and one of the options alone not', async () => {
    const id = await freshPa();
    const events = (mark: number) => office.activity.entries.slice(mark).filter((entry) => entry.action === 'user.permissionsChanged').length;
    let token = await as.tokenOf(id);
    let mark = office.activity.entries.length;
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { pos: { options: { darkMode: true } } })).status, 200);
    assert.deepEqual([events(mark), (await send(office, 'GET', '/me', token)).status], [0, 200]);
    for (const pos of [{ enabled: false }, { grants: { rider: true } }, { grants: { automaticCash: { vne: { tools: true } } } }, { grants: { servicePercentage: 10 } }]) {
      await users().updateOne({ _id: id }, { $set: { tokens: [{ token: 'legacy' }] } });
      mark = office.activity.entries.length;
      assert.equal((await as.call(g0().sa, 'PATCH', path(id), { pos })).status, 200, JSON.stringify(pos));
      assert.deepEqual([events(mark), (await send(office, 'GET', '/me', token)).status, (await stored(id))['tokens']], [1, 401, []], JSON.stringify(pos));
      token = await as.tokenOf(id);
    }
  });

  it('clears the nullable values with null and the lists with []', async () => {
    const id = await freshPa({ description: 'Old', pin: '9999', avatar: dataUrl('png', PNG), servicesId: [new ObjectId()], permissions: { ...everything(), apps: legacyPermissions({ sub: { discountMaxPercentage: 30, service: 5 }, options: { favoritesId: 'fav-1', quickDiscount: 10, roomsTablesColumns: 4, template: 'material-tealwhite-dark' } }).apps } });
    const reply = await as.call(g0().sa, 'PATCH', path(id), {
      description: null,
      pin: null,
      avatar: null,
      serviceIds: [],
      pos: { grants: { discountMaxPercentage: null, servicePercentage: null }, options: { favoritesId: null, quickDiscount: null, roomsTablesColumns: null, template: null, priceLists: [] } },
      shiftTime: { weeks: [], specialDays: [] },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = await stored(id);
    assert.deepEqual([after['description'], after['pin'], after['avatar'], after['servicesId']], [null, null, null, []]);
    const cash = ((after['permissions'] as Document)['apps'] as Document)['cash'] as { sub: Document; options: Document };
    assert.deepEqual([cash.sub['discountMaxPercentage'], cash.sub['service'], cash.options['favoritesId'], cash.options['quickDiscount'], cash.options['roomsTablesColumns'], cash.options['template'], cash.options['priceLists']], [null, null, null, null, null, null, {}]);
    assert.deepEqual([reply.body.data.pinSet, reply.body.data.hasAvatar, reply.body.data.avatar, reply.body.data.description], [false, false, null, null]);
  });

  it('sets, changes and removes the PIN without ever returning or logging it', async () => {
    const id = await freshPa();
    const mark = office.activity.entries.length;
    const set = await as.call(g0().sa, 'PATCH', path(id), { pin: '135790' });
    assert.equal(set.body.data.pinSet, true);
    assert.equal((await stored(id))['pin'], '135790');
    assert.ok(!JSON.stringify(set.body).includes('135790'));
    assert.ok(!JSON.stringify(office.activity.entries.slice(mark)).includes('135790'));
    // The fixture user already had a PIN: the event says that it was set, without saying which.
    const logged = office.activity.entries.slice(mark).at(-1)!.changes!.find((change) => change.field === 'pinChange');
    assert.deepEqual([logged?.before, logged?.after], [undefined, 'set']);
    for (const reply of [await as.call(g0().sa, 'GET', path(id)), await as.call(g0().sa, 'GET', path())]) {
      assert.ok(!JSON.stringify(reply.body).includes('135790'));
    }
    // A PIN is not a session credential: nobody is signed out.
    const token = await as.tokenOf(id);
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { pin: '246810' })).status, 200);
    assert.equal((await send(office, 'GET', '/me', token)).status, 200);
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { pin: null })).body.data.pinSet, false);
    assert.equal(office.activity.entries.at(-1)!.changes!.find((change) => change.field === 'pinChange')?.after, 'removed');
    assert.equal((await stored(id))['pin'], null);
  });

  it('never returns a stored picture of another kind (the legacy validated nothing), and still removes it with null', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')}`;
    const id = await freshPa({ avatar: svg });
    const detail = await as.call(g0().sa, 'GET', path(id));
    assert.deepEqual([detail.body.data.avatar, detail.body.data.hasAvatar], [null, true]);
    assert.ok(!JSON.stringify(detail.body).includes('svg'));
    const cleared = await as.call(g0().sa, 'PATCH', path(id), { avatar: null });
    assert.deepEqual([cleared.status, cleared.body.data.hasAvatar, (await stored(id))['avatar']], [200, false, null]);
  });

  it('shows the picture in the detail and not in the lists, and records a fingerprint of it', async () => {
    const id = await freshPa({ avatar: dataUrl('png', PNG) });
    const mark = office.activity.entries.length;
    const detail = await as.call(g0().sa, 'GET', path(id));
    assert.deepEqual([detail.body.data.avatar, detail.body.data.hasAvatar], [dataUrl('png', PNG), true]);
    const list = await as.call(g0().sa, 'GET', `${path()}?limit=200`);
    const row = list.body.data.find((user: Document) => user['id'] === hex(id));
    assert.deepEqual([row.hasAvatar, 'avatar' in row], [true, false]);
    assert.ok(!JSON.stringify(list.body).includes('data:image'));
    await as.call(g0().sa, 'PATCH', path(id), { avatar: dataUrl('jpeg', JPEG) });
    const changes = office.activity.entries.slice(mark).at(-1)!.changes!;
    assert.ok(changes.some((change) => change.field === 'avatarHash' && change.before !== change.after));
    assert.ok(!JSON.stringify(changes).includes('base64'));
  });

  it('validates a patch of the shifts against the shifts that result, and leaves an irregular stored value alone otherwise', async () => {
    const id = await freshPa({ shiftTime: 0 });
    // A stored value that is not an object is read as no shifts, and replaced when a shift is written.
    assert.equal((await as.call(g0().sa, 'GET', path(id))).body.data.shiftTime.enabled, false);
    const reply = await as.call(g0().sa, 'PATCH', path(id), { shiftTime: { enabled: true } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual((await stored(id))['shiftTime'], { status: true });
    const second = await freshPa({ shiftTime: null, permissions: { ...everything(), apps: null } });
    const reply2 = await as.call(g0().sa, 'PATCH', path(second), { shiftTime: { enabled: true }, pos: { enabled: true } });
    assert.equal(reply2.status, 200, JSON.stringify(reply2.body));
    const after = await stored(second);
    assert.deepEqual([after['shiftTime'], ((after['permissions'] as Document)['apps'] as Document)['cash']], [{ status: true }, { status: true }]);
    const dated = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', days: {} };
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { shiftTime: { weeks: [dated] } })).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { shiftTime: { weeks: [dated, { ...dated, from: '2026-01-31T00:00:00.000Z' }] } })), invalid(['shiftTime.weeks.1', 'incorrect']));
  });
});

describe('POS permissions: who may give what', () => {
  it('needs canManagePermissions for any change of a grant or of the app, as for the other permissions', async () => {
    const target = await freshPa({ permissions: everything(false) });
    const noManage = await fresh({ permissions: everything(false) });
    assert.deepEqual(failure(await as.call(noManage, 'PATCH', path(target), { pos: { grants: { rider: true } } })), denied);
    assert.deepEqual(failure(await as.call(noManage, 'PATCH', path(target), { pos: { enabled: false } })), denied);
    // The options are not permissions: whoever can modify the user can change them.
    assert.equal((await as.call(noManage, 'PATCH', path(target), { pos: { options: { darkMode: true } } })).status, 200);
    // A creator without it gets the default of the role, and cannot choose another.
    assert.equal((await as.call(noManage, 'POST', path(), body({ role: 'PA' }))).status, 201);
    assert.deepEqual(failure(await as.call(noManage, 'POST', path(), body({ role: 'PA', pos: { grants: { rider: true } } }))), denied);
    assert.deepEqual(failure(await as.call(noManage, 'POST', path(), body({ role: 'PA', pos: { enabled: false } }))), denied);
  });

  it('lets PSA, D and SA give any POS permission', async () => {
    for (const actor of [office.cluster.psa, office.cluster.dealerA, g0().sa]) {
      const created = await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { rider: true, tableMerge: true, discountMaxPercentage: 100, automaticCash: { vne: { tools: true } } } } }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const updated = await as.call(actor, 'PATCH', path(idOf(created)), { pos: { grants: { rider: false, tableClose: true } } });
      assert.equal(updated.status, 200);
    }
  });

  for (const role of ['CA', 'PA'] as const) {
    it(`lets a ${role} give only the POS permissions he has, the cap included`, async () => {
      const actor = await limitedActor(role, { sub: { rider: true, discount: true, discountMaxPercentage: 20, automaticCash: { glory: { deposit: true } } } });
      const target = await freshPa();
      const patch = (pos: Document) => as.call(actor, 'PATCH', path(target), { pos });
      assert.equal((await patch({ grants: { rider: true, discountMaxPercentage: 20, automaticCash: { glory: { deposit: true } } } })).status, 200);
      assert.equal((await patch({ grants: { rider: false } })).status, 200, 'turning off is free');
      assert.deepEqual(failure(await patch({ grants: { tableMerge: true } })), notAllowed('pos.grants.tableMerge'));
      assert.deepEqual(failure(await patch({ grants: { rider: true, tableClose: true, automaticCash: { vne: { tools: true } } } })), notAllowed('pos.grants.tableClose', 'pos.grants.automaticCash.vne.tools'));
      assert.deepEqual(failure(await patch({ grants: { discountMaxPercentage: 21 } })), notAllowed('pos.grants.discountMaxPercentage'));
      assert.deepEqual(failure(await patch({ grants: { discountMaxPercentage: null } })), notAllowed('pos.grants.discountMaxPercentage'));
      assert.equal((await patch({ grants: { discountMaxPercentage: 10, servicePercentage: 99 } })).status, 200, 'a lower cap and the service percentage are free');
      // The app can be enabled only if it is for him.
      const off = await as.call(actor, 'PATCH', path(target), { pos: { enabled: false } });
      assert.equal(off.status, 200);
      const withoutApp = await limitedActor(role, { status: false, sub: { rider: true } });
      assert.deepEqual(failure(await as.call(withoutApp, 'PATCH', path(target), { pos: { enabled: true } })), notAllowed('pos.enabled'));
      assert.equal((await as.call(withoutApp, 'PATCH', path(target), { pos: { options: { darkMode: true } } })).status, 200);
    });
  }

  it('limits what a CA gives to a new user: the default of the role, the cap, and the flags he holds', async () => {
    const actor = await limitedActor('CA', { sub: { discount: true, invoices: true, discountMaxPercentage: 15 } });
    const created = await as.call(actor, 'POST', path(), body({ role: 'PA' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const grants = created.body.data.pos.grants;
    assert.deepEqual([grants.discount, grants.invoices, grants.priceChange, grants.freeSale, grants.discountMaxPercentage, created.body.data.pos.enabled], [true, true, false, false, 15, true]);
    assert.deepEqual(failure(await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { freeSale: true } } }))), notAllowed('pos.grants.freeSale'));
    assert.deepEqual(failure(await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { discountMaxPercentage: null } } }))), notAllowed('pos.grants.discountMaxPercentage'));
    assert.deepEqual(failure(await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { discountMaxPercentage: 16 } } }))), notAllowed('pos.grants.discountMaxPercentage'));
    assert.equal((await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { discountMaxPercentage: 5, priceChange: false } } }))).status, 201);
  });
});

describe('the cash and handheld switches and the handheld 2.0 preferences', () => {
  const cashOf = (document: Document): { sub: Document; options: Document } => ((document['permissions'] as Document)['apps'] as Document)['cash'] as { sub: Document; options: Document };
  const NEW_OPTIONS = { productsColorStyle: 'fill', productsUppercase: true, productsBold: true, roomsLegend: true, handheldTextZoom: 125, handheldCategoriesLayout: 'slidein', handheldCategoriesRows: 1, handheldProductsColumns: 4, handheldMenuPosition: 'top' };

  it('gives a new user the legacy defaults, in the response and in the document', async () => {
    const created = await as.call(g0().sa, 'POST', path(), body({ role: 'PA' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { grants, options } = created.body.data.pos;
    assert.deepEqual([grants.cashEnabled, grants.handheldEnabled, grants.handheldWallet], [true, true, false]);
    assert.deepEqual(
      [options.productsColorStyle, options.productsUppercase, options.productsBold, options.roomsLegend, options.handheldTextZoom, options.handheldCategoriesLayout, options.handheldCategoriesRows, options.handheldProductsColumns, options.handheldMenuPosition],
      ['line', false, false, false, 100, 'scroll', 2, 2, 'bottom'],
    );
    const cash = cashOf(await stored(idOf(created)));
    assert.deepEqual([cash.sub['cashEnabled'], cash.sub['handheldEnabled'], cash.sub['handheldWallet']], [true, true, false]);
    assert.deepEqual([cash.options['handheldTextZoom'], cash.options['handheldCategoriesRows'], cash.options['handheldProductsColumns']], [100, 2, 2]);
  });

  it('writes the new values on their own paths, as numbers and texts, and keeps the rest', async () => {
    const created = await as.call(g0().sa, 'POST', path(), body({ role: 'PA', pos: { grants: { handheldWallet: true, handheldEnabled: false }, options: NEW_OPTIONS } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = idOf(created);
    assert.deepEqual(
      { ...cashOf(await stored(id)).options, priceLists: undefined, favoritesId: undefined },
      { ...cashOf(await stored(id)).options, ...NEW_OPTIONS, priceLists: undefined, favoritesId: undefined },
    );
    assert.deepEqual([cashOf(await stored(id)).sub['handheldWallet'], cashOf(await stored(id)).sub['handheldEnabled'], cashOf(await stored(id)).sub['cashEnabled']], [true, false, true]);
    const other = await stored(id);
    const reply = await as.call(g0().sa, 'PATCH', path(id), { pos: { grants: { cashEnabled: false }, options: { handheldTextZoom: 85, roomsLegend: false } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = cashOf(await stored(id));
    assert.deepEqual([after.sub['cashEnabled'], after.sub['handheldWallet'], after.options['handheldTextZoom'], after.options['roomsLegend'], after.options['productsColorStyle']], [false, true, 85, false, 'fill']);
    assert.equal(typeof after.options['handheldTextZoom'], 'number');
    assert.deepEqual([reply.body.data.pos.grants.cashEnabled, reply.body.data.pos.options.handheldTextZoom], [false, 85]);
    assert.notDeepEqual(await stored(id), other);
  });

  it('refuses the values out of their list, field by field', async () => {
    const post = async (options: Document) => failure(await as.call(g0().sa, 'POST', path(), body({ pos: { options } })));
    assert.deepEqual(
      await post({ productsColorStyle: 'x', handheldTextZoom: 87, handheldCategoriesLayout: 'grid', handheldCategoriesRows: 3, handheldProductsColumns: 5, handheldMenuPosition: 'left' }),
      invalid(['pos.options.productsColorStyle', 'enum'], ['pos.options.handheldTextZoom', 'enum'], ['pos.options.handheldCategoriesLayout', 'enum'], ['pos.options.handheldCategoriesRows', 'enum'], ['pos.options.handheldProductsColumns', 'enum'], ['pos.options.handheldMenuPosition', 'enum']),
    );
    assert.deepEqual(await post({ handheldTextZoom: '100', roomsLegend: 'yes' }), invalid(['pos.options.roomsLegend', 'type'], ['pos.options.handheldTextZoom', 'type']));
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(), body({ pos: { grants: { cashEnabled: 'yes' } } }))), invalid(['pos.grants.cashEnabled', 'type']));
  });

  it('treats the switches as permissions and the preferences as free, and judges the switches against what a CA or PA holds', async () => {
    const target = await freshPa({ permissions: everything(false) });
    const noManage = await fresh({ permissions: everything(false) });
    assert.deepEqual(failure(await as.call(noManage, 'PATCH', path(target), { pos: { grants: { handheldWallet: true } } })), denied);
    assert.deepEqual(failure(await as.call(noManage, 'PATCH', path(target), { pos: { grants: { cashEnabled: false } } })), denied);
    const optionsOnly = await as.call(noManage, 'PATCH', path(target), { pos: { options: NEW_OPTIONS } });
    assert.equal(optionsOnly.status, 200, JSON.stringify(optionsOnly.body));
    const actor = await limitedActor('CA', { sub: { cashEnabled: false, handheldEnabled: true } });
    const patch = (pos: Document) => as.call(actor, 'PATCH', path(target), { pos });
    assert.deepEqual(failure(await patch({ grants: { handheldWallet: true } })), notAllowed('pos.grants.handheldWallet'));
    assert.equal((await patch({ grants: { cashEnabled: false } })).status, 200);
    assert.deepEqual(failure(await patch({ grants: { cashEnabled: true } })), notAllowed('pos.grants.cashEnabled'));
    // A new user of that creator does not start with the cash desk either.
    const created = await as.call(actor, 'POST', path(), body({ role: 'PA' }));
    assert.deepEqual([created.status, created.body.data.pos.grants.cashEnabled, created.body.data.pos.grants.handheldEnabled], [201, false, true]);
    assert.deepEqual(failure(await as.call(actor, 'POST', path(), body({ role: 'PA', pos: { grants: { cashEnabled: true } } }))), notAllowed('pos.grants.cashEnabled'));
    // The preferences are the user's own too; the switches are not.
    const own = await as.call(g0().pa, 'PATCH', '/me', { pos: { options: { handheldMenuPosition: 'top', handheldTextZoom: 95 } } });
    assert.deepEqual([own.status, own.body.data.pos.options.handheldMenuPosition, own.body.data.pos.options.handheldTextZoom], [200, 'top', 95]);
    assert.deepEqual(failure(await as.call(g0().pa, 'PATCH', '/me', { pos: { grants: { cashEnabled: false } } })), invalid(['pos.grants', 'unknown']));
  });
});
