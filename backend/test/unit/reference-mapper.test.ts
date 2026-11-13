import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCompanyReference, toGroupReference, toPlaceReference } from '../../src/modules/reference/reference.mapper.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const _id = fixtureId('group', 1);
const NONE = { active: 0, trashed: 0 };
const ZERO = { companies: NONE, places: NONE, users: NONE };

describe('reference mapper', () => {
  it('maps a group by allowlist: only a true status is active, only a true trash is trashed', () => {
    assert.deepEqual(toGroupReference({ _id, name: 'G', status: true, trash: false, apiKey: 'secret' }, ZERO), { id: _id.toHexString(), name: 'G', status: 'active', trashed: false, dealerId: null, demo: false, counts: ZERO });
    assert.deepEqual(toGroupReference({ _id, name: 5, status: 'true', trash: 'yes' }, ZERO), { id: _id.toHexString(), name: '', status: 'suspended', trashed: false, dealerId: null, demo: false, counts: ZERO });
    assert.deepEqual(toGroupReference({ _id, status: false, trash: true }, ZERO), { id: _id.toHexString(), name: '', status: 'suspended', trashed: true, dealerId: null, demo: false, counts: ZERO });
  });

  it('maps a company', () => {
    assert.deepEqual(toCompanyReference({ _id, name: 'C', trash: true, fattura_elettronica: {} }), { id: _id.toHexString(), name: 'C', trashed: true });
    assert.deepEqual(toCompanyReference({ _id }), { id: _id.toHexString(), name: '', trashed: false });
  });

  it('maps a place, with the company id only when it is an object id', () => {
    const company = fixtureId('company', 1);
    assert.deepEqual(toPlaceReference({ _id, name: 'P', companyId: company, trash: false, integrations: {} }), { id: _id.toHexString(), name: 'P', companyId: company.toHexString(), trashed: false });
    for (const companyId of [undefined, null, 'abc', 5]) {
      assert.equal(toPlaceReference({ _id, companyId }).companyId, null);
    }
  });
});
