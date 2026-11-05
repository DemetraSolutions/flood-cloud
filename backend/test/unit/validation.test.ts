import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import {
  INVALID,
  MAX_DEPTH,
  MAX_ISSUES,
  VALIDATION_ISSUES,
  array,
  boolean,
  email,
  enumOf,
  integer,
  isForbiddenKey,
  isoDate,
  nullable,
  object,
  objectId,
  optional,
  personName,
  phone,
  string,
  validate,
} from '../../src/shared/validation/schema.ts';
import type { Schema } from '../../src/shared/validation/schema.ts';

/** Validates and returns the details of the error, or fails when the value is accepted. */
function problems(schema: Schema<unknown>, value: unknown, root = '(body)'): Array<{ field: string; issue: string }> {
  try {
    validate(schema, value, root);
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 422);
    return [...(error.details ?? [])];
  }
  assert.fail('the value was accepted');
}

const one = (schema: Schema<unknown>, value: unknown): string => {
  const found = problems(schema, value, 'v');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.field, 'v');
  return found[0]!.issue;
};

describe('string', () => {
  it('accepts a value within the bounds and normalizes to NFC by default', () => {
    assert.equal(validate(string({ max: 5 }), 'abc', 'v'), 'abc');
    assert.equal(validate(string({ max: 5 }), 'é', 'v'), 'é');
    assert.equal(validate(string({ max: 5, normalize: false }), 'é', 'v'), 'é');
    assert.equal(validate(string({ max: 5, normalize: 'NFKC' }), 'Ａ', 'v'), 'A');
    assert.equal(validate(string({ max: 5 }), '', 'v'), '');
  });

  it('trims only when asked, before measuring', () => {
    assert.equal(validate(string({ min: 1, max: 3, trim: true }), '  ab  ', 'v'), 'ab');
    assert.equal(validate(string({ max: 10 }), '  ab  ', 'v'), '  ab  ');
    assert.equal(one(string({ min: 1, max: 3, trim: true }), '   '), 'minLength');
  });

  it('rejects the wrong type, the bounds, the pattern and ill-formed Unicode', () => {
    for (const value of [5, null, true, {}, [], undefined]) {
      assert.equal(one(string({ max: 5 }), value), 'type');
    }
    assert.equal(one(string({ min: 2, max: 5 }), 'a'), 'minLength');
    assert.equal(one(string({ max: 3 }), 'abcd'), 'maxLength');
    assert.equal(one(string({ max: 5, pattern: /^[a-z]+$/ }), 'AB'), 'pattern');
    assert.equal(validate(string({ max: 5, pattern: /^[a-z]+$/ }), 'ab', 'v'), 'ab');
    assert.equal(one(string({ max: 5 }), 'a\ud800'), 'format');
    assert.equal(one(string({ max: 5 }), '\udc00b'), 'format');
  });
});

describe('integer, boolean, enumOf', () => {
  it('accepts safe integers inside the range and refuses coercions', () => {
    assert.equal(validate(integer({ min: 0, max: 10 }), 10, 'v'), 10);
    assert.equal(validate(integer(), -5, 'v'), -5);
    for (const value of ['5', 1.5, NaN, Infinity, 2 ** 60, null, true, [5]]) {
      assert.equal(one(integer(), value), 'type', String(value));
    }
    assert.equal(one(integer({ min: 1 }), 0), 'minimum');
    assert.equal(one(integer({ max: 1 }), 2), 'maximum');
  });

  it('accepts only booleans', () => {
    assert.equal(validate(boolean(), false, 'v'), false);
    for (const value of ['true', 1, 0, null, undefined]) {
      assert.equal(one(boolean(), value), 'type');
    }
  });

  it('accepts only the listed strings', () => {
    const roles = enumOf(['A', 'B']);
    assert.equal(validate(roles, 'B', 'v'), 'B');
    assert.equal(one(roles, 'C'), 'enum');
    assert.equal(one(roles, 'toString'), 'enum');
    assert.equal(one(roles, 1), 'type');
  });
});

