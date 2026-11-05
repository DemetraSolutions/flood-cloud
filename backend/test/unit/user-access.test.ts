import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { violationError } from '../../src/modules/users/user-access.ts';

describe('violationError', () => {
  it('has no error without violation', () => {
    assert.equal(violationError([], 'PA'), null);
  });

  it('answers 403 for anything about the actor, even next to a perimeter problem', () => {
    for (const violations of [['selfChange'], ['roleNotManageable'], ['permissionNotHeld'], ['cannotManagePermissions'], ['outOfScope', 'permissionNotHeld']] as const) {
      assert.equal(violationError(violations, 'PA')!.code, 'FORBIDDEN');
    }
  });

  it('answers a perimeter problem as the same incorrect reference the lookups give, on the field of the role', () => {
    assert.deepEqual(violationError(['outOfScope'], 'CA')!.details, [{ field: 'companyIds', issue: 'incorrect' }]);
    assert.deepEqual(violationError(['outOfScope'], 'PA')!.details, [{ field: 'placeIds', issue: 'incorrect' }]);
  });
});
