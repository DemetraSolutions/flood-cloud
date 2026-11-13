import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { COMPANIES_OWNED_FIELDS, PLACES_OWNED_FIELDS } from '../../db/collections.ts';

/**
 * The top-level paths a version is computed on, in a fixed order: `_id`, then the owned fields of the entity (which include `trash`, and
 * `companyId` for places) except `updateDate`. `updateDate` is left out because the legacy sets it on every write, the POS's too, so it would
 * say nothing about the parts this service checks.
 */
const VERSIONED_PATHS: Readonly<Record<'companies' | 'places', readonly string[]>> = Object.freeze({
  companies: Object.freeze(['_id', ...COMPANIES_OWNED_FIELDS.filter((field) => field !== 'updateDate')]),
  places: Object.freeze(['_id', ...PLACES_OWNED_FIELDS.filter((field) => field !== 'updateDate')]),
});

/**
 * The version of a stored document: SHA-256, in base64url, of a canonical form of the parts the write service owns and checks: `_id` and the
 * owned fields (so `trash` and, for a place, `companyId`), in a fixed order, each as present with its value or as absent (absent is not `null`).
 * The document must be read with the exact types (`EXACT_TYPES`), so a changed value or type (`Int32` that becomes `Double`) counts.
 * A change by the legacy to an owned field (`name`…) changes the version; a write of the POS on `devices`, `rooms` or any block the service
 * does not own does not, so it never makes a registry update fail. It is the token the routes will expose as `ETag` and accept as
 * `If-Match` (`doc/Tasks.md` 5.6.4).
 *
 * @param kind `companies` or `places`.
 * @param document The document as stored in the group database.
 * @returns The version, 43 characters.
 */
export function versionOf(kind: 'companies' | 'places', document: Document): string {
  const parts = VERSIONED_PATHS[kind].map((path) => (Object.hasOwn(document, path) ? { path, value: document[path] as unknown } : { path, absent: true }));
  return createHash('sha256').update(BSON.serialize({ parts })).digest('base64url');
}
