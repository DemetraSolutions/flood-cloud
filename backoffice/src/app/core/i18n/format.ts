import { Language } from './language';

/**
 * Formats a date with `Intl` for the given language.
 *
 * @param value Date, ISO string or epoch milliseconds.
 * @param language Language of the output.
 * @param options Intl options; defaults to a medium date.
 * @throws RangeError when the value is not a valid date.
 */
export function formatDate(
  value: Date | string | number,
  language: Language,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(language, options).format(new Date(value));
}

/**
 * Formats a number with `Intl` for the given language.
 *
 * @param value The number.
 * @param language Language of the output.
 * @param options Intl options.
 */
export function formatNumber(
  value: number,
  language: Language,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(language, options).format(value);
}

/**
 * Formats an amount expressed in minor units (cents) as currency.
 *
 * @param minorUnits Amount in the smallest currency unit, e.g. `1999` for 19,99.
 * @param currency ISO 4217 code, e.g. `EUR`.
 * @param language Language of the output.
 * @throws RangeError when the currency code is invalid.
 */
export function formatMoney(minorUnits: number, currency: string, language: Language): string {
  const formatter = new Intl.NumberFormat(language, { style: 'currency', currency });
  // Always resolved for the currency style, although typed as optional.
  const digits = formatter.resolvedOptions().maximumFractionDigits as number;
  return formatter.format(minorUnits / 10 ** digits);
}
