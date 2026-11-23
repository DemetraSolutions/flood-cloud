import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { catalogCollections, legacyBrand, legacyProduct, seedImage } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
let db: CatalogCollections;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/product-brands`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);

async function create(body: Document = {}, actor = sa()) {
  const reply = await call(actor, 'POST', base(), { name: { it: 'Marca' }, ...body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  db = catalogCollections(ctx, world);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('brands', () => {
  it('needs no feature of the group, and keeps the brands of the groups apart', async () => {
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.cash': false } });
    const created = await call(world.group(1).sa, 'POST', base(1), { name: { it: 'Altro gruppo' } });
    assert.equal(created.status, 201);
    assert.equal(failure(await call(sa(), 'GET', one(created.body.data.id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 0))).status, 404);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
  });

  it('creates a brand in the legacy shape and answers 201 with Location and ETag, replays a retry and records it', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const first = await call(sa(), 'POST', base(), { name: { it: '  Acme  ' }, description: { it: 'Una marca' }, placeIds: [hex(world.group(0).ownPlaceId)], enabled: false }, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.deepEqual(first.body.data, {
      id: first.body.data.id,
      name: { it: 'Acme' },
      description: { it: 'Una marca' },
      enabled: false,
      placeIds: [hex(world.group(0).ownPlaceId)],
      editable: true,
      createdAt: first.body.data.createdAt,
      updatedAt: first.body.data.updatedAt,
    });
    const document = (await db.brands.findOne({ _id: new ObjectId(first.body.data.id as string) }))!;
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'description', 'insertDate', 'medias', 'name', 'placesAvailability', 'status', 'updateDate']);
    assert.equal(document['status'], false);
    assert.deepEqual(log('productBrand.created', mark).map((entry) => entry.resource), [{ type: 'productBrand', id: first.body.data.id }]);
    assert.equal((await call(sa(), 'POST', base(), { name: { it: '  Acme  ' }, description: { it: 'Una marca' }, placeIds: [hex(world.group(0).ownPlaceId)], enabled: false }, { 'idempotency-key': key })).body.data.id, first.body.data.id);
    // The three switches the old form showed and never saved do not exist.
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, featured: true, ecommerce: true, cash: true })).details, [
      { field: 'featured', issue: 'unknown' },
      { field: 'ecommerce', issue: 'unknown' },
      { field: 'cash', issue: 'unknown' },
    ]);
    assert.deepEqual(failure(await call(sa(), 'POST', base(), {})).details, [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, code: 1 })).details, [{ field: 'code', issue: 'unknown' }]);
  });

  it('reads, lists with literal search and cursors, patches with If-Match, and writes nothing for a request that changes nothing', async () => {
    await db.brands.deleteMany({});
    await db.brands.insertMany([legacyBrand({ name: { it: 'Zeta' } }), legacyBrand({ name: { it: 'Alfa' }, status: false }), legacyBrand({ name: { en: 'Beta' }, placesAvailability: undefined, medias: undefined }), { _id: new ObjectId() }]);
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: Record<string, string> }) => Object.values(item.name)[0] ?? null);
    assert.deepEqual(names(await call(sa(), 'GET', base())), [null, 'Alfa', 'Beta', 'Zeta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?sort=-name&limit=2`)), ['Zeta', 'Beta']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('.*')}`)), []);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?enabled=false`)), [null, 'Alfa']);
    const created = await create({ name: { it: 'Da cambiare' } });
    const id = created.body.data.id as string;
    assert.equal(tag(await call(sa(), 'GET', one(id))), tag(created));
    const mark = world.office.activity.entries.length;
    const same = await call(sa(), 'PATCH', one(id), { name: { it: 'Da cambiare' }, enabled: true, placeIds: [], description: { it: '' } }, { 'if-match': tag(created) });
    assert.equal(tag(same), tag(created));
    assert.equal(world.office.activity.entries.length, mark);
    const changed = await call(sa(), 'PATCH', one(id), { name: { it: 'Cambiata' }, enabled: false }, { 'if-match': tag(created) });
    assert.deepEqual([changed.body.data.name, changed.body.data.enabled], [{ it: 'Cambiata' }, false]);
    assert.equal(log('productBrand.updated', mark).length, 1);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { enabled: true }, { 'if-match': tag(created) })).status, 412);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { enabled: true })), issues(['If-Match', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), {}, { 'if-match': tag(changed) })).details, [{ field: '(body)', issue: 'required' }]);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
  });

  it('refuses to delete a brand some product has, listing the products that are not in the trash, and deletes any other', async () => {
    const used = await create({ name: { it: 'Usata' } });
    const id = new ObjectId(used.body.data.id as string);
    const users = [legacyProduct({ brandId: id }), legacyProduct({ brandId: hex(id) })];
    await db.products.insertMany([...users, legacyProduct({ brandId: id, trash: true }), legacyProduct({ brandId: new ObjectId() })]);
    const refused = failure(await call(sa(), 'DELETE', one(id)));
    assert.equal(refused.status, 409);
    assert.deepEqual((refused.details as Array<{ field: string }>).map((detail) => detail.field).sort(), users.map((product) => `products.${hex(product['_id'] as ObjectId)}`).sort());
    assert.equal(await db.brands.countDocuments({ _id: id }), 1);
    await db.products.updateMany({ brandId: { $in: [id, hex(id)] } }, { $set: { trash: true } });
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
    assert.equal(log('productBrand.deleted', mark).length, 1);
    assert.equal(failure(await call(sa(), 'DELETE', one(id))).status, 404);
  });

  it('gives the company and place administrators the same perimeter as the departments', async () => {
    const mine = await db.brands.insertOne(legacyBrand({ name: { it: 'Mia' }, placesAvailability: [world.group(0).ownPlaceId] }));
    const elsewhere = await db.brands.insertOne(legacyBrand({ name: { it: 'Altrove' }, placesAvailability: [world.group(0).otherPlaceId] }));
    assert.equal((await call(ca(), 'GET', one(mine.insertedId))).status, 200);
    assert.equal(failure(await call(pa(), 'GET', one(elsewhere.insertedId))).status, 404);
    assert.deepEqual(failure(await call(pa(), 'POST', base(), { name: { it: 'x' } })).details, [{ field: 'placeIds', issue: 'notAllowed' }]);
    const created = await call(pa(), 'POST', base(), { name: { it: 'Del PA' }, placeIds: [hex(world.group(0).ownPlaceId)] });
    assert.equal(created.status, 201);
    assert.equal((await call(pa(), 'DELETE', one(created.body.data.id))).status, 204);
    assert.equal(failure(await call(ca(), 'DELETE', one(elsewhere.insertedId))).status, 404);
    // Shared with a place that is not his, or for every place: he reads it, he does not change or delete it.
    const shared = await db.brands.insertOne(legacyBrand({ name: { it: 'Condivisa' }, placesAvailability: [world.group(0).ownPlaceId, world.group(0).otherPlaceId] }));
    const everywhere = await db.brands.insertOne(legacyBrand({ name: { it: 'Per tutti' }, placesAvailability: [] }));
    for (const actor of [ca, pa]) {
      for (const id of [shared.insertedId, everywhere.insertedId]) {
        const read = await call(actor(), 'GET', one(id));
        assert.deepEqual([read.status, read.body.data.editable], [200, false]);
        assert.equal(failure(await call(actor(), 'PATCH', one(id), { placeIds: [hex(world.group(0).ownPlaceId)] }, { 'if-match': tag(read) })).status, 403);
        assert.equal(failure(await call(actor(), 'DELETE', one(id))).status, 403);
      }
    }
    assert.deepEqual((await db.brands.findOne({ _id: everywhere.insertedId }))!['placesAvailability'], []);
  });

  it('takes the image of the library only in a group with the media feature', async () => {
    const image = await seedImage(db, world.group(0).groupId);
    assert.deepEqual(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, image: { imageId: hex(image) } })), issues(['image', 'notAllowed']));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': true } });
    const created = await create({ image: { imageId: hex(image) } });
    assert.equal(created.body.data.image._id, hex(image));
    const document = (await db.brands.findOne({ _id: new ObjectId(created.body.data.id as string) }))!;
    assert.equal((((document['medias'] as Document)['images'] as Document)['main'] as Document)['_id'], hex(image));
    assert.equal(tag(await call(sa(), 'PATCH', one(created.body.data.id), { image: { imageId: hex(image) } }, { 'if-match': tag(created) })), tag(created));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.media': false } });
    assert.ok(!('image' in (await call(sa(), 'GET', one(created.body.data.id))).body.data));
  });
});
