import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** The refusal the hub gave to a document, as the table shows it. */
export interface ErrorDocumentErrorView {
  /** The code of the hub (`0034`...), `null` when it gave none. */
  readonly code: string | null;
  /** Plain text, trimmed, at most {@link MAX_DESCRIPTION} characters: it must be shown as text, never as markup. */
  readonly description: string | null;
}

/** One electronic document in error. The only representation that leaves the server: the XML, the fiscal and personal data of the counterpart, the hub's file name and the raw error object never do. */
export interface ErrorDocumentView {
  readonly id: string;
  /** `null` only for a queue document whose `groupId` is not an id (junk legacy data). */
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly companyName: string | null;
  /** The number as the legacy page showed it: the stored prefix or suffix, with its own separator, before or after the stored number. */
  readonly number: string | null;
  readonly date: string | null;
  readonly documentType: 'invoice' | 'creditNote' | null;
  /** The type of the electronic document (`TD01`...). */
  readonly eInvoiceType: string | null;
  readonly customer: string | null;
  readonly total: number | null;
  readonly sendStatus: string | null;
  readonly error: ErrorDocumentErrorView | null;
}

/** Longest error description the table carries. */
export const MAX_DESCRIPTION = 2000;

/** Longest text of any other stored value a row carries. */
const MAX_TEXT = 200;

/** Longest stored prefix or suffix, and longest stored number, a displayed number is made of. */
const MAX_NUMBER_PART = 50;

/** Cuts a text to a length without leaving half of a surrogate pair at the end. */
function truncate(value: string, max: number): string {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A stored text (or number) as a trimmed, cut text, `null` when it is not one or is empty. */
function text(value: unknown, max = MAX_TEXT): string | null {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const trimmed = raw.trim();
  return trimmed === '' ? null : truncate(trimmed, max);
}

/** A stored text (or number) exactly as stored, only cut: the separators of a prefix or a suffix are part of it. */
function verbatim(value: unknown): string {
  const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return truncate(raw, MAX_NUMBER_PART);
}

/** A stored date (a date, or a text or a number a date can be made of) as an ISO text, `null` when it is none. */
function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A stored value when it is an object (not an array), else an empty one. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof ObjectId) ? (value as Record<string, unknown>) : {};
}

/**
 * The number of a document as the legacy page built it (`BO/views/error-documents/view.html`): the stored prefix or suffix goes before (`company.invoicesPS === 'prefix'`) or after
 * (`'suffix'`) the stored number, with no separator of its own (the stored one is part of it: `/B`, ` M`, `A`); any other position shows the number alone.
 *
 * @param number The stored `number`.
 * @param prefixSuffix The stored `prefixSuffix`.
 * @param position The stored `company.invoicesPS`.
 * @returns The text, or `null` when the document has no number.
 */
export function displayNumber(number: unknown, prefixSuffix: unknown, position: unknown): string | null {
  const main = verbatim(number);
  if (main === '') {
    return null;
  }
  const affix = verbatim(prefixSuffix);
  return position === 'prefix' ? `${affix}${main}` : position === 'suffix' ? `${main}${affix}` : main;
}

/** The customer as the legacy page showed it: name and surname for a person (`customerType` 1), the company name for a company (2), nothing else. */
function customerOf(document: Document): string | null {
  const counterpart = objectOf(document['counterpart']);
  if (document['customerType'] === 1) {
    return text([text(counterpart['name']), text(counterpart['surname'])].filter((part) => part !== null).join(' '));
  }
  return document['customerType'] === 2 ? text(counterpart['companyName']) : null;
}

/** The hub's refusal: `null` when the document has none, else its code and its description, whatever shape the stored value has. */
function errorOf(stored: unknown): ErrorDocumentErrorView | null {
  if (stored === null || stored === undefined) {
    return null;
  }
  if (typeof stored === 'string') {
    return { code: null, description: text(stored, MAX_DESCRIPTION) };
  }
  const fields = objectOf(stored);
  return { code: text(fields['errorCode'], 50), description: typeof fields['errorDescription'] === 'string' ? text(fields['errorDescription'], MAX_DESCRIPTION) : null };
}

/**
 * Maps a document read from the legacy send queue to its row, field by field: nothing of the stored data goes out that is not named here, and every value is checked for its type (a
 * value of the wrong type is `null`; nothing throws).
 *
 * @param document The queue document, read with the projection of the repository.
 * @param groupNames Names of the groups of the page, by hexadecimal id.
 */
export function toErrorDocument(document: Document, groupNames: ReadonlyMap<string, string>): ErrorDocumentView {
  const groupId: unknown = document['groupId'];
  const groupHex = groupId instanceof ObjectId ? groupId.toHexString() : null;
  const fe = objectOf(document['fattura_elettronica']);
  const company = objectOf(document['company']);
  const total: unknown = document['total'];
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    groupId: groupHex,
    groupName: groupHex === null ? null : text(groupNames.get(groupHex)),
    companyName: text(company['name']),
    number: displayNumber(document['number'], document['prefixSuffix'], company['invoicesPS']),
    date: isoDate(document['date']),
    documentType: document['type'] === 'invoice' ? 'invoice' : document['type'] === 'credit-note' ? 'creditNote' : null,
    eInvoiceType: text(fe['tipo']),
    customer: customerOf(document),
    total: typeof total === 'number' && Number.isFinite(total) ? total : null,
    sendStatus: text(document['sendStatus']),
    error: errorOf(document['error']),
  };
}
