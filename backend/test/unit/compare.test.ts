import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../../src/shared/security/compare.ts';

describe('safeEqual', () => {
  it('compares equal, different and different-length strings without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual('é', 'é'), true);
  });
});
