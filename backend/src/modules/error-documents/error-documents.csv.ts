import { csvCell } from '../diagnostics/diagnostics.csv.ts';
import type { ErrorDocumentView } from './error-documents.mapper.ts';

export { CSV_BOM } from '../diagnostics/diagnostics.csv.ts';

/** The columns of the CSV, in order: the ones of the table, then the status of the send and the description of the error. */
export const CSV_COLUMNS: readonly string[] = Object.freeze([
  'NUMERO',
  'DATA',
  'TIPO DOCUMENTO',
  'TIPO FE',
  'CLIENTE',
  'IMPORTO',
  'AZIENDA',
  'GRUPPO',
  'STATO INVIO',
  'CODICE ERRORE',
  'DESCRIZIONE ERRORE',
]);

/** The separator of the file (the Italian Excel), as the diagnostics. */
const SEPARATOR = ';';

/** `dd-mm-yyyy` in the Italian time zone, as the legacy page; empty for a missing date. */
const ITALY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
function dateCell(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const part = Object.fromEntries(ITALY.formatToParts(new Date(iso)).map((entry) => [entry.type, entry.value]));
  return `${part['day']!}-${part['month']!}-${part['year']!}`;
}

/** An amount as the Italian Excel reads it: two decimals with a comma, no thousands separator. It is built from a number, so it holds nothing a spreadsheet could run (a `-` is a sign). */
const AMOUNT = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

const DOCUMENT_TYPES = { invoice: 'Fattura', creditNote: 'Nota di credito' } as const;

/** The header line, with its line end. */
export function csvHeader(): string {
  return `${CSV_COLUMNS.map(csvCell).join(SEPARATOR)}\r\n`;
}

/**
 * The lines of some rows, each with its line end (CRLF). Every text cell goes through `csvCell`: a cell that could be read as a formula gets a leading apostrophe and a cell that holds the
 * separator, a quotation mark or a line break is quoted.
 *
 * @param rows The rows of the documents in error.
 */
export function csvLines(rows: readonly ErrorDocumentView[]): string {
  return rows
    .map((row) => {
      const cells = [
        csvCell(row.number ?? ''),
        dateCell(row.date),
        row.documentType === null ? '' : DOCUMENT_TYPES[row.documentType],
        csvCell(row.eInvoiceType ?? ''),
        csvCell(row.customer ?? ''),
        row.total === null ? '' : AMOUNT.format(row.total),
        csvCell(row.companyName ?? ''),
        csvCell(row.groupName ?? ''),
        csvCell(row.sendStatus ?? ''),
        csvCell(row.error?.code ?? ''),
        csvCell(row.error?.description ?? ''),
      ];
      return `${cells.join(SEPARATOR)}\r\n`;
    })
    .join('');
}
