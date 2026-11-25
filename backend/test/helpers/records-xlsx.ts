import type { RecordSheet } from '../../src/modules/records-xlsx/records-xlsx.sheet.ts';
import { xlsxChunks } from '../../src/shared/xlsx/writer.ts';

/** Writes a workbook with the real writer; the cells of a row are the texts of the columns. */
export async function writeBook(sheets: ReadonlyArray<{ readonly name: string; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of xlsxChunks(sheets.map((sheet) => ({ name: sheet.name, columns: [...sheet.columns], rows: sheet.rows.map((row) => [...row]) })))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Builds the workbook of a one-sheet domain for a test: the columns are the ones the rows use (and `headers` adds more), in the order of the sheet, written with the header the sheet gives them; a key that is not a column
 * of the sheet is written as it is (an unknown column). A column a test does not name is absent from the file, and an absent column leaves the data alone.
 *
 * @param sheet The sheet.
 * @param rows The rows: each maps the key of a column to its text.
 * @param headers Columns that must exist even when no row uses them.
 */
export async function recordsWorkbook(sheet: RecordSheet, rows: ReadonlyArray<Readonly<Record<string, string>>>, headers: readonly string[] = []): Promise<Buffer> {
  const used = new Set([...headers, ...rows.flatMap((row) => Object.keys(row))]);
  const known = sheet.columns.filter((column) => used.has(column.key));
  const others = [...used].filter((key) => !sheet.columns.some((column) => column.key === key));
  const keys = [...known.map((column) => column.key), ...others];
  const header = (key: string): string => sheet.columns.find((column) => column.key === key)?.header ?? key;
  return writeBook([{ name: sheet.name, columns: keys.map(header), rows: rows.map((row) => keys.map((key) => row[key] ?? '')) }]);
}
