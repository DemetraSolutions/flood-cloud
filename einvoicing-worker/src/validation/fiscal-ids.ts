/**
 * Offline checks of the Italian fiscal identifiers (code `FISCAL_ID`, severity `error`).
 *
 * The SdI verifies fiscal identifiers against the tax registry (codes 00300 to 00306); the worker cannot, but it can
 * catch typos before sending: an Italian VAT number is 11 digits with the official check digit, an Italian fiscal
 * code is 16 characters with the official check character (the letters of the *omocodia* substitution are accepted)
 * or, for companies, an 11-digit number that follows the VAT rules. Identifiers with a foreign country code are never
 * touched (their formats are not ours to know). Whether the identifier exists in the registry stays with the SdI.
 *
 * @module
 */
import type { IdFiscale, InvoiceModel } from '../invoice/model.ts';
import { error } from './issue.ts';
import type { ValidationIssue } from './issue.ts';

const VAT_NUMBER = /^\d{11}$/;
const PERSON_FISCAL_CODE = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** Value of a character in an odd position (1, 3, 5...) of a fiscal code; digits use the entries of `A` to `J`. */
const ODD_VALUES = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
const ASCII_ZERO = 48;
const ASCII_A = 65;

/**
 * Whether a text is a valid Italian VAT number: 11 digits whose last one is the check digit (Luhn-style: the digits
 * in even positions are doubled, minus nine when the double exceeds nine).
 *
 * @param code The text.
 * @returns `true` when it is well formed and the check digit matches.
 * @example
 * isValidVatNumber('01879020517'); // true
 */
export function isValidVatNumber(code: string): boolean {
  if (!VAT_NUMBER.test(code)) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const digit = code.charCodeAt(index) - ASCII_ZERO;
    const doubled = digit * 2;
    sum += index % 2 === 0 ? digit : doubled > 9 ? doubled - 9 : doubled;
  }
  return (10 - (sum % 10)) % 10 === code.charCodeAt(10) - ASCII_ZERO;
}

function letterIndex(character: string): number {
  const code = character.charCodeAt(0);
  return code >= ASCII_A ? code - ASCII_A : code - ASCII_ZERO;
}

function checkCharacter(code: string): string {
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    const position = letterIndex(code.charAt(index));
    sum += index % 2 === 0 ? (ODD_VALUES[position] as number) : position;
  }
  return String.fromCharCode(ASCII_A + (sum % 26));
}

/**
 * Whether a text is a valid Italian fiscal code: 16 characters in the official layout with the right check character
 * (omocodia letters accepted in the digit positions), or an 11-digit number that is a valid VAT number.
 *
 * @param code The text (upper case, as the schema requires).
 * @returns `true` when it is well formed and the check character matches.
 * @example
 * isValidFiscalCode('RSSMRA85T10A562S'); // true
 */
export function isValidFiscalCode(code: string): boolean {
  if (VAT_NUMBER.test(code)) {
    return isValidVatNumber(code);
  }
  return PERSON_FISCAL_CODE.test(code) && checkCharacter(code) === code.charAt(15);
}

interface Party {
  readonly vat: IdFiscale | undefined;
  readonly fiscalCode: string | undefined;
  /** Path of the party block that holds `IdFiscaleIVA` and `CodiceFiscale`. */
  readonly path: string;
}

function checkParty(party: Party): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const italian = party.vat === undefined || party.vat.IdPaese === 'IT';
  if (party.vat?.IdPaese === 'IT' && !isValidVatNumber(party.vat.IdCodice)) {
    issues.push(error('FISCAL_ID', `${party.path}.IdFiscaleIVA.IdCodice`, 'Partita IVA italiana non valida (formato o cifra di controllo)'));
  }
  if (party.fiscalCode !== undefined && italian && !isValidFiscalCode(party.fiscalCode)) {
    issues.push(error('FISCAL_ID', `${party.path}.CodiceFiscale`, 'Codice fiscale non valido (formato o carattere di controllo)'));
  }
  return issues;
}

/**
 * Checks the fiscal identifiers of the seller and of the buyer.
 *
 * @param model The invoice.
 * @returns One `FISCAL_ID` error per Italian identifier that is malformed or has a wrong check digit.
 */
export function checkFiscalIds(model: InvoiceModel): ValidationIssue[] {
  const header = 'FatturaElettronicaHeader';
  if (model.versione === 'FSM10') {
    const seller = model.FatturaElettronicaHeader.CedentePrestatore;
    const buyer = model.FatturaElettronicaHeader.CessionarioCommittente.IdentificativiFiscali;
    return [
      ...checkParty({ vat: seller.IdFiscaleIVA, fiscalCode: seller.CodiceFiscale, path: `${header}.CedentePrestatore` }),
      ...checkParty({ vat: buyer.IdFiscaleIVA, fiscalCode: buyer.CodiceFiscale, path: `${header}.CessionarioCommittente.IdentificativiFiscali` }),
    ];
  }
  const seller = model.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici;
  const buyer = model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici;
  return [
    ...checkParty({ vat: seller.IdFiscaleIVA, fiscalCode: seller.CodiceFiscale, path: `${header}.CedentePrestatore.DatiAnagrafici` }),
    ...checkParty({ vat: buyer.IdFiscaleIVA, fiscalCode: buyer.CodiceFiscale, path: `${header}.CessionarioCommittente.DatiAnagrafici` }),
  ];
}
