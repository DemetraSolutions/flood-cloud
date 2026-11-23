import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { catalogCollections, legacyBrand, legacyCategory, legacyDepartment } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, placeEntry } from '../helpers/products.ts';

/** The rule of the group with one place only: the entries for every place are wholly the property of whoever is limited to that place, in the backoffice as for the server of the store. */
let ctx: TestDatabases;
let world: PlacesWorld;
let db: CatalogCollections;
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const copies = () => ctx.databases.common().collection('places');
const base = (segment: string) => `/groups/${hex(gid())}/${segment}`;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const tagOf = (reply: { headers: Headers }) => reply.headers.get('etag')!;
const originals = () => ctx.databases.group(gid(), 'cluster0').collection('places');
const setTrash = (place: ObjectId, trash: boolean) => Promise.all([copies().updateOne({ _id: place }, { $set: { trash } }), originals().updateOne({ _id: place }, { $set: { trash } })]);
const soleOwner = () => setTrash(other(), true);
const twoPlaces = () => setTrash(other(), false);

const RESOURCES = [
  { name: 'products', segment: 'products', collection: () => db.products, seed: (overrides: Document) => legacyFullProduct(overrides), create: (): Document => ({ name: { it: 'Nuovo' } }), withPlace: (): Document => ({ places: [{ placeId: hex(own()) }] }), patch: { name: { it: 'Cambiato' } } },
  { name: 'categories', segment: 'product-categories', collection: () => db.categories, seed: (overrides: Document) => legacyCategory(overrides), create: (): Document => ({ name: { it: 'Nuova' } }), withPlace: (): Document => ({ places: [{ placeId: hex(own()) }] }), patch: { name: { it: 'Cambiata' } } },
  { name: 'departments', segment: 'product-departments', collection: () => db.departments, seed: (overrides: Document) => legacyDepartment({ code: 7, ...overrides }), create: (): Document => ({ name: { it: 'Nuovo' }, code: nextCode++, taxId: taxId }), withPlace: (): Document => ({ placeIds: [hex(own())] }), patch: { name: { it: 'Cambiato' } } },
  { name: 'brands', segment: 'product-brands', collection: () => db.brands, seed: (overrides: Document) => legacyBrand(overrides), create: (): Document => ({ name: { it: 'Nuova' } }), withPlace: (): Document => ({ placeIds: [hex(own())] }), patch: { name: { it: 'Cambiata' } } },
] as const;
let taxId = '';
let nextCode = 40;

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  db = catalogCollections(ctx, world);
  const group = (await ctx.databases.common().collection('groups').findOne({ _id: gid() }))!;
  taxId = (group['taxes'] as Document[])[0]!['id'] as string;
  await ctx.databases.common().collection('groups').updateOne({ _id: gid() }, { $set: { 'settings.cash': true } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await copies().updateMany({}, { $set: { trash: false } });
  await originals().updateMany({}, { $set: { trash: false } });
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({}), db.departments.deleteMany({}), db.brands.deleteMany({})]);
});

for (const resource of RESOURCES) {
  describe(`the group with one place: ${resource.name}`, () => {
    const seeded = async (overrides: Document = {}): Promise<string> => {
      const document = resource.seed(overrides);
      await resource.collection().insertOne(document);
      return hex(document['_id'] as ObjectId);
    };
    const read = (actor: ObjectId, id: string) => call(actor, 'GET', `${base(resource.segment)}/${id}`);
    const rename = async (actor: ObjectId, id: string) => call(actor, 'PATCH', `${base(resource.segment)}/${id}`, resource.patch, { 'if-match': tagOf(await read(actor, id)) });
    const make = (actor: ObjectId, extra: Document = {}) => call(actor, 'POST', base(resource.segment), { ...resource.create(), ...extra }, { 'idempotency-key': randomUUID() });

    it('keeps an entry for every place out of the hands of a company and a place administrator while the group has two', async () => {
      const everyone = await seeded();
      for (const actor of [world.group(0).ca, world.group(0).pa]) {
        assert.equal((await read(actor, everyone)).body.data.editable, false);
        assert.equal((await rename(actor, everyone)).status, 403);
        assert.equal((await make(actor)).status, 403, 'an entry for every place is not theirs to make');
        if (resource.name !== 'products') {
          assert.equal((await call(actor, 'DELETE', `${base(resource.segment)}/${everyone}`)).status, 403);
        }
      }
      assert.equal((await rename(world.group(0).sa, everyone)).status, 200);
    });

    it('makes it wholly theirs when the group has one place that is not in the trash, and takes it back on the next request', async () => {
      const everyone = await seeded();
      await soleOwner();
      for (const actor of [world.group(0).ca, world.group(0).pa]) {
        assert.equal((await read(actor, everyone)).body.data.editable, true, `${resource.name}: editable`);
        const renamed = await rename(actor, everyone);
        assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
        const made = await make(actor);
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.deepEqual(made.body.data[resource.name === 'products' || resource.name === 'categories' ? 'places' : 'placeIds'], []);
      }
      if (resource.name !== 'products') {
        const gone = await seeded();
        assert.equal((await call(world.group(0).pa, 'DELETE', `${base(resource.segment)}/${gone}`)).status, 204);
      }
      // An entry of the place of the other administrator stays as it was: for every place, so it is theirs; one of the trashed place is not visible to them.
      const elsewhere = await seeded(resource.name === 'departments' || resource.name === 'brands' ? { placesAvailability: [other()] } : { placesAvailability: [resource.name === 'products' ? placeEntry(other()) : { id: other(), position: 1, productionCenterId: null }] });
      assert.equal((await read(world.group(0).pa, elsewhere)).status, 404);
      // The creation of a second place takes effect at once.
      await twoPlaces();
      assert.equal((await read(world.group(0).pa, everyone)).body.data.editable, false);
      assert.equal((await rename(world.group(0).pa, everyone)).status, 403);
      assert.equal((await make(world.group(0).pa)).status, 403);
    });

    it('is the same for the roles that are not limited to places, and does not apply when the place left is not in the perimeter', async () => {
      const everyone = await seeded();
      for (const actor of [world.group(0).sa, world.office.cluster.psa]) {
        assert.equal((await read(actor, everyone)).body.data.editable, true);
      }
      await soleOwner();
      for (const actor of [world.group(0).sa, world.office.cluster.psa]) {
        assert.equal((await read(actor, everyone)).body.data.editable, true);
      }
      // The only place that is not in the trash is the one of the other company: the administrator of the first company and place gains nothing.
      await setTrash(other(), false);
      await setTrash(own(), true);
      assert.equal((await read(world.group(0).pa, everyone)).body.data.editable, false);
      assert.equal((await read(world.group(0).ca, everyone)).body.data.editable, false);
    });
  });
}
