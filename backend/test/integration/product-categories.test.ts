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
import { catalogCollections, legacyCategory, legacyProduct, seedImage } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
let db: CatalogCollections;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const gid = () => world.group(0).groupId;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/product-categories`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const groups = () => ctx.databases.common().collection('groups');
const features = (value: Document) => groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(value).map(([key, flag]) => [`settings.${key}`, flag])) });
const ALL = { cash: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, ordering: true, rooms: true, media: true };
const NONE = { cash: false, customersApp: false, tobaccosGamesMonopoly: false, productsVariants: false, ordering: false, rooms: false, media: false };
const stored = (id: string | ObjectId) => db.categories.findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

async function create(body: Document = {}, actor = sa(), headers: Record<string, string> = {}) {
  const reply = await call(actor, 'POST', base(), { name: { it: 'Bibite' }, ...body }, headers);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}
const seed = async (overrides: Document = {}) => {
  // A key given as `undefined` is missing from the stored document (the driver would write `null`).
  const document = Object.fromEntries(Object.entries(legacyCategory(overrides)).filter(([, value]) => value !== undefined));
  await db.categories.insertOne(document);
  return document['_id'] as ObjectId;
};

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  db = catalogCollections(ctx, world);
  await features(ALL);
  await db.places.updateOne(
    { _id: own() },
    { $set: { printStations: [{ id: 'st-1', name: 'A' }, { id: 'st-2' }, { name: 'senza id' }, 7], productionCenter: [{ id: 'pc-1', name: 'Cucina', capacity: 5 }] } },
  );
  await db.places.updateOne({ _id: other() }, { $set: { printStations: [{ id: 'st-9' }], productionCenter: 'x' } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('categories: access', () => {
  it('lets the roles that update products write, refuses the others and keeps the groups apart', async () => {
    for (const actor of [psa(), world.office.cluster.dealerA, sa()]) {
      const created = await create({}, actor);
      assert.equal(created.body.data.editable, true);
      assert.equal((await call(actor, 'DELETE', one(created.body.data.id))).status, 204);
    }
    const created = await create();
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal((await world.office.call('GET', `${base()}/tree`, undefined)).status, 401);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', `${base()}/tree`)).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(created.body.data.id, 1), { enabled: false }, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}/tree?x=1`)).status, 422);
  });
});

