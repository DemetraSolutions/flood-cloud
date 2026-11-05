import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { buildActivityDocument } from '../../src/shared/activity-log/activity-log.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import { recordDataChange } from '../../src/shared/activity-log/data-change.ts';
import { memoryActivityLog } from '../helpers/activity.ts';

const actor = { kind: 'user', id: new ObjectId(), role: 'SA' } as const;

describe('the activity log of the user management', () => {
  it('lets a permanent deletion carry the role of the removed user and no other data action', () => {
    assert.ok(ACTION_CATALOG.get('user.deleted')!.metadataKeys.includes('role'));
    for (const action of ['user.created', 'user.updated', 'user.trashed', 'user.restored', 'group.deleted', 'company.deleted']) {
      assert.ok(!ACTION_CATALOG.get(action)!.metadataKeys.includes('role'), action);
    }
    const entry = { category: 'data', action: 'user.deleted', outcome: 'success', actor, metadata: { role: 'PA' } } as const;
    assert.deepEqual(buildActivityDocument(entry, new Date(0), 1).metadata, { role: 'PA' });
    assert.throws(() => buildActivityDocument({ ...entry, action: 'user.created' }, new Date(0), 1), /metadata key "role" is not allowed for user.created/);
  });

  it('records the metadata of a data change next to the truncation note when there are both', async () => {
    const log = memoryActivityLog();
    await recordDataChange(log, { actor, resource: { type: 'user', id: 'x' }, action: 'user.deleted', before: undefined, after: undefined, metadata: { role: 'E' } });
    assert.deepEqual(log.entries[0]!.metadata, { role: 'E' });
    const many = Object.fromEntries(Array.from({ length: 205 }, (_unused, index) => [`field${String(index)}`, index]));
    await recordDataChange(log, { actor, resource: { type: 'user', id: 'x' }, action: 'user.deleted', before: {}, after: many, metadata: { role: 'E' } });
    assert.deepEqual(log.entries[1]!.metadata, { role: 'E', changesTruncated: true, changesTotal: 205 });
  });
});
