/**
 * Entry point of the pre-send validator (step EI4).
 *
 * The queue engine runs: map the record (`mapQueueRecord`), **validate** (`validateInvoice`, then `checkDuplicate`),
 * serialize, **check the size** (`checkFileSize`), send. An invoice with errors is never sent. The validator is pure:
 * no database, no clock (the day of sending is an input), no network.
 *
 * @module
 */
import type { InvoiceModel } from '../invoice/model.ts';
import type { MappingWarning } from '../invoice/map-support.ts';
import { checkFiscalIds } from './fiscal-ids.ts';
import { error, sortIssues, warning } from './issue.ts';
import type { ValidationIssue, ValidationResult } from './issue.ts';
import { checkSdi } from './sdi-checks.ts';
import { validateSchema } from './schema-validate.ts';

export type { ValidationIssue, ValidationResult } from './issue.ts';

/** Largest file accepted: 5 000 000 bytes, the conservative reading of the "5 MB" of the SdI (web and API channels) and of the provider. */
export const MAX_FILE_BYTES = 5_000_000;

/** Inputs of {@link validateInvoice}. */
export interface ValidationContext {
  /** Day the file will reach the SdI, `YYYY-MM-DD` in the Europe/Rome time zone (check 00403). */
  readonly sendDate: string;
  /** Warnings of the mapping, passed through as `TEXT` warnings. */
  readonly mappingWarnings?: readonly MappingWarning[];
}

const TEXT_MESSAGES: Readonly<Record<MappingWarning['warning'], string>> = {
  unrepresentable: 'Il testo conteneva caratteri non rappresentabili, sostituiti con ?',
  truncated: 'Il testo è stato troncato al limite di lunghezza del campo',
};

/**
 * Validates an invoice model before it is serialized and sent: schema rules, offline SdI checks, fiscal identifier
 * checksums, and the mapping warnings.
 *
 * @param model The invoice.
 * @param context The sending day and the warnings of the mapping.
 * @returns Errors (the invoice must not be sent) and warnings, each sorted by path then code.
 */
export function validateInvoice(model: InvoiceModel, context: ValidationContext): ValidationResult {
  const texts = (context.mappingWarnings ?? []).map((entry) => warning('TEXT', entry.path, TEXT_MESSAGES[entry.warning]));
  const issues = sortIssues([...validateSchema(model), ...checkSdi(model, context), ...checkFiscalIds(model), ...texts]);
  return {
    errors: issues.filter((entry) => entry.severity === 'error'),
    warnings: issues.filter((entry) => entry.severity === 'warning'),
  };
}

/**
 * Checks that the XML is within the size limit.
 *
 * @param xml The serialized document.
 * @returns A `SIZE` error when its UTF-8 length exceeds {@link MAX_FILE_BYTES}, otherwise `undefined`.
 */
export function checkFileSize(xml: string): ValidationIssue | undefined {
  return Buffer.byteLength(xml, 'utf8') > MAX_FILE_BYTES ? error('SIZE', 'file', 'Il file supera la dimensione massima di 5 MB') : undefined;
}
