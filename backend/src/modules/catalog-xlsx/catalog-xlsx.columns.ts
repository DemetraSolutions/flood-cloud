import type { CellValue } from '../../shared/xlsx/reader.ts';
import { restoreFormula } from '../../shared/xlsx/formula.ts';

/** The kinds of sheet of the workbook. */
export type SheetKind = 'products' | 'variants' | 'categories';

/** The names of the sheets, recognized by name (the order of the sheets does not matter). */
export const SHEET_NAMES: Readonly<Record<SheetKind, string>> = Object.freeze({ products: 'Prodotti', variants: 'Varianti', categories: 'Categorie' });

/** The sheets, in the order they are written and, reversed in meaning, read: categories first (what products and variants refer to), then variants, then products. */
export const SHEET_KINDS: readonly SheetKind[] = Object.freeze(['products', 'variants', 'categories'] as const);

/** The number of price triples (price list, price, tax rate) of a product row. */
export const PRICE_SLOTS = 15;

/** The kinds of column that depend on a point of sale: the availability of a product or a category, and the print stations of a category (dining room and counter). */
export type PlaceColumnKind = 'DISPO' | 'SALA' | 'BANCO';

const PLACE_ACTIONS: ReadonlyMap<string, PlaceColumnKind> = new Map([
  ['DISPO', 'DISPO'],
  ['POSTAZIONI SALA', 'SALA'],
  ['POSTAZIONI BANCO', 'BANCO'],
]);
const PLACE_PREFIX: Readonly<Record<PlaceColumnKind, string>> = Object.freeze({ DISPO: 'DISPO', SALA: 'POSTAZIONI SALA', BANCO: 'POSTAZIONI BANCO' });

/** A fixed column: the key the importer reads it by and the header of the file. */
export interface FixedColumn {
  readonly key: string;
  readonly header: string;
}

const col = (key: string, header: string): FixedColumn => ({ key, header });
const priceColumns = (from: number, to: number): FixedColumn[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index).flatMap((n) => [col(`list${String(n)}`, `LISTINO ${String(n)} (ID / NOME )`), col(`price${String(n)}`, `PREZZO ${String(n)}`), col(`tax${String(n)}`, `ALIQUOTA ${String(n)} (ID / VALORE)`)]);

const PRODUCT_COMMON = (withType: boolean): FixedColumn[] => [
  col('id', 'ID'),
  ...(withType ? [col('type', 'TIPO (pm / p / m / i)')] : []),
  col('position', 'POSIZIONE'),
  col('name', 'NOME'),
  col('shortName', 'NOME BREVE'),
  col('categories', 'CATEGORIE (ID / NOME)'),
  ...priceColumns(1, 1),
  col('pos', 'DISPONIBILE CASSA (X)'),
  col('favorite', 'PREFERITO (X)'),
  col('favoriteHandheld', 'PREFERITO PALMARE (X)'),
  col('warehouse', 'MOVIMENTA MAGAZZINO (X)'),
  col('scales', 'DISPONIBILE BILANCIA (X)'),
  col('plu', 'PLU'),
  col('scaleType', 'PEZZO/PESO (p / w)'),
  col('ecommerce', 'DISPONIBILE E-COMMERCE (X)'),
  col('description', 'DESCRIZIONE'),
  col('shortDescription', 'DESCRIZIONE BREVE'),
  col('code', 'CODICE'),
  col('barcode', 'BARCODE'),
  col('delete', 'CANCELLAZIONE (X)'),
  ...priceColumns(2, PRICE_SLOTS),
];

/** The fixed columns of each sheet, in order: 63 for the products, 64 for the variants (the type is the second), 9 for the categories, the very same headers of the legacy workbook. */
export const FIXED_COLUMNS: Readonly<Record<SheetKind, readonly FixedColumn[]>> = Object.freeze({
  products: Object.freeze(PRODUCT_COMMON(false)),
  variants: Object.freeze(PRODUCT_COMMON(true)),
  categories: Object.freeze([
    col('id', 'ID'),
    col('position', 'POSIZIONE'),
    col('name', 'NOME'),
    col('parent', 'GENITORE'),
    col('pos', 'DISPONIBILE CASSA (X)'),
    col('modifierCategories', 'CATEGORIE VARIANTI (ID / NOME)'),
    col('description', 'DESCRIZIONE'),
    col('color', 'COLORE (1-12 / HEX)'),
    col('delete', 'CANCELLAZIONE (X)'),
  ]),
});

