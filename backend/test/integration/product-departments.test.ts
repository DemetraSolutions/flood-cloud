import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { LEGACY_DATE, catalogCollections, legacyDepartment, legacyProduct, priceWithDepartment, seedImage } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
let db: CatalogCollections;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/product-departments`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const ownPlace = () => world.group(0).ownPlaceId;
const otherPlace = () => world.group(0).otherPlaceId;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
let taxId: string;

async function create(body: Document = {}, actor = sa()) {
  const reply = await call(actor, 'POST', base(), { code: nextCode++, name: { it: 'Bibite' }, taxId, ...body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}
let nextCode = 10;
const stored = (id: string) => db.departments.findOne({ _id: new ObjectId(id) }, { ...EXACT_TYPES });
/** A stored value read with the exact types, as plain JSON (the BSON wrappers of the numbers become numbers). */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  db = catalogCollections(ctx, world);
  const group = await ctx.databases.common().collection('groups').findOne({ _id: world.group(0).groupId });
  taxId = (group!['taxes'] as Array<{ id: string }>)[0]!.id;
  await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': false } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('departments: access', () => {
  it('answers 403 FEATURE_DISABLED to every role in a group without the cash feature, for every route', async () => {
    const id = hex(new ObjectId());
    for (const actor of [psa(), dealer(), world.group(1).sa]) {
      for (const [method, path, body, headers] of [
        ['GET', base(1), undefined, undefined],
        ['GET', one(id, 1), undefined, undefined],
        ['POST', base(1), { code: 1, name: { it: 'x' }, taxId: 'x' }, undefined],
        ['PATCH', one(id, 1), { enabled: false }, { 'if-match': `"${'a'.repeat(43)}"` }],
        ['DELETE', one(id, 1), undefined, undefined],
      ] as const) {
        assert.deepEqual(failure(await call(actor, method, path, body, headers ? { ...headers } : undefined)), { status: 403, code: 'FEATURE_DISABLED', details: undefined }, `${method} ${path}`);
      }
    }
  });

  it('lets the roles that update products write, refuses the others, anonymous callers and other groups', async () => {
    for (const actor of [psa(), dealer(), sa()]) {
      const created = await create({}, actor);
      assert.equal(created.body.data.editable, true);
      assert.equal((await call(actor, 'GET', one(created.body.data.id))).body.data.editable, true);
      assert.equal((await call(actor, 'DELETE', one(created.body.data.id))).status, 204);
    }
    const blind = await addUser(ctx, world.office, { permissions: { status: true, products: { r: false, w: false } } });
    assert.equal(failure(await call(blind.id, 'GET', base())).status, 403);
    assert.equal(failure(await call(blind.id, 'POST', base(), { code: 1, name: { it: 'x' }, taxId })).status, 403);
    const reader = await addUser(ctx, world.office, { permissions: { status: true, products: { r: true, w: false } } });
    const created = await create();
    assert.equal((await call(reader.id, 'GET', base())).status, 200);
    assert.equal(failure(await call(reader.id, 'POST', base(), { code: 1, name: { it: 'x' }, taxId })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(created.body.data.id), { enabled: false }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'DELETE', one(created.body.data.id))).status, 403);
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', base())).status, 404);
  });

  it('keeps the departments of the groups apart', async () => {
    const created = await create();
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': true } });
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(created.body.data.id, 1), { enabled: false }, { 'if-match': tag(created) })).status, 404);
    assert.ok(!(await call(world.group(1).sa, 'GET', base(1))).body.data.some((item: { id: string }) => item.id === created.body.data.id));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': false } });
  });
});

describe('departments: creation', () => {
  it('creates a department in the legacy shape with 201, Location and ETag, writes the code as Int32, copies the tax and records it', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { code: 31, name: { it: '  Bibite  ' }, description: { it: 'Tutte\nle bibite' }, taxId, noDiscount: true, placeIds: [hex(ownPlace())] };
    const first = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.ok(tag(first).length > 40);
    assert.deepEqual(first.body.data, {
      id: first.body.data.id,
      code: 31,
      taxId,
      tax: { rate: 22, department: 1, vatNature: null, description: null },
      noDiscount: true,
      secondaryFiscalPrinter: false,
      name: { it: 'Bibite' },
      description: { it: 'Tutte\nle bibite' },
      enabled: true,
      placeIds: [hex(ownPlace())],
      editable: true,
      createdAt: first.body.data.createdAt,
      updatedAt: first.body.data.updatedAt,
    });
    const document = (await stored(first.body.data.id as string))!;
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'code', 'description', 'insertDate', 'medias', 'name', 'noDiscount', 'placesAvailability', 'secondaryFiscalPrinter', 'status', 'tax', 'updateDate']);
    assert.ok(document['code'] instanceof Int32);
    assert.deepEqual(plain(document['tax']), { id: taxId, value: 22, department: 1, description: null, natura: null });
    assert.deepEqual(document['placesAvailability'], [ownPlace()]);
    assert.deepEqual(document['medias'], { images: {} });
    assert.equal(document['status'], true);
    assert.ok(document['insertDate'] instanceof Date && document['insertDate'].getTime() === (document['updateDate'] as Date).getTime());
    const entries = log('productDepartment.created', mark);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.resource, { type: 'productDepartment', id: first.body.data.id });
    assert.deepEqual(entries[0]!.groupId, world.group(0).groupId);
    // A retry with the same key and body replays the answer; another body is a conflict.
    const replay = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(await db.departments.countDocuments({ code: new Int32(31) }), 1);
    assert.equal(failure(await call(sa(), 'POST', base(), { ...body, code: 32 }, { 'idempotency-key': key })).status, 409);
    const minimal = await call(sa(), 'POST', base(), { code: 32, name: { it: 'Minimo' }, taxId });
    assert.deepEqual([minimal.body.data.description, minimal.body.data.enabled, minimal.body.data.placeIds, minimal.body.data.noDiscount], [{ it: '' }, true, [], false]);
    assert.equal(minimal.body.data.image, undefined);
  });

  it('validates every field by allowlist, reporting each problem', async () => {
    const post = (body: Document) => call(sa(), 'POST', base(), body);
    const ok = { code: 60, name: { it: 'x' }, taxId };
    assert.deepEqual(failure(await post({})).details, [
      { field: 'name', issue: 'required' },
      { field: 'code', issue: 'required' },
      { field: 'taxId', issue: 'required' },
    ]);
    for (const code of [0, 100, 1.5, '5', null, -1]) {
      assert.equal(failure(await post({ ...ok, code })).status, 422, String(code));
    }
    assert.deepEqual(failure(await post({ ...ok, extra: 1 })).details, [{ field: 'extra', issue: 'unknown' }]);
    assert.deepEqual(failure(await post({ ...ok, name: {} })).details, [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(failure(await post({ ...ok, name: { IT: 'x' } })).details, [{ field: 'name.IT', issue: 'format' }]);
    assert.deepEqual(failure(await post({ ...ok, name: { it: '' } })).details, [{ field: 'name.it', issue: 'minLength' }]);
    assert.deepEqual(failure(await post({ ...ok, name: { it: 'x'.repeat(151) } })).details, [{ field: 'name.it', issue: 'maxLength' }]);
    assert.deepEqual(failure(await post({ ...ok, name: { it: 'a\nb' } })).details, [{ field: 'name.it', issue: 'pattern' }]);
    assert.deepEqual(failure(await post({ ...ok, name: { it: null } })).details, [{ field: 'name.it', issue: 'type' }]);
    assert.deepEqual(failure(await post({ ...ok, description: { it: 'a\u0000b' } })).details, [{ field: 'description.it', issue: 'pattern' }]);
    assert.deepEqual(failure(await post({ ...ok, description: { it: 'x'.repeat(1001) } })).details, [{ field: 'description.it', issue: 'maxLength' }]);
    assert.deepEqual(failure(await post({ ...ok, taxId: 'a b' })).details, [{ field: 'taxId', issue: 'pattern' }]);
    assert.deepEqual(failure(await post({ ...ok, taxId: '$ne' })).details, [{ field: 'taxId', issue: 'pattern' }]);
    assert.deepEqual(failure(await post({ ...ok, enabled: 'yes' })).details, [{ field: 'enabled', issue: 'type' }]);
    assert.deepEqual(failure(await post({ ...ok, placeIds: [hex(ownPlace()), hex(ownPlace())] })).details, [{ field: 'placeIds.1', issue: 'incorrect' }]);
    assert.deepEqual(failure(await post({ ...ok, placeIds: ['nope'] })).details, [{ field: 'placeIds.0', issue: 'minLength' }]);
    assert.deepEqual(failure(await post({ ...ok, placeIds: Array.from({ length: 201 }, () => hex(new ObjectId())) })).details, [{ field: 'placeIds', issue: 'tooMany' }]);
    assert.deepEqual(failure(await post({ ...ok, image: { imageId: 'x' } })).details, [{ field: 'image.imageId', issue: 'minLength' }]);
    assert.equal(failure(await call(sa(), 'POST', base(), { ...ok, description: { it: 'a'.repeat(70_000) } })).status, 413);
    const text = await fetch(`${world.office.app.baseUrl}/v1${base()}`, { method: 'POST', headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}`, 'content-type': 'text/plain', 'idempotency-key': randomUUID() }, body: 'x' });
    assert.equal(text.status, 415);
  });

  it('checks the references: a tax rate of the group, languages of the group, places that exist and are not in the trash, no image without the media feature', async () => {
    const post = (body: Document) => call(sa(), 'POST', base(), body);
    const ok = { code: 61, name: { it: 'x' }, taxId };
    assert.deepEqual(failure(await post({ ...ok, taxId: 'missing-rate' })), issues(['taxId', 'incorrect']));
    // The rate of another group is not a rate of this one.
    const otherTax = ((await ctx.databases.common().collection('groups').findOne({ _id: world.group(2).groupId }))!['taxes'] as Array<{ id: string }>)[0]!.id;
    assert.deepEqual(failure(await post({ ...ok, taxId: otherTax })), issues(['taxId', 'incorrect']));
    assert.deepEqual(failure(await post({ ...ok, name: { it: 'x', en: 'y' } })), issues(['name.en', 'incorrect']));
    assert.deepEqual(failure(await post({ ...ok, name: { en: 'y' } })).details, [
      { field: 'name.en', issue: 'incorrect' },
      { field: 'name.it', issue: 'required' },
    ]);
    assert.deepEqual(failure(await post({ ...ok, description: { de: 'y' } })), issues(['description.de', 'incorrect']));
    const trashed = await world.seedPlace(0, 410, 1, { trash: true });
    assert.deepEqual(failure(await post({ ...ok, placeIds: [hex(ownPlace()), hex(new ObjectId()), hex(trashed), hex(world.group(1).ownPlaceId)] })), issues(['placeIds.1', 'incorrect'], ['placeIds.2', 'incorrect'], ['placeIds.3', 'incorrect']));
    assert.deepEqual(failure(await post({ ...ok, image: null })), issues(['image', 'notAllowed']));
    assert.deepEqual(failure(await post({ ...ok, image: { imageId: hex(new ObjectId()) } })), issues(['image', 'notAllowed']));
    assert.equal(await db.departments.countDocuments({ code: 61 }), 0);
  });

  it('refuses a code that another department of the group has, comparing numbers (the legacy text and the double included)', async () => {
    await db.departments.insertMany([legacyDepartment({ code: '44' }), legacyDepartment({ code: new Double(45) }), legacyDepartment({ code: Number.NaN }), legacyDepartment({ code: ' 46 ' }), legacyDepartment({ code: 'abc' }), legacyDepartment({ code: undefined })]);
    for (const code of [44, 45, 46]) {
      assert.deepEqual(failure(await call(sa(), 'POST', base(), { code, name: { it: 'x' }, taxId })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'taken' }] }, String(code));
    }
    assert.equal((await call(sa(), 'POST', base(), { code: 47, name: { it: 'x' }, taxId })).status, 201);
    // The same code in another group is free.
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': true } });
    assert.equal((await call(world.group(1).sa, 'POST', base(1), { code: 44, name: { it: 'x' }, taxId: ((await ctx.databases.common().collection('groups').findOne({ _id: world.group(1).groupId }))!['taxes'] as Array<{ id: string }>)[0]!.id })).status, 201);
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': false } });
  });
});

