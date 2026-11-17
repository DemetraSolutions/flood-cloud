import { createHmac } from 'node:crypto';
import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { toCountryReference } from '../reference/reference.mapper.ts';
import type { CountryReference } from '../reference/reference.mapper.ts';

/** The fields of a stored country the routes read (the whole country but its dates). */
export const COUNTRY_PROJECTION = Object.freeze({ code: 1, name: 1, areas: 1 } as const);

/** The owned fields a version covers, in a fixed order, after `_id`. The dates are left out: the legacy sets `updateDate` on every write, so it would say nothing about the parts this service checks. */
const VERSIONED_FIELDS: readonly string[] = Object.freeze(['code', 'name', 'areas']);

/**
 * The version of a stored country, the `ETag` of the reads and the `If-Match` of the writes: HMAC-SHA256 with the secret key of the server, in base64url, of a canonical form of `_id`, `code`, `name` and
 * `areas` (every key of every area included), each as present with its value or as absent (absent is not `null`). A change made by the legacy to any of them changes the version; a change to a key the
 * backend does not own (or to a date) does not.
 *
 * @param document The stored document, read with {@link COUNTRY_PROJECTION}.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function countryVersionOf(document: Document, key: Buffer): string {
  const parts = ['_id', ...VERSIONED_FIELDS].map((field) => (Object.hasOwn(document, field) ? { field, value: document[field] as unknown } : { field, absent: true }));
  return createHmac('sha256', key).update(BSON.serialize({ parts })).digest('base64url');
}

/**
 * The representation of a stored country: the same as the reference list (`code`, `name`, `areas` with `code` and `name`), read tolerantly.
 *
 * @param document A document found by its exact code, so the code is usable.
 */
export function toCountry(document: Document): CountryReference {
  return toCountryReference(document)!;
}
