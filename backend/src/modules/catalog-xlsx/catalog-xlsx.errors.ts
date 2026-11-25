import { SHEET_NAMES } from './catalog-xlsx.columns.ts';
import type { SheetKind } from './catalog-xlsx.columns.ts';

/** The stable codes of the problems of a row (or of a column) of the workbook, with the fixed text of each: nothing of the file is ever echoed but the header of the column. */
export const ROW_ERROR_MESSAGES = Object.freeze({
  unknownColumn: 'The column is not one of the sheet',
  duplicateColumn: 'The column appears more than once',
  unknownPlace: 'The point of sale of the column does not exist, is in the trash or is not in the perimeter of the caller',
  ambiguousPlace: 'More than one point of sale has the name of the column',
  tooManyRows: 'The sheet has more rows than an import accepts',
  invalidId: 'The id is not valid',
  duplicateId: 'The id appears more than once in the sheet',
  notFound: 'The id does not exist, is in the trash or is not reached by the caller',
  trashed: 'The element is in the trash',
  wrongSheet: 'The element belongs to another sheet (a variant is in the sheet of the variants)',
  notImportable: 'The element is of a kind the workbook does not handle',
  deleteWithoutId: 'A deletion needs the id of the element',
  required: 'The value is required',
  invalidValue: 'The value is not valid',
  notFoundReference: 'The reference matches nothing (neither an id nor a name)',
  ambiguousName: 'The reference is a name that more than one element has',
  incompletePrice: 'A price needs the price list, the price and the tax rate',
  duplicatePriceList: 'The price list appears in more than one price of the row',
  notRepresentable: 'The product has a price the workbook cannot represent: nothing is changed',
  unknownStation: 'The print station does not exist in the point of sale',
  invalid: 'The value is refused',
  forbidden: 'The caller may not make this change',
  conflict: 'The change conflicts with the state of the catalog',
  tooSlow: 'The import takes too long: split the file',
} as const);

/** A code of {@link ROW_ERROR_MESSAGES}. */
export type RowErrorCode = keyof typeof ROW_ERROR_MESSAGES;

/** A problem of the workbook: the sheet, the row (`null` for a problem of the whole sheet), the column (its header), a stable code and a text. The workbooks of the contacts and of the cards use their own codes (`C`). */
export interface RowError<C extends string = RowErrorCode> {
  readonly sheet: string;
  readonly row: number | null;
  readonly column: string | null;
  readonly code: C;
  readonly message: string;
}

/** Most problems a response lists; the others are only counted. */
export const MAX_REPORTED_ERRORS = 200;

/** Most problems an import collects before it stops reading the file (it is refused anyway). */
export const MAX_COLLECTED_ERRORS = 1000;

/** The problems of an import, listed up to {@link MAX_REPORTED_ERRORS} and counted up to {@link MAX_COLLECTED_ERRORS}. */
export class ErrorCollector {
  readonly errors: RowError[] = [];
  count = 0;

  /** Whether the import has seen enough problems to stop. */
  get full(): boolean {
    return this.count >= MAX_COLLECTED_ERRORS;
  }

  /**
   * Records a problem.
   *
   * @param kind The sheet.
   * @param row The row number in the sheet, `null` for the sheet.
   * @param column The header of the column, `null` when the problem is not of one column.
   * @param code What is wrong.
   * @param detail A fixed text that says more (the field and the issue the catalog gave), appended to the message.
   */
  add(kind: SheetKind, row: number | null, column: string | null, code: RowErrorCode, detail?: string): void {
    this.count += 1;
    if (this.errors.length < MAX_REPORTED_ERRORS) {
      this.errors.push({ sheet: SHEET_NAMES[kind], row, column, code, message: detail === undefined ? ROW_ERROR_MESSAGES[code] : `${ROW_ERROR_MESSAGES[code]} (${detail})` });
    }
  }
}

/** The refusal of an import whose workbook has problems: nothing was written. The controller answers `422` with the list. */
export class ImportRefusal extends Error {
  /** The problems listed, at most {@link MAX_REPORTED_ERRORS}. */
  readonly errors: readonly RowError<string>[];
  /** How many problems the import found (counted up to {@link MAX_COLLECTED_ERRORS}). */
  readonly errorCount: number;

  /**
   * @param errors The problems listed.
   * @param errorCount How many problems there are.
   */
  constructor(errors: readonly RowError<string>[], errorCount: number) {
    super('The workbook has problems: nothing was imported');
    this.name = 'ImportRefusal';
    this.errors = errors;
    this.errorCount = errorCount;
  }
}