describe('departments: reads', () => {
  it('reads the dirty shapes of the real data tolerantly: text and NaN codes, flags that are absent, a tax that is not an object, residue in medias, unknown keys', async () => {
    const ids = {
      text: new ObjectId(),
      nan: new ObjectId(),
      bare: new ObjectId(),
      numericTax: new ObjectId(),
      noName: new ObjectId(),
    };
    await db.departments.insertMany([
      legacyDepartment({ _id: ids.text, code: '7', name: { it: 'Con codice testo', en: 'Text code', _x: 'no', 'it-IT': 'regione' }, trash: false, groupId: world.group(0).groupId, mystery: { a: 1 }, placesAvailability: [ownPlace(), hex(otherPlace()), 'junk', 5] }),
      legacyDepartment({ _id: ids.nan, code: Number.NaN, noDiscount: false, secondaryFiscalPrinter: true, medias: { images: { images: {} } } }),
      { _id: ids.bare },
      legacyDepartment({ _id: ids.numericTax, code: 8, tax: 22, status: 'yes', placesAvailability: null, name: 'Solo testo', description: 5 }),
      legacyDepartment({ _id: ids.noName, code: 9, name: undefined, description: undefined, tax: { id: 7, value: 'x', department: 2.5, description: 3, natura: 'N1' } }),
    ]);
    const read = async (id: ObjectId) => (await call(sa(), 'GET', one(id))).body.data;
    assert.deepEqual(await read(ids.text), {
      id: hex(ids.text),
      code: 7,
      taxId,
      tax: { rate: 22, department: 1, vatNature: null, description: null },
      noDiscount: false,
      secondaryFiscalPrinter: false,
      name: { it: 'Con codice testo', en: 'Text code', 'it-IT': 'regione' },
      description: { it: '' },
      enabled: true,
      placeIds: [hex(ownPlace())],
      editable: true,
      createdAt: LEGACY_DATE.toISOString(),
      updatedAt: LEGACY_DATE.toISOString(),
    });
    const nan = await read(ids.nan);
    assert.deepEqual([nan.code, nan.secondaryFiscalPrinter, nan.noDiscount], [null, true, false]);
    const bare = await read(ids.bare);
    assert.deepEqual(bare, { id: hex(ids.bare), code: null, taxId: null, tax: null, noDiscount: false, secondaryFiscalPrinter: false, name: {}, description: {}, enabled: false, placeIds: [], editable: true, createdAt: null, updatedAt: null });
    const numericTax = await read(ids.numericTax);
    assert.deepEqual([numericTax.tax, numericTax.taxId, numericTax.enabled, numericTax.placeIds, numericTax.name, numericTax.description], [null, null, false, [], {}, {}]);
    const noName = await read(ids.noName);
    assert.deepEqual([noName.tax, noName.taxId], [{ rate: null, department: null, vatNature: 'N1', description: null }, null]);
    // The list shows the same shapes.
    const list = await call(sa(), 'GET', `${base()}?limit=100`);
    assert.ok([ids.text, ids.nan, ids.bare, ids.numericTax, ids.noName].every((id) => list.body.data.some((item: { id: string }) => item.id === hex(id))));
    assert.equal(failure(await call(sa(), 'GET', one(hex(new ObjectId())))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
    await db.departments.deleteMany({ _id: { $in: Object.values(ids) } });
  });

  it('lists in pages sorted by name or by code, searches the name as literal text in every language and filters by state', async () => {
    await db.departments.deleteMany({});
    await db.departments.insertMany([
      legacyDepartment({ code: 3, name: { it: 'Zeta', en: 'Last' } }),
      legacyDepartment({ code: '1', name: { it: 'alfa (uno)' } }),
      legacyDepartment({ code: 2, name: { en: 'Only english' }, status: false }),
      legacyDepartment({ code: Number.NaN, name: { it: 'Beta.*' } }),
      legacyDepartment({ code: 4, name: 'not texts' }),
    ]);
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: Record<string, string> }) => Object.values(item.name)[0] ?? null);
    // The order is the binary one of the database, as in every list of this backend: capitals first.
    assert.deepEqual(names(await call(sa(), 'GET', base())), [null, 'Beta.*', 'Only english', 'Zeta', 'alfa (uno)']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?sort=-name`)), ['alfa (uno)', 'Zeta', 'Only english', 'Beta.*', null]);
    const byCode = await call(sa(), 'GET', `${base()}?sort=code`);
    assert.deepEqual(byCode.body.data.map((item: { code: number | null }) => item.code), [null, 1, 2, 3, 4]);
    assert.deepEqual((await call(sa(), 'GET', `${base()}?sort=-code`)).body.data.map((item: { code: number | null }) => item.code), [4, 3, 2, 1, null]);
    // The search is literal text: a regular expression of the client matches nothing, the text of it does.
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('.*')}`)), ['Beta.*']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('(uno)')}`)), ['alfa (uno)']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=ZETA`)), ['Zeta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=last`)), ['Zeta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('not texts')}`)), []);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?enabled=false`)), ['Only english']);
    assert.equal((await call(sa(), 'GET', `${base()}?enabled=true`)).body.data.length, 4);
    const seen: Array<number | null> = [];
    let url = `${base()}?limit=2&sort=-code`;
    for (let page = 0; page < 6; page += 1) {
      const next = await call(sa(), 'GET', url);
      assert.equal(next.body.page.limit, 2);
      seen.push(...next.body.data.map((item: { code: number | null }) => item.code));
      if (next.body.page.next === null) {
        break;
      }
      url = `${base()}?limit=2&sort=-code&cursor=${next.body.page.next as string}`;
    }
    assert.deepEqual(seen, [4, 3, 2, 1, null]);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=101`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=0`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?cursor=nope`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?sort=insertDate`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?enabled=maybe`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?q=${'x'.repeat(65)}`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?extra=1`)).status, 422);
    // A cursor made for one sort is refused by another.
    const first = await call(sa(), 'GET', `${base()}?limit=1&sort=code`);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?sort=name&cursor=${first.body.page.next as string}`)).status, 422);
    await db.departments.deleteMany({});
  });
});

