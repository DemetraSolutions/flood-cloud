import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { CellValue, SheetRow } from '../../shared/xlsx/reader.ts';

/** Most products one price list holds: the whole list is replaced in one transaction, which stays well under the limits of MongoDB at this size (the national list has a few thousand). */
export const MAX_TOBACCOS = 20_000;

/** Most problems one answer reports; the import stops looking after them. */
export const MAX_REPORTED_PROBLEMS = 50;

/** Pairs of barcode and quantity a row may hold (columns 10 to 29). */
export const MAX_BARCODE_PAIRS = 10;

/** Largest number a price, a weight or a count may hold: far above anything real, far below what loses precision. */
export const MAX_AMOUNT = 1_000_000_000;

/** Largest quantity of a barcode (pieces in the pack). */
export const MAX_QUANTITY = 100_000;

/** A barcode as the official list writes it: digits only, 8 to 14 of them (EAN-8 to GTIN-14). */
const BARCODE = /^[0-9]{8,14}$/;
/** A product code: letters, digits and a few separators, no more than 40 characters. */
const CODE = /^[A-Za-z0-9._/ -]{1,40}$/;
/** What no text of the list may hold: control characters (tab, line feed and carriage return are allowed in a text). */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** What a single-line text may not hold either: tab, line feed, carriage return and the characters that reorder or hide text (bidirectional controls, zero width characters, the byte order mark). */
const SINGLE_LINE = /[\t\n\r\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** Longest text of a cell still looked at: a longer one is refused as it is, before any scan of it. */
const SCAN_LIMIT = 4096;
/** Room left to the blanks around a text that is trimmed. */
const SCAN_MARGIN = 256;
/** A string longer than this is never taken for a blank cell, so a row of huge blanks is validated (and refused) and not skipped. */
const BLANK_LIMIT = 1000;
/** Longest text a number may be written as. */
const NUMBER_TEXT_LIMIT = 64;
/** A number written as text: digits with an optional decimal part, the comma or the point as the separator. */
const DECIMAL_TEXT = /^[0-9]+(?:[.,][0-9]+)?$/;

/** One barcode of a product with the number of pieces it stands for. */
export interface TobaccoBarcode {
  readonly barcode: string;
  readonly quantity: number | null;
}

/** A product of the national price list, as it is stored (the shape of the legacy documents). */
export interface TobaccoDocument {
  readonly category: string;
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly priceKg: number | null;
  readonly price: number | null;
  readonly unitWeight: number | null;
  readonly numPieces: number | null;
  readonly description: string;
  readonly barcodes: readonly TobaccoBarcode[];
}

/** The columns of the official file, from 0 (column A). */
const COLUMN = { category: 0, code: 1, name: 2, shortName: 3, priceKg: 4, price: 5, unitWeight: 6, numPieces: 7, description: 8, barcodes: 9 } as const;

/** What a cell turns into, or why it does not. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (issue: string): Parsed<never> => ({ ok: false, issue });

/** The text of a cell, trimmed and at most `max` characters; an empty cell is `''`. */
function textOf(cell: CellValue | undefined, max: number, singleLine = true): Parsed<string> {
  if (cell === null || cell === undefined) {
    return ok('');
  }
  if (typeof cell === 'boolean') {
    return bad('type');
  }
  // The length comes first: nothing scans a text longer than the field could ever hold.
  if (typeof cell === 'string' && cell.length > Math.min(max, SCAN_LIMIT) + SCAN_MARGIN) {
    return bad('maxLength');
  }
  const text = (typeof cell === 'number' ? String(cell) : cell).trim();
  if (CONTROL.test(text) || (singleLine && SINGLE_LINE.test(text))) {
    return bad('pattern');
  }
  return text.length > max ? bad('maxLength') : ok(text);
}

/** The number of a cell: a number, or the text of one; empty is `null`; negative, too large or not a number is refused. */
function numberOf(cell: CellValue | undefined): Parsed<number | null> {
  if (typeof cell === 'string' && cell.length > NUMBER_TEXT_LIMIT) {
    return bad('type');
  }
  if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
    return ok(null);
  }
  if (typeof cell === 'boolean') {
    return bad('type');
  }
  let value: number;
  if (typeof cell === 'number') {
    value = cell;
  } else if (DECIMAL_TEXT.test(cell.trim())) {
    value = Number(cell.trim().replace(',', '.'));
  } else {
    return bad(cell.trim().startsWith('-') ? 'minimum' : 'type');
  }
  if (value < 0) {
    return bad('minimum');
  }
  // Adding zero turns a negative zero into a zero.
  return value > MAX_AMOUNT ? bad('maximum') : ok(value + 0);
}

/** A whole number of a cell (a count of pieces): like {@link numberOf}, and with no fraction. */
function integerOf(cell: CellValue | undefined, max: number): Parsed<number | null> {
  const parsed = numberOf(cell);
  if (!parsed.ok || parsed.value === null) {
    return parsed;
  }
  if (!Number.isInteger(parsed.value)) {
    return bad('format');
  }
  return parsed.value > max ? bad('maximum') : parsed;
}

