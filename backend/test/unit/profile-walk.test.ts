import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { MAX_DEPTH, bsonTypeName, collapseKey, compilePathPattern, isPlainObject, walkDocument } from '../../src/tools/profile-legacy/walk.ts';

class Weird {
  _bsontype = 'Weird';
}

describe('bsonTypeName', () => {
  it('names every type', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      ['x', 'string'],
      [true, 'bool'],
      [3, 'int'],
      [3.5, 'double'],
      [[], 'array'],
      [new Date(), 'date'],
      [{}, 'object'],
      [new Int32(1), 'int'],
      [Long.fromNumber(1), 'long'],
      [new Double(1.5), 'double'],
      [Decimal128.fromString('1'), 'decimal'],
      [new ObjectId(), 'objectId'],
      [new Binary(Buffer.from('a')), 'binData'],
      [new Weird(), 'other'],
      [/x/, 'other'],
      [undefined, 'other'],
      [10n, 'other'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(bsonTypeName(value), expected, expected);
    }
  });
});

describe('isPlainObject and collapseKey', () => {
  it('recognizes plain documents only', () => {
    assert.equal(isPlainObject({ a: 1 }), true);
    for (const value of [null, [], new Date(), new ObjectId(), 'x', 1, Object.create(null)]) {
      assert.equal(isPlainObject(value), false);
    }
  });

  it('collapses keys that look like ids, numbers, e-mails or free text', () => {
    assert.equal(collapseKey('settings'), 'settings');
    assert.equal(collapseKey('cash_sub-1'), 'cash_sub-1');
    for (const key of ['0123456789abcdef01234567', 'ABCDEFABCDEFABCDEFABCDEF', '42', 'a@b.test', 'two words', 'x'.repeat(41), '', '$x', 'IT01234567890', 'RSSMRA80A01H501U', 'abcdef0123456789abcdef0123456789', '0123456789abcdef', 'tok1en2abc3def', 'a1b2c3d4', 'mario.rossi']) {
      assert.equal(collapseKey(key), '<key>', key);
    }
    assert.equal(collapseKey('x'.repeat(40)), 'x'.repeat(40));
    for (const kept of ['v2', 'address1', 'abcdefabcdefabc', 'LongFieldNameWithoutDigits', 'a1b2c3', 'user123']) {
      assert.equal(collapseKey(kept), kept, kept);
    }
  });
});

describe('walkDocument', () => {
  it('reports normalized paths, arrays and stops at the maximum depth', () => {
    const seen: string[] = [];
    walkDocument(
      { a: { b: { c: { d: { e: 1 } } } }, list: [{ x: 1 }, [2, 3], 'z'], 'a@b.test': 1, nothing: null },
      (path) => seen.push(path),
    );
    assert.equal(MAX_DEPTH, 4);
    assert.deepEqual(seen, [
      'a',
      'a.b',
      'a.b.c',
      'a.b.c.d',
      'list',
      'list[]',
      'list[].x',
      'list[]',
      'list[][]',
      'list[][]',
      'list[]',
      '<key>',
      'nothing',
    ]);
  });
});

describe('compilePathPattern', () => {
  it('matches exact paths, array markers and one-segment wildcards', () => {
    const device = compilePathPattern('devices[].type');
    assert.ok(device.test('devices[].type'));
    assert.ok(!device.test('devices.type'));
    assert.ok(!device.test('xdevices[].type'));
    const rules = compilePathPattern('warehouseRules.*.type');
    assert.ok(rules.test('warehouseRules.<key>.type'));
    assert.ok(rules.test('warehouseRules.D.type'));
    assert.ok(!rules.test('warehouseRules.a.b.type'));
    assert.ok(!compilePathPattern('a.b').test('aXb'));
  });
});
