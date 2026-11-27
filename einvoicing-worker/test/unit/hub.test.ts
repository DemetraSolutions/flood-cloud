import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dealerHub, HUB_PATTERN, parseHub } from '../../src/accounts/hub.ts';

describe('hub names', () => {
  it('parses the platform hub and a dealer hub', () => {
    assert.deepEqual(parseHub('aruba'), { provider: 'aruba', dealerId: undefined });
    assert.deepEqual(parseHub('aruba__0123456789abcdef01234567'), { provider: 'aruba', dealerId: '0123456789abcdef01234567' });
    assert.equal(dealerHub('aruba', '0123456789abcdef01234567'), 'aruba__0123456789abcdef01234567');
  });

  it('accepts only <provider> or <provider>__<24 lowercase hex>', () => {
    for (const good of ['aruba', 'fake2', 'aruba__0123456789abcdef01234567']) {
      assert.match(good, HUB_PATTERN);
    }
    for (const bad of ['', 'Aruba', '2aruba', 'aruba__', 'aruba__0123456789ABCDEF01234567', 'aruba__0123456789abcdef0123456', 'aruba__0123456789abcdef012345678', 'aruba_x', 'ar-uba']) {
      assert.doesNotMatch(bad, HUB_PATTERN, bad);
    }
  });
});