describe('objectId and isoDate', () => {
  it('converts a 24 hex string to an ObjectId', () => {
    const id = validate(objectId(), 'aabbccddeeff001122334455', 'v');
    assert.ok(id instanceof ObjectId);
    assert.equal(id.toHexString(), 'aabbccddeeff001122334455');
    assert.equal(validate(objectId(), 'AABBCCDDEEFF001122334455', 'v').toHexString(), 'aabbccddeeff001122334455');
    for (const value of ['', 'abc', 'zzbbccddeeff001122334455', 'aabbccddeeff0011223344556', { $gt: '' }.toString()]) {
      assert.equal(one(objectId(), value), 'format', value);
    }
    for (const value of [5, null, { $gt: '' }, ['aabbccddeeff001122334455'], new ObjectId()]) {
      assert.equal(one(objectId(), value), 'type');
    }
  });

  it('converts ISO dates and UTC date-times and refuses impossible ones', () => {
    assert.equal(validate(isoDate(), '2026-10-30', 'v').toISOString(), '2026-10-30T00:00:00.000Z');
    assert.equal(validate(isoDate(), '2026-10-30T14:05:00Z', 'v').toISOString(), '2026-10-30T14:05:00.000Z');
    assert.equal(validate(isoDate(), '2026-10-30T14:05:00.123Z', 'v').toISOString(), '2026-10-30T14:05:00.123Z');
    for (const value of ['2026-02-30', '2026-13-01', '2026-10-30T25:00:00Z', '2026-10-30T14:05:00', '2026-10-30T14:05:00+02:00', 'yesterday', '', '2026-10-30T14:05:00.1234Z']) {
      assert.equal(one(isoDate(), value), 'format', value);
    }
    for (const value of [0, null, new Date()]) {
      assert.equal(one(isoDate(), value), 'type');
    }
  });
});

describe('personName', () => {
  const issuesOf = (value: unknown): unknown => {
    try {
      return validate(personName(10), value, '(value)');
    } catch (error) {
      return (error as { details: unknown }).details;
    }
  };

  it('trims, normalizes and bounds the name', () => {
    assert.equal(issuesOf('  Ada '), 'Ada');
    assert.equal(issuesOf('e\u0301'), '\u00e9');
    assert.deepEqual(issuesOf(''), [{ field: '(value)', issue: 'minLength' }]);
    assert.deepEqual(issuesOf('x'.repeat(11)), [{ field: '(value)', issue: 'maxLength' }]);
    assert.deepEqual(issuesOf(5), [{ field: '(value)', issue: 'type' }]);
  });

  it('rejects control characters and bidirectional overrides and isolates as a format problem', () => {
    for (const hidden of ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f', '\u202a', '\u202e', '\u2066', '\u2069', '\u200b', '\u200f', '\u061c', '\ufeff', '\u2060', '\u2064']) {
      assert.deepEqual(issuesOf(`A${hidden}B`), [{ field: '(value)', issue: 'format' }], hidden.charCodeAt(0).toString(16));
    }
    assert.equal(issuesOf('A\u2065B'), 'A\u2065B');
    assert.equal(issuesOf('A\u2065\u2065B'), 'A\u2065\u2065B');
    assert.equal(issuesOf('A\u2065B'.replace('\u2065', '\u2005')), 'A\u2005B');
  });
});

describe('email and phone', () => {
  it('normalizes an e-mail to trimmed lower case', () => {
    assert.equal(validate(email(), '  Mario.Rossi+x@Example.COM ', 'v'), 'mario.rossi+x@example.com');
    assert.equal(validate(email(), 'Ｍ@example.test', 'v'), 'm@example.test');
  });

  it('rejects malformed e-mails and the wrong type', () => {
    for (const value of ['', 'a', 'a@', '@b.it', 'a@b', 'a b@c.it', 'a@@c.it', 'a@c..it', 'a@-c.it', 'a@c.it.', 'a@c_d.it', 'à@c.it', 'a@b@c.it']) {
      assert.equal(one(email(), value), 'format', JSON.stringify(value));
    }
    assert.equal(one(email(), `${'a'.repeat(250)}@b.it`), 'maxLength');
    assert.equal(one(email(), `${'a'.repeat(65)}@b.it`), 'format');
    assert.equal(validate(email(), `${'a'.repeat(64)}@b.it`, 'v').length, 69);
    assert.equal(one(email(), 5), 'type');
    assert.equal(one(email(), 'a@b.it\ud800'), 'format');
  });

  it('accepts telephone numbers made of digits and separators', () => {
    assert.equal(validate(phone(), ' +39 (06) 123-4567 ', 'v'), '+39 (06) 123-4567');
    for (const value of ['abc', '+-()', '', '12a', '1\n2', '٣٤']) {
      assert.equal(one(phone(), value), 'format', JSON.stringify(value));
    }
    assert.equal(one(phone(), '1'.repeat(33)), 'maxLength');
    assert.equal(validate(phone(), '1'.repeat(32), 'v').length, 32);
    assert.equal(one(phone(), 5), 'type');
    assert.equal(one(phone(), '1\ud800'), 'format');
  });
});

