import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ObjectId } from 'mongodb';
import { AppError } from '../../../shared/http/errors.ts';
import type { ErrorDetail } from '../../../shared/http/errors.ts';
import { INVALID, isoDate } from '../../../shared/validation/schema.ts';
import type { Schema } from '../../../shared/validation/schema.ts';

/** A stored object of unknown content. */
export type Raw = Readonly<Record<string, unknown>>;

/** What is wrong with a stored catalog, found while reading it (the read itself never fails). */
export type CatalogAnomalyKind = 'invalidType' | 'invalidElement' | 'invalidValue' | 'overLimit';

/** One anomaly of a stored catalog. */
export interface CatalogAnomaly {
  readonly kind: CatalogAnomalyKind;
  /** Stored path concerned, for example `taxes` or `priceLists.<id>`. */
  readonly field: string;
}

/** Most ids an element of a catalog may refer to in one list (a reference check is one `$in` of at most this many ids). */
export const MAX_REFERENCES = 500;

/** The ids of the elements of a catalog: what a path segment of the database and of the URL can safely carry. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A random id for a new element: 128 bits from the CSPRNG in base64url (22 characters). The legacy treats ids as opaque strings. */
export function newElementId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Tells whether a value is a plain object (not an array, not `null`).
 *
 * @param value The value to test.
 * @returns `true` for a plain object.
 */
export function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId);
}

/**
 * The value at a dotted path of a document (`undefined` when any step is missing or not an object).
 *
 * @param document The document to read.
 * @param path Dotted path of the field, such as `address.city`.
 * @returns The value at the path, or `undefined`.
 */
export function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * A text, or `null` when absent or not a string.
 *
 * @param raw The stored value.
 * @returns The text, or `null`.
 */
export function textOf(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/**
 * A flag: on only when exactly `true`.
 *
 * @param raw The stored value.
 * @returns `true` only when the flag is on.
 */
export function flagOf(raw: unknown): boolean {
  return raw === true;
}

/**
 * A finite number, or `null` when absent or not a finite number.
 *
 * @param raw The stored value.
 * @returns The number, or `null`.
 */
export function numberOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * A valid date as an ISO 8601 string, or `null` when absent or not a valid `Date`.
 *
 * @param raw The stored value.
 * @returns The date as ISO 8601 text, or `null`.
 */
export function dateOf(raw: unknown): string | null {
  return raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw.toISOString() : null;
}

/**
 * An integer, or `null`.
 *
 * @param raw The stored value.
 * @returns The integer, or `null`.
 */
export function integerOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
}

/**
 * A value that must be one of a closed list: the value when it is, `null` otherwise (and reported unless it was absent).
 *
 * @param raw The stored value.
 * @param allowed The accepted values.
 * @param field Stored path, for the anomaly.
 * @param anomalies Where to report.
 */
export function choiceOf<const T extends string>(raw: unknown, allowed: readonly T[], field: string, anomalies: CatalogAnomaly[]): T | null {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidValue', field });
  }
  return null;
}

/**
 * A list of strings: the strings of an array, the others reported; nothing when absent.
 *
 * @param raw The stored list.
 * @param field Field name reported in the anomalies.
 * @param anomalies Collector of the anomalies found.
 * @returns The strings of the list.
 */
export function stringsOf(raw: unknown, field: string, anomalies: CatalogAnomaly[]): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    anomalies.push({ kind: 'invalidType', field });
    return [];
  }
  return raw.flatMap((item: unknown) => {
    if (typeof item === 'string') {
      return [item];
    }
    anomalies.push({ kind: 'invalidElement', field });
    return [];
  });
}

/**
 * A list of ids stored as `ObjectId`: their hexadecimal form, the others reported; nothing when absent.
 *
 * @param raw The stored list.
 * @param field Field name reported in the anomalies.
 * @param anomalies Collector of the anomalies found.
 * @returns The hexadecimal ids of the list.
 */
