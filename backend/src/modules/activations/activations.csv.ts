import { CSV_BOM, csvCell } from '../diagnostics/diagnostics.csv.ts';
import type { LineFlag, Line } from './activations.types.ts';

export { CSV_BOM };

/** The columns of the CSV of a statement, in order. */
export const CSV_COLUMNS: readonly string[] = Object.freeze(['Rivenditore', 'Gruppo', 'Azienda', 'Punto vendita', 'Attivato il', 'Piano', 'Dettaglio voci', 'Canone mensile', 'Mesi', 'Importo', 'Proiezione 12 mesi', 'Segnalazioni']);

/** The separator of the file (the Italian Excel). */
const SEPARATOR = ';';

/** What each flag says in the file. */
const FLAG_TEXT: Readonly<Record<LineFlag, string>> = Object.freeze({
  unpricedPlan: 'Piano senza prezzo',
  activationDateFromId: 'Data di attivazione dall’id',
  expired: 'Scaduto',
  groupSuspended: 'Gruppo sospeso',
  companyDisabled: 'Azienda disattivata',
});

/** An amount in cents as euro with the decimal comma (`1250` is `12,50`). */
export function euro(cents: number): string {
  return `${String(Math.floor(cents / 100))},${String(cents % 100).padStart(2, '0')}`;
}

const ITALY_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });

/** `dd-mm-yyyy` in the Italian time zone. */
function dayCell(date: Date): string {
  const part = Object.fromEntries(ITALY_DAY.formatToParts(date).map((entry) => [entry.type, entry.value]));
  return `${part['day']!}-${part['month']!}-${part['year']!}`;
}

/** The header line, with its line end. */
export function csvHeader(): string {
  return `${CSV_COLUMNS.map(csvCell).join(SEPARATOR)}\r\n`;
}

/**
 * The lines of some statement lines, each with its line end (CRLF). Every cell goes through {@link csvCell}, which makes a cell that a spreadsheet could read as a formula plain text.
 *
 * @param dealerName The name of the dealer, the first column of every line.
 * @param lines The lines of the statement.
 */
export function csvLines(dealerName: string, lines: readonly Line[]): string {
  return csvEntries(lines.map((line) => ({ dealerName, line })));
}

/**
 * The lines of some entries, each a line with the name of its dealer (the detail view has several dealers in one file). Same format and protections as {@link csvLines}.
 *
 * @param entries The lines with their dealers' names.
 */
export function csvEntries(entries: readonly { readonly dealerName: string; readonly line: Line }[]): string {
  return entries
    .map(({ dealerName, line }) => {
      const cells = [
        dealerName,
        line.groupName,
        line.companyName,
        line.placeName,
        dayCell(line.activatedAt),
        line.plan ?? '',
        line.items.map((item) => `${item.key}${item.providers === undefined ? '' : ` (${item.providers.join(', ')})`}${item.quantity === 1 ? '' : ` x${String(item.quantity)}`} ${item.unitCents === null ? '-' : euro(item.amountCents)}`).join(', '),
        euro(line.monthlyCents),
        String(line.months),
        euro(line.amountCents),
        euro(line.monthlyCents * 12),
        line.flags.map((flag) => FLAG_TEXT[flag]).join(', '),
      ];
      return `${cells.map(csvCell).join(SEPARATOR)}\r\n`;
    })
    .join('');
}
