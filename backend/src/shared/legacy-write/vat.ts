import type { Document, Filter } from 'mongodb';
import { escapeRegExp } from '../http/list.ts';

/**
 * The form of a VAT number the uniqueness check compares: trimmed, upper case, without any space and, when it is an Italian one (the two letters
 * `IT` followed by exactly eleven digits), without the prefix. `IT 01234567890`, `it01234567890` and `01234567890` are the same number; a foreign
 * number keeps its prefix (`DE123456789`).
 *
 * @param value A stored or requested VAT number.
 * @returns The normalized form, empty when the value has nothing but spaces.
 */
export function normalizeVatNumber(value: string): string {
  const compact = value.replace(/[ \t]+/g, '').toUpperCase();
  return /^IT\d{11}$/.test(compact) ? compact.slice(2) : compact;
}

/**
 * The filter that finds the stored companies whose VAT number normalizes to the given one: the stored value may be written with spaces, in lower
 * case or with the `IT` prefix, so the match is a regular expression built from the normalized form (every character escaped, any spaces or tabs (the same two characters {@link normalizeVatNumber} removes, never Unicode spaces, which the database pattern would not match) allowed
 * between them, the prefix allowed only before eleven digits). The group databases are small (some companies each), so no index is needed.
 *
 * @param normalized A non-empty result of {@link normalizeVatNumber}.
 * @returns A filter on `code`.
 */
export function vatNumberFilter(normalized: string): Filter<Document> {
  const body = [...normalized].map((character) => escapeRegExp(character)).join('[ \\t]*');
  const prefix = /^\d{11}$/.test(normalized) ? '(?:I[ \\t]*T)?[ \\t]*' : '';
  return { code: { $regex: `^[ \\t]*${prefix}${body}[ \\t]*$`, $options: 'i' } };
}

/**
 * Whether eleven digits are an Italian VAT number: the last digit is the check digit of the first ten (the digits in even positions are
 * doubled, and 9 is taken off those that become larger than 9; the total, check digit included, is a multiple of ten).
 *
 * @param digits Exactly eleven digits.
 * @returns `true` when the check digit is right.
 */
export function isValidItalianVatDigits(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) {
    return false;
  }
  let total = 0;
  for (let index = 0; index < 11; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    total += digit;
  }
  return total % 10 === 0;
}
