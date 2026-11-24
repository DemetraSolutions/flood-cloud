import { FIXED_COLUMNS, cellText } from './catalog-xlsx.columns.ts';
import type { PlaceColumn, SheetKind } from './catalog-xlsx.columns.ts';
import type { ParsedSheet } from './catalog-xlsx.parse.ts';
import type { ErrorCollector, RowErrorCode } from './catalog-xlsx.errors.ts';
import type { SheetRow } from '../../shared/xlsx/reader.ts';

/** Longest cell text the import reads, before any trim or comparison: a text beyond it is refused whatever the field (the longest field of the catalog is a description of 1000 characters). */
export const MAX_CELL_TEXT = 4000;

/** The header of each fixed column of each sheet, by key. */
const HEADERS: Readonly<Record<SheetKind, ReadonlyMap<string, string>>> = Object.freeze({
  products: new Map(FIXED_COLUMNS.products.map((column) => [column.key, column.header])),
  variants: new Map(FIXED_COLUMNS.variants.map((column) => [column.key, column.header])),
  categories: new Map(FIXED_COLUMNS.categories.map((column) => [column.key, column.header])),
});

/** The header of a fixed column, `null` for a key the sheet does not have. */
export function headerOf(kind: SheetKind, key: string): string | null {
  return HEADERS[kind].get(key) ?? null;
}

/** One row of a sheet being read: it gives the text of each column by what the column is, and records what is wrong with the row. */
export class RowReader {
  readonly kind: SheetKind;
  readonly number: number;
  /** Whether a problem has been recorded for the row: nothing is written for it. */
  failed = false;
  private readonly sheet: ParsedSheet;
  private readonly cells: SheetRow['cells'];
  private readonly errors: ErrorCollector;

  /**
   * @param sheet The sheet.
   * @param row The row.
   * @param errors Where the problems go.
   */
  constructor(sheet: ParsedSheet, row: SheetRow, errors: ErrorCollector) {
    this.kind = sheet.kind;
    this.sheet = sheet;
    this.number = row.number;
    this.cells = row.cells;
    this.errors = errors;
  }

  /**
   * Records a problem of the row.
   *
   * @param column The key of a fixed column, or the header of another one (a point of sale), `null` for none.
   * @param code What is wrong.
   * @param detail A fixed text that says more.
   */
  fail(column: string | null, code: RowErrorCode, detail?: string): void {
    this.failed = true;
    this.errors.add(this.kind, this.number, column === null ? null : (headerOf(this.kind, column) ?? column), code, detail);
  }

  /** Whether the sheet has the column. */
  has(key: string): boolean {
    return this.sheet.header.fixed.has(key);
  }

  /**
   * The text of a fixed column, trimmed: `undefined` when the sheet has no such column (the data is then left alone), `''` for an empty cell. A cell that is a boolean or longer than {@link MAX_CELL_TEXT}
   * is a problem of the row and reads as empty.
   *
   * @param key The key of the column.
   */
  text(key: string): string | undefined {
    const index = this.sheet.header.fixed.get(key);
    return index === undefined ? undefined : this.read(index, key);
  }

  /**
   * The text of a column of a point of sale, trimmed.
   *
   * @param column The column.
   */
  placeText(column: PlaceColumn): string {
    return this.read(column.index, column.header);
  }

  private read(index: number, name: string): string {
    const text = cellText(this.cells[index]);
    if (text === null || text.length > MAX_CELL_TEXT) {
      this.fail(name, 'invalidValue');
      return '';
    }
    return text.trim();
  }
}
