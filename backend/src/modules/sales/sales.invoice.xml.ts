import type { Document } from 'mongodb';
import { listOf, recordOf, textOrNull } from './sales.document.ts';
import { SAFE_TEXT, isCalendarDate } from './sales.lines.ts';
import type { LooseObject } from './sales.write.schemas.ts';

/** What was found wrong in the partial FatturaPA object of the till: the code of the anomaly (or of the refusal) and the path inside `xml`. */
export interface XmlIssue {
  readonly code: 'invoiceXmlInvalid' | 'invoiceIbanUnknown' | 'invoiceSplitPaymentDenied';
  readonly path: string;
}

/** What the reduction of the `xml` of an invoice gives: the object to save and what was left out and why. */
export interface InvoiceXml {
  readonly xml: Document | null;
  readonly issues: XmlIssue[];
}

/** What the reduction needs to know to judge the bank data and the split payment: the company (its banks and name) and the customer. */
export interface InvoiceXmlContext {
  readonly company: Document;
  readonly counterpart: Document;
}

/** A check of one value: the value to keep (normalized), or `undefined` when it is out of its domain. */
type Check = (value: unknown) => unknown;
interface Spec {
  readonly [name: string]: Check | Spec;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/;
const DECIMAL = /^\d{1,12}(?:\.\d{1,8})?$/;

/** A text of `min` to `max` characters the electronic invoice allows. */
const text =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === 'string' && value.length >= min && value.length <= max && SAFE_TEXT.test(value) ? value : undefined;

/** One of the listed values. */
const oneOf =
  (values: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value) ? value : undefined;

/** A text made of exactly `length` digits. */
const digits =
  (length: number): Check =>
  (value) =>
    typeof value === 'string' && new RegExp(`^\\d{${String(length)}}$`).test(value) ? value : undefined;

/** A text made of exactly `length` capital letters. */
const letters =
  (length: number): Check =>
  (value) =>
    typeof value === 'string' && new RegExp(`^[A-Z]{${String(length)}}$`).test(value) ? value : undefined;

/** A real calendar date as `YYYY-MM-DD`. */
const dateOnly: Check = (value) => (isCalendarDate(value) ? value : undefined);

/** A date and time (`YYYY-MM-DDThh:mm:ss`, with fractions and an offset if wanted) whose date is real. */
const dateTime: Check = (value) => {
  const found = typeof value === 'string' ? DATE_TIME.exec(value) : null;
  return found !== null && dateOnly(found[1]) !== undefined && !Number.isNaN(Date.parse(value as string)) ? value : undefined;
};

/** A number that is not negative, finite and at most `max`, as a number or as the text of a decimal. */
const amount =
  (max: number): Check =>
  (value) => {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
    }
    return typeof value === 'string' && DECIMAL.test(value) && Number(value) <= max ? value : undefined;
  };

/** A whole count from 0 to `max`, as a number or as text. */
const count =
  (max: number): Check =>
  (value) => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN;
    return Number.isInteger(number) && number >= 0 && number <= max ? value : undefined;
  };

const PAYMENT_CONDITIONS = ['TP01', 'TP02', 'TP03'] as const;
const PAYMENT_METHODS = Array.from({ length: 23 }, (_, index) => `MP${String(index + 1).padStart(2, '0')}`);

/** The parts of the partial FatturaPA object of the till the electronic invoice reads, with the domain of each value (the lengths are the ones of the schema of the invoice). */
const BODY: Spec = {
  DatiGenerali: {
    DatiGeneraliDocumento: { ScontoMaggiorazione: { Tipo: oneOf(['SC', 'MG']) } },
    DatiOrdineAcquisto: { IdDocumento: text(1, 20), Data: dateOnly, CodiceCUP: text(1, 15), CodiceCIG: text(1, 15) },
    DatiTrasporto: {
      DatiAnagraficiVettore: {
        IdFiscaleIVA: { IdPaese: letters(2), IdCodice: text(1, 28) },
        CodiceFiscale: text(11, 16),
        Anagrafica: { Denominazione: text(1, 80), Nome: text(1, 60), Cognome: text(1, 60), Titolo: text(2, 10), CodEORI: text(13, 17) },
        NumeroLicenzaGuida: text(1, 20),
      },
      MezzoTrasporto: text(1, 80),
      CausaleTrasporto: text(1, 100),
      NumeroColli: count(9999),
      Descrizione: text(1, 100),
      UnitaMisuraPeso: text(1, 10),
      PesoLordo: amount(9_999_999),
      PesoNetto: amount(9_999_999),
      DataOraRitiro: dateTime,
      DataInizioTrasporto: dateOnly,
      TipoResa: letters(3),
      IndirizzoResa: { Indirizzo: text(1, 60), NumeroCivico: text(1, 8), CAP: digits(5), Comune: text(1, 60), Provincia: letters(2), Nazione: letters(2) },
      DataOraConsegna: dateTime,
    },
  },
  DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: oneOf(['I', 'D', 'S']) } },
  DatiPagamento: { CondizioniPagamento: oneOf(PAYMENT_CONDITIONS) },
};

/** What of a payment the till decides: how, when and how much. The bank (`IBAN` and the data that go with it) and the beneficiary are never the till's: they come from the company. */
const PAYMENT: Spec = { ModalitaPagamento: oneOf(PAYMENT_METHODS), DataScadenzaPagamento: dateOnly, ImportoPagamento: amount(1_000_000_000) };

