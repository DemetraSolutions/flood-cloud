import { AppError } from '../../shared/http/errors.ts';
import { XlsxError, xlsxErrorToAppError } from '../../shared/xlsx/errors.ts';
import { DEFAULT_XLSX_LIMITS } from '../../shared/xlsx/limits.ts';
import type { XlsxLimits } from '../../shared/xlsx/limits.ts';
import { readXlsxSheets } from '../../shared/xlsx/reader.ts';
import type { SheetRow } from '../../shared/xlsx/reader.ts';
import { SHEET_KINDS, SHEET_NAMES, parseHeader } from './catalog-xlsx.columns.ts';
import type { ParsedHeader, SheetKind } from './catalog-xlsx.columns.ts';
import { MAX_PLACE_COLUMNS } from './catalog-xlsx.repository.ts';

/** Most data rows one sheet of an import may have. */
export const MAX_IMPORT_SHEET_ROWS = 1000;

/** Most data rows all the sheets of an import may have together: every row is one or two calls of the services of the catalog inside one transaction, which MongoDB limits in time. */
export const MAX_IMPORT_ROWS = 1500;

/**
 * The limits of the reader for this file, far tighter than the general ones: the widest sheet has 64 fixed columns and three for each point of sale, the file is held in memory (10 MB at most) and the event
 * loop is blocked while it is read.
 */
export const CATALOG_IMPORT_LIMITS: Partial<XlsxLimits> = Object.freeze({
  maxRows: MAX_IMPORT_SHEET_ROWS + 1 + 1000,
  maxColumns: 9 + 3 * MAX_PLACE_COLUMNS,
  maxEntryBytes: 30 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxCellTextTotal: 20 * 1024 * 1024,
  maxCellChars: DEFAULT_XLSX_LIMITS.maxCellChars,
});

/** A sheet of the workbook that has a header and rows. */
export interface ParsedSheet {
  readonly kind: SheetKind;
  readonly header: ParsedHeader;
  /** The data rows, with their numbers in the sheet. */
  readonly rows: readonly SheetRow[];
}

/** The sheets of a workbook that the import handles, in the order the import reads them. */
export interface ParsedWorkbook {
  readonly sheets: readonly ParsedSheet[];
}

/** The kinds of sheet in the order of reading. */
export const READ_ORDER: readonly SheetKind[] = SHEET_KINDS;

/**
 * Reads the three sheets of the workbook by name and splits each into header and data rows. A sheet that is missing, or has no row below the header, is left out (it is never an error: the legacy worked the same
 * way); a workbook with none of the three is refused (`422`, `file`/`incorrect`), and so is one that has more rows than {@link MAX_IMPORT_SHEET_ROWS} in a sheet or {@link MAX_IMPORT_ROWS} in all.
 *
 * @param file The whole file.
 * @param overrides Limits that replace {@link CATALOG_IMPORT_LIMITS} (tests use smaller ones).
 * @param rowLimits Most rows of a sheet and of the workbook (tests use smaller ones).
 * @throws {AppError} `VALIDATION_ERROR` when the file is not a workbook the reader accepts, has none of the sheets, or has too many rows.
 */
export function parseWorkbook(file: Buffer, overrides: Partial<XlsxLimits> = {}, rowLimits: { readonly sheet: number; readonly total: number } = { sheet: MAX_IMPORT_SHEET_ROWS, total: MAX_IMPORT_ROWS }): ParsedWorkbook {
  let found;
  try {
    found = readXlsxSheets(file, Object.values(SHEET_NAMES), { ...CATALOG_IMPORT_LIMITS, ...overrides });
  } catch (error) {
    throw xlsxErrorToAppError(error) ?? error;
  }
  const sheets: ParsedSheet[] = [];
  let total = 0;
  for (const kind of READ_ORDER) {
    const worksheet = found.get(SHEET_NAMES[kind]);
    if (worksheet === undefined || worksheet.rows.length < 2) {
      continue;
    }
    const [first, ...rows] = worksheet.rows;
    total += rows.length;
    if (rows.length > rowLimits.sheet || total > rowLimits.total) {
      throw new AppError('VALIDATION_ERROR', { message: new XlsxError('limit').message, details: [{ field: 'file', issue: 'tooMany' }] });
    }
    sheets.push({ kind, header: parseHeader(kind, first!.cells), rows });
  }
  if (sheets.length === 0) {
    throw new AppError('VALIDATION_ERROR', { message: new XlsxError('missing').message, details: [{ field: 'file', issue: 'incorrect' }] });
  }
  return { sheets };
}
