import { AppError } from '../../shared/http/errors.ts';
import { XlsxError, xlsxErrorToAppError } from '../../shared/xlsx/errors.ts';
import { readXlsxSheets } from '../../shared/xlsx/reader.ts';
import type { CellValue, SheetRow } from '../../shared/xlsx/reader.ts';
import { cellText, echoed, normalizeHeader } from '../catalog-xlsx/catalog-xlsx.columns.ts';
import { CATALOG_IMPORT_LIMITS, MAX_IMPORT_SHEET_ROWS } from '../catalog-xlsx/catalog-xlsx.parse.ts';
import { MAX_CELL_TEXT } from '../catalog-xlsx/catalog-xlsx.row.ts';
import { recognizeFlag } from '../catalog-xlsx/catalog-xlsx.rules.ts';
import type { RecordErrorCode } from './records-xlsx.errors.ts';
import type { RecordErrorCollector } from './records-xlsx.errors.ts';

/** A column of a one-sheet workbook: the key the importer reads it by and the header of the file. Two columns may have the same header (the contacts have a person and a company address). */
export interface RecordColumn {
  readonly key: string;
  readonly header: string;
}

/** The definition of the only sheet of a workbook. */
export interface RecordSheet {
  /** The name of the sheet. */
  readonly name: string;
  /** The columns, in order. */
  readonly columns: readonly RecordColumn[];
  /**
   * The key of a column after which a header that two columns share belongs to the **second** of them (the company block of the contacts, which repeats the headers of the person block): in the legacy workbook the
   * company data come after `NOME AZIENDA`. Without it, or when the file has no such column, a header that comes twice is a problem.
   */
  readonly splitAfter?: string;
}

/** A problem of a header row. */
export interface RecordHeaderProblem {
  readonly code: 'unknownColumn' | 'duplicateColumn';
  readonly column: string;
}

/** What a header row says: where each column is and the problems. */
export interface RecordHeader {
  readonly fixed: ReadonlyMap<string, number>;
  readonly problems: readonly RecordHeaderProblem[];
}

/**
 * A header in the form that is compared: {@link normalizeHeader} and no space around `/`, `:` and `|` (the legacy model of the cards has `TIPO (ID/NOME)`, the new one `TIPO (ID / NOME)`).
 *
 * @param header The text of the cell.
 */
export function normalizeRecordHeader(header: string): string {
  return normalizeHeader(header).replace(/ ?([/:|]) ?/g, '$1');
}

/**
 * Reads the first row of a sheet: each header is recognized by what it says, never by where it is, except a header that two columns share (see {@link RecordSheet.splitAfter}). An empty header is ignored (and so is
 * the column); one that is not a column of the sheet is a problem named after the header, and so is one that comes twice.
 *
 * @param sheet The sheet.
 * @param cells The cells of the first row.
 */
export function parseRecordHeader(sheet: RecordSheet, cells: readonly CellValue[]): RecordHeader {
  const candidates = new Map<string, string[]>();
  for (const column of sheet.columns) {
    const header = normalizeRecordHeader(column.header);
    candidates.set(header, [...(candidates.get(header) ?? []), column.key]);
  }
  const headers = cells.map((cell) => {
    const text = cellText(cell);
    return text === null ? '' : text.trim();
  });
  const splitHeader = sheet.columns.find((column) => column.key === sheet.splitAfter)?.header;
  const splitIndex = splitHeader === undefined ? -1 : headers.findIndex((header) => header !== '' && normalizeRecordHeader(header) === normalizeRecordHeader(splitHeader));
  const fixed = new Map<string, number>();
  const problems: RecordHeaderProblem[] = [];
  headers.forEach((header, index) => {
    if (header === '') {
      return;
    }
    const keys = candidates.get(normalizeRecordHeader(header));
    // Of two columns that share a header, the one after the split column is the second.
    const key = keys === undefined ? undefined : keys.length > 1 && splitIndex !== -1 && index > splitIndex ? keys[1] : keys[0];
    if (key === undefined) {
      problems.push({ code: 'unknownColumn', column: echoed(header) });
    } else if (fixed.has(key)) {
      problems.push({ code: 'duplicateColumn', column: echoed(header) });
    } else {
      fixed.set(key, index);
    }
  });
  return { fixed, problems };
}