export function objectIdsOf(raw: unknown, field: string, anomalies: CatalogAnomaly[]): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    anomalies.push({ kind: 'invalidType', field });
    return [];
  }
  return raw.flatMap((item: unknown) => {
    if (item instanceof ObjectId) {
      return [item.toHexString()];
    }
    anomalies.push({ kind: 'invalidElement', field });
    return [];
  });
}

/**
 * A nested object, or an empty one when absent; a value of another type is reported.
 *
 * @param raw The stored value.
 * @param field Field name reported in the anomalies.
 * @param anomalies Collector of the anomalies found.
 * @returns The nested object, or an empty one.
 */
export function nestedOf(raw: unknown, field: string, anomalies: CatalogAnomaly[]): Raw {
  if (isRecord(raw)) {
    return raw;
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidType', field });
  }
  return {};
}

/**
 * The stored objects of an array container (anything else in it is left out; so is a container that is not an array).
 *
 * @param raw The stored container.
 * @returns The objects of the array.
 */
export function recordsOf(raw: unknown): Raw[] {
  return (Array.isArray(raw) ? raw : []).filter(isRecord);
}

/**
 * The ids of the elements stored in a container: the keys of a map, the `id` of the elements of an array.
 *
 * @param raw The stored container.
 * @param kind Kind of the container: `map` or `array`.
 * @returns The ids of the elements.
 */
export function storedIds(raw: unknown, kind: 'map' | 'array'): Set<string> {
  return new Set(kind === 'map' ? (isRecord(raw) ? Object.keys(raw) : []) : recordsOf(raw).flatMap((item) => (typeof item['id'] === 'string' ? [item['id']] : [])));
}

/**
 * The card types (stored under `fidelity.cardsTypes`) that satisfy a test, named `cardTypes.<id>` for the details of a refused deletion.
 *
 * @param cards The stored card types.
 * @param test Predicate applied to each card type.
 * @returns The names of the matching card types.
 */
export function cardTypesWhere(cards: unknown, test: (card: Raw) => boolean): string[] {
  return recordsOf(cards)
    .filter(test)
    .map((card) => `cardTypes.${String(card['id'])}`);
}

/** Same text apart from case: the comparison of names that must be unique. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Equality of two stored values. */
export const equal = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

/** `404 NOT_FOUND`. */
export const notFound = (): AppError => new AppError('NOT_FOUND');

/** `409 CONFLICT` with the field and a reason, for a state the request cannot be applied to. */
export const conflict = (field: string, issue: string): AppError => new AppError('CONFLICT', { details: [{ field, issue }] });

/** `422 VALIDATION_ERROR` for one field. */
export const invalid = (field: string, issue: 'incorrect' | 'tooMany' | 'notAllowed' | 'required'): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

/**
 * `409 CONFLICT` listing the elements that still refer to the one being deleted (at most 20).
 *
 * @param users Elements that still refer to the one being deleted.
 * @returns The conflict error to return.
 */
export function referenced(users: readonly string[]): AppError {
  const details: ErrorDetail[] = users.slice(0, 20).map((field) => ({ field, issue: 'referenced' }));
  return new AppError('CONFLICT', { details });
}

/**
 * A string schema for an instant: an ISO 8601 date or UTC date-time, kept as the normalized `YYYY-MM-DDTHH:mm:ss.sssZ` text.
 */
export function isoInstant(): Schema<string, false> {
  const inner = isoDate();
  return {
    optional: false,
    parse: (value, path, context, depth) => {
      const parsed = inner.parse(value, path, context, depth);
      return parsed === INVALID ? INVALID : parsed.toISOString();
    },
  };
}

/** Whether a value is a plain object, for the merge of patches. */
function mergeable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies a JSON Merge Patch to a domain element: objects are merged key by key, everything else (scalars, `null`, arrays) replaces. A key
 * the patch does not carry is left alone.
 *
 * @param current The element as it is.
 * @param patch The validated body.
 * @returns A new element.
 */
export function mergePatch<T extends object>(current: T, patch: object): T {
  const result: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = mergeable(value) && mergeable(existing) ? mergePatch(existing, value) : value;
  }
  return result as T;
}
