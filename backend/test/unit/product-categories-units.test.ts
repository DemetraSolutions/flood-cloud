import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { PRODUCTS_CATEGORIES_OWNED_FIELDS, PRODUCTS_CATEGORIES_OWNED_TREES } from '../../src/db/collections.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { ClientContext } from '../../src/shared/http/client-context.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { entityVersion } from '../../src/modules/product-catalog/entity.service.ts';
import { modernPlaces, placesOf } from '../../src/modules/product-categories/categories.availability.ts';
import { applyChange, mediaWrites, storedNumber } from '../../src/modules/product-categories/categories.document.ts';
import { createEntityRepository } from '../../src/modules/product-catalog/entity.repository.ts';
import { createCategoriesService } from '../../src/modules/product-categories/categories.service.ts';
import { onCycle, shapeOf } from '../../src/modules/product-categories/categories.tree.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { legacyCategory } from '../helpers/product-catalog.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';

const groupId = fixtureId('group', 1);
const sa = principalOf('SA', { groupId });
const access = { groupId, clusterId: 'cluster0', crossGroup: false, features: { cash: true, media: true, ordering: true, productsVariants: true } } as unknown as GroupAccess;
const client: ClientContext = { requestId: 'r1', ip: '10.0.0.1', userAgent: null };
const key = Buffer.alloc(32, 7);
const hex = (id: ObjectId) => id.toHexString();
const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

describe('the tree of categories', () => {
  it('breaks a cycle at the smallest id even when it is entered from outside, and follows the stored parents', () => {
    const nodes = [
      { id: '0', parent: '3' },
      { id: '2', parent: '4' },
      { id: '3', parent: '4' },
      { id: '4', parent: '2' },
      { id: '9', parent: null },
    ];
    const shape = shapeOf(nodes);
    assert.deepEqual([...shape.cyclic], ['2']);
    assert.equal(shape.depthOf.get('0'), 3);
    assert.equal(shape.heightOf.get('2'), 3);
    assert.equal(onCycle(nodes, '2'), true);
    assert.equal(onCycle(nodes, '3'), false);
    assert.equal(onCycle(nodes, '9'), false);
    assert.equal(onCycle(nodes, 'unknown'), false);
  });
});

describe('the availability and the writes of the documents', () => {
  it('rewrites only the historical elements, reads anything else as it is', () => {
    const id = new ObjectId();
    assert.deepEqual(modernPlaces([id, 7]), [{ id, position: null, productionCenterId: null }, 7]);
    const stored = placesOf([id, { id, position: new Int32(2), productionCenterId: 'pc' }, { id: new ObjectId(), position: new Double(3) }]);
    assert.deepEqual([stored.entries.length, stored.historical, stored.anomalous], [2, true, false]);
  });

  it('writes whole numbers as Int32 and decimals as Double, and applies a change along its path without sharing the stored objects', () => {
    assert.ok(storedNumber(3) instanceof Int32 && storedNumber(3.5) instanceof Double);
    const stored = { a: { b: { c: 1 }, keep: 2 }, d: 4 };
    const next = applyChange(stored, { 'a.b.c': new Int32(9), 'x.y': new Double(1.5), z: [1] }, { d: '' });
    assert.deepEqual(next, { a: { b: { c: 9 }, keep: 2 }, x: { y: 1.5 }, z: [1] });
    assert.deepEqual(stored, { a: { b: { c: 1 }, keep: 2 }, d: 4 });
    assert.deepEqual(mediaWrites({ images: { main: {} } }, { icon: null, main: null }), { set: {}, unset: { 'medias.images.main': '' } });
    assert.deepEqual(mediaWrites(undefined, { icon: null }), { set: {}, unset: {} });
  });
});

