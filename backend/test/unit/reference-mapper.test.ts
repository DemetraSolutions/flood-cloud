import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toGroupReference } from '../../src/modules/reference/reference.mapper.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const _id = fixtureId('group', 1);
const NONE = { active: 0, trashed: 0 };
const ZERO = { companies: NONE, places: NONE, users: NONE };

describe('reference mapper', () => {
  it('maps a group by allowlist: only a true status is active, only a true trash is trashed', () => {
    assert.deepEqual(toGroupReference({ _id, name: 'G', status: true, trash: false, apiKey: 'secret' }, ZERO), { id: _id.toHexString(), name: 'G', status: 'active', trashed: false, trashedAt: null, dealerId: null, demo: false, counts: ZERO });
    assert.deepEqual(toGroupReference({ _id, name: 5, status: 'true', trash: 'yes' }, ZERO), { id: _id.toHexString(), name: '', status: 'suspended', trashed: false, trashedAt: null, dealerId: null, demo: false, counts: ZERO });
    assert.deepEqual(toGroupReference({ _id, status: false, trash: true }, ZERO), { id: _id.toHexString(), name: '', status: 'suspended', trashed: true, trashedAt: null, dealerId: null, demo: false, counts: ZERO });
    // The date of the trash: a valid date is an ISO string; anything else is none.
    assert.equal(toGroupReference({ _id, trash: true, trashDate: new Date('2026-11-17T09:30:00.000Z') }, ZERO).trashedAt, '2026-11-17T09:30:00.000Z');
    for (const junk of [undefined, null, '2026-11-17', new Date('nope')]) {
      assert.equal(toGroupReference({ _id, trash: true, trashDate: junk }, ZERO).trashedAt, null);
    }
  });
});
