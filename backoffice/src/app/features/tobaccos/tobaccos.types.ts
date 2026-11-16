import { ApiErrorDetail } from '../../core/api/api.types';

/** One product of the national price list, as `GET /v1/tobaccos` returns it. */
export interface TobaccoRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly category: string;
  /** Price per kilogram; `null` when the list has none. */
  readonly priceKg: number | null;
  /** Price of the pack; `null` when the list has none. */
  readonly price: number | null;
  /** First barcode of the product; `null` when it has none. */
  readonly barcode: string | null;
}

/** What `POST /v1/tobaccos/import` answers. */
export interface TobaccoImportResult {
  /** Products of the new list. */
  readonly inserted: number;
  /** Products of the list that was replaced. */
  readonly previous: number;
  /** Milliseconds the replacement took on the server. */
  readonly elapsedMs: number;
}

/** Sort names the server accepts (the keys of the columns of the table). */
export const TOBACCO_SORTS = ['code', 'name', 'category', 'priceKg', 'price', 'barcode'] as const;

/** Largest file the server accepts: 10 MB. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Most problems the server reports for one file. */
export const MAX_REPORTED_PROBLEMS = 50;

/** What is wrong with a file before it is sent. */
export type FileProblem = 'type' | 'size' | 'empty';

/**
 * Checks the chosen file for the user's convenience only (the server reads the bytes and decides): it must be an `.xlsx` file, not empty and not above 10 MB.
 *
 * @param file The chosen file.
 * @returns What is wrong with it, or `null` when it can be sent.
 */
export function checkWorkbook(file: File): FileProblem | null {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return 'type';
  }
  if (file.size === 0) {
    return 'empty';
  }
  return file.size > MAX_IMPORT_BYTES ? 'size' : null;
}

/** A problem of one cell of the file, as the server reports it. */
export interface ImportProblem {
  /** Row of the worksheet (the header is row 1). */
  readonly row: number;
  /** Dictionary key of the name of the column. */
  readonly columnKey: string;
  /** Parameters of that name (the number of a barcode). */
  readonly columnParams: Readonly<Record<string, number>>;
  /** The reason (`taken`, `minimum`…). */
  readonly issue: string;
}

const PLAIN_COLUMNS: Readonly<Record<string, string>> = {
  category: 'TOBACCOS.COLUMN.CATEGORY',
  code: 'TOBACCOS.COLUMN.CODE',
  name: 'TOBACCOS.COLUMN.NAME',
  shortName: 'TOBACCOS.COLUMN.SHORT_NAME',
  priceKg: 'TOBACCOS.COLUMN.PRICE_KG',
  price: 'TOBACCOS.COLUMN.PRICE',
  unitWeight: 'TOBACCOS.COLUMN.UNIT_WEIGHT',
  numPieces: 'TOBACCOS.COLUMN.NUM_PIECES',
  description: 'TOBACCOS.COLUMN.DESCRIPTION',
};
const PLAIN_FIELD = /^rows\[(\d+)\]\.([A-Za-z]+)$/;
const BARCODE_FIELD = /^rows\[(\d+)\]\.barcodes\[(\d+)\]\.(barcode|quantity)$/;

/**
 * The cell problems among the details of a `422` of the import: the fields look like `rows[12].price` or `rows[12].barcodes[0].quantity`, the number being the row of the worksheet. Anything else
 * (the details about the file as a whole) is left out.
 *
 * @param details The details of the error.
 * @returns The problems in the order the server sent them.
 */
export function importProblems(details: readonly ApiErrorDetail[]): ImportProblem[] {
  const problems: ImportProblem[] = [];
  for (const { field, issue } of details) {
    const barcode = BARCODE_FIELD.exec(field);
    if (barcode !== null) {
      problems.push({
        row: Number(barcode[1]),
        columnKey:
          barcode[3] === 'barcode' ? 'TOBACCOS.IMPORT.BARCODE' : 'TOBACCOS.IMPORT.QUANTITY',
        columnParams: { n: Number(barcode[2]) + 1 },
        issue,
      });
      continue;
    }
    const plain = PLAIN_FIELD.exec(field);
    if (plain !== null && Object.hasOwn(PLAIN_COLUMNS, plain[2]!)) {
      problems.push({
        row: Number(plain[1]),
        columnKey: PLAIN_COLUMNS[plain[2]!]!,
        columnParams: {},
        issue,
      });
    }
  }
  return problems;
}
