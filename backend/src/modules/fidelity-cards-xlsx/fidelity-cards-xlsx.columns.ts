import type { RecordColumn, RecordSheet } from '../records-xlsx/records-xlsx.sheet.ts';

/** The segment of the export under `/groups/{groupId}`. */
export const CARDS_EXPORT_SEGMENT = 'fidelity-cards-export';

/** The segment of the import under `/groups/{groupId}`. */
export const CARDS_IMPORT_SEGMENT = 'fidelity-cards-import';

/**
 * The columns of the workbook of the advanced loyalty cards: the four of the CSV model of the legacy (`CODICE`, `TIPO`, `SALDO`, `PUNTI`) and `STATO`. The headers are compared without the spaces around `/`, `:` and `|`,
 * so the legacy text `TIPO (ID/NOME)` is the same column as `TIPO (ID / NOME)`.
 */
export const CARD_COLUMNS: readonly RecordColumn[] = Object.freeze([
  { key: 'code', header: 'CODICE' },
  { key: 'type', header: 'TIPO (ID / NOME)' },
  { key: 'balance', header: 'SALDO' },
  { key: 'points', header: 'PUNTI (ID / NOME : VALORE | ID / NOME : VALORE)' },
  { key: 'enabled', header: 'STATO (X = ATTIVA)' },
]);

/** The only sheet of the workbook of the cards. */
export const CARDS_SHEET: RecordSheet = Object.freeze({ name: 'Carte', columns: CARD_COLUMNS });