/** The kinds of point-of-sale column each sheet may have. */
export const PLACE_KINDS: Readonly<Record<SheetKind, readonly PlaceColumnKind[]>> = Object.freeze({ products: ['DISPO'], variants: ['DISPO'], categories: ['SALA', 'BANCO', 'DISPO'] });

/**
 * A header in the form that is compared: trimmed, with the white space collapsed, in capitals, and with no space before a closing parenthesis (the legacy template has `LISTINO 1 (ID / NOME )`).
 *
 * @param header The text of the cell.
 */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, ' ').toUpperCase().replace(/ \)/g, ')');
}

/** The header of a column of a point of sale, as the export writes it: `DISPO | <name>`. */
export function placeHeader(kind: PlaceColumnKind, placeName: string): string {
  return `${PLACE_PREFIX[kind]} | ${placeName}`;
}

/** A column of a point of sale found in a header row. */
export interface PlaceColumn {
  readonly kind: PlaceColumnKind;
  /** The name of the point of sale, as written in the header (trimmed). */
  readonly placeName: string;
  /** The index of the column (from 0). */
  readonly index: number;
  /** The header as written, cut for a message. */
  readonly header: string;
}

/** A problem of a header row. */
export interface HeaderProblem {
  readonly code: 'unknownColumn' | 'duplicateColumn';
  readonly column: string;
}

/** What a header row says: where each fixed column is, the columns of the points of sale and the problems. */
export interface ParsedHeader {
  readonly fixed: ReadonlyMap<string, number>;
  readonly places: readonly PlaceColumn[];
  readonly problems: readonly HeaderProblem[];
}

/** Characters that are not shown in a message: control characters, line separators and the characters that change the direction of the text. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Longest header echoed in a message. */
const MAX_ECHOED_HEADER = 60;

/** A text of the file made safe to be shown in a message: no control character, cut. */
export function echoed(text: string): string {
  return text.replace(HIDDEN, ' ').slice(0, MAX_ECHOED_HEADER);
}

/** The text of a cell as it is compared and read: a number as its digits, a text without the neutralization of formulas, nothing for an empty cell. `null` for a boolean (it is never a valid value). */
export function cellText(cell: CellValue | undefined): string | null {
  if (cell === undefined || cell === null) {
    return '';
  }
  if (typeof cell === 'boolean') {
    return null;
  }
  return typeof cell === 'number' ? String(cell) : restoreFormula(cell);
}

/**
 * Reads the first row of a sheet: each header is recognized by what it says, never by where it is. A header that is empty is ignored (and so is the column); one that is not a column of the sheet
 * (the point of sale of a `DISPO | name` is checked against the group by the importer) is a problem named after the header, and so is one that comes twice.
 *
 * @param kind The sheet.
 * @param cells The cells of the first row.
 */
export function parseHeader(kind: SheetKind, cells: readonly CellValue[]): ParsedHeader {
  const known = new Map(FIXED_COLUMNS[kind].map((column) => [normalizeHeader(column.header), column.key]));
  const fixed = new Map<string, number>();
  const places: PlaceColumn[] = [];
  const problems: HeaderProblem[] = [];
  const seen = new Set<string>();
  cells.forEach((cell, index) => {
    const text = cellText(cell);
    const header = text === null ? '' : text.trim();
    if (header === '') {
      return;
    }
    const normalized = normalizeHeader(header);
    const bar = header.indexOf('|');
    const action = bar === -1 ? undefined : PLACE_ACTIONS.get(normalizeHeader(header.slice(0, bar)));
    if (action !== undefined && PLACE_KINDS[kind].includes(action)) {
      const placeName = header.slice(bar + 1).trim();
      const identity = `${action}|${placeName}`;
      if (placeName === '' || seen.has(identity)) {
        problems.push({ code: placeName === '' ? 'unknownColumn' : 'duplicateColumn', column: echoed(header) });
      } else {
        seen.add(identity);
        places.push({ kind: action, placeName, index, header: echoed(header) });
      }
      return;
    }
    const key = known.get(normalized);
    if (key === undefined) {
      problems.push({ code: 'unknownColumn', column: echoed(header) });
    } else if (fixed.has(key)) {
      problems.push({ code: 'duplicateColumn', column: echoed(header) });
    } else {
      fixed.set(key, index);
    }
  });
  return { fixed, places, problems };
}