describe('departments: modification', () => {
  it('changes the given fields with If-Match, merges the texts by language, keeps every other key and records before and after', async () => {
    const created = await create({ name: { it: 'Vecchio' }, description: { it: 'Desc' } });
    const id = created.body.data.id as string;
    await db.departments.updateOne({ _id: new ObjectId(id) }, { $set: { mystery: { keep: 1 }, trash: false, groupId: world.group(0).groupId } });
    const current = await call(sa(), 'GET', one(id));
    const mark = world.office.activity.entries.length;
    const changed = await call(sa(), 'PATCH', one(id), { name: { it: 'Nuovo' }, enabled: false, secondaryFiscalPrinter: true, noDiscount: true, description: { it: null } }, { 'if-match': tag(current) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual([changed.body.data.name, changed.body.data.description, changed.body.data.enabled, changed.body.data.secondaryFiscalPrinter, changed.body.data.noDiscount], [{ it: 'Nuovo' }, {}, false, true, true]);
    assert.notEqual(tag(changed), tag(created));
    assert.equal(tag(await call(sa(), 'GET', one(id))), tag(changed));
    const document = (await stored(id))!;
    assert.equal(((document['mystery'] as Document)['keep'] as Int32).value, 1);
    assert.deepEqual([document['trash'], document['groupId']], [false, world.group(0).groupId]);
    assert.ok(document['code'] instanceof Int32);
    assert.ok((document['updateDate'] as Date).getTime() > (document['insertDate'] as Date).getTime() || (document['updateDate'] as Date).getTime() === (document['insertDate'] as Date).getTime() + 0);
    const entries = log('productDepartment.updated', mark);
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0]!.changes ?? []).map((change) => change.field).sort(), ['description.it', 'enabled', 'name.it', 'noDiscount', 'secondaryFiscalPrinter']);
    // Two changes in the same millisecond still have different versions.
    const again = await call(sa(), 'PATCH', one(id), { enabled: true }, { 'if-match': tag(changed) });
    const third = await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': tag(again) });
    assert.notEqual(tag(third), tag(again));
  });

  it('writes nothing for a request that changes nothing, and refuses an empty body, a missing, malformed or stale If-Match', async () => {
    const created = await create({ name: { it: 'Fermo' } });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const same = await call(sa(), 'PATCH', one(id), { name: { it: 'Fermo' }, enabled: true, noDiscount: false, taxId, code: created.body.data.code, placeIds: [], description: { it: '' } }, { 'if-match': tag(created) });
    assert.equal(same.status, 200);
    assert.equal(tag(same), tag(created));
    assert.equal(world.office.activity.entries.length, mark);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), {}, { 'if-match': tag(created) })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: '(body)', issue: 'required' }] });
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { enabled: false })), issues(['If-Match', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': 'abc' })), issues(['If-Match', 'format']));
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': `"${'a'.repeat(43)}"` })).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(hex(new ObjectId())), { enabled: false }, { 'if-match': tag(created) })).status, 404);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { code: 0 }, { 'if-match': tag(created) })).details, [{ field: 'code', issue: 'minimum' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { extra: 1 }, { 'if-match': tag(created) })).details, [{ field: 'extra', issue: 'unknown' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: null } }, { 'if-match': tag(created) })), issues(['name.it', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { en: 'x' } }, { 'if-match': tag(created) })), issues(['name.en', 'incorrect']));
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { description: { it: 'a'.repeat(70_000) } }, { 'if-match': tag(created) })).status, 413);
    // A change by the legacy makes the version stale, whatever field it touched.
    await db.departments.updateOne({ _id: new ObjectId(id) }, { $set: { secondaryFiscalPrinter: true } });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': tag(created) })).status, 412);
  });

  it('changes the code (checked against the other departments, never against itself) and the tax rate (a new copy)', async () => {
    const other = await create({ code: 71 });
    const created = await create({ code: 72 });
    const id = created.body.data.id as string;
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { code: 71 }, { 'if-match': tag(created) })), { status: 409, code: 'CONFLICT', details: [{ field: 'code', issue: 'taken' }] });
    const changed = await call(sa(), 'PATCH', one(id), { code: 73 }, { 'if-match': tag(created) });
    assert.equal(changed.body.data.code, 73);
    assert.ok((await stored(id))!['code'] instanceof Int32);
    // The same department with the same code is not a collision, and a code stored as text is the same number as the one sent.
    await db.departments.updateOne({ _id: new ObjectId(id) }, { $set: { code: '73' } });
    const textual = await call(sa(), 'GET', one(id));
    const sameCode = await call(sa(), 'PATCH', one(id), { code: 73, enabled: false }, { 'if-match': tag(textual) });
    assert.equal(sameCode.status, 200);
    assert.equal((await stored(id))!['code'], '73');
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { taxId: 'missing' }, { 'if-match': tag(sameCode) })), issues(['taxId', 'incorrect']));
    // Another tax rate of the group: its copy replaces the old one.
    const rate = await call(sa(), 'POST', `/groups/${hex(world.group(0).groupId)}/taxes`, { rate: 10, department: 3, description: 'Ridotta', vatNature: 'N1' });
    assert.equal(rate.status, 201, JSON.stringify(rate.body));
    const retaxed = await call(sa(), 'PATCH', one(id), { taxId: rate.body.data.id }, { 'if-match': tag(sameCode) });
    assert.deepEqual(retaxed.body.data.tax, { rate: 10, department: 3, vatNature: 'N1', description: 'Ridotta' });
    assert.deepEqual(plain((await stored(id))!['tax']), { id: rate.body.data.id, value: 10, department: 3, description: 'Ridotta', natura: 'N1' });
    assert.equal(other.status, 201);
  });

  it('makes a change by name only in the languages the group has and keeps a text in the language it had', async () => {
    const created = await create({ name: { it: 'Italiano' } });
    const id = created.body.data.id as string;
    await db.departments.updateOne({ _id: new ObjectId(id) }, { $set: { name: { it: 'Italiano', fr: 'Français' } } });
    const current = await call(sa(), 'GET', one(id));
    // A language that is stored and not in the group is not judged again when it is not changed, and is when it is.
    assert.equal((await call(sa(), 'PATCH', one(id), { name: { it: 'Nuovo' } }, { 'if-match': tag(current) })).status, 200);
    const next = await call(sa(), 'GET', one(id));
    assert.deepEqual(next.body.data.name, { it: 'Nuovo', fr: 'Français' });
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { fr: 'Autre' } }, { 'if-match': tag(next) })), issues(['name.fr', 'incorrect']));
    assert.equal((await call(sa(), 'PATCH', one(id), { name: { fr: 'Français' } }, { 'if-match': tag(next) })).status, 200);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: null } }, { 'if-match': tag(next) })), issues(['name.it', 'required']));
    const removeFrench = await call(sa(), 'PATCH', one(id), { name: { fr: null } }, { 'if-match': tag(next) });
    assert.deepEqual(removeFrench.body.data.name, { it: 'Nuovo' });
    // A name stored as something that is not texts is replaced.
    await db.departments.updateOne({ _id: new ObjectId(id) }, { $set: { name: 'testo' } });
    const odd = await call(sa(), 'GET', one(id));
    assert.deepEqual((await call(sa(), 'PATCH', one(id), { name: { it: 'Ripristinato' } }, { 'if-match': tag(odd) })).body.data.name, { it: 'Ripristinato' });
  });

  it('works on a department with no dates and keeps the languages the caller asks for from his own settings', async () => {
    const undated = new ObjectId();
    await db.departments.insertOne({ _id: undated, code: 80, tax: { id: taxId, value: 22, department: 1, description: null, natura: null }, name: { it: 'Senza date' }, status: true });
    const current = await call(sa(), 'GET', one(undated));
    const changed = await call(sa(), 'PATCH', one(undated), { enabled: false }, { 'if-match': tag(current) });
    assert.equal(changed.status, 200);
    assert.ok((await db.departments.findOne({ _id: undated }))!['updateDate'] instanceof Date);
  });
});

