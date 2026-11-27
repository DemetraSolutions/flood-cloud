/**
 * Duplicate-invoice check (SdI codes 00404 and 00409), following the pseudo-code of the Elenco dei controlli.
 *
 * The SdI refuses an invoice whose seller, number and year (the full date when `Art73` is `SI`) match an invoice it
 * accepted before, unless that one was rejected; the same checks refer to the **buyer** when the invoice is issued by
 * the buyer (`SoggettoEmittente` `CC`). A credit note (`TD04`) collides only with another credit note, any other type
 * only with other non-credit-note documents.
 *
 * The check needs history the validator does not have: it takes a lookup port, implemented by the queue engine on its
 * own record of what was sent. Check 00409 (a duplicate inside a batch) is not offered: the model holds exactly one
 * body and Flood sends one invoice per file.
 *
 * @module
 */
import type { IdFiscale, InvoiceModel } from '../invoice/model.ts';
import { error } from './issue.ts';
import type { ValidationIssue } from './issue.ts';

/** Elements of the invoice the model does not carry, for the rare cases that change the key. */
export interface DuplicateOptions {
  /** `SoggettoEmittente` is `CC`: the key uses the buyer's identifier instead of the seller's. */
  readonly issuedByBuyer?: boolean;
  /** `Art73` is `SI`: the key uses the full date instead of the year. */
  readonly art73?: boolean;
}

/** Answer of the lookup: whether an invoice with the same key is already known. */
export type DuplicateLookup = (key: string) => Promise<'duplicate' | 'unique'>;

function sellerId(model: InvoiceModel): IdFiscale {
  return model.versione === 'FSM10'
    ? model.FatturaElettronicaHeader.CedentePrestatore.IdFiscaleIVA
    : model.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA;
}

function buyerId(model: InvoiceModel): IdFiscale | undefined {
  return model.versione === 'FSM10'
    ? model.FatturaElettronicaHeader.CessionarioCommittente.IdentificativiFiscali.IdFiscaleIVA
    : model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.IdFiscaleIVA;
}

const NUMBER_PATH = 'FatturaElettronicaBody[0].DatiGenerali.DatiGeneraliDocumento.Numero';

/**
 * Derives the key by which two invoices are the same for the SdI.
 *
 * @param model The invoice.
 * @param options Elements not in the model (`SoggettoEmittente`, `Art73`).
 * @returns A stable string: identifier (country and code), number, year or full date, and the credit-note class.
 * @example
 * duplicateKeyOf(model); // '["IT01879020517","42","2026","other"]'
 */
export function duplicateKeyOf(model: InvoiceModel, options: DuplicateOptions = {}): string {
  const document = model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento;
  const party = options.issuedByBuyer === true ? buyerId(model) : sellerId(model);
  const identifier = party === undefined ? '' : `${party.IdPaese}${party.IdCodice}`;
  const period = options.art73 === true ? document.Data : document.Data.slice(0, 4);
  return JSON.stringify([identifier, document.Numero, period, document.TipoDocumento === 'TD04' ? 'TD04' : 'other']);
}

/**
 * Asks the history whether the invoice was already sent.
 *
 * @param model The invoice.
 * @param lookup The port that knows the invoices already accepted by the SdI.
 * @param options Elements not in the model.
 * @returns The 00404 error, or `undefined` when the invoice is new.
 * @throws Whatever the lookup throws (never swallowed: the caller decides to retry).
 */
export async function checkDuplicate(model: InvoiceModel, lookup: DuplicateLookup, options: DuplicateOptions = {}): Promise<ValidationIssue | undefined> {
  const answer = await lookup(duplicateKeyOf(model, options));
  return answer === 'duplicate' ? error('00404', NUMBER_PATH, 'Fattura già trasmessa (stesso emittente, numero e anno)') : undefined;
}
