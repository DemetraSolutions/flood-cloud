/**
 * From a queue record to a file ready to send: map, validate, check for a duplicate, serialize, check the size.
 *
 * A credit note (`fromDocumentId`) cites the invoice it corrects: the original is read from the group's `documents`
 * (number, section and date only) and passed to the mapper. An original that cannot be found is a warning, not an
 * error: the credit note is then sent without the `DatiFattureCollegate` block.
 *
 * @module
 */
import type { Document, ObjectId } from 'mongodb';
import { mapQueueRecord } from '../invoice/from-queue.ts';
import type { LinkedInvoice, MappingIssue } from '../invoice/from-queue.ts';
import type { InvoiceModel } from '../invoice/model.ts';
import { serialize } from '../invoice/serialize.ts';
import type { OutgoingFile } from '../providers/types.ts';
import { romeDate } from '../time.ts';
import { checkDuplicate, duplicateKeyOf } from '../validation/duplicates.ts';
import type { DuplicateLookup } from '../validation/duplicates.ts';
import { error, sortIssues, warning } from '../validation/issue.ts';
import type { ValidationIssue } from '../validation/issue.ts';
import { checkFileSize, validateInvoice } from '../validation/validate.ts';
import type { GroupStore } from './groups.ts';

/** Collaborators of {@link prepareInvoice}. */
export interface PrepareOptions {
  /** The transmitter of the provider adapter. */
  readonly transmitter: { readonly IdPaese: string; readonly IdCodice: string };
  /** Read access to the original of a credit note: nothing else of the group store is needed (the shadow mode relies on it). */
  readonly groups: Pick<GroupStore, 'readOriginal'>;
  /** The duplicate lookup of the record being prepared. */
  readonly lookup: DuplicateLookup;
  /** Worker clock (the sending day is today in Europe/Rome). */
  readonly now: number;
}

/** The result of {@link prepareInvoice}. */
export type Prepared =
  | {
      readonly ok: true;
      readonly file: OutgoingFile;
      /** The key of the duplicate check, kept in the history once the provider accepts the file. */
      readonly key: string;
      /** The warnings found (none blocks the sending). */
      readonly warnings: readonly ValidationIssue[];
    }
  | {
      readonly ok: false;
      /** How many of {@link Prepared.issues} are errors. */
      readonly errors: number;
      /** Errors first, then warnings. */
      readonly issues: readonly ValidationIssue[];
      /** Identity of the document, when the record could be mapped (absent when the mapping failed). */
      readonly document?: { readonly number: string; readonly date: string; readonly documentType: string };
      /** The serialized file, when one was built (only a file over the size limit is built and still refused). */
      readonly xml?: string;
    };

const MAPPING_MESSAGES: Readonly<Record<MappingIssue['issue'], string>> = {
  missing: 'Dato obbligatorio mancante',
  invalid: 'Dato non valido',
  unsupported: 'Valore non gestito',
};

/** The original document of a credit note as the mapper wants it, or `undefined` when it cannot be used. */
function toLinkedInvoice(original: Document | null): LinkedInvoice | undefined {
  if (original === null) {
    return undefined;
  }
  const number: unknown = original['number'];
  const digits = typeof number === 'number' && Number.isFinite(number) ? String(number) : number;
  if (typeof digits !== 'string' || digits.trim() === '') {
    return undefined;
  }
  const prefixSuffix: unknown = original['prefixSuffix'];
  const date: unknown = original['date'];
  return {
    number: digits,
    prefixSuffix: typeof prefixSuffix === 'string' ? prefixSuffix : '',
    date: date instanceof Date && !Number.isNaN(date.getTime()) ? date : null,
  };
}

/** The seller's identifier of a model. */
function sellerOf(model: InvoiceModel): string {
  const id = model.versione === 'FSM10' ? model.FatturaElettronicaHeader.CedentePrestatore.IdFiscaleIVA : model.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA;
  return `${id.IdPaese}${id.IdCodice}`;
}

/**
 * Prepares one record.
 *
 * @param record The queue record (the whole document).
 * @param options Transmitter, group store, duplicate lookup and the clock.
 * @returns The file and its duplicate key, or every error and warning found. Nothing with an error is ever sent.
 * @throws Whatever the group store or the duplicate lookup throws (the caller retries later).
 */
export async function prepareInvoice(record: Document, options: PrepareOptions): Promise<Prepared> {
  const hasOriginal = record['fromDocumentId'] !== undefined && record['fromDocumentId'] !== null;
  const linkedInvoice = hasOriginal ? toLinkedInvoice(await options.groups.readOriginal(record['groupId'], record['fromDocumentId'])) : undefined;
  const mapped = mapQueueRecord(record, linkedInvoice === undefined ? { transmitter: options.transmitter } : { transmitter: options.transmitter, linkedInvoice });
  if (!mapped.ok) {
    const issues = mapped.issues.map((entry) => error('MAPPING', entry.path, MAPPING_MESSAGES[entry.issue]));
    return { ok: false, errors: issues.length, issues: sortIssues(issues) };
  }
  const { model } = mapped;
  const checked = validateInvoice(model, { sendDate: romeDate(options.now), mappingWarnings: mapped.warnings });
  const errors = [...checked.errors];
  const warnings = [...checked.warnings];
  const duplicate = await checkDuplicate(model, options.lookup);
  if (duplicate !== undefined) {
    errors.push(duplicate);
  }
  if (hasOriginal && model.versione !== 'FSM10' && model.FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate === undefined) {
    warnings.push(warning('LINKED', 'FatturaElettronicaBody[0].DatiGenerali.DatiFattureCollegate', 'Fattura originale non trovata: la nota di credito non cita la fattura collegata'));
  }
  const xml = errors.length === 0 ? serialize(model) : '';
  const size = errors.length === 0 ? checkFileSize(xml) : undefined;
  if (size !== undefined) {
    errors.push(size);
  }
  const general = model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento;
  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.length,
      issues: [...errors, ...warnings],
      document: { number: general.Numero, date: general.Data, documentType: general.TipoDocumento },
      ...(xml === '' ? {} : { xml }),
    };
  }
  return {
    ok: true,
    key: duplicateKeyOf(model),
    warnings,
    file: {
      queueId: (record['_id'] as ObjectId).toHexString(),
      sellerVat: sellerOf(model),
      number: general.Numero,
      date: general.Data,
      progressive: model.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio,
      documentType: general.TipoDocumento,
      xml,
    },
  };
}