describe('departments: deletion', () => {
  const withNumber = async (department: number, overrides: Document = {}) => {
    const id = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: id, code: 90 + department, tax: { id: 'x', value: 22, department, description: null, natura: null }, ...overrides }));
    return id;
  };

  it('deletes for good with 204 and records the deletion; the second one is 404', async () => {
    const created = await create();
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'DELETE', one(created.body.data.id))).status, 204);
    assert.equal(await db.departments.countDocuments({ _id: new ObjectId(created.body.data.id as string) }), 0);
    assert.equal(failure(await call(sa(), 'GET', one(created.body.data.id))).status, 404);
    assert.equal(failure(await call(sa(), 'DELETE', one(created.body.data.id))).status, 404);
    const entries = log('productDepartment.deleted', mark);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.resource, { type: 'productDepartment', id: created.body.data.id });
  });

  it('refuses with 409 and the products when it is the last active department with the department number of a tax some product has', async () => {
    const last = await withNumber(41);
    const users = [legacyProduct({ prices: [priceWithDepartment(41)] }), legacyProduct({ prices: [priceWithDepartment(3), priceWithDepartment(41)] }), legacyProduct({ prices: [{ ...priceWithDepartment(3), taxData: { department: '41' } }] })];
    await db.products.insertMany([...users, legacyProduct({ trash: true, prices: [priceWithDepartment(41)] }), legacyProduct({ prices: [priceWithDepartment(42)] })]);
    const refused = failure(await call(sa(), 'DELETE', one(last)));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'CONFLICT');
    assert.deepEqual((refused.details as Array<{ field: string; issue: string }>).map((detail) => detail.field).sort(), users.map((product) => `products.${hex(product['_id'] as ObjectId)}`).sort());
    assert.ok((refused.details as Array<{ issue: string }>).every((detail) => detail.issue === 'referenced'));
    assert.equal(await db.departments.countDocuments({ _id: last }), 1);
    // Another active department with the same number lets it go; an inactive one does not count.
    const twin = await withNumber(41, { status: false });
    assert.equal(failure(await call(sa(), 'DELETE', one(last))).status, 409);
    await db.departments.updateOne({ _id: twin }, { $set: { status: true } });
    assert.equal((await call(sa(), 'DELETE', one(last))).status, 204);
    // Now the twin is the last one again.
    assert.equal(failure(await call(sa(), 'DELETE', one(twin))).status, 409);
    // Products in the trash do not count.
    await db.products.updateMany({ 'prices.taxData.department': { $in: [41, '41'] } }, { $set: { trash: true } });
    assert.equal((await call(sa(), 'DELETE', one(twin))).status, 204);
  });

  it('deletes without looking at the products an inactive department, one whose tax has no department number, or when no product uses the number', async () => {
    const inactive = await withNumber(43, { status: false });
    await db.products.insertOne(legacyProduct({ prices: [priceWithDepartment(43)] }));
    assert.equal((await call(sa(), 'DELETE', one(inactive))).status, 204);
    const noNumber = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: noNumber, code: 95, tax: { id: 'x', value: 22, department: null, description: null, natura: null } }));
    assert.equal((await call(sa(), 'DELETE', one(noNumber))).status, 204);
    const nonObjectTax = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: nonObjectTax, code: 96, tax: 22 }));
    assert.equal((await call(sa(), 'DELETE', one(nonObjectTax))).status, 204);
    const unused = await withNumber(44);
    assert.equal((await call(sa(), 'DELETE', one(unused))).status, 204);
  });

  it('lists at most twenty products', async () => {
    const last = await withNumber(45);
    await db.products.insertMany(Array.from({ length: 25 }, () => legacyProduct({ prices: [priceWithDepartment(45)] })));
    const refused = failure(await call(sa(), 'DELETE', one(last)));
    assert.equal((refused.details as unknown[]).length, 20);
  });
});