/** Whether a row holds nothing but empty cells and blanks. */
const isBlank = (cells: readonly CellValue[]): boolean => cells.every((cell) => cell === null || (typeof cell === 'string' && cell.length <= BLANK_LIMIT && cell.trim() === ''));

/**
 * Turns the rows of the official price list into the documents to store, checking **every** row before anything is written.
 *
 * The first row of the worksheet is the header and is skipped; blank rows are skipped. Columns, as the legacy reads them: 1 category, 2 code, 3 name, 4 short name, 5 price per kilogram, 6 price, 7 unit weight,
 * 8 number of pieces, 9 description, 10 to 29 up to ten pairs of barcode and quantity. Beyond what the legacy checked (nothing): the code and the name are required, the code is unique in the file, the texts are
 * trimmed, bounded and free of control characters, the numbers are non-negative, finite and bounded (a comma is accepted as the decimal separator of a number written as text), the number of pieces and the
 * quantities are whole numbers, a barcode is 8 to 14 digits. A barcode cell that is empty ends the pair, as in the legacy (the quantity of a pair without a barcode is ignored).
 *
 * @param rows The rows of the first worksheet (`readXlsx`).
 * @returns The documents, in the order of the file.
 * @throws {AppError} `VALIDATION_ERROR` (422): `file`/`required` when there is no product, `file`/`tooMany` above {@link MAX_TOBACCOS}, or one detail per problem (at most {@link MAX_REPORTED_PROBLEMS}) with the field
 * `rows[<row of the worksheet>].<field>` (for a barcode `rows[7].barcodes[0].barcode`) and the issue; nothing of the file is echoed.
 */
export function parseTobaccoSheet(rows: readonly SheetRow[]): TobaccoDocument[] {
  const documents: TobaccoDocument[] = [];
  const problems: ErrorDetail[] = [];
  const codes = new Set<string>();
  for (const row of rows) {
    if (row.number === 1 || isBlank(row.cells)) {
      continue;
    }
    if (documents.length >= MAX_TOBACCOS) {
      throw new AppError('VALIDATION_ERROR', { message: 'The price list has too many products', details: [{ field: 'file', issue: 'tooMany' }] });
    }
    const at = `rows[${String(row.number)}]`;
    const take = <T>(field: string, parsed: Parsed<T>, fallback: T): T => {
      if (parsed.ok) {
        return parsed.value;
      }
      problems.push({ field: `${at}.${field}`, issue: parsed.issue });
      return fallback;
    };
    const cell = (column: number): CellValue | undefined => row.cells[column];
    const code = take('code', textOf(cell(COLUMN.code), 40), '');
    const name = take('name', textOf(cell(COLUMN.name), 200), '');
    const reported = (field: string): boolean => problems.some((problem) => problem.field === `${at}.${field}`);
    if (code === '') {
      if (!reported('code')) {
        problems.push({ field: `${at}.code`, issue: 'required' });
      }
    } else if (!CODE.test(code)) {
      problems.push({ field: `${at}.code`, issue: 'pattern' });
    } else if (codes.has(code)) {
      problems.push({ field: `${at}.code`, issue: 'taken' });
    } else {
      codes.add(code);
    }
    if (name === '' && !reported('name')) {
      problems.push({ field: `${at}.name`, issue: 'required' });
    }
    const barcodes: TobaccoBarcode[] = [];
    for (let pair = 0; pair < MAX_BARCODE_PAIRS; pair += 1) {
      const barcode = take(`barcodes[${String(pair)}].barcode`, textOf(cell(COLUMN.barcodes + pair * 2), 14), '');
      if (barcode === '') {
        continue;
      }
      if (!BARCODE.test(barcode)) {
        problems.push({ field: `${at}.barcodes[${String(pair)}].barcode`, issue: 'format' });
      }
      barcodes.push({ barcode, quantity: take(`barcodes[${String(pair)}].quantity`, integerOf(cell(COLUMN.barcodes + pair * 2 + 1), MAX_QUANTITY), null) });
    }
    documents.push({
      category: take('category', textOf(cell(COLUMN.category), 100), ''),
      code,
      name,
      shortName: take('shortName', textOf(cell(COLUMN.shortName), 100), ''),
      priceKg: take('priceKg', numberOf(cell(COLUMN.priceKg)), null),
      price: take('price', numberOf(cell(COLUMN.price)), null),
      unitWeight: take('unitWeight', numberOf(cell(COLUMN.unitWeight)), null),
      numPieces: take('numPieces', integerOf(cell(COLUMN.numPieces), MAX_AMOUNT), null),
      description: take('description', textOf(cell(COLUMN.description), 1000, false), ''),
      barcodes,
    });
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      break;
    }
  }
  if (problems.length > 0) {
    throw new AppError('VALIDATION_ERROR', { message: 'The price list has rows that are not valid', details: problems.slice(0, MAX_REPORTED_PROBLEMS) });
  }
  if (documents.length === 0) {
    throw new AppError('VALIDATION_ERROR', { message: 'The price list has no products', details: [{ field: 'file', issue: 'required' }] });
  }
  return documents;
}
