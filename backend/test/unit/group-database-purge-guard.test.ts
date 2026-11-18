import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { assertPurgeableGroupDatabase } from '../../src/db/group-database-purger.ts';
import { commonDatabaseName, groupDatabaseName, queueDatabaseName } from '../../src/db/names.ts';

const CONTEXT = { prefix: 'p_', appEnv: 'production' } as const;
const GROUP = ObjectId.createFromHexString('0123456789abcdef01234567');
const OTHER = ObjectId.createFromHexString('0123456789abcdef01234568');

describe('assertPurgeableGroupDatabase', () => {
  it('accepts exactly the database of the group in this prefix and environment', () => {
    assert.doesNotThrow(() => assertPurgeableGroupDatabase(groupDatabaseName(CONTEXT, GROUP), GROUP, CONTEXT));
  });

  it('refuses the common and the queue databases, whatever the group', () => {
    for (const name of [commonDatabaseName(CONTEXT), queueDatabaseName(CONTEXT)]) {
      assert.throws(() => assertPurgeableGroupDatabase(name, GROUP, CONTEXT), /is not a group database/);
    }
  });

  it('refuses the database of another group, of another environment, of another prefix and names that are not group databases', () => {
    assert.throws(() => assertPurgeableGroupDatabase(groupDatabaseName(CONTEXT, OTHER), GROUP, CONTEXT), /does not belong to the group 0123456789abcdef01234567/);
    assert.throws(() => assertPurgeableGroupDatabase(groupDatabaseName({ ...CONTEXT, appEnv: 'development' }, GROUP), GROUP, CONTEXT), /is not allowed in environment "production"/);
    assert.throws(() => assertPurgeableGroupDatabase(groupDatabaseName({ ...CONTEXT, prefix: 'q_' }, GROUP), GROUP, CONTEXT), /is not allowed/);
    assert.throws(() => assertPurgeableGroupDatabase(`p_production_${GROUP.toHexString().toUpperCase()}`, GROUP, CONTEXT), /is not allowed/);
    assert.throws(() => assertPurgeableGroupDatabase('admin', GROUP, CONTEXT), /is not allowed/);
    assert.throws(() => assertPurgeableGroupDatabase(`p_production_${GROUP.toHexString()}x`, GROUP, CONTEXT), /is not allowed/);
  });
});
