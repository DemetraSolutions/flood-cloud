import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { LEGACY_DATE, catalogCollections, legacyAttributeGroup, legacyProduct } from '../helpers/product-catalog.ts';
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
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/product-attribute-groups`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);

async function create(body: Document = {}, actor = sa()) {
  const reply = await call(actor, 'POST', base(), { name: { it: 'Colori' }, ...body });
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

describe('groups of attributes: access', () => {
  it('needs no feature; only the platform, dealer and group administrators write, the company and place administrators read; nobody reaches another group', async () => {
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, sa()]) {
      const created = await create({}, actor);
      assert.equal(created.body.data.editable, true);
      assert.equal((await call(actor, 'GET', one(created.body.data.id))).status, 200);
      assert.equal((await call(actor, 'DELETE', one(created.body.data.id))).status, 204);
    }
    const shared = await create({ attributes: [{ name: { it: 'Uno' } }] });
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(failure(await call(actor, 'POST', base(), { name: { it: 'x' } })), { status: 403, code: 'FORBIDDEN', details: undefined });
      assert.equal(failure(await call(actor, 'PATCH', one(shared.body.data.id), { name: { it: 'y' } }, { 'if-match': tag(shared) })).status, 403);
      assert.equal(failure(await call(actor, 'DELETE', one(shared.body.data.id))).status, 403);
      const read = await call(actor, 'GET', one(shared.body.data.id));
      assert.deepEqual([read.status, read.body.data.editable], [200, false]);
      assert.equal((await call(actor, 'GET', base())).status, 200);
    }
    assert.equal(await db.attributes.countDocuments({ _id: new ObjectId(shared.body.data.id as string) }), 1);
    const blind = await addUser(ctx, world.office, { permissions: { status: true, products: { r: false, w: false } } });
    assert.equal(failure(await call(blind.id, 'GET', base())).status, 403);
    const reader = await addUser(ctx, world.office, { permissions: { status: true, products: { r: true, w: false } } });
    const created = await create();
    assert.equal((await call(reader.id, 'GET', base())).status, 200);
    assert.equal(failure(await call(reader.id, 'POST', base(), { name: { it: 'x' } })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(created.body.data.id), { name: { it: 'y' } }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'DELETE', one(created.body.data.id))).status, 403);
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
  });
});

describe('groups of attributes: creation', () => {
  it('creates a group with attributes whose ids the server makes, in the legacy shape, with 201, Location and ETag, and records it', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { name: { it: '  Taglie  ' }, attributes: [{ name: { it: 'S' } }, { name: { it: 'M' } }] };
    const first = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    const [s, m] = first.body.data.attributes as Array<{ id: string; name: Record<string, string> }>;
    assert.match(s!.id, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(s!.id, m!.id);
    assert.deepEqual(first.body.data, { id: first.body.data.id, name: { it: 'Taglie' }, editable: true, attributes: [{ id: s!.id, name: { it: 'S' } }, { id: m!.id, name: { it: 'M' } }], createdAt: first.body.data.createdAt, updatedAt: first.body.data.updatedAt });
    const document = (await db.attributes.findOne({ _id: new ObjectId(first.body.data.id as string) }))!;
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'attributes', 'insertDate', 'name', 'updateDate']);
    assert.deepEqual(document['attributes'], [{ id: s!.id, name: { it: 'S' } }, { id: m!.id, name: { it: 'M' } }]);
    assert.equal(log('productAttributeGroup.created', mark).length, 1);
    const replay = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(await db.attributes.countDocuments({ _id: new ObjectId(first.body.data.id as string) }), 1);
    const empty = await create({ name: { it: 'Vuoto' } });
    assert.deepEqual(empty.body.data.attributes, []);
  });

  it('validates by allowlist: the client never chooses an id, names are bounded, at most 200 attributes', async () => {
    const post = (body: Document) => call(sa(), 'POST', base(), body);
    assert.deepEqual(failure(await post({})).details, [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: [{ id: 'mine', name: { it: 'y' } }] })).details, [{ field: 'attributes.0.id', issue: 'unknown' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: [{ name: {} }] })).details, [{ field: 'attributes.0.name', issue: 'required' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: [{ name: { it: '' } }] })).details, [{ field: 'attributes.0.name.it', issue: 'minLength' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: [{ name: { it: 'y'.repeat(151) } }] })).details, [{ field: 'attributes.0.name.it', issue: 'maxLength' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: Array.from({ length: 201 }, () => ({ name: { it: 'y' } })) })).details, [{ field: 'attributes', issue: 'tooMany' }]);
    assert.equal((await post({ name: { it: 'x' }, attributes: Array.from({ length: 200 }, () => ({ name: { it: 'y' } })) })).status, 201);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, extra: 1 })).details, [{ field: 'extra', issue: 'unknown' }]);
    assert.deepEqual(failure(await post({ name: { en: 'x' } })).details, [
      { field: 'name.en', issue: 'incorrect' },
      { field: 'name.it', issue: 'required' },
    ]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, attributes: [{ name: { de: 'y' } }] })), issues(['attributes.0.name.de', 'incorrect']));
    assert.equal(failure(await call(sa(), 'POST', base(), { name: { it: 'x' }, attributes: [{ name: { it: 'a'.repeat(70_000) } }] })).status, 413);
  });
});

describe('groups of attributes: reads', () => {
  it('lists in pages sorted by name, searches the name as literal text, and reads a group the legacy created without insertDate or with dirty shapes', async () => {
    await db.attributes.deleteMany({});
    const legacy = legacyAttributeGroup({ name: { it: 'Colore' } });
    await db.attributes.insertMany([
      legacy,
      legacyAttributeGroup({ name: { it: 'Zona (nord)' }, attributes: [null, 5, { name: { it: 'senza id' } }, { id: 7 }, { id: 'ok', name: 'testo', extra: true }] }),
      legacyAttributeGroup({ name: { en: 'Only english' }, attributes: undefined }),
      { _id: new ObjectId(), name: 'text', attributes: 'none' },
    ]);
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: Record<string, string> }) => Object.values(item.name)[0] ?? null);
    assert.deepEqual(names(await call(sa(), 'GET', base())), [null, 'Colore', 'Only english', 'Zona (nord)']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?sort=-name&limit=3`)), ['Zona (nord)', 'Only english', 'Colore']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('(nord)')}`)), ['Zona (nord)']);
    assert.deepEqual(names(await call(sa(), 'GET', `${base()}?q=${encodeURIComponent('.*')}`)), []);
    const seen: Array<string | null> = [];
    let url = `${base()}?limit=1`;
    for (let page = 0; page < 6; page += 1) {
      const next = await call(sa(), 'GET', url);
      seen.push(...names(next));
      if (next.body.page.next === null) {
        break;
      }
      url = `${base()}?limit=1&cursor=${next.body.page.next as string}`;
    }
    assert.deepEqual(seen, [null, 'Colore', 'Only english', 'Zona (nord)']);
    const read = await call(sa(), 'GET', one(legacy['_id'] as ObjectId));
    assert.deepEqual(read.body.data, { id: hex(legacy['_id'] as ObjectId), name: { it: 'Colore' }, editable: true, attributes: [{ id: 'attr-1', name: { it: 'Rosso' } }, { id: 'attr-2', name: { it: 'Blu' } }], createdAt: null, updatedAt: LEGACY_DATE.toISOString() });
    const dirty = (await call(sa(), 'GET', `${base()}?q=zona`)).body.data[0];
    assert.deepEqual(dirty.attributes, [{ id: 'ok', name: {} }]);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=101`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?enabled=true`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', one(hex(new ObjectId())))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('nope'))).status, 422);
    await db.attributes.deleteMany({});
  });
});

describe('groups of attributes: modification', () => {
  it('replaces the list: known ids are updated, no id is new, the missing ones are deleted; the name merges by language', async () => {
    const created = await create({ name: { it: 'Colori' }, attributes: [{ name: { it: 'Rosso' } }, { name: { it: 'Blu' } }, { name: { it: 'Verde' } }] });
    const id = created.body.data.id as string;
    const [red, blue, green] = created.body.data.attributes as Array<{ id: string }>;
    await db.attributes.updateOne({ _id: new ObjectId(id) }, { $set: { 'attributes.0.legacyKey': 'keep' } });
    const current = await call(sa(), 'GET', one(id));
    const mark = world.office.activity.entries.length;
    const changed = await call(sa(), 'PATCH', one(id), { attributes: [{ id: blue!.id, name: { it: 'Azzurro' } }, { id: red!.id, name: { it: 'Rosso' } }, { name: { it: 'Giallo' } }] }, { 'if-match': tag(current) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const attributes = changed.body.data.attributes as Array<{ id: string; name: Record<string, string> }>;
    assert.deepEqual(attributes.map((attribute) => attribute.name.it), ['Azzurro', 'Rosso', 'Giallo']);
    assert.deepEqual([attributes[0]!.id, attributes[1]!.id], [blue!.id, red!.id]);
    assert.ok(attributes[2]!.id !== green!.id && /^[A-Za-z0-9_-]{22}$/.test(attributes[2]!.id));
    const document = (await db.attributes.findOne({ _id: new ObjectId(id) }))!;
    // An attribute whose name does not change is kept as stored, with the keys the backend does not manage.
    assert.deepEqual((document['attributes'] as Document[])[1], { id: red!.id, name: { it: 'Rosso' }, legacyKey: 'keep' });
    assert.equal(log('productAttributeGroup.updated', mark).length, 1);
    const renamed = await call(sa(), 'PATCH', one(id), { name: { it: 'Tinte' } }, { 'if-match': tag(changed) });
    assert.deepEqual(renamed.body.data.name, { it: 'Tinte' });
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: null } }, { 'if-match': tag(renamed) })), issues(['name.it', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { en: 'x' } }, { 'if-match': tag(renamed) })), issues(['name.en', 'incorrect']));
  });

  it('writes nothing for a request that changes nothing, and refuses an empty body, a missing, malformed or stale If-Match', async () => {
    const created = await create({ attributes: [{ name: { it: 'Uno' } }] });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const same = await call(sa(), 'PATCH', one(id), { name: { it: 'Colori' }, attributes: created.body.data.attributes }, { 'if-match': tag(created) });
    assert.equal(tag(same), tag(created));
    assert.equal(world.office.activity.entries.length, mark);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), {}, { 'if-match': tag(created) })).details, [{ field: '(body)', issue: 'required' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: 'x' } })), issues(['If-Match', 'required']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: { it: 'x' } }, { 'if-match': 'abc' })), issues(['If-Match', 'format']));
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { name: { it: 'x' } }, { 'if-match': `"${'a'.repeat(43)}"` })).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(hex(new ObjectId())), { name: { it: 'x' } }, { 'if-match': tag(created) })).status, 404);
    const [uno] = created.body.data.attributes as Array<{ id: string }>;
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { attributes: [{ id: 'unknown', name: { it: 'x' } }] }, { 'if-match': tag(created) })), issues(['attributes.0.id', 'incorrect']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { attributes: [{ id: uno!.id, name: { it: 'x' } }, { id: uno!.id, name: { it: 'y' } }] }, { 'if-match': tag(created) })), issues(['attributes.1.id', 'incorrect']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { attributes: [{ id: '$ne', name: { it: 'x' } }] }, { 'if-match': tag(created) })).details, [{ field: 'attributes.0.id', issue: 'pattern' }]);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { attributes: [{ name: { de: 'x' } }] }, { 'if-match': tag(created) })), issues(['attributes.0.name.de', 'incorrect']));
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { attributes: [{ id: uno!.id, name: { de: 'x' } }] }, { 'if-match': tag(created) })), issues(['attributes.0.name.de', 'incorrect']));
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { attributes: Array.from({ length: 201 }, () => ({ name: { it: 'y' } })) }, { 'if-match': tag(created) })).status, 422);
    await db.attributes.updateOne({ _id: new ObjectId(id) }, { $set: { name: { it: 'Cambiato dal legacy' } } });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { name: { it: 'x' } }, { 'if-match': tag(created) })).status, 412);
  });

  it('works on a group the legacy upserted without insertDate, with a name that is not texts and attributes that are not a list', async () => {
    const legacy = new ObjectId();
    await db.attributes.insertOne({ _id: legacy, name: 'solo testo', attributes: 'none' });
    const current = await call(sa(), 'GET', one(legacy));
    const changed = await call(sa(), 'PATCH', one(legacy), { name: { it: 'Ora a lingue' }, attributes: [{ name: { it: 'Nuovo' } }] }, { 'if-match': tag(current) });
    assert.equal(changed.status, 200);
    assert.ok((await db.attributes.findOne({ _id: legacy }))!['updateDate'] instanceof Date);
    assert.equal((await db.attributes.findOne({ _id: legacy }))!['insertDate'], undefined);
    // Elements without an id are not shown and not addressable: a replacement of the list keeps them, at the end, as they are.
    const mixed = new ObjectId();
    await db.attributes.insertOne({ _id: mixed, name: { it: 'Misto' }, attributes: [null, { name: { it: 'senza id' } }, { id: 'ok', name: { it: 'Uno' } }] });
    const mixedTag = tag(await call(sa(), 'GET', one(mixed)));
    const kept = await call(sa(), 'PATCH', one(mixed), { attributes: [{ id: 'ok', name: { it: 'Uno' } }] }, { 'if-match': mixedTag });
    assert.deepEqual(kept.body.data.attributes, [{ id: 'ok', name: { it: 'Uno' } }]);
    assert.deepEqual((await db.attributes.findOne({ _id: mixed }))!['attributes'], [{ id: 'ok', name: { it: 'Uno' } }, null, { name: { it: 'senza id' } }]);
  });

  it('refuses to remove an attribute that a product that is not in the trash uses, listing the products', async () => {
    const created = await create({ attributes: [{ name: { it: 'Usato' } }, { name: { it: 'Libero' } }] });
    const id = created.body.data.id as string;
    const [used, free] = created.body.data.attributes as Array<{ id: string }>;
    const users = [legacyProduct({ attributes: [used!.id, 'other'] }), legacyProduct({ attributes: [used!.id] })];
    await db.products.insertMany([...users, legacyProduct({ attributes: [used!.id], trash: true }), legacyProduct({ attributes: [free!.id], trash: true })]);
    const refused = failure(await call(sa(), 'PATCH', one(id), { attributes: [{ id: free!.id, name: { it: 'Libero' } }] }, { 'if-match': tag(created) }));
    assert.equal(refused.status, 409);
    assert.deepEqual((refused.details as Array<{ field: string }>).map((detail) => detail.field).sort(), users.map((product) => `products.${hex(product['_id'] as ObjectId)}`).sort());
    assert.equal((await call(sa(), 'GET', one(id))).body.data.attributes.length, 2);
    // Removing the one nobody has is fine, and so is renaming the one in use.
    const removed = await call(sa(), 'PATCH', one(id), { attributes: [{ id: used!.id, name: { it: 'Rinominato' } }] }, { 'if-match': tag(created) });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.data.attributes, [{ id: used!.id, name: { it: 'Rinominato' } }]);
  });
});

describe('groups of attributes: deletion', () => {
  it('deletes a group for good with 204 and records it', async () => {
    const created = await create({ attributes: [{ name: { it: 'A' } }] });
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'DELETE', one(created.body.data.id))).status, 204);
    assert.equal(await db.attributes.countDocuments({ _id: new ObjectId(created.body.data.id as string) }), 0);
    assert.equal(log('productAttributeGroup.deleted', mark).length, 1);
    assert.equal(failure(await call(sa(), 'DELETE', one(created.body.data.id))).status, 404);
    const empty = await create({});
    assert.equal((await call(sa(), 'DELETE', one(empty.body.data.id))).status, 204);
  });

  it('refuses with 409 and the products when a product that is not in the trash uses an attribute of the group', async () => {
    const created = await create({ attributes: [{ name: { it: 'A' } }, { name: { it: 'B' } }] });
    const [a, b] = created.body.data.attributes as Array<{ id: string }>;
    const users = [legacyProduct({ attributes: [b!.id] })];
    await db.products.insertMany([...users, legacyProduct({ attributes: [a!.id], trash: true })]);
    const refused = failure(await call(sa(), 'DELETE', one(created.body.data.id)));
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.details, [{ field: `products.${hex(users[0]!['_id'] as ObjectId)}`, issue: 'referenced' }]);
    assert.equal(await db.attributes.countDocuments({ _id: new ObjectId(created.body.data.id as string) }), 1);
    await db.products.updateMany({ attributes: b!.id }, { $set: { trash: true } });
    assert.equal((await call(sa(), 'DELETE', one(created.body.data.id))).status, 204);
  });
});