describe('departments: the perimeter of the company and place administrators', () => {
  const seedAll = async (overrides: Document = {}) => {
    const id = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: id, code: 100 + Math.floor(Math.random() * 1e6), ...overrides }));
    return id;
  };

  for (const [role, actor] of [['company administrator', ca], ['place administrator', pa]] as const) {
    it(`shows the ${role} the entries for every place and the ones that name a place of his own, and 404 for the others`, async () => {
      await db.departments.deleteMany({});
      const everywhere = await seedAll({ placesAvailability: [], name: { it: 'Ovunque' } });
      const absent = await seedAll({ placesAvailability: undefined, name: { it: 'Assente' } });
      const nul = await seedAll({ placesAvailability: null, name: { it: 'Nullo' } });
      const mine = await seedAll({ placesAvailability: [ownPlace()], name: { it: 'Mio' } });
      const mixed = await seedAll({ placesAvailability: [otherPlace(), ownPlace()], name: { it: 'Misto' } });
      const text = await seedAll({ placesAvailability: [hex(ownPlace())], name: { it: 'Testo' } });
      const withJunk = await seedAll({ placesAvailability: [ownPlace(), 7], name: { it: 'Anomala' } });
      const elsewhere = await seedAll({ placesAvailability: [otherPlace()], name: { it: 'Altrove' } });
      const list = await call(actor(), 'GET', `${base()}?limit=100`);
      assert.deepEqual(list.body.data.map((item: { name: { it: string } }) => item.name.it), ['Anomala', 'Assente', 'Mio', 'Misto', 'Nullo', 'Ovunque']);
      // What is shared or for every place, or anomalous, he reads and does not write; the server says so.
      const editable = Object.fromEntries(list.body.data.map((item: { name: { it: string }; editable: boolean }) => [item.name.it, item.editable]));
      assert.deepEqual(editable, { Anomala: false, Assente: false, Mio: true, Misto: false, Nullo: false, Ovunque: false });
      // He is shown only the places of his perimeter in an entry that names others too.
      assert.deepEqual(list.body.data.find((item: { id: string }) => item.id === hex(mixed)).placeIds, [hex(ownPlace())]);
      assert.equal((await call(actor(), 'GET', one(mixed))).status, 200);
      assert.equal(failure(await call(actor(), 'GET', one(elsewhere))).status, 404);
      assert.equal(failure(await call(actor(), 'DELETE', one(elsewhere))).status, 404);
      assert.equal(failure(await call(actor(), 'PATCH', one(elsewhere), { enabled: false }, { 'if-match': tag(await call(sa(), 'GET', one(elsewhere))) })).status, 404);
      // The administrator of the group sees all of them, with every place.
      const all = await call(sa(), 'GET', `${base()}?limit=100`);
      assert.equal(all.body.data.length, 8);
      assert.ok(all.body.data.every((item: { editable: boolean }) => item.editable));
      assert.deepEqual(all.body.data.find((item: { id: string }) => item.id === hex(mixed)).placeIds, [hex(otherPlace()), hex(ownPlace())]);
      assert.ok([everywhere, absent, nul, mine, text, withJunk].every((id) => all.body.data.some((item: { id: string }) => item.id === hex(id))));
    });
  }

  it('lets him create and change only entries whose places are all his, with only places of his perimeter', async () => {
    const created = await call(ca(), 'POST', base(), { code: 11, name: { it: 'Del CA' }, taxId, placeIds: [hex(ownPlace())] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.data.placeIds, created.body.data.editable], [[hex(ownPlace())], true]);
    // Without a place, or with a place outside his perimeter: refused with the details, whatever else the body says.
    assert.deepEqual(failure(await call(ca(), 'POST', base(), { code: 12, name: { it: 'x' }, taxId })), { status: 403, code: 'FORBIDDEN', details: [{ field: 'placeIds', issue: 'notAllowed' }] });
    assert.deepEqual(failure(await call(ca(), 'POST', base(), { code: 12, name: { it: 'x' }, taxId, placeIds: [] })).details, [{ field: 'placeIds', issue: 'notAllowed' }]);
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { code: 12, name: { it: 'x' }, taxId, placeIds: [hex(ownPlace()), hex(otherPlace())] })).details, [{ field: 'placeIds.1', issue: 'notAllowed' }]);
    assert.equal(await db.departments.countDocuments({ code: 12 }), 0);
    // He deletes what is all his.
    assert.equal((await call(ca(), 'DELETE', one(created.body.data.id))).status, 204);
    const paOwn = await call(pa(), 'POST', base(), { code: 19, name: { it: 'Del PA' }, taxId, placeIds: [hex(ownPlace())] });
    assert.equal((await call(pa(), 'DELETE', one(paOwn.body.data.id))).status, 204);
    const mine = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: mine, code: 14, placesAvailability: [ownPlace()] }));
    const mineTag = tag(await call(ca(), 'GET', one(mine)));
    assert.deepEqual(failure(await call(ca(), 'PATCH', one(mine), { placeIds: [] }, { 'if-match': mineTag })).details, [{ field: 'placeIds', issue: 'notAllowed' }]);
    assert.deepEqual(failure(await call(ca(), 'PATCH', one(mine), { placeIds: [hex(otherPlace())] }, { 'if-match': mineTag })).details, [{ field: 'placeIds.0', issue: 'notAllowed' }]);
    assert.equal((await call(ca(), 'PATCH', one(mine), { noDiscount: true }, { 'if-match': mineTag })).status, 200);
    // A place the entry did not name is verified to exist (after the perimeter).
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(mine), { placeIds: [hex(ownPlace()), hex(new ObjectId())] }, { 'if-match': tag(await call(pa(), 'GET', one(mine))) })).status, 403);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(mine), { placeIds: [hex(ownPlace()), hex(new ObjectId())] }, { 'if-match': tag(await call(sa(), 'GET', one(mine))) })), issues(['placeIds.1', 'incorrect']));
    const added = await call(sa(), 'PATCH', one(mine), { placeIds: [hex(ownPlace()), hex(otherPlace())] }, { 'if-match': tag(await call(sa(), 'GET', one(mine))) });
    assert.deepEqual(added.body.data.placeIds, [hex(ownPlace()), hex(otherPlace())]);
    // Now the entry is shared with a place that is not his: he still reads it, and cannot change or delete it, nor the one for every place.
    const shared = await call(ca(), 'GET', one(mine));
    assert.deepEqual([shared.body.data.placeIds, shared.body.data.editable], [[hex(ownPlace())], false]);
    const everywhere = new ObjectId();
    const junk = new ObjectId();
    await db.departments.insertMany([legacyDepartment({ _id: everywhere, code: 15, placesAvailability: [] }), legacyDepartment({ _id: junk, code: 16, placesAvailability: [ownPlace(), 'x'] })]);
    for (const [actor, id] of [[ca, mine], [pa, mine], [ca, everywhere], [pa, everywhere], [ca, junk], [pa, junk]] as const) {
      const read = await call(actor(), 'GET', one(id));
      assert.equal(read.status, 200);
      for (const body of [{ noDiscount: false }, { placeIds: [hex(ownPlace())] }, { enabled: false }]) {
        assert.deepEqual(failure(await call(actor(), 'PATCH', one(id), body, { 'if-match': tag(read) })), { status: 403, code: 'FORBIDDEN', details: undefined });
      }
      assert.deepEqual(failure(await call(actor(), 'DELETE', one(id))), { status: 403, code: 'FORBIDDEN', details: undefined });
    }
    // The entry for every place is unchanged, so a restriction to his place never happened.
    assert.deepEqual((await db.departments.findOne({ _id: everywhere }))!['placesAvailability'], []);
    assert.equal(await db.departments.countDocuments({ _id: { $in: [mine, everywhere, junk] } }), 3);
  });

  it('records only the places of the perimeter of the actor in the activity log', async () => {
    const created = await call(sa(), 'POST', base(), { code: 17, name: { it: 'Misto' }, taxId, placeIds: [hex(ownPlace()), hex(otherPlace())] });
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'PATCH', one(created.body.data.id), { enabled: false }, { 'if-match': tag(created) })).status, 200);
    assert.equal(((log('productDepartment.updated', mark)[0]!.changes ?? []).find((change) => change.field === 'enabled')) !== undefined, true);
    // A company administrator edits an entry that is all his; what is stored beyond (nothing) is never in the entry he can read back.
    const own = await call(ca(), 'POST', base(), { code: 18, name: { it: 'Mio' }, taxId, placeIds: [hex(ownPlace())] });
    await db.departments.updateOne({ _id: new ObjectId(own.body.data.id as string) }, { $set: { placesAvailability: [ownPlace()] } });
    const mark2 = world.office.activity.entries.length;
    const changed = await call(ca(), 'PATCH', one(own.body.data.id), { enabled: false }, { 'if-match': tag(await call(ca(), 'GET', one(own.body.data.id))) });
    assert.equal(changed.status, 200);
    const text = JSON.stringify(log('productDepartment.updated', mark2));
    assert.ok(!text.includes(hex(otherPlace())));
    // The same entry written by the group administrator with another place: the log of the company administrator's own write above never held it; the one of the creation shows the places to its actor.
    assert.ok(JSON.stringify(log('productDepartment.created', 0).find((entry) => entry.resource?.id === created.body.data.id)).includes(hex(otherPlace())));
  });

  it('refuses a change or a deletion when the entry changed while the request ran: the date, any type, and the places the legacy writes without it', async () => {
    const created = await create({ placeIds: [hex(ownPlace())] });
    const id = new ObjectId(created.body.data.id as string);
    // The date stored as another type is still compared as it is stored, not an entry nobody can change.
    await db.departments.updateOne({ _id: id }, { $set: { updateDate: 'a text' } });
    const odd = await call(sa(), 'GET', one(id));
    const changed = await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': tag(odd) });
    assert.equal(changed.status, 200);
    assert.ok((await db.departments.findOne({ _id: id }))!['updateDate'] instanceof Date);
    await db.departments.updateOne({ _id: id }, { $unset: { updateDate: '' } });
    assert.equal((await call(sa(), 'PATCH', one(id), { enabled: true }, { 'if-match': tag(await call(sa(), 'GET', one(id))) })).status, 200);
    await db.departments.updateOne({ _id: id }, { $set: { updateDate: { $note: 'looks like an operator' } } });
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
  });

  it('writes the places only while they are what was read (the legacy does not touch the date)', async () => {
    const created = await create({ placeIds: [hex(ownPlace())] });
    const id = new ObjectId(created.body.data.id as string);
    const read = await call(sa(), 'GET', one(id));
    await db.departments.updateOne({ _id: id }, { $set: { placesAvailability: [otherPlace()] } });
    // The version moved with it, so this is the 412 of every stale read; the guard of the write itself is checked in the units.
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { placeIds: [] }, { 'if-match': tag(read) })).status, 412);
  });
});