/** The collaborators of the service that never reach a database; `nodes` is read once per call, in order. */
function fakes(
  stored: Document | null,
  options: { language?: string | null; update?: Array<'updated' | 'conflict'>; remove?: boolean; nodes?: Array<Array<{ id: string; parent: string | null }> | Error | null>; reachable?: string[]; treeDocuments?: Document[] } = {},
) {
  const logs = memoryLogger();
  const updates = [...(options.update ?? ['updated'])];
  const reads = [...(options.nodes ?? [[]])];
  const calls: Document[] = [];
  const removed: unknown[] = [];
  const repository = {
    list: async () => ({ items: [], page: { limit: 50, next: null } }),
    findById: async () => stored,
    insert: async () => undefined,
    update: async (_p: unknown, _a: unknown, _id: unknown, change: Document) => {
      calls.push(change);
      return updates.shift() ?? 'updated';
    },
    remove: async (_p: unknown, _a: unknown, removedId: unknown) => (removed.push(removedId), options.remove ?? true),
    nodes: async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    reachableIds: async () => new Set<string>(options.reachable ?? []),
    treeDocuments: async () => options.treeDocuments ?? [],
    subcategories: async () => [],
    modifierCategoryUsers: async () => [],
  };
  const service = createCategoriesService({
    repository,
    places: { setupOf: async () => new Map(), using: async () => [] },
    references: { missing: async () => [] },
    catalogs: { list: async () => [] },
    products: { inCategory: async () => [], withModifierCategory: async () => [], withBundleCategory: async () => [], notModifiers: async () => [] },
    images: { imageSource: async () => null },
    languages: { of: async () => ['it'] },
    users: { findById: async () => (options.language === null ? null : ({ user: { language: options.language ?? 'it' } } as never)) },
    activityLog: memoryActivityLog(),
    logger: logs.logger,
    versionKey: key,
    now: () => 5000,
  });
  return { service, logs, calls, removed };
}

