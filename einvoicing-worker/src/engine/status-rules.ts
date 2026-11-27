/**
 * What a provider status means for the queue: terminal or not, kept or deleted, and when to ask again.
 *
 * Terminal states, corrected against the legacy (which deleted a record on `notDelivered` for everybody):
 * - `FPR12` and `FSM10` (private recipients): `delivered`, `notDelivered` (a failed delivery notice is final: the invoice is
 *   in the recipient's reserved area), `effectiveDate`, `accepted`, `refused`, `rejected`, `processingError`,
 *   `deliveryImpossible`.
 * - `FPA12` (public administration): `delivered` and `notDelivered` are **not** final (acceptance, refusal or the
 *   deadline follow within 15 days; a failed delivery becomes `deliveryImpossible` after 10): `accepted`, `refused`,
 *   `effectiveDate`, `deliveryImpossible`, `rejected`, `processingError`.
 *
 * @module
 */
import type { Document } from 'mongodb';
import type { NormalizedStatus } from '../providers/types.ts';

/** The three formats of the SdI that matter here. */
export type InvoiceFormat = 'FPR12' | 'FPA12' | 'FSM10';

/** What to do with the record after a status. */
export type Disposition =
  /** Ask again later. */
  | 'continue'
  /** Done well: delete the record (the group's document keeps the final `sendStatus`). */
  | 'delete'
  /** Done badly: keep the record, with its error, so "Documenti in errore" shows it. */
  | 'keep';

const SIMPLIFIED_TYPES: ReadonlySet<string> = new Set(['TD07', 'TD08', 'TD09']);

/**
 * The format of a record (`TD07`–`TD09` are always simplified; otherwise the counterpart's choice, `FPR12` by default).
 *
 * @param record A queue record with `fattura_elettronica.tipo` and `counterpart.fattura_elettronica.formato_trasmissione`.
 * @returns The format.
 */
export function formatOf(record: Document): InvoiceFormat {
  const type: unknown = (record['fattura_elettronica'] as Document | undefined)?.['tipo'];
  const format: unknown = ((record['counterpart'] as Document | undefined)?.['fattura_elettronica'] as Document | undefined)?.['formato_trasmissione'];
  if (typeof type === 'string' && SIMPLIFIED_TYPES.has(type)) {
    return 'FSM10';
  }
  return format === 'FPA12' ? 'FPA12' : 'FPR12';
}

const KEPT: ReadonlySet<NormalizedStatus> = new Set(['rejected', 'processingError', 'refused']);
const FINAL_FOR_ALL: ReadonlySet<NormalizedStatus> = new Set(['accepted', 'effectiveDate', 'deliveryImpossible']);
const FINAL_FOR_PRIVATE: ReadonlySet<NormalizedStatus> = new Set(['delivered', 'notDelivered']);

/**
 * The disposition of a status for a format.
 *
 * @param status The normalized status.
 * @param format The format of the invoice.
 * @returns `keep` for `rejected`, `processingError` and `refused`; `delete` for the other final states; `continue` otherwise.
 */
export function dispositionOf(status: NormalizedStatus, format: InvoiceFormat): Disposition {
  if (KEPT.has(status)) {
    return 'keep';
  }
  if (FINAL_FOR_ALL.has(status) || (format !== 'FPA12' && FINAL_FOR_PRIVATE.has(status))) {
    return 'delete';
  }
  return 'continue';
}

/** The error a kept status leaves on the record, in the form "Documenti in errore" reads. */
export const KEPT_ERRORS: Readonly<Record<'rejected' | 'processingError' | 'refused', { readonly errorCode: string; readonly errorDescription: string }>> = {
  rejected: { errorCode: 'SDI_REJECTED', errorDescription: 'Fattura scartata dal SdI' },
  processingError: { errorCode: 'PROCESSING_ERROR', errorDescription: 'Errore di elaborazione della fattura presso il provider' },
  refused: { errorCode: 'REFUSED', errorDescription: 'Fattura rifiutata dal committente' },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The first status check, after the upload. */
export const FIRST_STATUS_DELAY_MS = 2 * MINUTE;

/** The wait after the 1st, 2nd, ... non-final answer; the last one repeats. */
const STATUS_DELAYS_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 12 * HOUR];

/**
 * The wait before the next status check.
 *
 * @param answers How many answers (found or not) the record has had, at least 1.
 * @returns Milliseconds: 5, 15, 30 minutes, 1, 2, 4, 8 hours, then 12 hours.
 */
export function nextStatusDelay(answers: number): number {
  return STATUS_DELAYS_MS[Math.min(answers, STATUS_DELAYS_MS.length) - 1] as number;
}

/** Past this age (from the upload) a record that is still not final stops being polled and waits for a manual check. */
export const REVIEW_AFTER_MS = 30 * 24 * HOUR;

/** Answers "the provider does not know the file" tolerated before the record goes to review. */
export const MAX_NOT_FOUND = 3;
