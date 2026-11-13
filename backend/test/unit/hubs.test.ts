import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARUBA_HUB, HUB, mayChooseHub } from '../../src/modules/companies/hubs.ts';
import { principalOf } from '../helpers/principal.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const OWN = fixtureId('user', 900);
const OTHER = fixtureId('user', 901);

describe('the allowlist of the e-invoicing hub', () => {
  it('lets a PSA choose any form, a dealer none, aruba or his own, and nobody else anything', () => {
    assert.equal(ARUBA_HUB, 'aruba');
    assert.deepEqual(HUB.exec(`aruba__${OTHER.toHexString()}`)?.[1], OTHER.toHexString());
    assert.equal(HUB.test('aruba__xyz'), false);
    const psa = principalOf('PSA', { userId: OWN });
    const dealer = principalOf('D', { userId: OWN });
    for (const hub of ['aruba', `aruba__${OWN.toHexString()}`, `aruba__${OTHER.toHexString()}`, 'whatever']) {
      assert.equal(mayChooseHub(psa, hub), true, hub);
    }
    assert.deepEqual(['aruba', `aruba__${OWN.toHexString()}`, `aruba__${OTHER.toHexString()}`, 'whatever'].map((hub) => mayChooseHub(dealer, hub)), [true, true, false, true]);
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      assert.equal(mayChooseHub(principalOf(role, { userId: OWN, groupId: fixtureId('group', 1) }), 'aruba'), false, role);
    }
  });
});
