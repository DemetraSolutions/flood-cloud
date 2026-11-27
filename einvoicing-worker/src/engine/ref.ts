/**
 * The identity of an invoice read straight from a queue record, without mapping or validating it.
 *
 * A record found `uploading` may already be at the provider; the lookup that settles it must not depend on the record
 * passing today's validation. The fields mirror what the mapper writes (`InvoiceRef`): seller identifier, number with the
 * company's section rule, date in Rome, progressive, document type, and when the search starts: the later of the first upload (`worker.firstUploadAt`) and the end of the last complete search that found nothing (`worker.searchedUntil`), plus where an interrupted search stopped (`worker.findFrom`). Nothing is guessed: a missing or unusable field gives no reference.
 *
 * @module
 */
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { InvoiceRef, SearchPosition } from '../providers/types.ts';
import { romeDate } from '../time.ts';

/** A non-empty text (numbers are accepted: the legacy stores numbers where codes are expected), or `''`. */
function text(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === 'string' ? value.trim() : '';
}

/** The stored resume point of an interrupted search, when it is well-formed. */
function searchPositionOf(value: unknown): SearchPosition | undefined {
  const position = (value ?? {}) as Document;
  const { slice, page } = position;
  return Number.isSafeInteger(slice) && Number.isSafeInteger(page) && (slice as number) >= 0 && (page as number) >= 0 ? { slice: slice as number, page: page as number } : undefined;
}

/**
 * Builds the reference of a record.
 *
 * @param record The queue record.
 * @returns The reference, or `undefined` when the record lacks its id, seller code, number, date, progressive, document type or first upload time.
 */
export function rawInvoiceRef(record: Document): InvoiceRef | undefined {
  const id: unknown = record['_id'];
  const company = (record['company'] ?? {}) as Document;
  const vat = text(company['code']).toUpperCase().replace(/^IT/, '');
  const digits = text(record['number']);
  const progressive = text(((record['fattura_elettronica'] ?? {}) as Document)['progressivo_invio']);
  const documentType = text(((record['fattura_elettronica'] ?? {}) as Document)['tipo']);
  const worker = (record['worker'] ?? {}) as Document;
  const first: unknown = worker['firstUploadAt'];
  const searched: unknown = worker['searchedUntil'];
  const from: unknown = worker['findFrom'];
  const raw: unknown = record['date'];
  const date = raw instanceof Date || typeof raw === 'string' ? new Date(raw) : undefined;
  if (!(id instanceof ObjectId) || vat === '' || digits === '' || progressive === '' || documentType === '' || !(first instanceof Date) || date === undefined || Number.isNaN(date.getTime())) {
    return undefined;
  }
  const position = searchPositionOf(from);
  const section = typeof record['prefixSuffix'] === 'string' ? record['prefixSuffix'] : '';
  const mode: unknown = company['invoicesPS'];
  const number = mode === 'prefix' ? `${section}${digits}` : mode === 'suffix' ? `${digits}${section}` : digits;
  return { queueId: id.toHexString(), sellerVat: `IT${vat}`, number, date: romeDate(date.getTime()), progressive, documentType, since: Math.max(first.getTime(), searched instanceof Date ? searched.getTime() : 0), ...(position === undefined ? {} : { resume: position }) };
}
