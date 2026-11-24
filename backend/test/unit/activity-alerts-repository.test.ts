import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createActivityLogRepository } from '../../src/modules/activity-log/activity-log.repository.ts';
import type { Databases } from '../../src/db/databases.ts';

const principal = { userId: new ObjectId(), scope: { kind: 'platform' } } as never;

function databasesWith(countDocuments: (filter: Document, options: Document) => Promise<number>): Databases {
  return { common: () => ({ collection: () => ({ countDocuments }) }) } as never;
}

describe('activity log repository count', () => {
  it('counts with the scope, a limit of cap + 1, a time limit and the hint on the index of the action', async () => {
    const seen: Array<[Document, Document]> = [];
    const repository = createActivityLogRepository(databasesWith((filter, options) => (seen.push([filter, options]), Promise.resolve(7))));
    assert.equal(await repository.count(principal, { action: 'x' }, 100), 7);
    assert.deepEqual(seen[0]?.[1], { limit: 101, maxTimeMS: 5000, hint: 'action_1_at_-1' });
  });

  it('answers 503 when the database time limit expires, and propagates any other failure', async () => {
    const expired = createActivityLogRepository(databasesWith(() => Promise.reject(new MongoServerError({ message: 'operation exceeded time limit', code: 50 }))));
    await assert.rejects(expired.count(principal, {}, 100), { code: 'SERVICE_UNAVAILABLE' });
    const other = createActivityLogRepository(databasesWith(() => Promise.reject(new MongoServerError({ message: 'boom', code: 2 }))));
    await assert.rejects(other.count(principal, {}, 100), (error) => error instanceof MongoServerError && error.code === 2);
    const plain = createActivityLogRepository(databasesWith(() => Promise.reject(new Error('network'))));
    await assert.rejects(plain.count(principal, {}, 100), /network/);
  });
});
