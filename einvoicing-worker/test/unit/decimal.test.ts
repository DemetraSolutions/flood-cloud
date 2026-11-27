import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { add, compare, decimal, divide, formatDecimal, fromNumber, isZero, mul, negate, parseDecimal, round, sub, ZERO } from '../../src/invoice/decimal.ts';
import type { Decimal } from '../../src/invoice/decimal.ts';

function d(text: string): Decimal {
  const value = parseDecimal(text);
  assert.ok(value !== null, `not a decimal: ${text}`);
  return value;
}

describe('parseDecimal', () => {
  it('reads plain, signed and scientific numbers exactly', () => {
    assert.deepEqual(d('12'), decimal(12n, 0));
    assert.deepEqual(d('-0.50'), decimal(-50n, 2));
    assert.deepEqual(d('+3.1'), decimal(31n, 1));
    assert.deepEqual(d('1.5e-7'), decimal(15n, 8));
    assert.deepEqual(d('1e3'), decimal(1000n, 0));
    assert.deepEqual(d('2.5E+1'), decimal(25n, 0));
    assert.deepEqual(d('  7 '), decimal(7n, 0));
  });

  it('rejects what is not a finite decimal number', () => {
    for (const text of ['', 'abc', '1.2.3', '1,5', '.5', '5.', '1e', '1e999', '1e-999']) {
      assert.equal(parseDecimal(text), null, text);
    }
  });
});

describe('fromNumber', () => {
  it('goes through the shortest text, so binary noise does not appear', () => {
    assert.deepEqual(fromNumber(0.1), decimal(1n, 1));
    assert.deepEqual(fromNumber(1.005), decimal(1005n, 3));
    assert.deepEqual(fromNumber(1e21), decimal(10n ** 21n, 0));
    assert.deepEqual(fromNumber(1.5e-7), decimal(15n, 8));
    assert.equal(fromNumber(-0)?.units, 0n);
  });

  it('refuses NaN and the infinities', () => {
    assert.equal(fromNumber(Number.NaN), null);
    assert.equal(fromNumber(Number.POSITIVE_INFINITY), null);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and multiplies exactly', () => {
    assert.equal(formatDecimal(add(d('0.1'), d('0.2')), 1, 8), '0.3');
    assert.equal(formatDecimal(sub(d('1'), d('0.0001')), 1, 8), '0.9999');
    assert.equal(formatDecimal(negate(d('2.5')), 1, 8), '-2.5');
    assert.deepEqual(mul(d('1.25'), d('-0.4')), decimal(-500n, 3));
  });

  it('compares across different scales', () => {
    assert.equal(compare(d('1.50'), d('1.5')), 0);
    assert.equal(compare(d('1.49'), d('1.5')), -1);
    assert.equal(compare(d('2'), d('1.999')), 1);
    assert.equal(isZero(ZERO), true);
    assert.equal(isZero(d('0.001')), false);
  });
});

describe('round (half away from zero)', () => {
  it('rounds the third decimal digit 5 or more up, in magnitude', () => {
    assert.equal(formatDecimal(round(d('1500.2448'), 2), 2, 2), '1500.24');
    assert.equal(formatDecimal(round(d('1500.2458'), 2), 2, 2), '1500.25');
    assert.equal(formatDecimal(round(d('0.005'), 2), 2, 2), '0.01');
    assert.equal(formatDecimal(round(d('-0.005'), 2), 2, 2), '-0.01');
    assert.equal(formatDecimal(round(d('-0.004'), 2), 2, 2), '0.00');
    assert.equal(formatDecimal(round(d('2.5'), 0), 0, 0), '3');
  });

  it('only changes the scale when there is nothing to drop', () => {
    assert.deepEqual(round(d('1.5'), 3), decimal(1500n, 3));
    assert.deepEqual(round(d('1.50'), 2), decimal(150n, 2));
  });
});

describe('divide', () => {
  it('rounds the quotient half away from zero at the requested scale', () => {
    assert.equal(formatDecimal(divide(d('10'), d('3'), 8), 2, 8), '3.33333333');
    assert.equal(formatDecimal(divide(d('2'), d('3'), 2), 2, 2), '0.67');
    assert.equal(formatDecimal(divide(d('1.5'), d('0.5'), 2), 2, 2), '3.00');
  });

  it('handles negative operands', () => {
    assert.equal(formatDecimal(divide(d('-10'), d('4'), 1), 1, 1), '-2.5');
    assert.equal(formatDecimal(divide(d('10'), d('-4'), 1), 1, 1), '-2.5');
    assert.equal(formatDecimal(divide(d('-10'), d('-4'), 1), 1, 1), '2.5');
    assert.equal(formatDecimal(divide(d('-2'), d('3'), 2), 2, 2), '-0.67');
  });

  it('refuses a zero divisor', () => {
    assert.throws(() => divide(d('1'), ZERO, 2), RangeError);
  });
});

describe('formatDecimal', () => {
  it('writes the digits the schema types want', () => {
    assert.equal(formatDecimal(d('12.5'), 2, 8), '12.50');
    assert.equal(formatDecimal(d('12.505'), 2, 8), '12.505');
    assert.equal(formatDecimal(d('0.123456789'), 2, 8), '0.12345679');
    assert.equal(formatDecimal(d('3'), 2, 2), '3.00');
    assert.equal(formatDecimal(d('100'), 0, 0), '100');
    assert.equal(formatDecimal(d('0.1'), 2, 2), '0.10');
  });

  it('never writes a negative zero and keeps the sign of a non-zero value', () => {
    assert.equal(formatDecimal(d('-0.001'), 2, 2), '0.00');
    assert.equal(formatDecimal(d('-12.3'), 2, 2), '-12.30');
  });
});
