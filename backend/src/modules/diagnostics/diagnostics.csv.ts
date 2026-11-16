import type { DeviceRowView } from './diagnostics.mapper.ts';

/** The columns of the CSV, in order: the ones of the legacy file, then the store key of the place. */
export const CSV_COLUMNS: readonly string[] = Object.freeze([
  'GRUPPO',
  'AZIENDA',
  'P.IVA',
  'PUNTO VENDITA',
  'DISPOSITIVO',
  'TIPO',
  'VERSIONE FLOOD',
  'SERVER',
  'SISTEMA',
  'VERSIONE',
  'MODELLO',
  'ULT. DOWNLOAD',
  'ULT. SESSIONE',
  'CHIAVE NEGOZIO',
  'ULT. USO CHIAVE',
  'VERSIONE APP NEGOZIO',
]);

/** The byte order mark that makes Excel read the file as UTF-8. */
export const CSV_BOM = '﻿';

/** The separator of the file, as the legacy one (the Italian Excel). */
const SEPARATOR = ';';

/** The characters a spreadsheet reads as the start of a formula, or that it strips: a cell that starts with one is made text. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell of the file: a cell that could be read as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe, then a cell that holds
 * the separator, a quotation mark or a line break is quoted, with the quotation marks doubled.
 *
 * @param value The text of the cell.
 * @returns The text to write in the file.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** `dd-mm-yyyy HH:MM:SS` in the Italian time zone, as the legacy file; empty for a missing date. */
const ITALY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function dateCell(iso: string | null): string {
  if (iso === null) {
    return '';
  }
  const part = Object.fromEntries(ITALY.formatToParts(new Date(iso)).map((entry) => [entry.type, entry.value]));
  return `${part['day']!}-${part['month']!}-${part['year']!} ${part['hour']!}:${part['minute']!}:${part['second']!}`;
}

/** The header line, with its line end. */
export function csvHeader(): string {
  return `${CSV_COLUMNS.map(csvCell).join(SEPARATOR)}\r\n`;
}

/**
 * The lines of some rows, each with its line end (CRLF). The VAT code of a company that is only digits gets the `_` prefix of the legacy file, so that Excel keeps its leading zeros.
 *
 * @param rows The rows of the diagnostics.
 */
export function csvLines(rows: readonly DeviceRowView[]): string {
  return rows
    .map((row) => {
      const code = row.companyCode ?? '';
      const cells = [
        row.groupName,
        row.companyName ?? '',
        /^\d+$/.test(code) ? `_${code}` : code,
        row.placeName,
        row.deviceName,
        row.deviceType ?? '',
        row.appVersion ?? '',
        row.server ? 'Sì' : 'No',
        row.platform ?? '',
        row.platformVersion ?? '',
        row.model ?? '',
        dateCell(row.lastDataDownload),
        dateCell(row.lastSession),
        row.storeKey.status === 'active' ? 'Attiva' : 'Nessuna',
        dateCell(row.storeKey.lastSeenAt),
        row.storeKey.appVersion ?? '',
      ];
      return `${cells.map(csvCell).join(SEPARATOR)}\r\n`;
    })
    .join('');
}