describe('nullable, optional, array', () => {
  const shape = object({ a: nullable(string({ max: 3 })), b: optional(integer()), c: optional(nullable(boolean())), d: array(integer(), { max: 3 }) });

  it('keeps null where allowed and leaves absent optional keys out', () => {
    assert.deepEqual(validate(shape, { a: null, d: [] }, 'v'), { a: null, d: [] });
    assert.deepEqual(validate(shape, { a: 'x', b: 1, c: null, d: [1, 2] }, 'v'), { a: 'x', b: 1, c: null, d: [1, 2] });
    assert.deepEqual(validate(shape, { a: 'x', b: undefined, d: [] }, 'v'), { a: 'x', d: [] });
    assert.deepEqual(problems(shape, { a: undefined, d: [] }), [{ field: 'a', issue: 'required' }]);
    assert.deepEqual(problems(shape, { a: 'x', b: null, d: [] }), [{ field: 'b', issue: 'type' }]);
    assert.deepEqual(problems(shape, { a: 'xxxx', d: [] }), [{ field: 'a', issue: 'maxLength' }]);
  });

  it('bounds the number of elements before looking at them and reports the index', () => {
    const list = array(string({ max: 2 }), { min: 1, max: 3 });
    assert.equal(one(list, []), 'minLength');
    assert.equal(one(list, ['a', 'b', 'c', 'd']), 'tooMany');
    assert.equal(one(list, 'a'), 'type');
    assert.deepEqual(problems(list, ['a', 'bbb', 5], 'v'), [{ field: '1', issue: 'maxLength' }, { field: '2', issue: 'type' }]);
    assert.deepEqual(problems(object({ ids: list }), { ids: ['a', 'bbb'] }), [{ field: 'ids.1', issue: 'maxLength' }]);
    assert.deepEqual(validate(list, ['a', 'b'], 'v'), ['a', 'b']);
    // Elements of a too long array are never visited.
    assert.deepEqual(problems(array({ optional: false, parse: () => assert.fail('visited') }, { max: 1 }), [1, 2]), [{ field: '(body)', issue: 'tooMany' }]);
  });
});

