import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { MAX_ENUM_VALUES, MAX_PATHS, MIN_PUBLISH_COUNT, RARE_VALUES_KEY, createFieldProfiler } from '../../src/tools/profile-legacy/fields.ts';

describe('createFieldProfiler', () => {
  it('counts documents, presence and types per sorted path', () => {
    const profiler = createFieldProfiler({ minCount: 1 });
    profiler.add({ b: 1, a: [ 'x', 2 ], c: { d: null } });
    profiler.add({ a: [], b: 'text', c: { d: new ObjectId() } });
    const result = profiler.result();
    assert.equal(MAX_PATHS, 500);
    assert.equal(result.documents, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.rarePaths, 0);
    assert.deepEqual(Object.keys(result.fields), ['a', 'a[]', 'b', 'c', 'c.d']);
    assert.deepEqual(result.fields['a'], { docs: 2, types: { array: 2 } });
    assert.deepEqual(result.fields['a[]'], { docs: 1, types: { string: 1, int: 1 } });
    assert.deepEqual(result.fields['b'], { docs: 2, types: { int: 1, string: 1 } });
    assert.deepEqual(result.fields['c.d'], { docs: 2, types: { null: 1, objectId: 1 } });
    assert.deepEqual(result.enums, {});
    assert.deepEqual(result.booleans, {});
  });

  it('stops tracking new paths beyond the limit and says so', () => {
    const profiler = createFieldProfiler({ maxPaths: 2, minCount: 1 });
    profiler.add({ a: 1, b: 2, c: 3 });
    profiler.add({ a: 1, c: 3 });
    const result = profiler.result();
    assert.equal(result.truncated, true);
    assert.deepEqual(Object.keys(result.fields), ['a', 'b']);
  });

  it('lists enum values only for allowlisted paths and only when few', () => {
    const profiler = createFieldProfiler({ enums: ['role', 'rules.*.type', 'many'], booleans: ['flag'], minCount: 1 });
    profiler.add({ role: 'D', secret: 'SENTINEL', rules: { x: { type: 'L' } }, many: 'v0', flag: true });
    profiler.add({ role: 'D', rules: { y: { type: 'D' } }, many: 'v1', flag: false });
    profiler.add({ role: null, many: 'v2', flag: 'yes' });
    for (let i = 3; i <= MAX_ENUM_VALUES + 1; i += 1) {
      profiler.add({ many: `v${i}` });
    }
    const result = profiler.result();
    assert.deepEqual(result.enums['role'], { distinct: 1, nonString: 1, values: { D: 2 } });
    assert.deepEqual(result.enums['rules.*.type'], { distinct: 2, nonString: 0, values: { D: 1, L: 1 } });
    assert.deepEqual(result.enums['many'], { distinct: MAX_ENUM_VALUES + 2, nonString: 0 });
    assert.deepEqual(result.booleans['flag'], { true: 1, false: 1, other: 1 });
    assert.ok(!JSON.stringify(result).includes('SENTINEL'));
  });

  it('publishes only paths seen in at least 3 documents and sums the rare enum values', () => {
    const profiler = createFieldProfiler({ enums: ['role'] });
    assert.equal(MIN_PUBLISH_COUNT, 3);
    profiler.add({ common: 1, role: 'A', 'IT01234567890': 1, once: 1 });
    profiler.add({ common: 1, role: 'A', once2: 1 });
    profiler.add({ common: 1, role: 'A', once2: 1 });
    profiler.add({ role: 'B' });
    profiler.add({ role: 'C' });
    const result = profiler.result();
    assert.deepEqual(Object.keys(result.fields), ['common', 'role']);
    assert.equal(result.rarePaths, 3);
    assert.deepEqual(result.enums['role']?.values, { A: 3, [RARE_VALUES_KEY]: 2 });
    assert.equal(result.enums['role']?.distinct, 3);
    assert.ok(!JSON.stringify(result).includes('IT0123'));
  });
});
