import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commonDatabaseName, groupDatabaseName, queueDatabaseName } from '../../src/db/names.ts';

describe('database names', () => {
  it('are <prefix><appEnv>_common and _queue', () => {
    assert.equal(commonDatabaseName({ prefix: '', appEnv: 'development' }), 'development_common');
    assert.equal(commonDatabaseName({ prefix: 'p_', appEnv: 'production' }), 'p_production_common');
    assert.equal(queueDatabaseName({ prefix: '', appEnv: 'development' }), 'development_queue');
    assert.equal(queueDatabaseName({ prefix: 'p_', appEnv: 'production' }), 'p_production_queue');
  });

  it('the database of a group is <prefix><appEnv>_<groupId>', () => {
    assert.equal(groupDatabaseName({ prefix: '', appEnv: 'development' }, '0123456789abcdef01234567'), 'development_0123456789abcdef01234567');
    assert.equal(groupDatabaseName({ prefix: 'p_', appEnv: 'production' }, 'abcdef0123456789abcdef01'), 'p_production_abcdef0123456789abcdef01');
  });
});
