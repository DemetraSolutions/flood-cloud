import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { ContainerChange } from '../../src/modules/groups/catalogs/catalog.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { MAX_GROUP_DOCUMENT_BYTES, createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import { createReferencesRepository } from '../../src/modules/groups/catalogs/references.repository.ts';
import { CATALOGS } from '../../src/modules/groups/catalogs/registry.ts';
import type { AppError } from '../../src/shared/http/errors.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId, legacyGroup } from '../helpers/legacy-fixtures.ts';
import { TEST_CLUSTER, openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

let ctx: TestDatabases;
const groups = () => ctx.databases.common().collection('groups');
const stored = async (id: ObjectId): Promise<Document> => (await groups().findOne({ _id: id }))!;
const array = (path: string, next: unknown, old: unknown): ContainerChange => ({ path, kind: 'array', old, next });
const NOW = new Date('2026-11-06T10:00:00.000Z');

before(async () => {
  ctx = await openTestDatabases();
});
after(async () => {
  await ctx.cleanup();
});

describe('the catalogs repository', () => {
  const repository = () => createCatalogsRepository(ctx.databases);

  it('reads the asked paths with the update date, and nothing else of the document', async () => {
    await groups().insertOne(legacyGroup(1));
    const read = await repository().read(fixtureId('group', 1), ['taxes', 'fidelity.cardsTypes', 'priceLists']);
    assert.deepEqual(Object.keys(read!.values), ['taxes', 'fidelity.cardsTypes', 'priceLists']);
    assert.deepEqual([read!.updateDate, read!.values['fidelity.cardsTypes']], [(await stored(fixtureId('group', 1)))['updateDate'], undefined]);
    // The size is the one of the whole document, computed by the database, not of the projected fields.
    assert.equal(read!.size, BSON.calculateObjectSize(await stored(fixtureId('group', 1))));
    assert.equal(await repository().read(new ObjectId(), ['taxes']), null);
  });

  it('writes when the version is the one read, and then refuses the same version', async () => {
    await groups().insertOne(legacyGroup(2));
    const id = fixtureId('group', 2);
    const read = (await repository().read(id, ['taxes']))!;
    assert.equal(await repository().apply(id, [array('taxes', [{ id: 'n' }], read.values['taxes'])], read.updateDate, NOW), 'updated');
    assert.deepEqual([(await stored(id))['taxes'], (await stored(id))['updateDate']], [[{ id: 'n' }], NOW]);
    assert.equal(await repository().apply(id, [array('taxes', [], [{ id: 'n' }])], read.updateDate, NOW), 'conflict');
    assert.deepEqual((await stored(id))['taxes'], [{ id: 'n' }]);
    assert.equal(await repository().apply(new ObjectId(), [array('taxes', [], [])], NOW, NOW), 'notFound');
  });

  it('writes to a document that has no update date, and refuses one that has', async () => {
    await groups().insertOne({ _id: fixtureId('group', 3), name: 'no date' });
    assert.equal(await repository().apply(fixtureId('group', 3), [array('taxes', [{ id: 'a' }], undefined)], undefined, NOW), 'updated');
    assert.equal(await repository().apply(fixtureId('group', 3), [array('taxes', [], [])], undefined, NOW), 'conflict');
  });

  it('refuses to write into a parent that is not an object, and creates a missing one', async () => {
    await groups().insertOne({ ...legacyGroup(4), fidelity: 'broken' });
    const id = fixtureId('group', 4);
    const date = (await stored(id))['updateDate'];
    assert.equal(await repository().apply(id, [array('fidelity.cardsTypes', [{ id: 'a' }], undefined)], date, NOW), 'malformed');
    await groups().insertOne(legacyGroup(5));
    const other = fixtureId('group', 5);
    assert.equal(await repository().apply(other, [array('fidelity.cardsTypes', [{ id: 'a' }], undefined)], (await stored(other))['updateDate'], NOW), 'updated');
    assert.deepEqual((await stored(other))['fidelity'], { cardsTypes: [{ id: 'a' }] });
  });

  it('removes a map element with $unset and writes the others by field', async () => {
    await groups().insertOne(legacyGroup(6, { measureUnits: { a: { id: 'a', value: 'x', keep: 1 }, b: { id: 'b', value: 'y' } } }));
    const id = fixtureId('group', 6);
    const change: ContainerChange = { path: 'measureUnits', kind: 'map', old: (await stored(id))['measureUnits'], next: { a: { id: 'a', value: 'z', keep: 1 } } };
    assert.equal(await repository().apply(id, [change], (await stored(id))['updateDate'], NOW), 'updated');
    assert.deepEqual((await stored(id))['measureUnits'], { a: { id: 'a', value: 'z', keep: 1 } });
  });

  it('refuses a path the backend does not own, writing nothing', async () => {
    const id = fixtureId('group', 6);
    const before = await stored(id);
    await assert.rejects(repository().apply(id, [array('apiKey', 'x', undefined)], before['updateDate'], NOW), /not an owned catalog path/);
    assert.deepEqual(await stored(id), before);
  });
});

describe('the catalogs service, around the repository', () => {
  const principal = () => principalOf('PSA', { matrix: undefined as never });
  const service = (overrides: Partial<ReturnType<typeof createCatalogsRepository>>, now = () => NOW.getTime()) => {
    const activityLog = memoryActivityLog();
    const logger = memoryLogger();
    return {
      activityLog,
      logger,
      service: createCatalogsService({ catalogs: { ...createCatalogsRepository(ctx.databases), ...overrides }, references: createReferencesRepository(ctx.databases), activityLog, logger: logger.logger, newId: ((n = 0) => () => `fixed-${String(n++)}`)(), now }),
    };
  };
  const taxes = CATALOGS.find((catalog) => catalog.name === 'tax')!;
  const code = async (work: Promise<unknown>): Promise<string> => work.then(() => 'ok', (error: AppError) => error.code);

  it('answers 404 when the group is gone, when the write finds none, and for every operation', async () => {
    const access = { groupId: new ObjectId() } as never;
    const { service: gone } = service({});
    const client = { requestId: 'r', ip: null } as never;
    assert.equal(await code(gone.list(taxes, access)), 'NOT_FOUND');
    assert.equal(await code(gone.create(principal(), access, taxes, { rate: 1 }, client)), 'NOT_FOUND');
    assert.equal(await code(gone.patch(principal(), access, taxes, 'x', { rate: 1 }, client)), 'NOT_FOUND');
    assert.equal(await code(gone.remove(principal(), access, taxes, 'x', client)), 'NOT_FOUND');
    const real = createCatalogsRepository(ctx.databases);
    const { service: vanished } = service({ apply: async () => 'notFound' });
    await groups().insertOne(legacyGroup(8));
    const present = { groupId: fixtureId('group', 8) } as never;
    assert.equal(await code(vanished.create(principal(), present, taxes, { rate: 1, department: null, description: null, vatNature: null }, client)), 'NOT_FOUND');
    assert.equal(await code(vanished.create(principal(), present, taxes, { rate: 1 }, client)), 'NOT_FOUND');
    assert.equal(await code(vanished.patch(principal(), present, taxes, 'x', {}, client)), 'VALIDATION_ERROR');
    assert.equal((await real.read(fixtureId('group', 8), ['taxes']))!.values['taxes'] !== undefined, true);
  });

  it('records the address of the client, and moves the update date strictly forward within the same millisecond', async () => {
    await groups().insertOne(legacyGroup(9, { updateDate: new Date(NOW.getTime() + 5000) }));
    const access = { groupId: fixtureId('group', 9) } as never;
    const { service: working, activityLog } = service({});
    const created = await working.create(principal(), access, taxes, { rate: 4 }, { requestId: 'req-1', ip: '203.0.113.9' } as never);
    assert.equal((created as { rate: number }).rate, 4);
    assert.equal((await stored(fixtureId('group', 9)))['updateDate'].getTime(), NOW.getTime() + 5001);
    assert.deepEqual([activityLog.entries[0]!.ip, activityLog.entries[0]!.requestId], ['203.0.113.9', 'req-1']);
    await working.create(principal(), access, taxes, { rate: 5 }, { requestId: 'req-2', ip: null } as never);
    assert.equal('ip' in activityLog.entries[1]!, false);
  });

  it('refuses a write that makes the document grow beyond its size budget, and still allows one that makes it shrink', async () => {
    await groups().insertOne(legacyGroup(11, { taxes: [{ id: 'a', value: 1, department: null, description: null, natura: null }], filler: 'x'.repeat(MAX_GROUP_DOCUMENT_BYTES - 64) }));
    const access = { groupId: fixtureId('group', 11) } as never;
    const client = { requestId: 'r', ip: null } as never;
    const { service: working, activityLog } = service({});
    const before = await stored(fixtureId('group', 11));
    await assert.rejects(working.create(principal(), access, taxes, { rate: 4 }, client), (error: AppError) => {
      assert.deepEqual([error.code, error.details], ['VALIDATION_ERROR', [{ field: '(body)', issue: 'tooMany' }]]);
      return true;
    });
    await assert.rejects(working.patch(principal(), access, taxes, 'a', { description: 'a longer description' }, client), (error: AppError) => error.code === 'VALIDATION_ERROR');
    assert.deepEqual(await stored(fixtureId('group', 11)), before);
    assert.equal(activityLog.entries.length, 0);
    // A change that does not make the document grow is written.
    await working.patch(principal(), access, taxes, 'a', { rate: 2 }, client);
    await working.remove(principal(), access, taxes, 'a', client);
    assert.deepEqual((await stored(fixtureId('group', 11)))['taxes'], []);
  });

  it('logs the anomalies of a stored catalog when it lists it', async () => {
    await groups().insertOne(legacyGroup(10, { taxes: [{ id: 'a' }, 'junk'] }));
    const { service: listing, logger } = service({});
    assert.equal((await listing.list(taxes, { groupId: fixtureId('group', 10) } as never)).length, 1);
    assert.ok(logger.events.some((event) => event['msg'] === 'group catalog anomalies'));
  });
});
