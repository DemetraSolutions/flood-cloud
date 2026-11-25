import type { RecordColumn, RecordSheet } from '../records-xlsx/records-xlsx.sheet.ts';

/** The segment of the export under `/groups/{groupId}`. */
export const CONTACTS_EXPORT_SEGMENT = 'contacts-export';

/** The segment of the import under `/groups/{groupId}`. */
export const CONTACTS_IMPORT_SEGMENT = 'contacts-import';

const col = (key: string, header: string): RecordColumn => ({ key, header });

/**
 * The 35 columns of the workbook of the contacts, with the very same headers and in the same order as the CSV model of the legacy backoffice. The headers of the person's block (`CF`, `INDIRIZZO`, `CAP`, `CITTA`,
 * `PROVINCIA (RM)`, `NAZIONE (IT)`, `TELEFONO`, `EMAIL`, `SCONTO %`) come again, with the same text, in the company's block that follows `NOME AZIENDA`: a header the file has twice is the company's when it is after
 * the `NOME AZIENDA` column ({@link CONTACTS_SHEET}'s `splitAfter`), so the model and a legacy file converted to XLSX read the same way.
 */
export const CONTACT_COLUMNS: readonly RecordColumn[] = Object.freeze([
  col('id', 'ID'),
  col('code', 'CODICE'),
  col('priceList', 'LISTINO (ID / NOME)'),
  col('customer', 'CLIENTE (X)'),
  col('supplier', 'FORNITORE (X)'),
  col('firstName', 'NOME'),
  col('lastName', 'COGNOME'),
  col('taxCode', 'CF'),
  col('birthDate', 'NASCITA (AAAA/MM/GG)'),
  col('street', 'INDIRIZZO'),
  col('postcode', 'CAP'),
  col('city', 'CITTA'),
  col('area', 'PROVINCIA (RM)'),
  col('country', 'NAZIONE (IT)'),
  col('phone', 'TELEFONO'),
  col('email', 'EMAIL'),
  col('discount', 'SCONTO %'),
  col('companyName', 'NOME AZIENDA'),
  col('vatNumber', 'PIVA'),
  col('companyTaxCode', 'CF'),
  col('companyStreet', 'INDIRIZZO'),
  col('companyPostcode', 'CAP'),
  col('companyCity', 'CITTA'),
  col('companyArea', 'PROVINCIA (RM)'),
  col('companyCountry', 'NAZIONE (IT)'),
  col('companyPhone', 'TELEFONO'),
  col('companyEmail', 'EMAIL'),
  col('fax', 'FAX'),
  col('companyDiscount', 'SCONTO %'),
  col('fidelity', 'FIDELITY'),
  col('transmission', 'TRASMISSIONE (FPR12 / FPA12)'),
  col('channel', 'IDENTIFICATIVO (CD / PEC)'),
  col('recipientCode', 'CODICE DESTINATARIO'),
  col('pec', 'PEC'),
  col('delete', 'CANCELLAZIONE (X)'),
]);

/** The only sheet of the workbook of the contacts. */
export const CONTACTS_SHEET: RecordSheet = Object.freeze({ name: 'Contatti', columns: CONTACT_COLUMNS, splitAfter: 'companyName' });