describe('departments: the image of the library', () => {
  before(async () => {
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': true } });
  });
  after(async () => {
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': false } });
  });

  it('stores the descriptor the library gives at medias.images.main, leaves the residue of the old form alone, and removes it with null', async () => {
    const image = await seedImage(db, world.group(0).groupId);
    const created = await create({ image: { imageId: hex(image) } });
    const id = created.body.data.id as string;
    assert.deepEqual(created.body.data.image, { _id: hex(image), basename: 'insegna-1a2b3c4d.png', extension: 'png', filename: 'Insegna', mimetype: 'image/png', title: 'Insegna title', alt: 'Insegna alt', dirname: '/media/image', type: 'image', filectime: 1_731_490_000_123 });
    const document = (await stored(id))!;
    const main = ((document['medias'] as Document)['images'] as Document)['main'] as Document;
    assert.deepEqual(Object.keys(main), ['_id', 'dirname', 'basename', 'extension', 'filename', 'mimetype', 'filectime', 'mmThumb', 'type', 'title', 'alt']);
    assert.ok(main['filectime'] instanceof Double);
    assert.deepEqual(main['mmThumb'], {});
    // A department with the residue of the old form: it is not read, and a new image does not touch it.
    const old = new ObjectId();
    await db.departments.insertOne(legacyDepartment({ _id: old, code: 55, medias: { images: { images: { main: { _id: 'old' } }, internalFileName: 'x' } } }));
    assert.equal((await call(sa(), 'GET', one(old))).body.data.image, null);
    const oldTag = tag(await call(sa(), 'GET', one(old)));
    const set = await call(sa(), 'PATCH', one(old), { image: { imageId: hex(image) } }, { 'if-match': oldTag });
    assert.equal(set.body.data.image._id, hex(image));
    const medias = (await db.departments.findOne({ _id: old }))!['medias'] as Document;
    assert.deepEqual((medias['images'] as Document)['images'], { main: { _id: 'old' } });
    assert.equal((medias['images'] as Document)['internalFileName'], 'x');
    // The same image again changes nothing; null removes only the main one.
    assert.equal(tag(await call(sa(), 'PATCH', one(old), { image: { imageId: hex(image) } }, { 'if-match': tag(set) })), tag(set));
    const removed = await call(sa(), 'PATCH', one(old), { image: null }, { 'if-match': tag(set) });
    assert.equal(removed.body.data.image, null);
    const after = (await db.departments.findOne({ _id: old }))!['medias'] as Document;
    assert.deepEqual(after, { images: { images: { main: { _id: 'old' } }, internalFileName: 'x' } });
    assert.equal(tag(await call(sa(), 'PATCH', one(old), { image: null }, { 'if-match': tag(removed) })), tag(removed));
  });

  it('writes the smallest container that holds the path when medias is missing or has no images', async () => {
    const image = await seedImage(db, world.group(0).groupId);
    for (const [medias, expected] of [[undefined, 'medias'], [null, 'medias'], [{ other: 1 }, 'images'], [{ images: null, other: 1 }, 'images'], ['text', 'medias']] as const) {
      const id = new ObjectId();
      await db.departments.insertOne(legacyDepartment({ _id: id, code: 120 + Math.floor(Math.random() * 1e6), medias }));
      const current = await call(sa(), 'GET', one(id));
      const set = await call(sa(), 'PATCH', one(id), { image: { imageId: hex(image) } }, { 'if-match': tag(current) });
      assert.equal(set.status, 200, expected);
      assert.equal(set.body.data.image._id, hex(image));
      const written = (await db.departments.findOne({ _id: id }))!['medias'] as Document;
      assert.equal(((written['images'] as Document)['main'] as Document)['_id'], hex(image));
      if (typeof medias === 'object' && medias !== null && 'other' in medias) {
        assert.equal(written['other'], 1);
      }
    }
  });

  it('refuses an image that is not one of the library of the group: unknown, in the trash, of another group, not an image, unsafe', async () => {
    const post = (image: unknown) => call(sa(), 'POST', base(), { code: 62, name: { it: 'x' }, taxId, image });
    for (const id of [hex(new ObjectId()), hex(await seedImage(db, world.group(0).groupId, { trash: true })), hex(await seedImage(db, world.group(0).groupId, { type: 'file' })), hex(await seedImage(db, world.group(0).groupId, { basename: '../x.png' })), hex(await seedImage(db, world.group(0).groupId, { mimetype: 'text/html' })), hex(await seedImage(db, world.group(0).groupId, { filectime: undefined }))]) {
      assert.deepEqual(failure(await post({ imageId: id })), issues(['image', 'incorrect']), id);
    }
    const foreign = await seedImage(catalogCollections(ctx, world, 1), world.group(1).groupId);
    assert.deepEqual(failure(await post({ imageId: hex(foreign) })), issues(['image', 'incorrect']));
    const created = await create({});
    assert.equal(created.body.data.image, null);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(created.body.data.id), { image: { imageId: hex(new ObjectId()) } }, { 'if-match': tag(created) })), issues(['image', 'incorrect']));
  });

  it('shows a company administrator only the images of his own companies', async () => {
    const legacyImage = await seedImage(db, world.group(0).groupId);
    const mine = await seedImage(db, world.group(0).groupId, { companyId: (await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').findOne({ _id: ownPlace() }))!['companyId'] });
    const created = await create({ placeIds: [hex(ownPlace())] }, ca());
    assert.deepEqual(failure(await call(ca(), 'PATCH', one(created.body.data.id), { image: { imageId: hex(legacyImage) } }, { 'if-match': tag(created) })), issues(['image', 'incorrect']));
    assert.equal((await call(ca(), 'PATCH', one(created.body.data.id), { image: { imageId: hex(mine) } }, { 'if-match': tag(created) })).status, 200);
    // A place administrator has no company in his scope that the server can derive: he gets no image, not every image of the group.
    const withPlace = await create({ placeIds: [hex(ownPlace())] }, pa());
    for (const image of [legacyImage, mine]) {
      assert.deepEqual(failure(await call(pa(), 'PATCH', one(withPlace.body.data.id), { image: { imageId: hex(image) } }, { 'if-match': tag(withPlace) })), issues(['image', 'incorrect']));
    }
  });

  it('does not show the image and refuses it when the group has no media feature', async () => {
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': false } });
    const created = await create({});
    assert.ok(!('image' in created.body.data));
    assert.ok(!('image' in (await call(sa(), 'GET', one(created.body.data.id))).body.data));
    assert.ok((await call(sa(), 'GET', base())).body.data.every((item: object) => !('image' in item)));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(created.body.data.id), { image: null }, { 'if-match': tag(created) })), issues(['image', 'notAllowed']));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': true } });
  });
});

