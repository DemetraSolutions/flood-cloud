import { MAX_COLLECTED_ERRORS, MAX_REPORTED_ERRORS } from '../catalog-xlsx/catalog-xlsx.errors.ts';
import type { RowError } from '../catalog-xlsx/catalog-xlsx.errors.ts';

/**
 * The stable codes of the problems of a row (or of a column) of the workbooks of the contacts and of the loyalty cards, with the fixed text of each: nothing of the file is ever echoed but the header of the column. The
 * codes the catalog workbook has too mean the same here.
 */
export const RECORD_ERROR_MESSAGES = Object.freeze({
  unknownColumn: 'The column is not one of the sheet',
  duplicateColumn: 'The column appears more than once',
  invalidId: 'The id is not valid',
  duplicateId: 'The id appears more than once in the sheet',
  notFound: 'The id does not exist or is not reached by the caller',
  trashed: 'The element is in the trash',
  deleteWithoutId: 'A deletion needs the id of the element',
  required: 'The value is required',
  invalidValue: 'The value is not valid',
  notFoundReference: 'The reference matches nothing (neither an id nor a name)',
  ambiguousName: 'The reference is a name that more than one element has',
  duplicateCode: 'The code appears more than once in the sheet',
  balanceChange: 'The credit of an existing card cannot be changed by the workbook: use the adjustments',
  pointsChange: 'The points of an existing card cannot be changed by the workbook: use the adjustments',
  invalid: 'The value is refused',
  forbidden: 'The caller may not make this change',
  conflict: 'The change conflicts with the state of the data',
} as const);

/** A code of {@link RECORD_ERROR_MESSAGES}. */
export type RecordErrorCode = keyof typeof RECORD_ERROR_MESSAGES;

/** A problem of one of these workbooks. */
export type RecordRowError = RowError<RecordErrorCode>;

/** The problems of an import of a one-sheet workbook, listed up to {@link MAX_REPORTED_ERRORS} and counted up to {@link MAX_COLLECTED_ERRORS}. */
export class RecordErrorCollector {
  readonly errors: RecordRowError[] = [];
  count = 0;
  private readonly sheet: string;

  /**
   * @param sheet The name of the sheet, in every problem.
   */
  constructor(sheet: string) {
    this.sheet = sheet;
  }

  /** Whether the import has seen enough problems to stop. */
  get full(): boolean {
    return this.count >= MAX_COLLECTED_ERRORS;
  }

  /**
   * Records a problem.
   *
   * @param row The row number in the sheet, `null` for the whole sheet.
   * @param column The header of the column, `null` when the problem is not of one column.
   * @param code What is wrong.
   * @param detail A fixed text that says more (the field and the issue the service gave), appended to the message.
   */
  add(row: number | null, column: string | null, code: RecordErrorCode, detail?: string): void {
    this.count += 1;
    if (this.errors.length < MAX_REPORTED_ERRORS) {
      this.errors.push({ sheet: this.sheet, row, column, code, message: detail === undefined ? RECORD_ERROR_MESSAGES[code] : `${RECORD_ERROR_MESSAGES[code]} (${detail})` });
    }
  }
}