/** How many payments an invoice keeps. */
const MAX_PAYMENTS = 20;

const isObject = (raw: unknown): raw is LooseObject => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Whether a value stands for "not filled in": the tills send `null` and empty texts for what the user left blank, which is neither kept nor reported. */
const blank = (value: unknown): boolean => value === null || value === undefined || value === '';

/** Keeps of `raw` the fields of `spec` that are in their domain; reports (with the path) the ones that were sent and are not. `undefined` when nothing is kept. */
function reduce(raw: unknown, spec: Spec, path: string, issues: XmlIssue[]): Document | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  const kept: Document = {};
  for (const [name, rule] of Object.entries(spec)) {
    const value = Object.hasOwn(raw, name) ? raw[name] : undefined;
    const here = `${path}.${name}`;
    if (typeof rule === 'function') {
      const checked = blank(value) ? undefined : rule(value);
      if (checked !== undefined) {
        kept[name] = checked;
      } else if (!blank(value)) {
        issues.push({ code: 'invoiceXmlInvalid', path: here });
      }
    } else {
      const inner = reduce(value, rule, here, issues);
      if (inner !== undefined) {
        kept[name] = inner;
      }
    }
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** An IBAN as compared: without spaces, in capitals. */
const normalIban = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : '');

/** The bank data of a payment, from the bank of the company the IBAN names; `undefined` when the company has no such bank. Nothing of it comes from the till. */
function bankOf(company: Document, iban: string): Document | undefined {
  const bank = listOf(company['banks']).find((candidate) => normalIban(candidate['iban']) === iban);
  if (bank === undefined) {
    return undefined;
  }
  const kept: Document = { IBAN: iban };
  const institute = text(1, 80)(textOrNull(bank['name']) ?? '');
  const abi = digits(5)(textOrNull(bank['abi']) ?? '');
  const cab = digits(5)(textOrNull(bank['cab']) ?? '');
  const bic = typeof bank['bic'] === 'string' && /^[A-Z0-9]{8,11}$/.test(bank['bic'].toUpperCase()) ? bank['bic'].toUpperCase() : undefined;
  return { ...kept, ...(institute === undefined ? {} : { IstitutoFinanziario: institute }), ...(abi === undefined ? {} : { ABI: abi }), ...(cab === undefined ? {} : { CAB: cab }), ...(bic === undefined ? {} : { BIC: bic }) };
}

/**
 * Reduces the partial FatturaPA object of the till to what the electronic invoice reads, **checking the domain of every value** (the codes of the standard, the dates, the numbers, the characters, the lengths of the schema of the invoice): a value out of its domain is left
 * out and reported, never kept. The payments keep what the till decides (how, when, how much); the bank data come only from a bank **of the company** that the IBAN of the till names, and the beneficiary is always the company; an IBAN the company does not have is left out
 * with everything that goes with it (`invoiceIbanUnknown`). `S` (split payment) in the due date of the VAT is kept only for a customer that has the split payment (`invoiceSplitPaymentDenied` otherwise).
 *
 * @param raw The `xml` of the invoice options of the body (bounded, with unknown fields), when the till sent one.
 * @param context The company and the customer of the invoice, as read from the database.
 * @returns The object to save in `XML` (`null` when nothing is kept) and the issues.
 */
export function reduceInvoiceXml(raw: LooseObject | null | undefined, context: InvoiceXmlContext): InvoiceXml {
  const issues: XmlIssue[] = [];
  const body = recordOf(raw?.['FatturaElettronicaBody']);
  const kept = reduce(body, BODY, 'FatturaElettronicaBody', issues) ?? {};
  const due = recordOf(recordOf(kept['DatiBeniServizi'])['DatiRiepilogo']);
  if (due['EsigibilitaIVA'] === 'S' && recordOf(context.counterpart['fattura_elettronica'])['split_payment'] !== true) {
    issues.push({ code: 'invoiceSplitPaymentDenied', path: 'FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA' });
    // The due date of the VAT is the only thing of the section the till decides.
    delete kept['DatiBeniServizi'];
  }
  const payment = recordOf(body['DatiPagamento']);
  const details: Document[] = [];
  (Array.isArray(payment['DettaglioPagamento']) ? (payment['DettaglioPagamento'] as unknown[]) : []).slice(0, MAX_PAYMENTS).forEach((item, index) => {
    const path = `FatturaElettronicaBody.DatiPagamento.DettaglioPagamento.${String(index)}`;
    const detail = reduce(item, PAYMENT, path, issues);
    const iban = normalIban(recordOf(item)['IBAN']);
    const bank = iban === '' ? undefined : bankOf(context.company, iban);
    if (iban !== '' && bank === undefined) {
      issues.push({ code: 'invoiceIbanUnknown', path: `${path}.IBAN` });
    }
    if (detail !== undefined || bank !== undefined) {
      details.push({ Beneficiario: String(context.company['name'] ?? '').slice(0, 200), ...detail, ...bank });
    }
  });
  if (details.length > 0) {
    kept['DatiPagamento'] = { ...recordOf(kept['DatiPagamento']), DettaglioPagamento: details };
  }
  return { xml: Object.keys(kept).length === 0 ? null : { FatturaElettronicaBody: kept }, issues };
}