describe('object', () => {
  const user = object({ name: string({ max: 10 }), age: optional(integer({ min: 0 })) });

  it('returns only the declared keys', () => {
    const result = validate(user, { name: 'a', age: 3 }, 'v');
    assert.deepEqual(result, { name: 'a', age: 3 });
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  });

  it('rejects anything that is not a plain object', () => {
    for (const value of [null, 'x', 5, [], [{ name: 'a' }], true]) {
      assert.equal(one(user, value), 'type');
    }
  });

  it('collects every problem, with dot-notation fields, in one error', () => {
    assert.deepEqual(problems(object({ name: string({ max: 1 }), tags: array(object({ id: objectId() }), { max: 5 }), who: object({ age: integer() }) }), { name: 'ab', tags: [{ id: 'x' }, { id: 1 }], who: {} }), [
      { field: 'name', issue: 'maxLength' },
      { field: 'tags.0.id', issue: 'format' },
      { field: 'tags.1.id', issue: 'type' },
      { field: 'who.age', issue: 'required' },
    ]);
  });

  it('rejects unknown properties, or drops them with allowUnknown', () => {
    assert.deepEqual(problems(user, { name: 'a', extra: 1 }), [{ field: 'extra', issue: 'unknown' }]);
    assert.deepEqual(problems(user, { name: 'a', nested: { a: { b: {} } } }), [{ field: 'nested', issue: 'unknown' }]);
    const lenient = object({ name: string({ max: 10 }) }, { allowUnknown: true });
    assert.deepEqual(validate(lenient, { name: 'a', extra: { deep: 1 } }, 'v'), { name: 'a' });
    assert.deepEqual(problems(lenient, { name: 'a', $where: 1 }), [{ field: '(key)', issue: 'forbiddenKey' }]);
  });

  it('rejects operators, dotted keys and prototype keys, even when unknown properties are allowed', () => {
    const hostile = JSON.parse('{"name":"a","$gt":1,"a.b":2,"__proto__":{"x":1},"constructor":{"x":1},"prototype":3}') as unknown;
    const expected = [
      { field: '(key)', issue: 'forbiddenKey' },
      { field: '(key)', issue: 'forbiddenKey' },
      { field: '(key)', issue: 'forbiddenKey' },
      { field: '(key)', issue: 'forbiddenKey' },
      { field: '(key)', issue: 'forbiddenKey' },
    ];
    assert.deepEqual(problems(user, hostile), expected);
    assert.deepEqual(problems(object({ name: string({ max: 9 }) }, { allowUnknown: true }), hostile), expected);
    assert.deepEqual(problems(object({ inner: user }), { inner: { name: 'a', $set: {} } }), [{ field: 'inner.(key)', issue: 'forbiddenKey' }]);
    assert.equal(({} as { x?: number }).x, undefined);
  });

  it('never echoes a hostile key in a field', () => {
    const found = problems(user, { name: 'a', 'x<script>': 1, ['y'.repeat(100)]: 2, 'ünï': 3 });
    assert.deepEqual(found, [{ field: '(key)', issue: 'unknown' }, { field: '(key)', issue: 'unknown' }, { field: '(key)', issue: 'unknown' }]);
  });

  it('ignores inherited properties for declared keys', () => {
    const inherited = Object.create({ name: 'from-prototype' }) as unknown;
    assert.deepEqual(problems(user, inherited), [{ field: 'name', issue: 'required' }]);
  });

  it('refuses at definition time a shape with a forbidden key', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', '$set', 'a.b']) {
      assert.throws(() => object({ [key]: string({ max: 1 }) }), /forbidden/);
    }
    assert.equal(isForbiddenKey('name'), false);
    assert.equal(isForbiddenKey('toString'), false);
  });

  it('rejects nesting deeper than the limit and never visits the levels below', () => {
    const nest = (levels: number): { schema: Schema<unknown>; value: unknown } => {
      let schema: Schema<unknown> = integer();
      let value: unknown = 1;
      for (let level = 0; level < levels; level += 1) {
        const inner = schema;
        schema = level % 2 === 0 ? array(inner, { max: 1 }) : object({ v: inner });
        value = level % 2 === 0 ? [value] : { v: value };
      }
      return { schema, value };
    };
    const atLimit = nest(MAX_DEPTH);
    assert.deepEqual(validate(atLimit.schema, atLimit.value, 'v'), atLimit.value);
    const tooDeep = nest(MAX_DEPTH + 1);
    // The problem is reported where the limit is crossed, as a path from the root.
    const direct = problems(tooDeep.schema, tooDeep.value);
    assert.equal(direct.length, 1);
    assert.equal(direct[0]!.issue, 'tooDeep');
    assert.equal(direct[0]!.field.split('.').length, MAX_DEPTH);
    const nested = problems(object({ a: tooDeep.schema }), { a: tooDeep.value });
    assert.equal(nested[0]!.field.split('.').length, MAX_DEPTH);
  });
});

describe('validate', () => {
  it('uses the root label for problems of the value itself and never contains the received value', () => {
    const secret = 'sentinel-secret-value';
    const found = problems(object({ name: integer(), tags: array(integer(), { max: 1 }) }), { name: secret, tags: [secret, secret], extra: secret, $gt: secret }, '(query)');
    assert.equal(JSON.stringify(found).includes(secret), false);
    assert.deepEqual(problems(integer(), 'x', '(query)'), [{ field: '(query)', issue: 'type' }]);
    for (const { issue } of found) {
      assert.ok((VALIDATION_ISSUES as readonly string[]).includes(issue));
    }
  });

  it('caps the number of problems', () => {
    const found = problems(array(integer(), { max: 500 }), Array.from({ length: 200 }, () => 'x'));
    assert.equal(found.length, MAX_ISSUES);
  });

  it('exposes the closed list of issues and the INVALID marker', () => {
    assert.deepEqual([...VALIDATION_ISSUES], ['required', 'type', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'enum', 'unknown', 'forbiddenKey', 'format', 'tooDeep', 'tooMany', 'incorrect', 'taken', 'reused']);
    assert.equal(typeof INVALID, 'symbol');
    assert.ok(Object.isFrozen(string({ max: 1 })));
  });
});