describe('categories: creation', () => {
  it('creates a category in the legacy shape with 201, Location and ETag, replays a retry and records it', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = {
      name: { it: '  Pizze  ' },
      description: { it: 'Tutte' },
      position: 3,
      productionValue: 4,
      availability: { pos: true, ecommerce: true },
      noDiscount: true,
      requiresLegalAge: true,
      secondaryFiscalPrinter: true,
      featured: true,
      integrations: { floodOrders: true, leggimenu: true },
      dining: { endOfMeal: true, feePercentage: 2.5, printGroup: 2, type: 'food' },
      tobacco: true,
      backgroundColor: '#AABBCC',
      textColor: '#ffffff',
      internalFileName: 'pizze.png',
      externalUrl: 'https://example.test/pizze.png',
    };
    const first = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.ok(tag(first));
    const data = first.body.data;
    assert.equal(data.name.it, 'Pizze');
    assert.deepEqual([data.parentId, data.depth, data.cyclic, data.editable], [null, 0, false, true]);
    assert.deepEqual(data.availability, { pos: true, ecommerce: true });
    assert.deepEqual(data.dining, { endOfMeal: true, hiddenOnHandheld: false, feePercentage: 2.5, printGroup: 2, alwaysFirstCourse: false, notAffiliatedMenu: false, type: 'food' });
    assert.deepEqual([data.backgroundColor, data.textColor, data.tobacco, data.secondaryFiscalPrinter, data.featured, data.requiresLegalAge], ['#aabbcc', '#ffffff', true, true, true, true]);
    assert.deepEqual([data.internalFileName, data.externalUrl, data.image, data.icon], ['pizze.png', 'https://example.test/pizze.png', null, null]);
    assert.deepEqual(data.integrations, { floodOrders: true, yellgo: false, leggimenu: true });
    const document = (await stored(data.id))!;
    assert.deepEqual(Object.keys(document), ['_id', 'parentId', 'name', 'description', 'position', 'productionValue', 'availability', 'noDiscount', 'requiresGreaterAge', 'secondaryFiscalPrinter', 'featured', 'backgroundColor', 'textColor', 'medias', 'placesAvailability', 'variants', 'variantsCategories', 'printStations', 'printStationsNoRooms', 'roomsSettings', 'tgm', 'integrations', 'status', 'insertDate', 'updateDate']);
    assert.ok(document['position'] instanceof Int32 && document['productionValue'] instanceof Int32);
    assert.ok((document['roomsSettings'] as Document)['percentageFee'] instanceof Double);
    assert.deepEqual(document['integrations'], { floodOrders: true, easyappear: false, yellgo: false, leggimenu: true });
    assert.deepEqual(plain(document['medias']), { images: { internalFileName: 'pizze.png', externalUrl: 'https://example.test/pizze.png' } });
    assert.equal(log('productCategory.created', mark).length, 1);
    assert.equal((await call(sa(), 'POST', base(), body, { 'idempotency-key': key })).body.data.id, data.id);
    assert.equal(failure(await call(sa(), 'POST', base(), { name: { it: 'altro' } }, { 'idempotency-key': key })).status, 409);
    assert.equal((await call(sa(), 'GET', one(data.id))).headers.get('etag'), tag(first));
  });

  it('writes the defaults of the legacy and Int32 for whole percentages', async () => {
    const created = await create({ dining: { feePercentage: 12 } });
    const document = (await stored(created.body.data.id))!;
    assert.ok((document['roomsSettings'] as Document)['percentageFee'] instanceof Int32);
    assert.deepEqual([document['position'], document['productionValue'], document['backgroundColor'], document['status']], [null, null, '#000000', true]);
    assert.deepEqual(document['description'], { it: '' });
    assert.deepEqual(document['printStations'], {});
  });

  it('validates every field by allowlist', async () => {
    const post = (body: Document) => call(sa(), 'POST', base(), body);
    assert.deepEqual(failure(await post({})).details, [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, autoDepartments: true, trash: true })).details, [{ field: 'autoDepartments', issue: 'unknown' }, { field: 'trash', issue: 'unknown' }]);
    for (const [field, value, issue] of [
      ['parentId', 'zz', 'pattern'],
      ['position', -1, 'minimum'],
      ['productionValue', 1.5, 'type'],
      ['backgroundColor', 'red', 'pattern'],
      ['externalUrl', 'javascript:alert(1)', 'format'],
      ['externalUrl', 'https://user:pw@example.test/x', 'format'],
      ['externalUrl', 'not a url', 'format'],
      ['internalFileName', 'a\nb', 'pattern'],
      ['modifierIds', ['x'], 'minLength'],
      ['places', [{ placeId: hex(own()) }, { placeId: hex(own()) }], 'incorrect'],
    ] as const) {
      const reply = failure(await post({ name: { it: 'x' }, [field]: value }));
      assert.equal(reply.status, 422, field);
      assert.ok((reply.details as Array<{ issue: string }>).some((detail) => detail.issue === issue || detail.issue === 'pattern' || detail.issue === 'minLength'), `${field} ${JSON.stringify(reply.details)}`);
    }
    assert.equal(failure(await post({ name: { it: 'x' }, description: { it: 'a'.repeat(140_000) } })).status, 413);
    assert.equal(failure(await post({ name: { it: 'x' }, dining: { type: 'drink' } })).status, 422);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, dining: { feePercentage: 101 } })).details, [{ field: 'dining.feePercentage', issue: 'maximum' }]);
  });

  it('checks the languages of the group, the parent, the places, the production centers, the stations and the modifiers', async () => {
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { en: 'x' } })).details, [{ field: 'name.en', issue: 'incorrect' }, { field: 'name.it', issue: 'required' }]);
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, parentId: hex(new ObjectId()) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    const modifier = legacyProduct({ variant: { status: true } });
    const plainProduct = legacyProduct({ variant: { status: false } });
    const trashed = legacyProduct({ variant: { status: true }, trash: true });
    await db.products.insertMany([modifier, plainProduct, trashed]);
    const missingCategory = hex(new ObjectId());
    const reply = failure(
      await call(sa(), 'POST', base(), {
        name: { it: 'x' },
        places: [{ placeId: hex(own()), productionCenterId: 'pc-1' }, { placeId: hex(other()), productionCenterId: 'pc-9' }, { placeId: hex(new ObjectId()) }],
        printStations: { [hex(own())]: ['st-1', 'zz'], [hex(new ObjectId())]: ['st-1'], [hex(other())]: [] },
        counterPrintStations: { [hex(own())]: ['st-2'] },
        modifierIds: [hex(modifier['_id'] as ObjectId), hex(plainProduct['_id'] as ObjectId), hex(trashed['_id'] as ObjectId), hex(new ObjectId())],
        modifierCategoryIds: [missingCategory],
      }),
    );
    assert.equal(reply.status, 422);
    const fields = (reply.details as Array<{ field: string }>).map((detail) => detail.field);
    assert.deepEqual(fields.filter((field) => field.startsWith('places')), ['places.2.placeId', 'places.1.productionCenterId']);
    assert.ok(fields.includes('printStations.' + hex(own()) + '.1'));
    assert.equal(fields.filter((field) => field.startsWith('printStations.')).length, 2);
    assert.deepEqual(fields.filter((field) => field.startsWith('modifierIds')), ['modifierIds.1', 'modifierIds.2', 'modifierIds.3']);
    assert.ok(fields.includes('modifierCategoryIds.0'));
    const holderCategory = await seed({ name: { it: 'Per i modificatori' } });
    await create({ modifierCategoryIds: [hex(holderCategory)] });
    const ok = await create({
      places: [{ placeId: hex(own()), position: 2, productionCenterId: 'pc-1' }, { placeId: hex(other()) }],
      printStations: { [hex(own())]: ['st-1'] },
      counterPrintStations: { [hex(own())]: ['st-2'], [hex(other())]: [] },
      modifierIds: [hex(modifier['_id'] as ObjectId)],
    });
    assert.deepEqual(ok.body.data.places, [{ placeId: hex(own()), position: 2, productionCenterId: 'pc-1' }, { placeId: hex(other()), position: null, productionCenterId: null }]);
    assert.deepEqual(ok.body.data.printStations, { [hex(own())]: ['st-1'] });
    const document = (await stored(ok.body.data.id))!;
    assert.deepEqual(document['printStations'], { [`__${hex(own())}`]: ['st-1'] });
    assert.ok((document['placesAvailability'] as Document[])[0]!['position'] instanceof Int32);
    assert.deepEqual(document['variants'], [modifier['_id']]);
  });

  it('creates a child, refuses a parent that is too deep, and a group with too many categories', async () => {
    const root = await create({ name: { it: 'Radice' } });
    let parent = root.body.data.id as string;
    for (let level = 1; level < 10; level += 1) {
      const child = await create({ name: { it: `L${String(level)}` }, parentId: parent });
      assert.equal(child.body.data.depth, level);
      parent = child.body.data.id;
    }
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'troppo' }, parentId: parent })).details, [{ field: 'parentId', issue: 'tooDeep' }]);
    const many = Array.from({ length: 2000 }, () => legacyCategory({ name: { it: 'x' } }));
    const before = await db.categories.countDocuments();
    await db.categories.insertMany(many.slice(0, 2000 - before));
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'una in più' } })), { status: 409, code: 'CONFLICT', details: [{ field: 'categories', issue: 'tooMany' }] });
    await db.categories.insertOne(legacyCategory());
    assert.equal(failure(await call(sa(), 'GET', `${base()}/tree`)).status, 409);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?parentId=null`)).status, 409);
    const listed = await call(sa(), 'GET', `${base()}?limit=5`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.every((item: { depth: unknown }) => item.depth === null));
    assert.equal((await call(sa(), 'GET', one(root.body.data.id))).body.data.depth, null);
    assert.equal(failure(await call(sa(), 'PATCH', one(root.body.data.id), { parentId: hex(new ObjectId()) }, { 'if-match': tag(await call(sa(), 'GET', one(root.body.data.id))) })).status, 409);
    await db.categories.deleteMany({});
  });
});

describe('categories: the features of the group', () => {
  it('refuses with notAllowed and never shows the fields of a function the group does not have', async () => {
    await features(NONE);
    try {
      const created = await create({});
      const keys = Object.keys(created.body.data);
      for (const hidden of ['availability', 'secondaryFiscalPrinter', 'featured', 'dining', 'tobacco', 'backgroundColor', 'modifierIds', 'modifierCategoryIds', 'printStations', 'counterPrintStations', 'image', 'icon', 'internalFileName', 'externalUrl']) {
        assert.ok(!keys.includes(hidden), hidden);
      }
      const attempt = {
        availability: { pos: true, ecommerce: false },
        featured: true,
        secondaryFiscalPrinter: true,
        tobacco: true,
        backgroundColor: '#000000',
        modifierIds: [],
        modifierCategoryIds: [],
        printStations: {},
        counterPrintStations: {},
        dining: { endOfMeal: true },
        image: null,
        icon: null,
        internalFileName: 'x',
        externalUrl: 'https://example.test',
      };
      const expected = ['availability.pos', 'availability.ecommerce', 'featured', 'secondaryFiscalPrinter', 'tobacco', 'backgroundColor', 'modifierIds', 'modifierCategoryIds', 'printStations', 'counterPrintStations', 'dining.endOfMeal', 'image', 'icon', 'internalFileName', 'externalUrl'];
      const reply = failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, ...attempt }));
      assert.deepEqual((reply.details as Array<{ field: string }>).map((detail) => detail.field).sort(), [...expected].sort());
      assert.deepEqual((failure(await call(sa(), 'PATCH', one(created.body.data.id), attempt, { 'if-match': tag(created) })).details as unknown[]).length, expected.length);
      // The flags that need no function are accepted.
      assert.equal((await call(sa(), 'PATCH', one(created.body.data.id), { noDiscount: true, integrations: { yellgo: true } }, { 'if-match': tag(created) })).status, 200);
      // Each function alone shows only its own fields.
      await features({ cash: true });
      assert.deepEqual((await call(sa(), 'GET', one(created.body.data.id))).body.data.availability, { pos: false });
      await features({ cash: false, customersApp: true });
      assert.deepEqual((await call(sa(), 'GET', one(created.body.data.id))).body.data.availability, { ecommerce: false });
    } finally {
      await features(ALL);
    }
  });
});

describe('categories: reads', () => {
  it('reads the dirty shapes of the real data tolerantly', async () => {
    const dirty = await seed({
      name: { it: 'Sporca', en: 5, xx1: 'no' },
      description: 'testo',
      position: Number.NaN,
      productionValue: new Double(Number.NaN),
      availability: undefined,
      integrations: undefined,
      roomsSettings: { endMeal: 'si', percentageFee: Number.NaN, printGroup: 1.5, type: 'drink' },
      tgm: undefined,
      backgroundColor: 'red',
      textColor: undefined,
      featured: undefined,
      variants: [new ObjectId(), 'x', 5],
      variantsCategories: 'no',
      printStations: { [`__${hex(own())}`]: ['st-1', 4], '__zz': ['a'], plain: ['b'], [`__${hex(other())}`]: 'no' },
      printStationsNoRooms: [],
      medias: { images: { icon: { _id: 'i1', basename: 'a.png' }, internalFileName: 5, images: { main: { _id: 'old' } } } },
      placesAvailability: [{ id: own(), position: 2, productionCenterId: 'pc-1' }, other(), 7, { id: 'text' }, { id: own(), position: 9 }],
      insertDate: undefined,
      updateDate: 'x',
      status: 'yes',
      trash: true,
    });
    const reply = await call(sa(), 'GET', one(dirty));
    assert.equal(reply.status, 200);
    const data = reply.body.data;
    assert.deepEqual([data.position, data.productionValue, data.enabled, data.createdAt, data.updatedAt, data.description], [null, null, false, null, null, {}]);
    assert.deepEqual(data.dining, { endOfMeal: false, hiddenOnHandheld: false, feePercentage: null, printGroup: null, alwaysFirstCourse: false, notAffiliatedMenu: false, type: 'other' });
    assert.deepEqual([data.backgroundColor, data.textColor, data.featured, data.tobacco, data.availability], [null, null, false, false, { pos: false, ecommerce: false }]);
    assert.equal(data.modifierIds.length, 1);
    assert.deepEqual(data.modifierCategoryIds, []);
    assert.deepEqual(data.printStations, { [hex(own())]: ['st-1'], [hex(other())]: [] });
    assert.deepEqual(data.counterPrintStations, {});
    assert.equal(data.icon._id, 'i1');
    assert.deepEqual([data.image, data.internalFileName, data.name], [null, null, { it: 'Sporca' }]);
    assert.deepEqual(data.places, [{ placeId: hex(own()), position: 2, productionCenterId: 'pc-1' }, { placeId: hex(other()), position: null, productionCenterId: null }]);
    assert.deepEqual(data.integrations, { floodOrders: false, yellgo: false, leggimenu: false });
    // A place the CA does not have is not shown; the category is not his to change (anomalous list, shared places).
    const asCa = await call(ca(), 'GET', one(dirty));
    assert.deepEqual([asCa.body.data.places.map((entry: { placeId: string }) => entry.placeId), asCa.body.data.editable], [[hex(own())], false]);
    assert.deepEqual(asCa.body.data.printStations, { [hex(own())]: ['st-1'] });
    await db.categories.deleteMany({});
  });

  it('lists with cursors, literal search, filters and the position order; reads a document with no keys at all', async () => {
    await db.categories.deleteMany({});
    const zeta = await seed({ name: { it: 'Zeta' }, position: 2 });
    const alfa = await seed({ name: { it: 'Alfa' }, position: Number.NaN, status: false });
    const child = await seed({ name: { en: 'Beta' }, parentId: zeta, position: 1 });
    const bare = new ObjectId();
    await db.categories.insertOne({ _id: bare });
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: Record<string, string> }) => Object.values(item.name)[0] ?? null);
    assert.deepEqual(names(await call(sa(), 'GET', base())), [null, 'Alfa', 'Beta', 'Zeta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?sort=-name&limit=2`)), ['Zeta', 'Beta']);
    const page = await call(sa(), 'GET', `${base()}?limit=2`);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?limit=2&cursor=${page.body.page.next as string}`)), ['Beta', 'Zeta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?sort=position`)).length, 4);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('.*')}`)), []);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?enabled=false`)), [null, 'Alfa']);
    assert.equal((await call(sa(), 'GET', `${base()}?enabled=true`)).body.data.length, 2);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?parentId=${hex(zeta)}`)), ['Beta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?parentId=null`)), [null, 'Alfa', 'Zeta']);
    const depths = Object.fromEntries((await call(sa(), 'GET', base())).body.data.map((item: { id: string; depth: number }) => [item.id, item.depth]));
    assert.deepEqual([depths[hex(child)], depths[hex(zeta)], depths[hex(alfa)]], [1, 0, 0]);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?cursor=zz`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=101`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?parentId=zz`)).status, 422);
    const bareReply = await call(sa(), 'GET', one(bare));
    assert.deepEqual([bareReply.body.data.enabled, bareReply.body.data.parentId, bareReply.body.data.places], [false, null, []]);
    await db.categories.deleteMany({});
  });

  it('reads a cycle of the stored parents as a root, flags it and keeps it out of the way of the writes', async () => {
    await db.categories.deleteMany({});
    const a = new ObjectId('000000000000000000000001');
    const b = new ObjectId('000000000000000000000002');
    const c = new ObjectId('000000000000000000000003');
    const self = new ObjectId('000000000000000000000004');
    const orphan = new ObjectId('000000000000000000000005');
    await db.categories.insertMany([
      legacyCategory({ _id: a, parentId: c, name: { it: 'A' } }),
      legacyCategory({ _id: b, parentId: a, name: { it: 'B' } }),
      legacyCategory({ _id: c, parentId: b, name: { it: 'C' } }),
      legacyCategory({ _id: self, parentId: self, name: { it: 'Self' } }),
      legacyCategory({ _id: orphan, parentId: new ObjectId(), name: { it: 'Orfana' } }),
    ]);
    const list = (await call(sa(), 'GET', base())).body.data as Array<{ id: string; parentId: string | null; depth: number; cyclic: boolean }>;
    const byId = Object.fromEntries(list.map((item) => [item.id, item]));
    assert.deepEqual([byId[hex(a)]!.cyclic, byId[hex(a)]!.parentId, byId[hex(a)]!.depth], [true, null, 0]);
    assert.deepEqual([byId[hex(b)]!.cyclic, byId[hex(b)]!.parentId, byId[hex(b)]!.depth], [false, hex(a), 1]);
    assert.deepEqual([byId[hex(c)]!.parentId, byId[hex(c)]!.depth], [hex(b), 2]);
    assert.deepEqual([byId[hex(self)]!.cyclic, byId[hex(orphan)]!.parentId, byId[hex(orphan)]!.cyclic], [true, null, false]);
    const tree = (await call(sa(), 'GET', `${base()}/tree`)).body.data as Array<{ id: string; children: Array<{ id: string; children: unknown[] }> }>;
    assert.deepEqual(tree.map((node) => node.id), [hex(a), hex(orphan), hex(self)]);
    // Moving a category under its own descendant, or under itself, is a cycle; an unrelated change works on a node of the cycle.
    const reply = await call(sa(), 'GET', one(b));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(b), { parentId: hex(c) }, { 'if-match': tag(reply) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(b), { parentId: hex(b) }, { 'if-match': tag(reply) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    const aReply = await call(sa(), 'GET', one(a));
    assert.equal((await call(sa(), 'PATCH', one(a), { noDiscount: true }, { 'if-match': tag(aReply) })).status, 200);
    // The category that closes the cycle can be freed by writing a root over its stored parent.
    const freed = await call(sa(), 'PATCH', one(a), { parentId: null }, { 'if-match': tag(await call(sa(), 'GET', one(a))) });
    assert.equal(freed.status, 200);
    assert.equal((await stored(a))!['parentId'], null);
    await db.categories.deleteMany({});
  });

  it('shows the compact tree in the language of the caller, sorted, with an ETag and 304', async () => {
    await db.categories.deleteMany({});
    const r1 = await seed({ name: { it: 'Primi' }, position: 2 });
    const r2 = await seed({ name: { en: 'Drinks' }, position: null });
    const r3 = await seed({ name: { it: 'Antipasti' }, position: 1, status: false });
    const r4 = await seed({ name: 7, position: 1 });
    await seed({ name: 8, position: 1 });
    const c1 = await seed({ name: { it: 'Pasta' }, parentId: r1, position: 5 });
    await seed({ name: { it: 'Riso' }, parentId: r1, position: null });
    await seed({ name: { it: 'Zuppe' }, parentId: r1, position: null });
    await seed({ name: { it: 'Pane' }, parentId: r1, position: 2 });
    await seed({ name: { it: 'Riso' }, parentId: r1, position: null });
    await seed({ name: { it: 'Sub' }, parentId: c1 });
    const reply = await call(sa(), 'GET', `${base()}/tree`);
    assert.equal(reply.status, 200);
    const tree = reply.body.data as Array<{ id: string; name: string | null; position: number | null; enabled: boolean; parentId: string | null; children: Array<{ name: string }> }>;
    assert.deepEqual(tree.map((node) => node.name), [null, null, 'Antipasti', 'Primi', 'Drinks']);
    assert.equal(tree.find((node) => node.id === hex(r3))!.enabled, false);
    assert.deepEqual(tree.find((node) => node.id === hex(r1))!.children.map((node) => node.name), ['Pane', 'Pasta', 'Riso', 'Riso', 'Zuppe']);
    assert.ok([r2, r4].every((id) => tree.some((node) => node.id === hex(id))));
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const again = await world.as.call(sa(), 'GET', `${base()}/tree`, undefined, { 'if-none-match': tag(reply) });
    assert.equal(again.status, 304);
    // A company administrator gets the categories of his perimeter; one whose parent he does not reach is a root.
    await db.categories.deleteMany({});
    const hidden = await seed({ name: { it: 'Nascosta' }, placesAvailability: [{ id: other(), position: null, productionCenterId: null }] });
    const mine = await seed({ name: { it: 'Mia' }, parentId: hidden, placesAvailability: [{ id: own(), position: null, productionCenterId: null }] });
    const caTree = (await call(ca(), 'GET', `${base()}/tree`)).body.data as Array<{ id: string; parentId: string }>;
    assert.deepEqual(caTree.map((node) => [node.id, node.parentId, (node as unknown as { parentHidden: boolean }).parentHidden]), [[hex(mine), null, true]]);
    await db.categories.deleteMany({});
  });
});

describe('categories: modification', () => {
  it('changes the given fields with If-Match, merges the texts, keeps every other key and records before and after', async () => {
    const id = await seed({ name: { it: 'Vecchia', en: 'Old' }, extra: { keep: 1 }, integrations: { easyappear: true, easyAppear: true, other: 1 }, roomsSettings: { endMeal: false, other: 1 }, availability: { pos: false, foreign: 1 } });
    const current = await call(sa(), 'GET', one(id));
    const mark = world.office.activity.entries.length;
    const changed = await call(
      sa(),
      'PATCH',
      one(id),
      {
        name: { it: 'Nuova', en: null },
        description: { it: 'd' },
        enabled: false,
        position: 7,
        productionValue: 3,
        availability: { pos: true, ecommerce: true },
        noDiscount: true,
        requiresLegalAge: true,
        secondaryFiscalPrinter: true,
        featured: true,
        integrations: { floodOrders: true, yellgo: true, leggimenu: true },
        dining: { endOfMeal: true, hiddenOnHandheld: true, feePercentage: 3.5, printGroup: 4, alwaysFirstCourse: true, notAffiliatedMenu: true, type: 'beverage' },
        tobacco: true,
        backgroundColor: '#112233',
        textColor: '#445566',
      },
      { 'if-match': tag(current) },
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.notEqual(tag(changed), tag(current));
    assert.equal(tag(await call(sa(), 'GET', one(id))), tag(changed));
    const document = (await stored(id))!;
    assert.deepEqual(document['name'], { it: 'Nuova' });
    assert.deepEqual(plain(document['integrations']), { easyappear: true, easyAppear: true, other: 1, floodOrders: true, yellgo: true, leggimenu: true });
    assert.equal(plain((document['roomsSettings'] as Document)['other']), 1);
    assert.deepEqual(plain((document['availability'] as Document)['foreign']), 1);
    assert.deepEqual(plain(document['extra']), { keep: 1 });
    assert.ok(document['position'] instanceof Int32 && (document['roomsSettings'] as Document)['percentageFee'] instanceof Double);
    assert.equal(log('productCategory.updated', mark).length, 1);
    assert.ok(log('productCategory.updated', mark)[0]!.changes!.some((change) => change.field === 'publishing.floodOrders'));
    // The same request changes nothing: same tag, nothing recorded; a stored NaN is written as null.
    const mark2 = world.office.activity.entries.length;
    assert.equal(tag(await call(sa(), 'PATCH', one(id), { position: 7, name: { it: 'Nuova' }, dining: { type: 'beverage' }, backgroundColor: '#112233' }, { 'if-match': tag(changed) })), tag(changed));
    assert.equal(world.office.activity.entries.length, mark2);
    await db.categories.updateOne({ _id: id }, { $set: { position: Number.NaN, productionValue: new Double(Number.NaN) } });
    const nanTag = tag(await call(sa(), 'GET', one(id)));
    const fixed = await call(sa(), 'PATCH', one(id), { position: null, productionValue: 5 }, { 'if-match': nanTag });
    assert.equal(fixed.status, 200);
    const after = (await stored(id))!;
    assert.deepEqual(plain([after['position'], after['productionValue']]), [null, 5]);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: true }, { 'if-match': nanTag })).status, 412);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { enabled: true })), issues(['If-Match', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), {}, { 'if-match': tag(fixed) })).details, [{ field: '(body)', issue: 'required' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: null } }, { 'if-match': tag(fixed) })).details, [{ field: 'name.it', issue: 'required' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { de: 'x' }, description: { de: 'x' } }, { 'if-match': tag(fixed) })).details, [{ field: 'name.de', issue: 'incorrect' }, { field: 'description.de', issue: 'incorrect' }]);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { description: { it: 'a'.repeat(140_000) } }, { 'if-match': tag(fixed) })).status, 413);
  });

  it('works on documents with missing containers, and refuses a container that is not an object with 409', async () => {
    const bare = await seed({ integrations: undefined, roomsSettings: undefined, tgm: undefined, availability: undefined, printStations: undefined, medias: undefined });
    const done = await call(sa(), 'PATCH', one(bare), { integrations: { yellgo: true }, dining: { endOfMeal: true }, tobacco: true, availability: { pos: true }, printStations: { [hex(own())]: ['st-1'] }, internalFileName: 'x' }, { 'if-match': tag(await call(sa(), 'GET', one(bare))) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const document = (await stored(bare))!;
    assert.deepEqual(plain([document['integrations'], document['tgm'], document['medias']]), [{ yellgo: true }, { type: true }, { images: { internalFileName: 'x' } }]);
    const strange = await seed({ integrations: null });
    assert.equal(failure(await call(sa(), 'PATCH', one(strange), { integrations: { yellgo: true } }, { 'if-match': tag(await call(sa(), 'GET', one(strange))) })).status, 409);
    const text = await seed({ medias: 'x', variants: undefined });
    assert.equal((await call(sa(), 'PATCH', one(text), { externalUrl: 'https://example.test/a', modifierIds: [] }, { 'if-match': tag(await call(sa(), 'GET', one(text))) })).status, 200);
    assert.deepEqual(plain((await stored(text))!['medias']), { images: { externalUrl: 'https://example.test/a' } });
    const noImages = await seed({ medias: { other: 1, images: null } });
    await call(sa(), 'PATCH', one(noImages), { internalFileName: 'y' }, { 'if-match': tag(await call(sa(), 'GET', one(noImages))) });
    assert.deepEqual(plain((await stored(noImages))!['medias']), { other: 1, images: { internalFileName: 'y' } });
    const none = await seed({ medias: { images: null } });
    const same = await call(sa(), 'GET', one(none));
    assert.equal(tag(await call(sa(), 'PATCH', one(none), { internalFileName: null, externalUrl: null }, { 'if-match': tag(same) })), tag(same));
  });

  it('moves a category in the tree, with the checks of the parent, and replaces modifiers and places', async () => {
    const root = await seed({ name: { it: 'R' } });
    const mid = await seed({ name: { it: 'M' }, parentId: root });
    const leaf = await seed({ name: { it: 'F' }, parentId: mid });
    const current = async (id: ObjectId) => tag(await call(sa(), 'GET', one(id)));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(root), { parentId: hex(leaf) }, { 'if-match': await current(root) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(leaf), { parentId: hex(new ObjectId()) }, { 'if-match': await current(leaf) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    const moved = await call(sa(), 'PATCH', one(leaf), { parentId: hex(root) }, { 'if-match': await current(leaf) });
    assert.deepEqual([moved.body.data.parentId, moved.body.data.depth], [hex(root), 1]);
    // A deep chain under a new parent is too deep.
    let parent = await seed({ name: { it: 'p0' } });
    for (let level = 1; level < 9; level += 1) {
      parent = await seed({ name: { it: `p${String(level)}` }, parentId: parent });
    }
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(root), { parentId: hex(parent) }, { 'if-match': await current(root) })).details, [{ field: 'parentId', issue: 'tooDeep' }]);
    const modifier = legacyProduct({ variant: { status: true } });
    await db.products.insertOne(modifier);
    const other1 = await seed({ name: { it: 'Altra' } });
    const set = await call(sa(), 'PATCH', one(mid), { modifierIds: [hex(modifier['_id'] as ObjectId)], modifierCategoryIds: [hex(other1)], places: [{ placeId: hex(own()), position: 1, productionCenterId: 'pc-1' }] }, { 'if-match': await current(mid) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.data.modifierCategoryIds, [hex(other1)]);
    // Only what the category did not have is judged: the same lists again change nothing, an old gone modifier never blocks.
    await db.products.deleteMany({});
    assert.equal(tag(await call(sa(), 'PATCH', one(mid), { modifierIds: [hex(modifier['_id'] as ObjectId)], places: [{ placeId: hex(own()), position: 1, productionCenterId: 'pc-1' }] }, { 'if-match': tag(set) })), tag(set));
    const changedCenter = failure(await call(sa(), 'PATCH', one(mid), { places: [{ placeId: hex(own()), position: 1, productionCenterId: 'zz' }] }, { 'if-match': tag(set) }));
    assert.deepEqual(changedCenter.details, [{ field: 'places.0.productionCenterId', issue: 'incorrect' }]);
    assert.equal((await call(sa(), 'PATCH', one(mid), { places: [{ placeId: hex(own()) }] }, { 'if-match': tag(set) })).body.data.places[0].position, null);
    const cleared = await call(sa(), 'PATCH', one(mid), { places: [], modifierIds: [] }, { 'if-match': tag(await call(sa(), 'GET', one(mid))) });
    assert.deepEqual([cleared.body.data.places, cleared.body.data.modifierIds], [[], []]);
  });

  it('writes the print stations place by place, checks them, and removes a place with null', async () => {
    const id = await seed({ printStations: { [`__${hex(other())}`]: ['old'], foreign: ['x'] }, printStationsNoRooms: undefined });
    let version = tag(await call(sa(), 'GET', one(id)));
    const bad = failure(await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: ['st-1', 'zz'], [hex(new ObjectId())]: ['st-1'] } }, { 'if-match': version }));
    assert.equal(bad.status, 422);
    assert.equal((bad.details as unknown[]).length, 2);
    const done = await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: ['st-1'], [hex(other())]: null }, counterPrintStations: { [hex(own())]: [] } }, { 'if-match': version });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    version = tag(done);
    const document = (await stored(id))!;
    assert.deepEqual(plain([document['printStations'], document['printStationsNoRooms']]), [{ foreign: ['x'], [`__${hex(own())}`]: ['st-1'] }, null]);
    const more = await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: ['st-1', 'st-2'] } }, { 'if-match': version });
    assert.equal(more.status, 200);
    version = tag(more);
    // The same again, removing a place that is not there, and an old station that is gone: nothing changes.
    await db.places.updateOne({ _id: own() }, { $set: { 'printStations.0.id': 'renamed' } });
    assert.equal(tag(await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: ['st-1', 'st-2'], [hex(other())]: null } }, { 'if-match': version })), version);
    await db.places.updateOne({ _id: own() }, { $set: { 'printStations.0.id': 'st-1' } });
  });

  it('judges only the new modifiers and stations, whatever junk the document holds', async () => {
    const keep = new ObjectId();
    const id = await seed({ variants: [keep, 'x', 7], printStations: { [`__${hex(own())}`]: 'no' } });
    const version = tag(await call(sa(), 'GET', one(id)));
    const done = await call(sa(), 'PATCH', one(id), { modifierIds: [hex(keep)], printStations: { [hex(own())]: ['st-1'] } }, { 'if-match': version });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.data.printStations, { [hex(own())]: ['st-1'] });
  });

  it('rewrites the historical availability in the current form on any save', async () => {
    const id = await seed({ placesAvailability: [own(), other()] });
    const version = tag(await call(sa(), 'GET', one(id)));
    const saved = await call(sa(), 'PATCH', one(id), { noDiscount: true }, { 'if-match': version });
    assert.deepEqual(plain((await stored(id))!['placesAvailability']), [{ id: hex(own()), position: null, productionCenterId: null }, { id: hex(other()), position: null, productionCenterId: null }]);
    assert.equal(saved.body.data.places.length, 2);
    const again = await seed({ placesAvailability: [own()] });
    const replaced = await call(sa(), 'PATCH', one(again), { places: [{ placeId: hex(own()), position: 3 }] }, { 'if-match': tag(await call(sa(), 'GET', one(again))) });
    assert.deepEqual(replaced.body.data.places, [{ placeId: hex(own()), position: 3, productionCenterId: null }]);
    // Keys the legacy adds to an element of the availability stay when the place stays.
    await db.categories.updateOne({ _id: again }, { $set: { 'placesAvailability.0.extra': 1 } });
    await call(sa(), 'PATCH', one(again), { places: [{ placeId: hex(own()), position: 4 }] }, { 'if-match': tag(await call(sa(), 'GET', one(again))) });
    assert.equal(plain(((await stored(again))!['placesAvailability'] as Document[])[0]!['extra']), 1);
  });

  it('refuses at once a parent that is already below the category', async () => {
    const a = await seed({ name: { it: 'A' } });
    const b = await seed({ name: { it: 'B' } });
    const version = tag(await call(sa(), 'GET', one(a)));
    await db.categories.updateOne({ _id: b }, { $set: { parentId: a } });
    const original = await stored(a);
    const reply = failure(await call(sa(), 'PATCH', one(a), { parentId: hex(b) }, { 'if-match': version }));
    assert.equal(reply.status, 422);
    assert.deepEqual((await stored(a))!['parentId'], original!['parentId']);
  });
});

describe('categories: deletion', () => {
  it('deletes for good with 204, records it, and a second one is 404', async () => {
    const id = await seed({});
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
    assert.equal(log('productCategory.deleted', mark).length, 1);
    assert.equal(failure(await call(sa(), 'DELETE', one(id))).status, 404);
    assert.equal(await db.categories.countDocuments({ _id: id }), 0);
  });

  it('refuses with 409 and the references of every kind, at most twenty of each, and deletes without cascade once they are gone', async () => {
    const id = await seed({ name: { it: 'Usata' } });
    const text = hex(id);
    const sub = await seed({ parentId: id });
    const holder = await seed({ variantsCategories: [id] });
    const inCategory = legacyProduct({ categories: [id] });
    const asText = legacyProduct({ categories: [text] });
    const modifiers = legacyProduct({ variantsCategories: [id] });
    const bundle = legacyProduct({ selectableBundleProducts: [{ categoryId: id }] });
    const variantBundle = legacyProduct({ selectableVariantsBundleProducts: [{ categoryId: id }] });
    await db.products.insertMany([inCategory, asText, modifiers, bundle, variantBundle, legacyProduct({ categories: [id], trash: true }), ...Array.from({ length: 25 }, () => legacyProduct({ categories: [id] }))]);
    await groups().updateOne({ _id: gid() }, { $set: { promotions: [{ id: 'promo-a', name: 'A', status: true, conditions: { categories: { ids: [text] } }, actions: { categoriesIds: [] } }, { id: 'promo-b', name: 'B', status: true, conditions: {}, actions: { categoriesIds: [text] } }, { id: 'promo-c', name: 'C', status: true, conditions: {}, actions: {} }] } });
    await db.places.updateOne({ _id: own() }, { $set: { 'printStations.0.summaryCategoriesIds': [text], kiosk: { upsellingCategoryId: text, productsCategories: [{ _id: 'x' }] }, selfOrdering: { priceListsConfig: { l1: { productsCategories: [{ _id: text }] }, l2: 'no', l3: { productsCategories: 'no' } } }, integrations: { tsh: { categoriesMap: { [text]: 'p' } } } } });
    await db.places.updateOne({ _id: other() }, { $set: { kiosk: { productsCategories: [{ _id: text }] } } });
    // The kinds are looked for in turn, cheapest first, and the answer lists the first kind found only.
    const kind = async () => {
      const refused = failure(await call(sa(), 'DELETE', one(id)));
      assert.equal(refused.status, 409);
      const details = refused.details as Array<{ field: string; issue: string }>;
      assert.ok(details.every((detail) => detail.issue === 'referenced'));
      assert.equal(new Set(details.map((detail) => detail.field.split('.')[0])).size, 1);
      return { kind: details[0]!.field.split('.')[0], count: details.length };
    };
    assert.deepEqual(await kind(), { kind: 'subcategories', count: 1 });
    await db.categories.deleteOne({ _id: sub });
    assert.deepEqual(await kind(), { kind: 'categoryModifierCategories', count: 1 });
    await db.categories.deleteOne({ _id: holder });
    assert.deepEqual(await kind(), { kind: 'promotions', count: 2 });
    await groups().updateOne({ _id: gid() }, { $unset: { promotions: '' } });
    assert.deepEqual(await kind(), { kind: 'places', count: 2 });
    await db.places.updateOne({ _id: own() }, { $unset: { kiosk: '', selfOrdering: '', integrations: '' }, $set: { 'printStations.0.summaryCategoriesIds': [] } });
    await db.places.updateOne({ _id: other() }, { $unset: { kiosk: '' } });
    assert.deepEqual(await kind(), { kind: 'products', count: 20 });
    await db.products.deleteMany({});
    await db.products.insertMany([modifiers, bundle, variantBundle]);
    assert.deepEqual(await kind(), { kind: 'productModifierCategories', count: 1 });
    await db.products.deleteOne({ _id: modifiers['_id'] });
    assert.deepEqual(await kind(), { kind: 'productBundles', count: 2 });
    await db.products.deleteMany({});
    assert.equal(await db.categories.countDocuments({ _id: id }), 1);
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
  });

  it('refuses a deletion when the category changed while the request ran, and a category that cites itself is not its own child', async () => {
    const selfish = await seed({ parentId: undefined, variantsCategories: [] });
    await db.categories.updateOne({ _id: selfish }, { $set: { parentId: selfish, variantsCategories: [selfish] } });
    assert.equal((await call(sa(), 'DELETE', one(selfish))).status, 204);
  });
});

describe('categories: the perimeter of the company and place administrators', () => {
  const place = (id: ObjectId) => ({ id, position: null, productionCenterId: null });
  for (const [role, actor] of [['company administrator', ca], ['place administrator', pa]] as const) {
    it(`shows the ${role} what is for every place or names a place of his own, and 404 for the rest`, async () => {
      await db.categories.deleteMany({});
      const everywhere = await seed({ name: { it: 'Ovunque' }, placesAvailability: [] });
      const absent = await seed({ name: { it: 'Assente' }, placesAvailability: undefined });
      const nul = await seed({ name: { it: 'Nullo' }, placesAvailability: null });
      const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [place(own())] });
      const old = await seed({ name: { it: 'Storico' }, placesAvailability: [own()] });
      const mixed = await seed({ name: { it: 'Misto' }, placesAvailability: [place(other()), place(own())] });
      const junk = await seed({ name: { it: 'Anomala' }, placesAvailability: [place(own()), 7] });
      const elsewhere = await seed({ name: { it: 'Altrove' }, placesAvailability: [place(other())] });
      const list = await call(actor(), 'GET', `${base()}?limit=100`);
      assert.deepEqual(list.body.data.map((item: { name: { it: string } }) => item.name.it), ['Anomala', 'Assente', 'Mio', 'Misto', 'Nullo', 'Ovunque', 'Storico']);
      const editable = Object.fromEntries(list.body.data.map((item: { name: { it: string }; editable: boolean }) => [item.name.it, item.editable]));
      assert.deepEqual(editable, { Anomala: false, Assente: false, Mio: true, Misto: false, Nullo: false, Ovunque: false, Storico: true });
      assert.deepEqual(list.body.data.find((item: { id: string }) => item.id === hex(mixed)).places.map((entry: { placeId: string }) => entry.placeId), [hex(own())]);
      assert.equal(failure(await call(actor(), 'GET', one(elsewhere))).status, 404);
      assert.equal(failure(await call(actor(), 'DELETE', one(elsewhere))).status, 404);
      assert.equal(failure(await call(actor(), 'PATCH', one(elsewhere), { enabled: false }, { 'if-match': tag(await call(sa(), 'GET', one(elsewhere))) })).status, 404);
      for (const id of [everywhere, absent, nul, mixed, junk]) {
        const version = tag(await call(sa(), 'GET', one(id)));
        assert.equal(failure(await call(actor(), 'PATCH', one(id), { enabled: false }, { 'if-match': version })).status, 403);
        assert.equal(failure(await call(actor(), 'DELETE', one(id))).status, 403);
      }
      assert.equal((await call(sa(), 'GET', `${base()}?limit=100`)).body.data.length, 8);
      assert.ok([mine, old].every((id) => id !== null));
      assert.equal((await call(actor(), 'PATCH', one(mine), { enabled: false }, { 'if-match': tag(await call(sa(), 'GET', one(mine))) })).status, 200);
      assert.equal((await call(actor(), 'PATCH', one(old), { enabled: false }, { 'if-match': tag(await call(sa(), 'GET', one(old))) })).status, 200);
      await db.categories.deleteMany({});
    });
  }

  it('lets him create and change only with places of his perimeter, at least one, and keeps the parent inside what he reaches', async () => {
    await db.categories.deleteMany({});
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { name: { it: 'x' } })).details, [{ field: 'places', issue: 'notAllowed' }]);
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { name: { it: 'x' }, places: [{ placeId: hex(other()) }, { placeId: hex(own()) }] })).details, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
    const created = await call(pa(), 'POST', base(), { name: { it: 'Del PA' }, places: [{ placeId: hex(own()), position: 1 }], printStations: { [hex(own())]: ['st-1'] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(created.body.data.id), { places: [] }, { 'if-match': tag(created) })).details, [{ field: 'places', issue: 'notAllowed' }]);
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(created.body.data.id), { printStations: { [hex(other())]: ['st-9'] } }, { 'if-match': tag(created) })).details, [{ field: `printStations.${hex(other())}`, issue: 'notAllowed' }]);
    const hidden = await seed({ name: { it: 'Nascosta' }, placesAvailability: [place(other())] });
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { name: { it: 'x' }, places: [{ placeId: hex(own()) }], parentId: hex(hidden) })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    const visible = await seed({ name: { it: 'Visibile' }, placesAvailability: [] });
    const child = await call(pa(), 'POST', base(), { name: { it: 'Figlia' }, places: [{ placeId: hex(own()) }], parentId: hex(visible) });
    assert.equal(child.status, 201);
    // Deleting shows him only the references he reaches, one kind at a time.
    const childId = new ObjectId(child.body.data.id as string);
    await seed({ parentId: childId, placesAvailability: [place(other())] });
    assert.deepEqual(failure(await call(pa(), 'DELETE', one(childId))).details, [{ field: 'subcategories', issue: 'referenced' }]);
    const own2 = await seed({ parentId: childId, placesAvailability: [place(own())] });
    assert.deepEqual((failure(await call(pa(), 'DELETE', one(childId))).details as Array<{ field: string }>).map((detail) => detail.field), [`subcategories.${hex(own2)}`, 'subcategories']);
    await db.categories.deleteMany({ parentId: childId });
    const holder = await seed({ variantsCategories: [childId], placesAvailability: [place(other())] });
    assert.deepEqual(failure(await call(pa(), 'DELETE', one(childId))).details, [{ field: 'categoryModifierCategories', issue: 'referenced' }]);
    await db.categories.deleteOne({ _id: holder });
    await db.places.updateOne({ _id: own() }, { $set: { 'kiosk.upsellingCategoryId': child.body.data.id } });
    await db.places.updateOne({ _id: other() }, { $set: { 'kiosk.upsellingCategoryId': child.body.data.id } });
    assert.deepEqual((failure(await call(pa(), 'DELETE', one(childId))).details as Array<{ field: string }>).map((detail) => detail.field), [`places.${hex(own())}`, 'places']);
    await db.places.updateMany({}, { $unset: { 'kiosk.upsellingCategoryId': '' } });
    await db.categories.deleteMany({});
  });

  it('records only the places of the perimeter of the actor in the activity log', async () => {
    const id = await seed({
      placesAvailability: [place(own())],
      printStations: { [`__${hex(own())}`]: ['st-1'], [`__${hex(other())}`]: ['st-9'] },
      printStationsNoRooms: { [`__${hex(other())}`]: ['st-9'] },
    });
    const mark = world.office.activity.entries.length;
    await call(pa(), 'PATCH', one(id), { enabled: false }, { 'if-match': tag(await call(sa(), 'GET', one(id))) });
    const entry = log('productCategory.updated', mark)[0]!;
    assert.ok(entry.changes!.some((change) => change.field === 'enabled'));
    assert.ok(!JSON.stringify(entry).includes(hex(other())));
    // An actor who reaches every place has them in the entries (the check above is not vacuous): a deletion records everything the category had.
    const created = await create({ places: [{ placeId: hex(own()) }, { placeId: hex(other()) }], printStations: { [hex(other())]: ['st-9'] } });
    const markCreated = world.office.activity.entries.length;
    await call(sa(), 'DELETE', one(created.body.data.id));
    assert.ok(JSON.stringify(log('productCategory.deleted', markCreated)[0]).includes(hex(other())));
  });

  it('refuses a change when the places changed while the request ran', async () => {
    const id = await seed({ placesAvailability: [place(own())] });
    const version = tag(await call(sa(), 'GET', one(id)));
    await db.categories.updateOne({ _id: id }, { $set: { placesAvailability: [place(own()), place(other())] } });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: false }, { 'if-match': version })).status, 412);
  });
});

describe('categories: the images of the library', () => {
  it('stores the image and the icon, leaves the residue alone and removes them with null', async () => {
    const image = await seedImage(db, gid());
    const icon = await seedImage(db, gid());
    const created = await create({ image: { imageId: hex(image) }, icon: { imageId: hex(icon) } });
    assert.equal(created.body.data.image._id, hex(image));
    assert.equal(created.body.data.icon._id, hex(icon));
    const document = (await stored(created.body.data.id))!;
    assert.ok(((((document['medias'] as Document)['images'] as Document)['main']) as Document)['filectime'] instanceof Double);
    const old = await seed({ medias: { images: { images: { main: { _id: 'old' } }, internalFileName: 'x' } } });
    const set = await call(sa(), 'PATCH', one(old), { image: { imageId: hex(image) }, icon: { imageId: hex(icon) } }, { 'if-match': tag(await call(sa(), 'GET', one(old))) });
    assert.equal(set.status, 200);
    const same = await call(sa(), 'PATCH', one(old), { image: { imageId: hex(image) } }, { 'if-match': tag(set) });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(tag(same), tag(set));
    const removed = await call(sa(), 'PATCH', one(old), { image: null, icon: null, internalFileName: null }, { 'if-match': tag(set) });
    assert.deepEqual([removed.body.data.image, removed.body.data.icon, removed.body.data.internalFileName], [null, null, null]);
    assert.deepEqual(plain((await stored(old))!['medias']), { images: { images: { main: { _id: 'old' } } } });
    const bad = (image: unknown) => call(sa(), 'POST', base(), { name: { it: 'x' }, image });
    for (const id of [hex(new ObjectId()), hex(await seedImage(db, gid(), { trash: true }))]) {
      assert.deepEqual(failure(await bad({ imageId: id })), issues(['image', 'incorrect']));
    }
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(old), { icon: { imageId: hex(new ObjectId()) } }, { 'if-match': tag(removed) })), issues(['icon', 'incorrect']));
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { name: { it: 'x' }, places: [{ placeId: hex(own()) }], image: { imageId: hex(image) } })), issues(['image', 'incorrect']));
  });
});

describe('categories: rejections of security', () => {
  const place = (id: ObjectId) => ({ id, position: null, productionCenterId: null });
  const raw = (text: string): Document => JSON.parse(text) as Document;

  it('answers 403 to a user without the permission, and to a reader on every write', async () => {
    const created = await create();
    const id = created.body.data.id as string;
    const blind = await addUser(ctx, world.office, { permissions: { status: true, products: { r: false, w: false } } });
    for (const path of [base(), `${base()}/tree`, one(id)]) {
      assert.equal(failure(await call(blind.id, 'GET', path)).status, 403, path);
    }
    assert.equal(failure(await call(blind.id, 'POST', base(), { name: { it: 'x' } })).status, 403);
    const reader = await addUser(ctx, world.office, { permissions: { status: true, products: { r: true, w: false } } });
    for (const path of [base(), `${base()}/tree`, one(id)]) {
      assert.equal((await call(reader.id, 'GET', path)).status, 200, path);
    }
    assert.equal(failure(await call(reader.id, 'POST', base(), { name: { it: 'x' } })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(id), { enabled: false }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'DELETE', one(id))).status, 403);
  });

  it('refuses hostile keys in the texts, the print stations and the places, and a key of a map that is not an id', async () => {
    const post = (body: Document) => call(sa(), 'POST', base(), { name: { it: 'x' }, ...body });
    const own24 = hex(own());
    for (const [body, field] of [
      [{ name: raw('{"$gt":"x"}') }, 'name.$gt'],
      [{ name: raw('{"a.b":"x"}') }, 'name.a.b'],
      [{ name: raw('{"__proto__":"x"}') }, 'name.__proto__'],
      [{ description: raw('{"$where":"x"}') }, 'description.$where'],
      [{ printStations: raw('{"$gt":["a"]}') }, 'printStations.$gt'],
      [{ printStations: raw('{"a.b":["a"]}') }, 'printStations.a.b'],
      [{ printStations: raw('{"__proto__":["a"]}') }, 'printStations.__proto__'],
      [{ counterPrintStations: { notahexid: ['a'] } }, 'counterPrintStations.notahexid'],
      [{ places: [raw(`{"placeId":"${own24}","$gt":1}`)] }, 'places.0.$gt'],
      [{ places: [{ placeId: '$gt' }] }, 'places.0.placeId'],
      [{ places: [raw(`{"placeId":"${own24}","__proto__":{}}`)] }, 'places.0.__proto__'],
      [{ dining: raw('{"$set":1}') }, 'dining.$set'],
    ] as const) {
      const reply = failure(await post(body));
      assert.equal(reply.status, 422, field);
      assert.ok((reply.details as Array<{ field: string }>).some((detail) => detail.field.startsWith(field.split('.')[0]!)), `${field} ${JSON.stringify(reply.details)}`);
    }
    const id = (await create()).body.data.id as string;
    const current = tag(await call(sa(), 'GET', one(id)));
    for (const patch of [{ printStations: { '$ne': null } }, { printStations: { 'a.b': null } }, { name: raw('{"$set":"x"}') }]) {
      assert.equal(failure(await call(sa(), 'PATCH', one(id), patch, { 'if-match': current })).status, 422);
    }
  });

  it('judges a company administrator by his own places: not the production centers, the stations or the categories of the others', async () => {
    await db.categories.deleteMany({});
    const hidden = await seed({ name: { it: 'Nascosta' }, placesAvailability: [place(other())] });
    const shared = await seed({ name: { it: 'Per tutti' }, placesAvailability: [] });
    const body = (extra: Document) => ({ name: { it: 'Mia' }, places: [{ placeId: hex(own()) }], ...extra });
    // The center and the station belong to the other place.
    assert.deepEqual(failure(await call(ca(), 'POST', base(), body({ places: [{ placeId: hex(own()), productionCenterId: 'pc-9' }] }))).details, [{ field: 'places.0.productionCenterId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await call(ca(), 'POST', base(), body({ printStations: { [hex(own())]: ['st-9'] } }))).details, [{ field: `printStations.${hex(own())}.0`, issue: 'incorrect' }]);
    // A category he does not reach is judged like one that does not exist, and one he reaches is accepted.
    const absent = failure(await call(ca(), 'POST', base(), body({ modifierCategoryIds: [hex(new ObjectId())] })));
    assert.deepEqual(failure(await call(ca(), 'POST', base(), body({ modifierCategoryIds: [hex(hidden)] }))), absent);
    assert.equal((await call(ca(), 'POST', base(), body({ modifierCategoryIds: [hex(shared)] }))).status, 201);
    // The same by a modification, and a category he does not reach never ends up referring to a category he cannot see.
    const mine = await create(body({}), ca());
    assert.deepEqual(failure(await call(ca(), 'PATCH', one(mine.body.data.id), { modifierCategoryIds: [hex(hidden)] }, { 'if-match': tag(mine) })).details, [{ field: 'modifierCategoryIds.0', issue: 'incorrect' }]);
    assert.equal(await db.categories.countDocuments({ variantsCategories: hidden }), 0);
    await db.categories.deleteMany({});
  });

  it('shows a company or place administrator the categories he reaches in the lookup, with or without ids', async () => {
    await db.categories.deleteMany({});
    const mine = await seed({ name: { it: 'Mia' }, placesAvailability: [place(own())] });
    const everywhere = await seed({ name: { it: 'Ovunque' }, placesAvailability: [] });
    const hidden = await seed({ name: { it: 'Nascosta' }, placesAvailability: [place(other())] });
    const trashed = await seed({ name: { it: 'Cestinata' }, trash: true });
    const lookup = `/groups/${hex(gid())}/lookup/product-categories`;
    const ids = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { id: string }) => item.id).sort();
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(ids(await call(actor, 'GET', lookup)), [hex(mine), hex(everywhere)].sort());
      assert.deepEqual(ids(await call(actor, 'GET', `${lookup}?ids=${hex(hidden)},${hex(mine)},${hex(trashed)}`)), [hex(mine)]);
      assert.deepEqual(ids(await call(actor, 'GET', `${lookup}?ids=${hex(hidden)}`)), []);
    }
    assert.equal((await call(sa(), 'GET', lookup)).body.data.length, 3);
    await db.categories.deleteMany({});
  });

  it('never names a parent the caller does not reach, counts the depth on what he reaches, and keeps a hidden parent when he does not send one', async () => {
    await db.categories.deleteMany({});
    const top = await seed({ name: { it: 'Alta' }, placesAvailability: [place(other())] });
    const mid = await seed({ name: { it: 'Media' }, parentId: top, placesAvailability: [place(own())] });
    const leaf = await seed({ name: { it: 'Foglia' }, parentId: mid, placesAvailability: [place(own())] });
    const seen = (reply: Awaited<ReturnType<typeof call>>) => Object.fromEntries(reply.body.data.map((item: { id: string; parentId: string | null; parentHidden: boolean; depth: number }) => [item.id, [item.parentId, item.parentHidden, item.depth]]));
    assert.deepEqual(seen(await call(pa(), 'GET', base())), { [hex(mid)]: [null, true, 0], [hex(leaf)]: [hex(mid), false, 1] });
    assert.deepEqual(seen(await call(sa(), 'GET', base())), { [hex(top)]: [null, false, 0], [hex(mid)]: [hex(top), false, 1], [hex(leaf)]: [hex(mid), false, 2] });
    const detail = await call(pa(), 'GET', one(mid));
    assert.deepEqual([detail.body.data.parentId, detail.body.data.parentHidden, detail.body.data.depth], [null, true, 0]);
    // The filter by a parent he does not reach answers as for an id that does not exist; the roots of his perimeter are what he reaches first.
    assert.deepEqual((await call(pa(), 'GET', `${base()}?parentId=${hex(top)}`)).body.data, (await call(pa(), 'GET', `${base()}?parentId=${hex(new ObjectId())}`)).body.data);
    assert.deepEqual((await call(pa(), 'GET', `${base()}?parentId=null`)).body.data.map((item: { id: string }) => item.id), [hex(mid)]);
    // Changing something else keeps the hidden parent.
    assert.equal((await call(pa(), 'PATCH', one(mid), { noDiscount: true }, { 'if-match': tag(detail) })).status, 200);
    assert.deepEqual((await stored(mid))!['parentId'], top);
    // He cannot move a category under a parent he does not reach, which is judged like one that does not exist.
    const fresh = tag(await call(pa(), 'GET', one(leaf)));
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(leaf), { parentId: hex(top) }, { 'if-match': fresh })), failure(await call(pa(), 'PATCH', one(leaf), { parentId: hex(new ObjectId()) }, { 'if-match': fresh })));
    await db.categories.deleteMany({});
  });

  it('counts the whole subtree in the depth check, the categories the caller does not reach included', async () => {
    await db.categories.deleteMany({});
    const a = await seed({ name: { it: 'a' }, placesAvailability: [] });
    const b = await seed({ name: { it: 'b' }, parentId: a, placesAvailability: [] });
    const target = await seed({ name: { it: 'c' }, parentId: b, placesAvailability: [] });
    const movable = await seed({ name: { it: 'm' }, placesAvailability: [place(own())] });
    let parent = movable;
    for (let level = 0; level < 8; level += 1) {
      parent = await seed({ name: { it: `h${String(level)}` }, parentId: parent, placesAvailability: [place(other())] });
    }
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(movable), { parentId: hex(target) }, { 'if-match': tag(await call(pa(), 'GET', one(movable))) })).details, [{ field: 'parentId', issue: 'tooDeep' }]);
    assert.equal((await call(pa(), 'PATCH', one(movable), { parentId: hex(a) }, { 'if-match': tag(await call(pa(), 'GET', one(movable))) })).status, 200);
    await db.categories.deleteMany({});
  });
});

describe('categories: the maps of print stations', () => {
  it('writes nothing for an empty list on a place that is not there, and checks the place of every key', async () => {
    const id = await seed({ printStations: {}, printStationsNoRooms: undefined });
    const current = tag(await call(sa(), 'GET', one(id)));
    const same = await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: [] }, counterPrintStations: { [hex(own())]: [] } }, { 'if-match': current });
    assert.equal(tag(same), current);
    const unknown = hex(new ObjectId());
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { printStations: { [unknown]: [] } }, { 'if-match': current })).details, [{ field: `printStations.${unknown}`, issue: 'incorrect' }]);
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, counterPrintStations: { [unknown]: [] } })).details, [{ field: `counterPrintStations.${unknown}`, issue: 'incorrect' }]);
    // A key whose place is gone can still be taken away.
    await db.categories.updateOne({ _id: id }, { $set: { [`printStations.__${unknown}`]: ['x'] } });
    const removed = await call(sa(), 'PATCH', one(id), { printStations: { [unknown]: null } }, { 'if-match': tag(await call(sa(), 'GET', one(id))) });
    assert.equal(removed.status, 200);
  });

  it('never ends up with more places in a map than a request may name', async () => {
    const full = Object.fromEntries(Array.from({ length: 200 }, () => [`__${hex(new ObjectId())}`, ['x']]));
    const id = await seed({ printStations: full });
    const reply = failure(await call(sa(), 'PATCH', one(id), { printStations: { [hex(own())]: ['st-1'] } }, { 'if-match': tag(await call(sa(), 'GET', one(id))) }));
    assert.deepEqual(reply.details, [{ field: 'printStations', issue: 'tooMany' }]);
    // Taking one away and adding one is fine.
    const first = Object.keys(full)[0]!.slice(2);
    assert.equal((await call(sa(), 'PATCH', one(id), { printStations: { [first]: null, [hex(own())]: ['st-1'] } }, { 'if-match': tag(await call(sa(), 'GET', one(id))) })).status, 200);
  });
});

describe('categories: what the log and the address keep', () => {
  it('accepts only https for the external address and keeps its query string out of the activity log', async () => {
    for (const url of ['http://example.test/a.png', 'ftp://example.test/a', 'https://' + 'a'.repeat(2050)]) {
      assert.equal(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, externalUrl: url })).status, 422, url.slice(0, 20));
    }
    const mark = world.office.activity.entries.length;
    const created = await create({ externalUrl: 'https://example.test/a.png?token=secret123#frag' });
    assert.equal(created.body.data.externalUrl, 'https://example.test/a.png?token=secret123#frag');
    const entry = log('productCategory.created', mark)[0]!;
    assert.ok(JSON.stringify(entry).includes('https://example.test/a.png'));
    assert.ok(!JSON.stringify(entry).includes('secret123'));
  });
});

describe('categories: the limit of the group, with requests that run together', () => {
  it('never leaves the group over 2000 categories', async () => {
    await db.categories.deleteMany({});
    await db.categories.insertMany(Array.from({ length: 1998 }, () => legacyCategory({ name: { it: 'x' } })));
    const replies = await Promise.all(Array.from({ length: 4 }, (_, index) => call(sa(), 'POST', base(), { name: { it: `c${String(index)}` } })));
    const statuses = replies.map((reply) => reply.status);
    assert.ok(statuses.every((status) => status === 201 || status === 409), statuses.join());
    const total = await db.categories.countDocuments();
    assert.ok(total <= 2000, String(total));
    assert.equal(total, 1998 + statuses.filter((status) => status === 201).length);
    await db.categories.deleteMany({});
  });
});

describe('categories: the hidden parent and the hidden references of a caller with a perimeter', () => {
  const place = (id: ObjectId) => ({ id, position: null, productionCenterId: null });

  it('changes nothing when he sends null for a hidden parent, refuses the hidden parent itself, and lets the others detach it', async () => {
    await db.categories.deleteMany({});
    const top = await seed({ name: { it: 'Alta' }, placesAvailability: [place(other())] });
    const mid = await seed({ name: { it: 'Media' }, parentId: top, placesAvailability: [place(own())] });
    const version = tag(await call(pa(), 'GET', one(mid)));
    const same = await call(pa(), 'PATCH', one(mid), { parentId: null }, { 'if-match': version });
    assert.equal(same.status, 200);
    assert.equal(tag(same), version);
    assert.deepEqual((await stored(mid))!['parentId'], top);
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(mid), { parentId: hex(top) }, { 'if-match': version })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await call(pa(), 'PATCH', one(mid), { parentId: hex(new ObjectId()) }, { 'if-match': version })).details, [{ field: 'parentId', issue: 'incorrect' }]);
    // A root stays a root for him, and he can choose a parent he reaches.
    const visible = await seed({ name: { it: 'Visibile' }, placesAvailability: [] });
    assert.equal((await call(pa(), 'PATCH', one(mid), { parentId: hex(visible) }, { 'if-match': version })).status, 200);
    assert.deepEqual((await stored(mid))!['parentId'], visible);
    const root = await call(pa(), 'GET', one(mid));
    assert.equal(tag(await call(pa(), 'PATCH', one(mid), { parentId: hex(visible) }, { 'if-match': tag(root) })), tag(root));
    // The administrator of the group detaches it for good.
    await db.categories.updateOne({ _id: mid }, { $set: { parentId: top } });
    assert.equal((await call(sa(), 'PATCH', one(mid), { parentId: null }, { 'if-match': tag(await call(sa(), 'GET', one(mid))) })).status, 200);
    assert.equal((await stored(mid))!['parentId'], null);
    await db.categories.deleteMany({});
  });

  it('tells the parent, the depth, the filter and the tree from the view of the caller, also through a cycle of the legacy that crosses a category he does not reach', async () => {
    await db.categories.deleteMany({});
    const a = new ObjectId('000000000000000000000001');
    const b = new ObjectId('000000000000000000000002');
    const h = new ObjectId('000000000000000000000003');
    await db.categories.insertMany([
      legacyCategory({ _id: a, parentId: b, name: { it: 'A' }, placesAvailability: [place(own())] }),
      legacyCategory({ _id: b, parentId: h, name: { it: 'B' }, placesAvailability: [place(own())] }),
      legacyCategory({ _id: h, parentId: a, name: { it: 'H' }, placesAvailability: [place(other())] }),
    ]);
    const list = (await call(pa(), 'GET', base())).body.data as Array<{ id: string; parentId: string | null; parentHidden: boolean; depth: number }>;
    const byId = Object.fromEntries(list.map((item) => [item.id, item]));
    assert.deepEqual([byId[hex(a)]!.parentId, byId[hex(a)]!.depth, byId[hex(b)]!.parentId, byId[hex(b)]!.parentHidden, byId[hex(b)]!.depth], [hex(b), 1, null, true, 0]);
    assert.deepEqual((await call(pa(), 'GET', `${base()}?parentId=${hex(b)}`)).body.data.map((item: { id: string }) => item.id), [hex(a)]);
    const tree = (await call(pa(), 'GET', `${base()}/tree`)).body.data as Array<{ id: string; children: Array<{ id: string; parentId: string }> }>;
    assert.deepEqual(tree.map((node) => [node.id, node.children.map((child) => [child.id, child.parentId])]), [[hex(b), [[hex(a), hex(b)]]]]);
    await db.categories.deleteMany({});
  });

  it('shows and records only the categories of modifiers he reaches, and keeps the others when he changes the list', async () => {
    await db.categories.deleteMany({});
    const reachable = await seed({ name: { it: 'Raggiungibile' }, placesAvailability: [] });
    const reachable2 = await seed({ name: { it: 'Altra' }, placesAvailability: [place(own())] });
    const hidden = await seed({ name: { it: 'Nascosta' }, placesAvailability: [place(other())] });
    const mine = await seed({ placesAvailability: [place(own())], variantsCategories: [reachable, hidden] });
    const read = await call(pa(), 'GET', one(mine));
    assert.deepEqual(read.body.data.modifierCategoryIds, [hex(reachable)]);
    assert.deepEqual((await call(sa(), 'GET', one(mine))).body.data.modifierCategoryIds, [hex(reachable), hex(hidden)]);
    // Sending what he is shown changes nothing; a different list applies to the categories he reaches and leaves the other.
    assert.equal(tag(await call(pa(), 'PATCH', one(mine), { modifierCategoryIds: [hex(reachable)] }, { 'if-match': tag(read) })), tag(read));
    const mark = world.office.activity.entries.length;
    const changed = await call(pa(), 'PATCH', one(mine), { modifierCategoryIds: [hex(reachable2)] }, { 'if-match': tag(read) });
    assert.deepEqual(changed.body.data.modifierCategoryIds, [hex(reachable2)]);
    assert.deepEqual((await stored(mine))!['variantsCategories'], [reachable2, hidden]);
    assert.ok(!JSON.stringify(log('productCategory.updated', mark)[0]).includes(hex(hidden)));
    await db.categories.deleteMany({});
  });

  it('does not ask again about the place of a key the map already has, and refuses only a map that grows over the limit', async () => {
    const gone = hex(new ObjectId());
    const id = await seed({ printStations: { [`__${gone}`]: ['x'], [`__${hex(own())}`]: ['st-1'] } });
    let version = tag(await call(sa(), 'GET', one(id)));
    const same = await call(sa(), 'PATCH', one(id), { printStations: { [gone]: ['x'] } }, { 'if-match': version });
    assert.equal(tag(same), version);
    const emptied = await call(sa(), 'PATCH', one(id), { printStations: { [gone]: [] } }, { 'if-match': version });
    assert.equal(emptied.status, 200);
    version = tag(emptied);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { printStations: { [gone]: ['y'] } }, { 'if-match': version })).details, [{ field: `printStations.${gone}.0`, issue: 'incorrect' }]);
    // A map the legacy left over the limit can still be changed and shrunk, not grown.
    const over = Object.fromEntries(Array.from({ length: 201 }, () => [`__${hex(new ObjectId())}`, ['x']]));
    const crowded = await seed({ printStations: { ...over, [`__${hex(own())}`]: ['st-1'] } });
    const crowdedTag = tag(await call(sa(), 'GET', one(crowded)));
    assert.equal((await call(sa(), 'PATCH', one(crowded), { printStations: { [hex(own())]: ['st-1', 'st-2'] } }, { 'if-match': crowdedTag })).status, 200);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(crowded), { printStations: { [hex(other())]: ['st-9'] } }, { 'if-match': tag(await call(sa(), 'GET', one(crowded))) })).details, [{ field: 'printStations', issue: 'tooMany' }]);
    assert.equal((await call(sa(), 'PATCH', one(crowded), { printStations: { [Object.keys(over)[0]!.slice(2)]: null } }, { 'if-match': tag(await call(sa(), 'GET', one(crowded))) })).status, 200);
  });
});

describe('lookup/products with the modifier parameter', () => {
  it('lists only the variant products, or only the others, and combines with q, ids, type and the cursor', async () => {
    await db.products.deleteMany({});
    const make = (name: string, variant: unknown, extra: Document = {}) => legacyProduct({ name: { it: name }, type: 'product', variant, ...extra });
    const [red, blue, plainP, loose, truthy, text, trashed, service] = [
      make('Rossa', { status: true }),
      make('Blu', { status: true }),
      make('Semplice', { status: false }),
      make('Senza variante', undefined),
      make('Truthy', { status: 1 }),
      make('Testo', { status: 'true' }),
      make('Cestinata', { status: true }, { trash: true }),
      make('Servizio', { status: true }, { type: 'service' }),
    ];
    await db.products.insertMany([red, blue, plainP, loose, truthy, text, trashed, service]);
    const url = `/groups/${hex(gid())}/lookup/products`;
    const names = async (query: string) => ((await call(sa(), 'GET', `${url}${query}`)).body.data as Array<{ name: string }>).map((item) => item.name);
    assert.deepEqual(await names(''), ['Blu', 'Rossa', 'Semplice', 'Senza variante', 'Servizio', 'Testo', 'Truthy']);
    assert.deepEqual(await names('?modifier=true'), ['Blu', 'Rossa', 'Servizio']);
    assert.deepEqual(await names('?modifier=false'), ['Semplice', 'Senza variante', 'Testo', 'Truthy']);
    assert.deepEqual(await names('?modifier=true&q=ROS'), ['Rossa']);
    assert.deepEqual(await names('?modifier=true&type=service'), ['Servizio']);
    assert.deepEqual(await names(`?modifier=true&ids=${hex(red['_id'] as ObjectId)},${hex(plainP['_id'] as ObjectId)},${hex(trashed['_id'] as ObjectId)}`), ['Rossa']);
    assert.deepEqual(await names(`?modifier=false&ids=${hex(red['_id'] as ObjectId)},${hex(plainP['_id'] as ObjectId)}`), ['Semplice']);
    const page = await call(sa(), 'GET', `${url}?modifier=true&limit=2`);
    assert.deepEqual(page.body.data.map((item: { name: string }) => item.name), ['Blu', 'Rossa']);
    assert.deepEqual(await names(`?modifier=true&limit=2&cursor=${page.body.page.next as string}`), ['Servizio']);
    assert.deepEqual(Object.keys(page.body.data[0]).sort(), ['id', 'name', 'type']);
    for (const bad of ['yes', '1', '', 'TRUE']) {
      assert.equal(failure(await call(sa(), 'GET', `${url}?modifier=${bad}`)).status, 422, bad);
    }
    assert.equal(failure(await call(sa(), 'GET', `${url}?modifier=true&modifier=false`)).status, 422);
    await db.products.deleteMany({});
  });
});
