import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import { array, integer, nullable, object, optional, record, refine, string, transform, validate } from '../../src/shared/validation/schema.ts';
import type { Schema } from '../../src/shared/validation/schema.ts';

const problems = (schema: Schema<unknown>, value: unknown): unknown => {
  try {
    validate(schema, value, '(body)');
  } catch (error) {
    return error instanceof AppError ? error.details : error;
  }
  return null;
};

describe('transform', () => {
  const upper = transform(string({ max: 5 }), (text) => (/^[a-z]+$/.test(text) ? text.toUpperCase() : undefined), 'format');
  it('converts a valid value and keeps the key optional state of the inner schema', () => {
    assert.equal(validate(upper, 'abc', '(body)'), 'ABC');
    assert.deepEqual(validate(object({ code: optional(upper) }), {}, '(body)'), {});
    assert.deepEqual(validate(object({ code: optional(upper) }), { code: 'ab' }, '(body)'), { code: 'AB' });
  });
  it('reports the given issue when the conversion refuses, and the inner issue when the inner schema does', () => {
    assert.deepEqual(problems(object({ code: upper }), { code: 'AB1' }), [{ field: 'code', issue: 'format' }]);
    assert.deepEqual(problems(object({ code: upper }), { code: 'abcdef' }), [{ field: 'code', issue: 'maxLength' }]);
    assert.deepEqual(problems(object({ code: upper }), {}), [{ field: 'code', issue: 'required' }]);
  });
});

describe('refine', () => {
  const unique = refine(
    array(object({ name: string({ max: 5 }) }), { max: 5 }),
    (items) => items.flatMap((item, index) => (items.findIndex((other) => other.name === item.name) === index ? [] : [`${String(index)}.name`])),
    'incorrect',
  );
  it('passes a value the check accepts', () => {
    assert.deepEqual(validate(unique, [{ name: 'a' }, { name: 'b' }], '(body)'), [{ name: 'a' }, { name: 'b' }]);
  });
  it('reports every path the check returns, relative to the value', () => {
    assert.deepEqual(problems(object({ list: unique }), { list: [{ name: 'a' }, { name: 'b' }, { name: 'a' }, { name: 'b' }] }), [
      { field: 'list.2.name', issue: 'incorrect' },
      { field: 'list.3.name', issue: 'incorrect' },
    ]);
  });
  it('reports the value itself for an empty relative path, and the inner problems first', () => {
    const whole = refine(integer(), (value) => (value % 2 === 0 ? [] : ['']), 'incorrect');
    assert.deepEqual(problems(object({ n: whole }), { n: 3 }), [{ field: 'n', issue: 'incorrect' }]);
    assert.deepEqual(problems(whole, 3), [{ field: '(body)', issue: 'incorrect' }]);
    assert.deepEqual(problems(object({ n: whole }), { n: 'x' }), [{ field: 'n', issue: 'type' }]);
    assert.equal(validate(whole, 4, '(body)'), 4);
  });
});

describe('record', () => {
  const amounts = record(integer({ min: 0 }), { max: 2, key: /^[A-Z]{3}$/ });
  it('accepts a map with keys matching the pattern', () => {
    assert.deepEqual(validate(amounts, { EUR: 1, USD: 2 }, '(body)'), { EUR: 1, USD: 2 });
    assert.deepEqual(validate(amounts, {}, '(body)'), {});
  });
  it('rejects what is not an object, too many keys, keys outside the pattern, operators and prototype names, and bad values', () => {
    for (const value of [null, 'x', 3, [], [1]]) {
      assert.deepEqual(problems(object({ m: amounts }), { m: value }), [{ field: 'm', issue: 'type' }]);
    }
    assert.deepEqual(problems(object({ m: amounts }), { m: { EUR: 1, USD: 2, GBP: 3 } }), [{ field: 'm', issue: 'tooMany' }]);
    assert.deepEqual(problems(object({ m: amounts }), { m: { eur: 1 } }), [{ field: 'm.eur', issue: 'format' }]);
    assert.deepEqual(problems(object({ m: record(integer(), { max: 5, key: /^[A-Z]{3}$/ }) }), { m: JSON.parse('{"$set": 1, "__proto__": 2, "a.b": 3}') }), [
      { field: 'm.(key)', issue: 'forbiddenKey' },
      { field: 'm.(key)', issue: 'forbiddenKey' },
      { field: 'm.(key)', issue: 'forbiddenKey' },
    ]);
    assert.deepEqual(problems(object({ m: amounts }), { m: { EUR: -1, USD: 'x' } }), [
      { field: 'm.EUR', issue: 'minimum' },
      { field: 'm.USD', issue: 'type' },
    ]);
  });
  it('rejects nesting deeper than the limit', () => {
    let deep: Schema<unknown> = integer();
    for (let level = 0; level < 9; level += 1) {
      deep = record(deep, { max: 1, key: /^k$/ });
    }
    let value: unknown = 1;
    for (let level = 0; level < 9; level += 1) {
      value = { k: value };
    }
    assert.deepEqual((problems(deep, value) as Array<{ issue: string }>).map((item) => item.issue), ['tooDeep']);
  });
  it('can hold null values through nullable', () => {
    assert.deepEqual(validate(record(nullable(integer()), { max: 2, key: /^[A-Z]{3}$/ }), { EUR: null }, '(body)'), { EUR: null });
  });
});
