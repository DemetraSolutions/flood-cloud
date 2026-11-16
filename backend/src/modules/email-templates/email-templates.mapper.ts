import { createHmac } from 'node:crypto';
import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** A template as the list shows it: never its content. */
export interface EmailTemplateSummary {
  readonly id: string;
  readonly name: string;
  /** Last change (the creation when it was never changed), ISO 8601; `null` when the document has no valid date. */
  readonly updatedAt: string | null;
}

/** A template with its content. */
export interface EmailTemplate extends EmailTemplateSummary {
  /** The plain-text version. */
  readonly text: string;
  /** The HTML as saved; to be shown only isolated, never served as `text/html`. */
  readonly html: string;
  readonly createdAt: string | null;
}

/** The fields of a stored template the API reads (a projection). */
export const TEMPLATE_PROJECTION = Object.freeze({ name: 1, text: 1, html: 1, insertDate: 1, updateDate: 1 } as const);

/** The fields of the list: no `text` and no `html`, so the content never leaves the database for a list. */
export const TEMPLATE_SUMMARY_PROJECTION = Object.freeze({ name: 1, insertDate: 1, updateDate: 1 } as const);

const stringOr = (value: unknown): string => (typeof value === 'string' ? value : '');
const isoOf = (value: unknown): string | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null);
const idOf = (document: Document): string => (document['_id'] instanceof ObjectId ? document['_id'].toHexString() : '');

/**
 * The compact form of a stored template for the list: a field of the wrong type (the legacy writes whatever the client sent) is an empty name or no date.
 *
 * @param document The stored document, read with {@link TEMPLATE_SUMMARY_PROJECTION}.
 */
export function toSummary(document: Document): EmailTemplateSummary {
  return { id: idOf(document), name: stringOr(document['name']), updatedAt: isoOf(document['updateDate']) ?? isoOf(document['insertDate']) };
}

/**
 * The whole form of a stored template.
 *
 * @param document The stored document, read with {@link TEMPLATE_PROJECTION}.
 */
export function toTemplate(document: Document): EmailTemplate {
  return { ...toSummary(document), text: stringOr(document['text']), html: stringOr(document['html']), createdAt: isoOf(document['insertDate']) };
}

/**
 * The version of a stored template, the `ETag` of the reads and the `If-Match` of the writes: HMAC-SHA256 with the secret key of the server, in base64url, of the id, the three fields and
 * the date of the last change. A change by the legacy to any of them changes the version.
 *
 * @param document The stored document, read with {@link TEMPLATE_PROJECTION}.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function versionOf(document: Document, key: Buffer): string {
  const updated = document['updateDate'];
  const parts = { id: idOf(document), name: stringOr(document['name']), text: stringOr(document['text']), html: stringOr(document['html']), updated: updated instanceof Date ? updated.getTime() : null };
  return createHmac('sha256', key).update(BSON.serialize(parts)).digest('base64url');
}
