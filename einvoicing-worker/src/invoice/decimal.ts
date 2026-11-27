/**
 * Exact decimal arithmetic for invoice amounts.
 *
 * An invoice figure is never a JavaScript float: the legacy queue stores binary doubles, so every number read from a
 * record is converted once (through its shortest round-trip text) into a `Decimal`, and from then on only exact
 * integer operations are used. A `Decimal` is `units / 10^scale` with a `bigint` numerator, so additions,
 * multiplications and the cascades of the FatturaPA calculation rules never accumulate binary error. Rounding is
 * always explicit and is "half away from zero" (the SdI rule: the third decimal digit 5 or more rounds up, in
 * magnitude).
 *
 * @module
 */

/** A decimal number: `units / 10^scale`, with `scale >= 0`. Immutable. */
export interface Decimal {
  /** Numerator. */
  readonly units: bigint;
  /** Number of decimal digits of `units` (the power of ten of the denominator). */
  readonly scale: number;
}

/** Largest exponent accepted when parsing scientific notation (guards against huge `bigint` powers). */
const MAX_EXPONENT = 400;

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Builds a decimal from its parts.
 *
 * @param units Numerator.
 * @param scale Number of decimal digits (a non-negative integer).
 * @returns The decimal `units / 10^scale`.
 */
export function decimal(units: bigint, scale = 0): Decimal {
  return { units, scale };
}

/** The decimal zero. */
export const ZERO: Decimal = decimal(0n);

/**
 * Parses a plain or scientific decimal text (`"12"`, `"-0.5"`, `"1.5e-7"`).
 *
 * @param text The text; surrounding whitespace is ignored.
 * @returns The decimal, or `null` when the text is not a finite decimal number.
 */
export function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (match === null) {
    return null;
  }
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (Math.abs(exponent) > MAX_EXPONENT) {
    return null;
  }
  const fraction = match[3] ?? '';
  let units = BigInt(`${match[2] as string}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= pow10(-scale);
    scale = 0;
  }
  return decimal(match[1] === '-' ? -units : units, scale);
}

/**
 * Converts a JavaScript number through its shortest round-trip text, so `0.1` is exactly one tenth.
 *
 * @param value A number.
 * @returns The decimal, or `null` for `NaN` and the infinities.
 */
export function fromNumber(value: number): Decimal | null {
  return Number.isFinite(value) ? parseDecimal(String(value)) : null;
}

function rescale(value: Decimal, scale: number): bigint {
  return value.units * pow10(scale - value.scale);
}

/** Sum of two decimals. */
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return decimal(rescale(a, scale) + rescale(b, scale), scale);
}

/** Difference `a - b`. */
export function sub(a: Decimal, b: Decimal): Decimal {
  return add(a, negate(b));
}

/** Opposite of a decimal. */
export function negate(a: Decimal): Decimal {
  return decimal(-a.units, a.scale);
}

/** Exact product of two decimals (the scales add up). */
export function mul(a: Decimal, b: Decimal): Decimal {
  return decimal(a.units * b.units, a.scale + b.scale);
}

/** `numerator / denominator` rounded half away from zero (`denominator` is positive). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -quotient : quotient;
}

/**
 * Rounds to `scale` decimal digits, half away from zero.
 *
 * @param value The value to round.
 * @param scale Target number of decimal digits.
 * @returns A decimal whose scale is exactly `scale`.
 */
export function round(value: Decimal, scale: number): Decimal {
  if (value.scale <= scale) {
    return decimal(rescale(value, scale), scale);
  }
  return decimal(divideRounded(value.units, pow10(value.scale - scale)), scale);
}

/**
 * Divides two decimals and rounds the quotient half away from zero.
 *
 * @param dividend The dividend.
 * @param divisor The divisor.
 * @param scale Number of decimal digits of the result.
 * @returns The quotient with the given scale.
 * @throws RangeError When the divisor is zero.
 */
export function divide(dividend: Decimal, divisor: Decimal, scale: number): Decimal {
  if (divisor.units === 0n) {
    throw new RangeError('Division by zero');
  }
  const numerator = dividend.units * pow10(scale + divisor.scale);
  const denominator = divisor.units * pow10(dividend.scale);
  const sign = denominator < 0n ? -1n : 1n;
  return decimal(divideRounded(numerator * sign, denominator * sign), scale);
}

/** Compares two decimals: `-1`, `0` or `1`. */
export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Whether the value is zero. */
export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

/**
 * Formats a decimal for the XML: rounded half away from zero to `maxDecimals`, then trailing zeros are dropped
 * down to `minDecimals` (so an amount of the schema `Amount8DecimalType` is `12.50`, `12.505` or `0.12345678`).
 *
 * @param value The value.
 * @param minDecimals Minimum number of decimal digits written.
 * @param maxDecimals Maximum number of decimal digits written (at least `minDecimals`).
 * @returns The text, with a `.` as separator and a leading `-` only for a non-zero negative value.
 * @example
 * formatDecimal(parseDecimal('12.5') as Decimal, 2, 8); // "12.50"
 */
export function formatDecimal(value: Decimal, minDecimals: number, maxDecimals: number): string {
  const rounded = round(value, maxDecimals);
  const negative = rounded.units < 0n;
  const digits = (negative ? -rounded.units : rounded.units).toString().padStart(maxDecimals + 1, '0');
  const integerPart = digits.slice(0, digits.length - maxDecimals);
  let fraction = digits.slice(digits.length - maxDecimals);
  while (fraction.length > minDecimals && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  const text = fraction === '' ? integerPart : `${integerPart}.${fraction}`;
  return negative ? `-${text}` : text;
}
