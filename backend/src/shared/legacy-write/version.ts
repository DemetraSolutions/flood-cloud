import { createHash } from 'node:crypto';
import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { COMPANIES_OWNED_FIELDS, PLACES_OWNED_FIELDS } from '../../db/collections.ts';

/**
 * The paths a version is computed on, in a fixed order: `_id`, then the owned fields of the entity (which include `trash`, and `companyId` for
 * places; for companies every key of the blocks, as dotted paths) except `updateDate`. `updateDate` is left out because the legacy sets it on every
 * write, the POS's too, so it would say nothing about the parts this service checks.
 */
const VERSIONED_PATHS: Readonly<Record<'companies' | 'places', readonly string[]>> = Object.freeze({
  companies: Object.freeze(['_id', ...COMPANIES_OWNED_FIELDS.filter((field) => field !== 'updateDate')]),
  places: Object.freeze(['_id', ...PLACES_OWNED_FIELDS.filter((field) => field !== 'updateDate')]),
});

/** Whether a value is a plain stored object (a sub-document), the only thing a dotted path goes through. */
function isSubDocument(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Looks a dotted path up in a stored document: found with its value (which may be `null`), or absent when a step is missing or goes through
 * something that is not a sub-document.
 */
function lookup(document: Document, path: string): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let current: unknown = document;
  for (const key of path.split('.')) {
    if (!isSubDocument(current) || !Object.hasOwn(current, key)) {
      return { found: false };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

/**
 * The version of a stored document: SHA-256, in base64url, of a canonical form of the parts the write service owns and checks: `_id` and the
 * owned fields (so `trash`, for a place `companyId` and, for a company, every owned key of its blocks, `banks` and the other arrays included), in a fixed order,
 * each as present with its value or as absent (absent is not `null`; a dotted path is absent when a step of it is missing or is not a sub-document).
 * The document must be read with the exact types (`EXACT_TYPES`), so a changed value or type (`Int32` that becomes `Double`) counts.
 * A change by the legacy to an owned field (`name`, `settings.ecommerce.status`…) changes the version; a write of the POS on `devices`, `rooms`
 * or any key the service does not own (an unknown key of `settings`) does not, so it never makes an update fail. It is the token the routes will expose as `ETag` and accept as
 * `If-Match` (`doc/Tasks.md` 5.6.4).
 *
 * @param kind `companies` or `places`.
 * @param document The document as stored in the group database.
 * @returns The version, 43 characters.
 */
export function versionOf(kind: 'companies' | 'places', document: Document): string {
  const parts = VERSIONED_PATHS[kind].map((path) => {
    const found = lookup(document, path);
    return found.found ? { path, value: found.value } : { path, absent: true };
  });
  return createHash('sha256').update(BSON.serialize({ parts })).digest('base64url');
}