/** The sheet of a workbook that has a header and rows. */
export interface ParsedRecordSheet {
  readonly sheet: RecordSheet;
  readonly header: RecordHeader;
  /** The data rows, with their numbers in the sheet; the rows with nothing in them are left out. */
  readonly rows: readonly SheetRow[];
}

/** Whether a cell has something in it. */
const filled = (cell: CellValue | undefined): boolean => cell !== null && cell !== undefined && !(typeof cell === 'string' && cell.trim() === '');

/**
 * Reads the sheet of the workbook **by name** and splits it into header and data rows. A workbook without the sheet, or with the sheet but no row below the header, is refused (`422`, `file`/`incorrect`), and so is one
 * that has more data rows than {@link MAX_IMPORT_SHEET_ROWS} (`file`/`tooMany`). Rows with nothing in them are left out. The limits of the reader are the ones of the import of the catalog, narrowed to the columns of the sheet.
 *
 * @param file The whole file.
 * @param sheet The sheet.
 * @param maxRows Most data rows (tests use a smaller number).
 * @throws {AppError} `VALIDATION_ERROR` when the file is not a workbook the reader accepts, has no such sheet or no rows, or has too many rows.
 */
export function parseRecordWorkbook(file: Buffer, sheet: RecordSheet, maxRows: number = MAX_IMPORT_SHEET_ROWS): ParsedRecordSheet {
  let found;
  try {
    found = readXlsxSheets(file, [sheet.name], { ...CATALOG_IMPORT_LIMITS, maxColumns: sheet.columns.length + 5 });
  } catch (error) {
    throw xlsxErrorToAppError(error) ?? error;
  }
  const worksheet = found.get(sheet.name);
  if (worksheet === undefined || worksheet.rows.length < 2) {
    throw new AppError('VALIDATION_ERROR', { message: new XlsxError('missing').message, details: [{ field: 'file', issue: 'incorrect' }] });
  }
  const [first, ...all] = worksheet.rows;
  const rows = all.filter((row) => row.cells.some(filled));
  if (rows.length > maxRows) {
    throw new AppError('VALIDATION_ERROR', { message: new XlsxError('limit').message, details: [{ field: 'file', issue: 'tooMany' }] });
  }
  return { sheet, header: parseRecordHeader(sheet, first!.cells), rows };
}

/**
 * Records the problems of the header (a column that is not of the sheet, one that comes twice) as problems of the sheet, named after the column.
 *
 * @param parsed The sheet.
 * @param errors Where the problems go.
 * @returns Whether there are any: the rows are then not read.
 */
export function reportHeaderProblems(parsed: ParsedRecordSheet, errors: RecordErrorCollector): boolean {
  for (const problem of parsed.header.problems) {
    errors.add(null, problem.column, problem.code);
  }
  return parsed.header.problems.length > 0;
}

/** One row of the sheet being read: it gives the text of each column by what the column is, and records what is wrong with the row. */
export class RecordRowReader {
  readonly number: number;
  /** Whether a problem has been recorded for the row: nothing is written for it. */
  failed = false;
  private readonly parsed: ParsedRecordSheet;
  private readonly cells: SheetRow['cells'];
  private readonly errors: RecordErrorCollector;

  /**
   * @param parsed The sheet.
   * @param row The row.
   * @param errors Where the problems go.
   */
  constructor(parsed: ParsedRecordSheet, row: SheetRow, errors: RecordErrorCollector) {
    this.parsed = parsed;
    this.number = row.number;
    this.cells = row.cells;
    this.errors = errors;
  }

  /**
   * Records a problem of the row.
   *
   * @param column The key of a column, `null` for none.
   * @param code What is wrong.
   * @param detail A fixed text that says more.
   */
  fail(column: string | null, code: RecordErrorCode, detail?: string): void {
    this.failed = true;
    this.errors.add(this.number, column === null ? null : (this.parsed.sheet.columns.find((candidate) => candidate.key === column)?.header ?? column), code, detail);
  }

