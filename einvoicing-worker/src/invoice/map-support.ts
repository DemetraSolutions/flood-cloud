/**
 * Shared helpers of the mapping from a queue record to the invoice model (`from-queue.ts` and its companions).
 *
 * The mapper never throws for a data problem: every helper records an issue (or a warning) in a
 * {@link MapContext} and returns a harmless placeholder, so one pass reports every problem of the record. Issues
 * carry a path and a code and never the offending value (records hold personal data).
 *
 * @module
 */
import { cleanText, identifier } from './text.ts';
import type { Charset } from './text.ts';
import type { Indirizzo } from './model.ts';
import type { MappingIssue } from './queue-record.ts';

export type { MappingIssue } from './queue-record.ts';

/** Something the mapper changed in a text that the validator may want to report; it never blocks the invoice. */
export interface MappingWarning {
  readonly path: string;
  /** `unrepresentable`: a character outside the repertoire became `?`; `truncated`: the text was cut at the field limit. */
  readonly warning: 'unrepresentable' | 'truncated';
}

/** Collector of issues and warnings of one mapping run. */
export interface MapContext {
  readonly issues: MappingIssue[];
  readonly warnings: MappingWarning[];
  /** IANA time zone in which dates and date-times are written. */
  readonly timeZone: string;
}

/**
 * Creates the context of a mapping run.
 *
 * @param timeZone IANA time zone name used to turn instants into calendar dates.
 * @returns An empty context.
 */
export function createContext(timeZone: string): MapContext {
  return { issues: [], warnings: [], timeZone };
}

/** Records a required datum that is absent. */
export function missing(context: MapContext, path: string): void {
  context.issues.push({ path, issue: 'missing' });
}

/** Records a datum with the wrong shape. */
export function invalid(context: MapContext, path: string): void {
  context.issues.push({ path, issue: 'invalid' });
}

/**
 * An optional property for an object literal: `{}` when the value is absent, so an absent datum is an absent
 * property (never `undefined`).
 *
 * @param key Property name.
 * @param value Value, or `undefined`.
 * @returns `{ [key]: value }` or an empty object.
 */
export function has<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/**
 * Cleans a free text (see `text.ts`), recording a warning when it lost information.
 *
 * @returns The cleaned text, or `undefined` when nothing is left.
 */
export function freeText(context: MapContext, path: string, raw: string, charset: Charset, maxLength: number): string | undefined {
  const cleaned = cleanText(raw, charset, maxLength);
  if (cleaned.replaced) {
    context.warnings.push({ path, warning: 'unrepresentable' });
  }
  if (cleaned.truncated) {
    context.warnings.push({ path, warning: 'truncated' });
  }
  return cleaned.value === '' ? undefined : cleaned.value;
}

/** Like {@link freeText} for a required field: an empty result is a `missing` issue and reads as `''`. */
export function requiredText(context: MapContext, path: string, raw: string, charset: Charset, maxLength: number): string {
  const value = freeText(context, path, raw, charset, maxLength);
  if (value === undefined) {
    missing(context, path);
    return '';
  }
  return value;
}

/**
 * Validates an identifier-like value, which is never altered: a value that is too long, has a character outside
 * printable Basic Latin, or does not match the pattern is an `invalid` issue, not a truncation.
 *
 * @returns The value, or `undefined` when it is empty (a `missing` issue when `required`) or invalid.
 */
export function code(
  context: MapContext,
  path: string,
  raw: string,
  maxLength: number,
  options: { readonly required: boolean; readonly pattern?: RegExp },
): string | undefined {
  if (raw.trim() === '') {
    if (options.required) {
      missing(context, path);
    }
    return undefined;
  }
  const value = identifier(raw, maxLength);
  if (value === null || (options.pattern !== undefined && !options.pattern.test(value))) {
    invalid(context, path);
    return undefined;
  }
  return value;
}

