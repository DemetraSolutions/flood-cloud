import { AppError } from '../http/errors.ts';

/** Why a workbook was refused. */
export const XLSX_REASONS = Object.freeze(['notZip', 'unsupported', 'unsafe', 'limit', 'malformed', 'missing'] as const);

/** A reason a workbook was refused. */
export type XlsxReason = (typeof XLSX_REASONS)[number];

/** The message of each reason: fixed texts that are safe to show, they never repeat anything read from the file. */
export const XLSX_MESSAGES: Readonly<Record<XlsxReason, string>> = Object.freeze({
  notZip: 'The file is not an XLSX workbook',
  unsupported: 'The file uses a feature of the XLSX format that is not supported',
  unsafe: 'The file contains content that is not accepted',
  limit: 'The file exceeds the limits of an XLSX workbook',
  malformed: 'The file is damaged or is not a valid XLSX workbook',
  missing: 'The file does not contain a worksheet',
});

/** A workbook the reader refuses. It carries a reason and a fixed message only: no byte of the file is ever echoed. */
export class XlsxError extends Error {
  /** What went wrong. */
  readonly reason: XlsxReason;

  /**
   * @param reason Why the workbook was refused.
   */
  constructor(reason: XlsxReason) {
    super(XLSX_MESSAGES[reason]);
    this.name = 'XlsxError';
    this.reason = reason;
  }
}

/**
 * Maps a refusal of the reader to the answer of the API: `422 VALIDATION_ERROR` on the field `file` with the issue `incorrect` and the fixed message of the reason.
 *
 * @param error What the reader threw.
 * @returns The error to throw, or `null` when `error` is not a refusal of the reader (an unexpected failure: it must be rethrown as it is).
 */
export function xlsxErrorToAppError(error: unknown): AppError | null {
  return error instanceof XlsxError ? new AppError('VALIDATION_ERROR', { message: error.message, details: [{ field: 'file', issue: 'incorrect' }] }) : null;
}