  /**
   * The text of a column, trimmed: `undefined` when the sheet has no such column (the data is then left alone), `''` for an empty cell. A cell that is a boolean or longer than {@link MAX_CELL_TEXT} is a problem of the
   * row and reads as empty.
   *
   * @param key The key of the column.
   */
  text(key: string): string | undefined {
    const index = this.parsed.header.fixed.get(key);
    if (index === undefined) {
      return undefined;
    }
    const text = cellText(this.cells[index]);
    if (text === null || text.length > MAX_CELL_TEXT) {
      this.fail(key, 'invalidValue');
      return '';
    }
    return text.trim();
  }
}

/** The result of recognizing a reference, recorded as a problem of the row when it is not found. */
export function resolved<T>(rv: RecordRowReader, column: string, result: { readonly kind: 'found'; readonly value: T } | { readonly kind: 'none' } | { readonly kind: 'ambiguous' }): T | null {
  if (result.kind === 'found') {
    return result.value;
  }
  rv.fail(column, result.kind === 'none' ? 'notFoundReference' : 'ambiguousName');
  return null;
}

/**
 * The key of the column a field the service refuses belongs to: the first entry whose path is the field itself or its parent (`person.phones` for `person.phones.0`), `null` when the field is not one of a column.
 *
 * @param table The paths and the keys of the columns.
 * @param field The path of the field, as the service reports it.
 */
export function columnOfField(table: ReadonlyArray<readonly [string, string]>, field: string): string | null {
  return table.find(([start]) => field === start || field.startsWith(`${start}.`) || field.startsWith(`${start}[`))?.[1] ?? null;
}

/**
 * Records the problems a service refused a row with, one for each detail. Anything that is not a refusal of the data (`VALIDATION_ERROR`, `FORBIDDEN`, `CONFLICT`, `NOT_FOUND`, `PRECONDITION_FAILED`) is not a problem of
 * the row: it is rethrown.
 *
 * @param error What the service threw.
 * @param rv The row.
 * @param table The paths and the keys of the columns ({@link columnOfField}).
 */
export function refuse(error: unknown, rv: RecordRowReader, table: ReadonlyArray<readonly [string, string]>): void {
  if (!(error instanceof AppError)) {
    throw error;
  }
  const details = error.details ?? [];
  const codes = { VALIDATION_ERROR: 'invalid', FORBIDDEN: 'forbidden', CONFLICT: 'conflict', NOT_FOUND: 'notFound', PRECONDITION_FAILED: 'conflict' } as const;
  const code = codes[error.code as keyof typeof codes];
  if (code === undefined) {
    throw error;
  }
  if (details.length === 0) {
    rv.fail(null, code);
  }
  for (const detail of details.slice(0, 5)) {
    rv.fail(columnOfField(table, detail.field), code, `${detail.field}: ${detail.issue}`);
  }
}

/**
 * The identity of a row of a sheet that has `ID` and `CANCELLAZIONE (X)`: the id cell, validated, and the deletion mark. A `null` id is a new element; a repeated id is a problem.
 *
 * @param rv The row.
 * @param seen The ids of the rows before (updated).
 * @param keys The keys of the id and of the deletion columns.
 */
export function identityOf(rv: RecordRowReader, seen: Set<string>, keys: { readonly id: string; readonly remove: string }): { readonly id: string | null; readonly remove: boolean } {
  const cell = rv.text(keys.id) ?? '';
  const mark = rv.text(keys.remove);
  const remove = mark === undefined ? false : recognizeFlag(mark);
  if (remove === null) {
    rv.fail(keys.remove, 'invalidValue');
  }
  if (cell === '') {
    if (remove === true) {
      rv.fail(keys.remove, 'deleteWithoutId');
    }
    return { id: null, remove: false };
  }
  const lower = cell.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(lower)) {
    rv.fail(keys.id, 'invalidId');
    return { id: null, remove: false };
  }
  if (seen.has(lower)) {
    rv.fail(keys.id, 'duplicateId');
  }
  seen.add(lower);
  return { id: lower, remove: remove === true };
}