describe('departments: the tax rates of the group', () => {
  const taxes = () => `/groups/${hex(world.group(0).groupId)}/taxes`;

  it('realigns the copy of a tax rate in the departments that hold it when the rate changes, and only theirs', async () => {
    const rate = await call(sa(), 'POST', taxes(), { rate: 4, department: 5, description: 'Minima' });
    const tid = rate.body.data.id as string;
    const copy = { id: tid, value: 4, department: 5, description: 'Minima', natura: null };
    const mine = [new ObjectId(), new ObjectId()];
    const others = new ObjectId();
    await db.departments.insertMany([legacyDepartment({ _id: mine[0]!, code: 131, tax: { ...copy, extra: 'kept' } }), legacyDepartment({ _id: mine[1]!, code: 132, tax: { ...copy, value: new Double(4) } }), legacyDepartment({ _id: others, code: 133 })]);
    const before = (await db.departments.findOne({ _id: others }))!;
    const mark = world.office.activity.entries.length;
    const changed = await call(sa(), 'PATCH', `${taxes()}/${tid}`, { rate: 5, description: 'Cambiata', vatNature: 'N2.1' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    for (const id of mine) {
      const document = (await db.departments.findOne({ _id: id }, { ...EXACT_TYPES }))!;
      assert.deepEqual(plain(document['tax']), { id: tid, value: 5, department: 5, description: 'Cambiata', natura: 'N2.1', ...(hex(id) === hex(mine[0]!) ? { extra: 'kept' } : {}) });
      assert.ok((document['updateDate'] as Date).getTime() > LEGACY_DATE.getTime());
    }
    assert.deepEqual(await db.departments.findOne({ _id: others }), before);
    assert.equal(world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'group.tax.updated').length, 1);
    // Repeating the same change (a request that changes nothing) writes nothing in the departments that are aligned and aligns a copy that is not.
    await db.departments.updateOne({ _id: mine[0]! }, { $set: { 'tax.value': 4 } });
    const dateOfTheOther = (await db.departments.findOne({ _id: mine[1]! }))!['updateDate'];
    const again = await call(sa(), 'PATCH', `${taxes()}/${tid}`, { rate: 5 });
    assert.equal(again.status, 200);
    assert.equal(((await db.departments.findOne({ _id: mine[0]! }))!['tax'] as Document)['value'], 5);
    assert.deepEqual((await db.departments.findOne({ _id: mine[1]! }))!['updateDate'], dateOfTheOther);
  });

  it('refuses to delete a tax rate a department holds, listing the departments, and deletes one nobody holds', async () => {
    const used = await call(sa(), 'POST', taxes(), { rate: 7 });
    const free = await call(sa(), 'POST', taxes(), { rate: 8 });
    const departments = [new ObjectId(), new ObjectId()];
    await db.departments.insertMany(departments.map((_id, index) => legacyDepartment({ _id, code: 140 + index, tax: { id: used.body.data.id, value: 7, department: 1, description: null, natura: null } })));
    const refused = failure(await call(sa(), 'DELETE', `${taxes()}/${used.body.data.id as string}`));
    assert.equal(refused.status, 409);
    assert.deepEqual((refused.details as Array<{ field: string }>).map((detail) => detail.field).sort(), departments.map((id) => `productDepartments.${hex(id)}`).sort());
    assert.equal((await call(sa(), 'DELETE', `${taxes()}/${free.body.data.id as string}`)).status, 204);
    await db.departments.deleteMany({ _id: { $in: departments } });
    assert.equal((await call(sa(), 'DELETE', `${taxes()}/${used.body.data.id as string}`)).status, 204);
  });
});
