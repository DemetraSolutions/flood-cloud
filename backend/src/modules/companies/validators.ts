/**
 * Pure validators of the fiscal and bank data of a company: Italian VAT number and fiscal code with their check digits, IBAN with the
 * ISO 13616 checksum, BIC, ABI and CAB, the recipient code and the tax regime of the Italian e-invoice. They give a yes or a no and never an
 * explanation that repeats the value.
 */
import { isValidItalianVatDigits } from '../../shared/legacy-write/vat.ts';

/** Tax regimes of the Italian e-invoice (`RegimeFiscale`): `RF03` was abolished. */
export const TAX_REGIMES = Object.freeze([
  'RF01',
  'RF02',
  'RF04',
  'RF05',
  'RF06',
  'RF07',
  'RF08',
  'RF09',
  'RF10',
  'RF11',
  'RF12',
  'RF13',
  'RF14',
  'RF15',
  'RF16',
  'RF17',
  'RF18',
  'RF19',
] as const);

/**
 * Whether a text is an Italian VAT number: eleven digits with the check digit, with or without the `IT` prefix (kept as given by the caller).
 *
 * @param value The VAT number as typed, already trimmed.
 */
export function isValidItalianVatNumber(value: string): boolean {
  const match = /^(?:IT)?(\d{11})$/i.exec(value);
  return match !== null && isValidItalianVatDigits(match[1] as string);
}

/** Value of a character of the fiscal code in an odd position (the first, third…), digits and letters. */
const ODD_VALUES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23][index] as number]),
  ),
);

/** Digits and letters that stand for the digits `0` to `9` in the places of the fiscal code that homonymous people change (`LMNPQRSTUV`). */
const OMOCODIA_LETTERS = 'LMNPQRSTUV';

/**
 * Whether sixteen characters are an Italian personal fiscal code (codice fiscale): the shape (letters for surname, name and birth place, the digits
 * of the birth date and number, with the letters `LMNPQRSTUV` accepted in place of digits for the homonymous) and the check character.
 *
 * @param value Sixteen characters, upper case.
 */
export function isValidItalianFiscalCodeOfPerson(value: string): boolean {
  const digit = `[0-9${OMOCODIA_LETTERS}]`;
  if (!new RegExp(`^[A-Z]{6}${digit}{2}[ABCDEHLMPRST]${digit}{2}[A-Z]${digit}{3}[A-Z]$`).test(value)) {
    return false;
  }
  let total = 0;
  for (let index = 0; index < 15; index += 1) {
    const character = value[index] as string;
    const letter = /[0-9]/.test(character) ? 'ABCDEFGHIJ'[Number(character)]! : character;
    total += index % 2 === 0 ? (ODD_VALUES[letter] as number) : letter.charCodeAt(0) - 65;
  }
  return value[15] === String.fromCharCode(65 + (total % 26));
}

/**
 * Whether a text is the fiscal code of an Italian company or person: eleven digits with the check digit of a VAT number, or the sixteen
 * characters of a personal code with their check character. Upper case only: the caller normalizes first.
 *
 * @param value The fiscal code, trimmed and upper case.
 */
export function isValidItalianFiscalCode(value: string): boolean {
  return value.length === 11 ? isValidItalianVatDigits(value) : isValidItalianFiscalCodeOfPerson(value);
}

/**
 * The form of an IBAN the service stores: without spaces and in upper case.
 *
 * @param value An IBAN as typed.
 */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * Whether a normalized text is a valid IBAN (ISO 13616): two letters, two check digits and up to 30 letters or digits (15 to 34 in all), and the
 * checksum (the number made by moving the first four characters to the end and writing every letter as two digits leaves 1 when divided by 97); an Italian one
 * has its fixed 27 characters and shape.
 *
 * @param iban The IBAN, already normalized with {@link normalizeIban}.
 */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban) || (iban.startsWith('IT') && !/^IT\d{2}[A-Z]\d{10}[A-Z0-9]{12}$/.test(iban))) {
    return false;
  }
  let remainder = 0;
  for (const character of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const value = character >= 'A' ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Whether a text is the ABI (bank) or CAB (branch) code of an Italian bank: five digits. */
export const isValidBankCode = (value: string): boolean => /^\d{5}$/.test(value);

/** Whether a text is a BIC (SWIFT) code: four letters of the institution, two of the country, two letters or digits of the place and, optionally, three of the branch. Upper case. */
export const isValidBic = (value: string): boolean => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value);

/** Whether a text is the recipient code (`codice destinatario`) of the Italian e-invoice: six or seven upper case letters or digits. */
export const isValidRecipientCode = (value: string): boolean => /^[A-Z0-9]{6,7}$/.test(value);

/** Whether a text is a decimal amount written as text, at most two decimals (`1000`, `1000.50`): the share capital of the REA data. */
export const isValidDecimalText = (value: string): boolean => /^\d{1,15}(?:\.\d{1,2})?$/.test(value);

/**
 * Whether a text is an ISO 8601 calendar date `YYYY-MM-DD` that exists (`2026-02-30` does not).
 *
 * @param value The text.
 */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** What a VAT number or fiscal code of a country other than Italy may be: printable ASCII, without spaces at the ends (no invisible or non-ASCII characters, which would defeat the uniqueness check). */
export const PRINTABLE_ASCII = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;