/** Like {@link code} for a required identifier: any problem reads as `''` (the issue is already recorded). */
export function requiredCode(context: MapContext, path: string, raw: string, maxLength: number, pattern?: RegExp): string {
  return code(context, path, raw, maxLength, pattern === undefined ? { required: true } : { required: true, pattern }) ?? '';
}

/** Like {@link code} for an optional identifier. */
export function optionalCode(context: MapContext, path: string, raw: string, maxLength: number, pattern?: RegExp): string | undefined {
  return code(context, path, raw, maxLength, pattern === undefined ? { required: false } : { required: false, pattern });
}

/**
 * Writes the calendar date of an instant in a time zone.
 *
 * @param date The instant.
 * @param timeZone IANA time zone name.
 * @returns `YYYY-MM-DD`.
 * @throws RangeError When the time zone name is not valid.
 */
export function formatDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value as string;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Earliest date the schema accepts for the invoice date (`DataFatturaType`). */
const MIN_INVOICE_DATE = '1970-01-01';

/**
 * Writes a required calendar date; an absent date is `missing`, a date before 1970 is `invalid`.
 *
 * @returns `YYYY-MM-DD`, or `''` after recording the issue.
 */
export function requiredInvoiceDate(context: MapContext, path: string, date: Date | null): string {
  if (date === null) {
    missing(context, path);
    return '';
  }
  const text = formatDate(date, context.timeZone);
  if (text < MIN_INVOICE_DATE) {
    invalid(context, path);
    return '';
  }
  return text;
}

/**
 * Normalizes a country code: upper case, and the three-letter `ITA` of the legacy data becomes `IT`.
 *
 * @param raw The code as stored.
 * @returns The normalized code (possibly empty or not valid: see {@link address}).
 */
export function normalizeCountry(raw: string): string {
  const country = raw.trim().toUpperCase();
  return country === 'ITA' ? 'IT' : country;
}

/** The pieces of an address as stored in the record. */
export interface RawAddress {
  readonly street: string;
  readonly civic?: string;
  readonly postcode: string;
  readonly city: string;
  readonly area: string;
  readonly country: string;
}

const COUNTRY = /^[A-Z]{2}$/;
const POSTCODE = /^\d{5}$/;
/** Postcode written for an address abroad whose postcode is not of five digits (the schema requires five). */
const FOREIGN_POSTCODE = '00000';

/**
 * Maps an address. For Italy the postcode must have five digits and the province, when present, two letters; for
 * any other country the province is omitted (the schema wants it only for Italy) and a postcode that is not of five
 * digits is written as `00000` (the convention for foreign addresses, since the schema type is numeric of length 5).
 *
 * @param context Issues and warnings collector.
 * @param path XSD path of the address element (the issues add the child name).
 * @param raw The stored pieces.
 * @returns The address; its `Nazione` is `''` when the country is absent or not an ISO alpha-2 code.
 */
export function address(context: MapContext, path: string, raw: RawAddress): Indirizzo {
  const country = normalizeCountry(raw.country);
  if (country === '') {
    missing(context, `${path}.Nazione`);
  } else if (!COUNTRY.test(country)) {
    invalid(context, `${path}.Nazione`);
  }
  const italy = country === 'IT';
  const postcode = raw.postcode.replace(/\s+/g, '');
  return {
    Indirizzo: requiredText(context, `${path}.Indirizzo`, raw.street, 'latin', 60),
    ...has('NumeroCivico', raw.civic === undefined ? undefined : optionalCode(context, `${path}.NumeroCivico`, raw.civic, 8)),
    CAP: italy ? requiredCode(context, `${path}.CAP`, postcode, 5, POSTCODE) : POSTCODE.test(postcode) ? postcode : FOREIGN_POSTCODE,
    Comune: requiredText(context, `${path}.Comune`, raw.city, 'latin', 60),
    ...has('Provincia', italy ? optionalCode(context, `${path}.Provincia`, raw.area.toUpperCase(), 2, /^[A-Z]{2}$/) : undefined),
    Nazione: COUNTRY.test(country) ? country : '',
  };
}
