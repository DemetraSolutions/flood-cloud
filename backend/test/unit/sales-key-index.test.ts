import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';
import { createSalesKeyIndex, createSalesKeyIndexGuard, SALES_KEY_INDEX, SALES_KEY_INDEX_RETRY_MS, SALES_TIMESTAMP_INDEX, SALES_TOMBSTONE_INDEX } from '../../src/modules/sales/sales.key-index.ts';

/**
 * A database whose collections answer every `createIndex` with what the test says and list the indexes the test says (by default the unique ones, as the real server would after creating them).
 */
function fakeDb(answer: (spec: Record<string, unknown>) => Promise<string>, calls: unknown[] = [], listed: Record<string, Array<Record<string, unknown>>> = {}): Db {
  const unique = (name: string) => [{ name: '_id_' }, { name, unique: true }];
  return {
    collection: (name: string) => ({
      createIndex: (key: Record<string, unknown>, options: Record<string, unknown>) => (calls.push([name, key, options]), answer(key)),
      listIndexes: () => ({ toArray: async () => listed[name] ?? unique(name === 'sales' ? 'floodCloud.key_1' : 'key_1') }),
    }),
  } as unknown as Db;
}

describe('the unique key of the sales', () => {
  const groupId = new ObjectId();

  it('creates the unique partial index on the key, the one on the timestampId and the unique one of the tombstones', async () => {
    const calls: unknown[] = [];
    const logs = memoryLogger();
    assert.equal(await createSalesKeyIndex(fakeDb(async () => 'ok', calls), groupId, logs.logger), true);
    assert.deepEqual(calls, [
      ['sales', { 'floodCloud.key': 1 }, { name: 'floodCloud.key_1', unique: true, partialFilterExpression: { 'floodCloud.key': { $type: 'string' } } }],
      ['sales', { timestampId: 1 }, { name: 'timestampId_1' }],
      ['sales_tombstones', { key: 1 }, { name: 'key_1', unique: true }],
    ]);
    assert.deepEqual([SALES_KEY_INDEX.options.name, SALES_TIMESTAMP_INDEX.options.name, SALES_TOMBSTONE_INDEX.options.name], ['floodCloud.key_1', 'timestampId_1', 'key_1']);
  });

  it('says the indexes are there only when the server lists them as unique, even when it answered that they exist already', async () => {
    const logs = memoryLogger();
    const conflict = () => Promise.reject(Object.assign(new Error('secret message'), { codeName: 'IndexOptionsConflict', code: 85 }));
    assert.equal(await createSalesKeyIndex(fakeDb(conflict), groupId, logs.logger), true, 'the same index, unique, that was there already');
    // An index with the right name that is not unique (someone else made it) does not make a sale idempotent.
    assert.equal(await createSalesKeyIndex(fakeDb(conflict, [], { sales: [{ name: 'floodCloud.key_1' }] }), groupId, logs.logger), false);
    assert.equal(await createSalesKeyIndex(fakeDb(async () => 'ok', [], { sales_tombstones: [{ name: 'key_1' }] }), groupId, logs.logger), false);
    assert.equal(await createSalesKeyIndex(fakeDb(async () => 'ok', [], { sales: [] }), groupId, logs.logger), false);
    for (const codeName of ['IndexBuildAlreadyInProgress', 'IndexKeySpecsConflict']) {
      assert.equal(await createSalesKeyIndex(fakeDb(() => Promise.reject(Object.assign(new Error('secret message'), { codeName, code: 85 }))), groupId, logs.logger), true);
    }
  });

  it('reports any other failure without the message of the server', async () => {
    const logs = memoryLogger();
    assert.equal(await createSalesKeyIndex(fakeDb(() => Promise.reject(Object.assign(new Error('secret message'), { name: 'MongoServerError', code: 13 }))), groupId, logs.logger), false);
    assert.equal(await createSalesKeyIndex(fakeDb(() => Promise.reject(new Error('secret message'))), groupId, logs.logger), false);
    assert.ok(logs.lines.filter((line) => /could not be created/.test(line)).length === 2);
    assert.ok(!logs.lines.some((line) => line.includes('secret message')));
  });

  it('asks once per group and process, and again only after the pause when it failed', async () => {
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))!;
    let now = 1_000;
    const calls: unknown[] = [];
    let fail = true;
    const databases = { group: () => fakeDb(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve('ok')), calls) } as never;
    const guard = createSalesKeyIndexGuard(databases, memoryLogger().logger, () => now);
    assert.equal(await guard.ensure(principal, access), false);
    now += 1;
    assert.equal(await guard.ensure(principal, access), false, 'inside the pause: no new try');
    assert.equal(calls.length, 1);
    fail = false;
    now += SALES_KEY_INDEX_RETRY_MS;
    assert.equal(await guard.ensure(principal, access), true);
    assert.equal(await guard.ensure(principal, access), true);
    assert.equal(calls.length, 4, 'one more try (three indexes), then nothing');
  });
});