describe('the service of the categories, with collaborators that fail in the ways a database can', () => {
  const stored = legacyCategory({ updateDate: new Date(1000) });
  const id = stored['_id'] as ObjectId;
  const version = entityVersion(stored, PRODUCTS_CATEGORIES_OWNED_FIELDS, key);

  it('answers 404 when the caller disappeared since the authentication', async () => {
    const { service } = fakes(stored, { language: null });
    await assert.rejects(service.list(sa, access, {}), reject('NOT_FOUND'));
    await assert.rejects(service.tree(sa, access), reject('NOT_FOUND'));
    await assert.rejects(service.create(sa, access, { name: { it: 'x' } }, client), reject('NOT_FOUND'));
    await assert.rejects(service.update(sa, access, id, version, { name: { it: 'y' } }, client), reject('NOT_FOUND'));
  });

  it('answers 409 when the category changed or was deleted while the request ran', async () => {
    await assert.rejects(fakes(stored, { update: ['conflict'] }).service.update(sa, access, id, version, { enabled: false }, client), reject('CONFLICT'));
    await assert.rejects(fakes(stored, { remove: false }).service.remove(sa, access, id, client), reject('CONFLICT'));
    await assert.rejects(fakes(null).service.get(sa, access, id), reject('NOT_FOUND'));
  });

  it('undoes a write that left a cycle behind, and says so in the log when it cannot', async () => {
    const parent = new ObjectId();
    const mine = id.toHexString();
    const before = [{ id: mine, parent: null }, { id: parent.toHexString(), parent: null }];
    const cycle = [{ id: mine, parent: parent.toHexString() }, { id: parent.toHexString(), parent: mine }];
    const done = fakes(stored, { nodes: [before, cycle] });
    await assert.rejects(done.service.update(sa, access, id, version, { parentId: parent.toHexString() }, client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.details![0]!.field === 'parentId');
    assert.equal(done.calls.length, 2);
    assert.deepEqual(done.calls[1]!['set'], { parentId: null });
    assert.deepEqual(done.logs.events.filter((entry) => entry['level'] === 'error'), []);
    const failed = fakes(stored, { nodes: [before, cycle], update: ['updated', 'conflict'] });
    await assert.rejects(failed.service.update(sa, access, id, version, { parentId: parent.toHexString() }, client), reject('CONFLICT'));
    assert.equal(failed.logs.events.filter((entry) => entry['level'] === 'error').length, 1);
    // Without a tree to read after the write nothing can be checked, and the write stands.
    const unread = fakes(stored, { nodes: [before, null] });
    assert.equal((await unread.service.update(sa, access, id, version, { parentId: parent.toHexString() }, client)).entity.parentId, parent.toHexString());
  });

  it('records a deletion with the address of the actor', async () => {
    const { service } = fakes(stored);
    await service.remove(sa, access, id, client);
    await service.remove(sa, access, id, { ...client, ip: null });
    // A write whose touched field the stored document lacks is undone by removing it.
    const bare = legacyCategory({ updateDate: new Date(1000), parentId: undefined });
    const parent = new ObjectId();
    const mine = (bare['_id'] as ObjectId).toHexString();
    const cycle = [{ id: mine, parent: parent.toHexString() }, { id: parent.toHexString(), parent: mine }];
    const undo = fakes(bare, { nodes: [[{ id: mine, parent: null }, { id: parent.toHexString(), parent: null }], cycle] });
    await assert.rejects(undo.service.update(sa, access, bare['_id'] as ObjectId, entityVersion(bare, PRODUCTS_CATEGORIES_OWNED_FIELDS, key), { parentId: parent.toHexString() }, client), reject('CONFLICT'));
    assert.deepEqual(undo.calls[1]!['unset'], { parentId: '' });
  });
});

describe('the reads of the places of the copies', () => {
  const never = {} as never;
  it('refuse what is not an id or a limit before reaching the database', async () => {
    const { findPlacesUsingCategory, readPlaceSetups } = await import('../../src/shared/security/scope/group-mirror.ts');
    const { accessFor } = await import('../helpers/group-access.ts');
    const verified = (await accessFor(sa, groupId))!;
    await assert.rejects(readPlaceSetups(sa, verified, never, []), /needs their ids/);
    await assert.rejects(readPlaceSetups(sa, verified, never, ['x' as never]), /needs their ids/);
    await assert.rejects(findPlacesUsingCategory(sa, verified, never, 'x' as never, 5), /needs a category id/);
    await assert.rejects(findPlacesUsingCategory(sa, verified, never, new ObjectId(), 0), /positive limit/);
  });
});

describe('the limit of the group, the places of a caller and the ownership of the fields, with collaborators that fail', () => {
  const pa = principalOf('PA', { groupId, placeIds: [fixtureId('place', 1)] });
  const stored = legacyCategory({ updateDate: new Date(1000), parentId: undefined, placesAvailability: [{ id: fixtureId('place', 1), position: null, productionCenterId: null }] });
  const id = stored['_id'] as ObjectId;

  it('takes back the category it inserted when the recount finds the group over the limit, and says so when it cannot', async () => {
    const some = [{ id: 'a', parent: null }];
    const over = fakes(null, { nodes: [some, null] });
    await assert.rejects(over.service.create(sa, access, { name: { it: 'x' } }, client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.details![0]!.issue === 'tooMany');
    assert.equal(over.removed.length, 1);
    assert.deepEqual(over.logs.events.filter((event) => event['level'] === 'error'), []);
    const stuck = fakes(null, { nodes: [some, null], remove: false });
    await assert.rejects(stuck.service.create(sa, access, { name: { it: 'x' } }, client), reject('CONFLICT'));
    assert.equal(stuck.logs.events.filter((event) => event['level'] === 'error').length, 1);
    // The read after the insert fails: the category is taken back and the error is the original one.
    const failing = new Error('read failed');
    const lost = fakes(null, { nodes: [some, failing] });
    await assert.rejects(lost.service.create(sa, access, { name: { it: 'x' } }, client), (error: unknown) => error === failing);
    assert.equal(lost.removed.length, 1);
    const stuckToo = fakes(null, { nodes: [some, failing], remove: false });
    await assert.rejects(stuckToo.service.create(sa, access, { name: { it: 'x' } }, client), (error: unknown) => error === failing);
    assert.equal(stuckToo.logs.events.filter((event) => event['level'] === 'error').length, 1);
    // Already at the limit before the insert: nothing is inserted at all.
    const full = fakes(null, { nodes: [Array.from({ length: 2000 }, (_, index) => ({ id: String(index), parent: null }))] });
    await assert.rejects(full.service.create(sa, access, { name: { it: 'x' } }, client), reject('CONFLICT'));
    assert.equal(full.removed.length, 0);
  });

  it('gives a company or place administrator no parent he cannot reach, whether the tree is known or not', async () => {
    const parent = new ObjectId();
    const child = legacyCategory({ parentId: parent, updateDate: new Date(1000), placesAvailability: stored['placesAvailability'] });
    const childId = child['_id'] as ObjectId;
    const hidden = fakes(child, { nodes: [[{ id: hex(childId), parent: hex(parent) }, { id: hex(parent), parent: null }]], reachable: [hex(childId)] });
    const read = await hidden.service.get(pa, access, childId);
    assert.deepEqual([read.entity.parentId, read.entity.parentHidden, read.entity.depth], [null, true, 0]);
    const unread = fakes(child, { nodes: [null] });
    const blind = await unread.service.get(pa, access, childId);
    assert.deepEqual([blind.entity.parentId, blind.entity.parentHidden, blind.entity.depth], [null, true, null]);
    const free = await fakes(child, { nodes: [null] }).service.get(sa, access, childId);
    assert.deepEqual([free.entity.parentId, free.entity.parentHidden], [hex(parent), false]);
    const root = await fakes(stored, { nodes: [null] }).service.get(pa, access, id);
    assert.deepEqual([root.entity.parentId, root.entity.parentHidden], [null, false]);
    // A category that the tree does not know yet is read from its own document.
    const late = await fakes(child, { nodes: [[]] }).service.get(sa, access, childId);
    assert.equal(late.entity.parentId, hex(parent));
  });

  it('leaves as a root of the answer a node whose parent is not among the categories read', async () => {
    const parent = hex(new ObjectId());
    const tree = fakes(null, {
      nodes: [[{ id: hex(id), parent }, { id: parent, parent: null }]],
      treeDocuments: [{ _id: id, name: { it: 'x' }, status: true }],
    });
    const nodes = await tree.service.tree(sa, access);
    assert.deepEqual(nodes.map((node) => [node.id, node.parentId]), [[hex(id), parent]]);
  });

  it('owns by exact equality, and below a tree only', async () => {
    const calls: Document[] = [];
    const collection = { updateOne: async (...args: unknown[]) => (calls.push(args as unknown as Document), { matchedCount: 1 }), insertOne: async () => ({}) };
    const repository = createEntityRepository({ group: () => ({ collection: () => collection }) } as never, {
      open: (db) => db.collection('x') as never,
      ownedFields: PRODUCTS_CATEGORIES_OWNED_FIELDS,
      summary: { name: 1 },
      trees: PRODUCTS_CATEGORIES_OWNED_TREES,
    });
    const verified = (await accessFor(sa, groupId))!;
    const update = (set: Document) => repository.update(sa, verified, new ObjectId(), { set, unset: {}, updateDate: new Date(), readPlaces: undefined }, undefined);
    for (const path of ['integrations.floodOrders', 'printStations.__0123456789abcdef01234567', 'medias.images.icon', 'medias.images', 'medias', 'tgm.type']) {
      assert.equal(await update({ [path]: 1 }), 'updated', path);
    }
    for (const path of ['integrations.other', 'integrations', 'medias.images.other', 'medias.other', 'tgm', 'roomsSettings.x', 'trash', 'availability.foreign']) {
      await assert.rejects(update({ [path]: 1 }), /not an owned field/, path);
    }
    await assert.rejects(repository.insert(sa, verified, { _id: new ObjectId(), mystery: 1 }), /mystery/);
    await repository.insert(sa, verified, { _id: new ObjectId(), integrations: {}, printStations: {}, medias: {} });
  });
});
