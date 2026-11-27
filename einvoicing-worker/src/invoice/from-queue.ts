/**
 * Mapping from a record of the legacy e-invoicing queue to the typed invoice model.
 *
 * `mapQueueRecord` is pure: no database, no provider, no clock. It reads the record defensively
 * (`queue-record.ts`), decides the format, builds seller, buyer, document data, lines and VAT summaries with exact
 * arithmetic (`amounts.ts`, so the SdI calculation checks pass by construction), and returns either the model or the
 * list of data problems (`MappingIssue`: a path and a code, never the value). Text problems (a character the schema
 * cannot hold, a value cut at the field limit) never block an invoice: they come back as warnings.
 *
 * The format is `FSM10` when `fattura_elettronica.tipo` is `TD07`, `TD08` or `TD09`; otherwise it is the counterpart's
 * `formato_trasmissione` (`FPR12` or `FPA12`, `FPR12` when empty).
 *
 * @module
 */
import { taxableAmount, taxAmount } from './amounts.ts';
import { add, compare, decimal, round } from './decimal.ts';
import { adjustmentLines, documentDiscount, groupByVat, mapLines } from './map-lines.ts';
import type { MappedLine, VatGroup } from './map-lines.ts';
import { mapLinkedInvoices, mapOrders, mapPayments, mapRectified, mapTransport } from './map-optional.ts';
import {
  address,
  createContext,
  formatDate,
  freeText,
  has,
  invalid,
  missing,
  normalizeCountry,
  optionalCode,
  requiredCode,
  requiredInvoiceDate,
  requiredText,
} from './map-support.ts';
import type { MapContext, MappingIssue, MappingWarning } from './map-support.ts';
import type {
  CedentePrestatore,
  CedentePrestatoreSemplificata,
  CessionarioCommittente,
  CessionarioCommittenteSemplificata,
  DatiDocumentiCorrelati,
  DatiRiepilogo,
  DatiTrasmissione,
  DatiBeniServiziSemplificata,
  DettaglioLinee,
  FatturaElettronicaBody,
  IdFiscale,
  Indirizzo,
  InvoiceModel,
  IscrizioneREA,
  Nominativo,
} from './model.ts';
import { readQueueRecord } from './queue-record.ts';
import type { QueueCounterpart, QueueRecord } from './queue-record.ts';
import { splitText } from './text.ts';

export type { MappingIssue, MappingWarning } from './map-support.ts';

/** Options of {@link mapQueueRecord}. */
export interface MappingOptions {
  /**
   * Transmitter of the file (`IdTrasmittente`), supplied by the provider adapter (Aruba requires its own fiscal
   * code). The company's own transmitter (`fattura_elettronica.IdTrasmittente_paese` and `_codice`, both set) wins.
   */
  readonly transmitter: IdFiscale;
  /** Time zone that turns instants into invoice dates; default `Europe/Rome`. */
  readonly timeZone?: string;
  /**
   * The original invoice a credit note corrects, read by the queue engine from the group's documents. It becomes
   * `DatiFattureCollegate` (number written like the record's own, and date) only when the record's `XML` block carries
   * no linked invoice of its own (what the user typed in the form wins) and the format is ordinary (`FPR12`, `FPA12`).
   */
  readonly linkedInvoice?: LinkedInvoice;
}

/** The original document of a credit note, as stored in the group's `documents`. */
export interface LinkedInvoice {
  /** Document number (digits only, as the record's own `number`). */
  readonly number: string;
  /** Section (`prefixSuffix`) of the original, `''` when it has none. */
  readonly prefixSuffix: string;
  /** Date of the original, `null` when unknown (then `Data` is left out). */
  readonly date: Date | null;
}

/** Result of {@link mapQueueRecord}. */
export type MappingResult =
  | { readonly ok: true; readonly model: InvoiceModel; readonly warnings: readonly MappingWarning[] }
  | { readonly ok: false; readonly issues: readonly MappingIssue[] };

/** Time zone of the invoice dates when the caller gives none. */
export const DEFAULT_TIME_ZONE = 'Europe/Rome';

/** Legal reference written on a summary subject to split payment (legacy text). */
const SPLIT_PAYMENT_REFERENCE = 'ex art 17-ter DPR 633/72';

const SIMPLIFIED_TYPES: ReadonlySet<string> = new Set(['TD07', 'TD08', 'TD09']);
const ORDINARY_TYPES: ReadonlySet<string> = new Set([
  'TD01', 'TD02', 'TD03', 'TD04', 'TD05', 'TD06', 'TD16', 'TD17', 'TD18', 'TD19', 'TD20',
  'TD21', 'TD22', 'TD23', 'TD24', 'TD25', 'TD26', 'TD27', 'TD28', 'TD29',
]);
const REGIME = /^RF(0[12]|0[4-9]|1\d|2[01])$/;
const COUNTRY = /^[A-Z]{2}$/;
const FISCAL_CODE = /^[A-Z0-9]{11,16}$/;

type Format = 'FPR12' | 'FPA12' | 'FSM10';

const HEADER = 'FatturaElettronicaHeader';
const DOCUMENT = 'FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento';

function compactUpper(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** Removes a leading country prefix from a VAT number (`IT01234567890` for Italy); never anywhere else. */
function stripCountryPrefix(value: string, country: string): string {
  return country !== '' && value.startsWith(country) && value.length > country.length ? value.slice(country.length) : value;
}

function oneOf<T extends string>(context: MapContext, path: string, raw: string, allowed: readonly T[], required: boolean): T | undefined {
  const value = raw.trim().toUpperCase();
  if (value === '') {
    if (required) {
      missing(context, path);
    }
    return undefined;
  }
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    invalid(context, path);
  }
  return found;
}

/** Document type and transmission format. */
function resolveFormat(context: MapContext, record: QueueRecord): { readonly type: string; readonly format: Format } {
  const type = record.documentType.trim().toUpperCase();
  const path = `${DOCUMENT}.TipoDocumento`;
  const simplified = SIMPLIFIED_TYPES.has(type);
  if (type === '') {
    missing(context, path);
  } else if (!simplified && !ORDINARY_TYPES.has(type)) {
    invalid(context, path);
  }
  if (simplified) {
    return { type, format: 'FSM10' };
  }
  const formatPath = 'counterpart.fattura_elettronica.formato_trasmissione';
  const requested = record.counterpart.format.trim().toUpperCase();
  if (requested !== '' && requested !== 'FPR12' && requested !== 'FPA12') {
    context.issues.push({ path: formatPath, issue: 'unsupported' });
  }
  return { type, format: requested === 'FPA12' ? 'FPA12' : 'FPR12' };
}

interface Recipient {
  readonly code: string;
  readonly pec?: string;
}

/** `CodiceDestinatario` and `PECDestinatario` (legacy rules, checked against the specification and check 00427). */
function mapRecipient(context: MapContext, counterpart: QueueCounterpart, format: Format, foreign: boolean): Recipient {
  const path = `${HEADER}.DatiTrasmissione`;
  const channel = counterpart.channel.trim().toUpperCase();
  const publicAdministration = format === 'FPA12';
  if (channel === 'CD' && counterpart.recipientCode.trim() !== '') {
    const value = compactUpper(counterpart.recipientCode);
    if (!new RegExp(`^[A-Z0-9]{${publicAdministration ? 6 : 7}}$`).test(value)) {
      invalid(context, `${path}.CodiceDestinatario`);
      return { code: '' };
    }
    return { code: value };
  }
  if (channel === 'PEC' && counterpart.pec.trim() !== '' && !publicAdministration) {
    const pec = counterpart.pec.trim();
    if (pec.length > 256 || !/^[^\s@]+@[^\s@]+$/.test(pec)) {
      invalid(context, `${path}.PECDestinatario`);
    }
    return { code: '0000000', pec };
  }
  if (publicAdministration) {
    return { code: '999999' };
  }
  return { code: foreign ? 'XXXXXXX' : '0000000' };
}

interface Seller {
  readonly IdFiscaleIVA: IdFiscale;
  readonly CodiceFiscale?: string;
  readonly Denominazione: string;
  readonly RegimeFiscale: string;
  readonly Sede: Indirizzo;
  readonly IscrizioneREA?: IscrizioneREA;
}

function mapRea(context: MapContext, record: QueueRecord, path: string): IscrizioneREA | undefined {
  const company = record.company;
  if (company.reaNumber.trim() === '') {
    return undefined;
  }
  const partners = oneOf(context, `${path}.SocioUnico`, company.reaPartners, ['SU', 'SM'], false);
  return {
    Ufficio: requiredCode(context, `${path}.Ufficio`, company.reaOffice.toUpperCase(), 2, COUNTRY),
    NumeroREA: requiredCode(context, `${path}.NumeroREA`, company.reaNumber, 20),
    ...has('CapitaleSociale', company.reaCapital === null ? undefined : round(company.reaCapital, 2)),
    ...has('SocioUnico', partners),
    StatoLiquidazione: oneOf(context, `${path}.StatoLiquidazione`, company.reaLiquidation, ['LS', 'LN'], true) ?? 'LN',
  };
}

function mapSeller(context: MapContext, record: QueueRecord): Seller {
  const company = record.company;
  const path = `${HEADER}.CedentePrestatore`;
  const data = `${path}.DatiAnagrafici`;
  return {
    IdFiscaleIVA: {
      IdPaese: 'IT',
      IdCodice: requiredCode(context, `${data}.IdFiscaleIVA.IdCodice`, stripCountryPrefix(compactUpper(company.code), 'IT'), 28),
    },
    ...has('CodiceFiscale', optionalCode(context, `${data}.CodiceFiscale`, compactUpper(company.code2), 16, FISCAL_CODE)),
    Denominazione: requiredText(context, `${data}.Anagrafica.Denominazione`, company.name, 'latin', 80),
    RegimeFiscale: requiredCode(context, `${data}.RegimeFiscale`, company.regime.toUpperCase(), 4, REGIME),
    Sede: address(context, `${path}.Sede`, {
      street: company.address,
      postcode: company.postcode,
      city: company.city,
      area: company.countryAreaCode,
      country: 'IT',
    }),
    ...has('IscrizioneREA', mapRea(context, record, `${path}.IscrizioneREA`)),
  };
}

interface Buyer {
  readonly IdFiscaleIVA?: IdFiscale;
  readonly CodiceFiscale?: string;
  readonly nominativo: Nominativo;
  readonly Sede: Indirizzo;
}

function mapCompanyBuyer(context: MapContext, counterpart: QueueCounterpart, format: Format): Buyer {
  const path = `${HEADER}.CessionarioCommittente`;
  const data = `${path}.DatiAnagrafici`;
  const country = normalizeCountry(counterpart.companyCountryCode);
  const vat = stripCountryPrefix(compactUpper(counterpart.companyCode), country);
  const fiscal = compactUpper(counterpart.companyCode2);
  if (vat === '' && fiscal === '') {
    missing(context, `${data}.IdFiscaleIVA`);
  }
  // A public administration is identified by its fiscal code (the IPA directory is keyed on it): the VAT number is
  // written only when the record has no fiscal code.
  const useVat = vat !== '' && !(format === 'FPA12' && fiscal !== '');
  const idFiscale: IdFiscale | undefined = useVat
    ? {
        IdPaese: requiredCode(context, `${data}.IdFiscaleIVA.IdPaese`, country, 2, COUNTRY),
        IdCodice: requiredCode(context, `${data}.IdFiscaleIVA.IdCodice`, vat, 28),
      }
    : undefined;
  return {
    ...has('IdFiscaleIVA', idFiscale),
    ...has('CodiceFiscale', optionalCode(context, `${data}.CodiceFiscale`, fiscal, 16, FISCAL_CODE)),
    nominativo: { Denominazione: requiredText(context, `${data}.Anagrafica.Denominazione`, counterpart.companyName, 'latin', 80) },
    Sede: address(context, `${path}.Sede`, {
      street: counterpart.companyAddress,
      postcode: counterpart.companyPostcode,
      city: counterpart.companyCity,
      area: counterpart.companyCountryAreaCode,
      country: counterpart.companyCountryCode,
    }),
  };
}

function mapPersonBuyer(context: MapContext, counterpart: QueueCounterpart): Buyer {
  const path = `${HEADER}.CessionarioCommittente`;
  const data = `${path}.DatiAnagrafici`;
  return {
    CodiceFiscale: requiredCode(context, `${data}.CodiceFiscale`, compactUpper(counterpart.code), 16, FISCAL_CODE),
    nominativo: {
      Nome: requiredText(context, `${data}.Anagrafica.Nome`, counterpart.name, 'latin', 60),
      Cognome: requiredText(context, `${data}.Anagrafica.Cognome`, counterpart.surname, 'latin', 60),
    },
    Sede: address(context, `${path}.Sede`, {
      street: counterpart.address,
      postcode: counterpart.postcode,
      city: counterpart.city,
      area: counterpart.countryAreaCode,
      country: counterpart.countryCode,
    }),
  };
}

function mapBuyer(context: MapContext, record: QueueRecord, format: Format): Buyer {
  const type = record.customerType;
  if (type !== null && compare(type, decimal(2n)) === 0) {
    return mapCompanyBuyer(context, record.counterpart, format);
  }
  if (type === null) {
    missing(context, 'customerType');
  } else if (compare(type, decimal(1n)) !== 0) {
    invalid(context, 'customerType');
  }
  return mapPersonBuyer(context, record.counterpart);
}

/** Invoice number as printed: the digits with the section as prefix or suffix, as the company chose. */
function formatNumber(context: MapContext, path: string, number: string, section: string, mode: string): string {
  const digits = number.trim();
  if (digits === '') {
    missing(context, path);
    return '';
  }
  if (!/^\d+$/.test(digits)) {
    invalid(context, path);
    return '';
  }
  const raw = mode === 'prefix' ? `${section}${digits}` : mode === 'suffix' ? `${digits}${section}` : digits;
  return requiredCode(context, path, raw, 20);
}

/** Invoice number: the document number with the section as prefix or suffix, as the company chose. */
function mapNumber(context: MapContext, record: QueueRecord): string {
  return formatNumber(context, `${DOCUMENT}.Numero`, record.number, record.prefixSuffix, record.company.invoicesPS);
}

/** The original invoice of a credit note as a `DatiFattureCollegate` block (the company's numbering applies to both). */
function mapOriginalInvoice(context: MapContext, record: QueueRecord, original: LinkedInvoice): DatiDocumentiCorrelati[] {
  const path = 'FatturaElettronicaBody.DatiGenerali.DatiFattureCollegate[0].IdDocumento';
  const id = formatNumber(context, path, original.number, original.prefixSuffix, record.company.invoicesPS);
  return [{ IdDocumento: id, ...has('Data', original.date === null ? undefined : formatDate(original.date, context.timeZone)) }];
}

function mapTransmission(context: MapContext, record: QueueRecord, options: MappingOptions, format: Format, recipient: Recipient): DatiTrasmissione {
  const path = `${HEADER}.DatiTrasmissione`;
  const company = record.company;
  const own = company.transmitterCountry.trim() !== '' && company.transmitterCode.trim() !== '';
  const transmitter = own ? { IdPaese: company.transmitterCountry, IdCodice: company.transmitterCode } : options.transmitter;
  return {
    IdTrasmittente: {
      IdPaese: requiredCode(context, `${path}.IdTrasmittente.IdPaese`, transmitter.IdPaese.toUpperCase(), 2, COUNTRY),
      IdCodice: requiredCode(context, `${path}.IdTrasmittente.IdCodice`, compactUpper(transmitter.IdCodice), 28),
    },
    ProgressivoInvio: requiredCode(context, `${path}.ProgressivoInvio`, record.progressive, 10),
    FormatoTrasmissione: format,
    CodiceDestinatario: recipient.code,
    ...has('PECDestinatario', recipient.pec),
  };
}

function mapVatSummary(groups: readonly VatGroup[], splitPayment: boolean): DatiRiepilogo[] {
  return groups.map((group): DatiRiepilogo => {
    const taxable = taxableAmount(group.totals);
    const split = splitPayment && !(group.natura ?? '').startsWith('N6');
    const normative = split ? SPLIT_PAYMENT_REFERENCE : group.normative;
    return {
      AliquotaIVA: group.rate,
      ...has('Natura', group.natura),
      ImponibileImporto: taxable,
      Imposta: taxAmount(taxable, group.rate),
      EsigibilitaIVA: split ? 'S' : 'I',
      ...has('RiferimentoNormativo', normative),
    };
  });
}

function mapOrdinaryBody(
  context: MapContext,
  record: QueueRecord,
  type: string,
  lines: readonly MappedLine[],
  original: LinkedInvoice | undefined,
): FatturaElettronicaBody {
  const reason = freeText(context, `${DOCUMENT}.Causale`, record.note, 'latin', Number.POSITIVE_INFINITY);
  const orders = mapOrders(context, record.xml.orders);
  const typed = mapLinkedInvoices(context, record.xml.linkedInvoices);
  const linked = typed.length === 0 && original !== undefined ? mapOriginalInvoice(context, record, original) : typed;
  const transport = mapTransport(context, record.xml.transport);
  const payments = mapPayments(context, record.xml);
  const total = record.total;
  if (total === null) {
    missing(context, `${DOCUMENT}.ImportoTotaleDocumento`);
  }
  const detail = lines.map((line, index): DettaglioLinee => ({
    NumeroLinea: index + 1,
    Descrizione: line.Descrizione,
    Quantita: line.Quantita,
    PrezzoUnitario: line.PrezzoUnitario,
    ...(line.ScontoMaggiorazione.length > 0 ? { ScontoMaggiorazione: line.ScontoMaggiorazione } : {}),
    PrezzoTotale: line.PrezzoTotale,
    AliquotaIVA: line.AliquotaIVA,
    ...has('Natura', line.Natura),
    ...(line.AltriDatiGestionali.length > 0 ? { AltriDatiGestionali: line.AltriDatiGestionali } : {}),
  }));
  return {
    DatiGenerali: {
      DatiGeneraliDocumento: {
        TipoDocumento: type,
        Divisa: requiredCode(context, `${DOCUMENT}.Divisa`, record.company.currencyCode.toUpperCase(), 3, /^[A-Z]{3}$/),
        Data: requiredInvoiceDate(context, `${DOCUMENT}.Data`, record.date),
        Numero: mapNumber(context, record),
        ...has('ImportoTotaleDocumento', total === null ? undefined : round(total, 2)),
        ...(reason === undefined ? {} : { Causale: splitText(reason, 200) }),
      },
      ...(orders.length > 0 ? { DatiOrdineAcquisto: orders } : {}),
      ...(linked.length > 0 ? { DatiFattureCollegate: linked } : {}),
      ...has('DatiTrasporto', transport),
    },
    DatiBeniServizi: { DettaglioLinee: detail, DatiRiepilogo: mapVatSummary(groupByVat(lines), record.xml.splitPayment) },
    ...(payments.length > 0 ? { DatiPagamento: payments } : {}),
  };
}

function mapSimplifiedGoods(context: MapContext, groups: readonly VatGroup[]): DatiBeniServiziSemplificata[] {
  return groups.map((group, index): DatiBeniServiziSemplificata => {
    const taxable = taxableAmount(group.totals);
    const tax = taxAmount(taxable, group.rate);
    return {
      Descrizione: requiredText(context, `FatturaElettronicaBody.DatiBeniServizi[${index}].Descrizione`, group.descriptions.join('; '), 'latin', 1000),
      Importo: add(taxable, tax),
      DatiIVA: { Aliquota: group.rate },
      ...has('Natura', group.natura),
      ...has('RiferimentoNormativo', group.normative),
    };
  });
}

/**
 * Maps a queue record to an invoice model.
 *
 * @param record The record read from the queue (anything: it is read defensively).
 * @param options The transmitter and, optionally, the time zone of the dates.
 * @returns `ok: true` with the model and the text warnings, or `ok: false` with every data problem found (path and
 * code only, never a value). No data problem throws.
 * @throws RangeError When `options.timeZone` is not a valid IANA time zone (a configuration error, not a data one).
 */
export function mapQueueRecord(record: unknown, options: MappingOptions): MappingResult {
  const read = readQueueRecord(record);
  if (!read.ok) {
    return { ok: false, issues: read.issues };
  }
  const data = read.value;
  const context = createContext(options.timeZone ?? DEFAULT_TIME_ZONE);
  const { type, format } = resolveFormat(context, data);
  const seller = mapSeller(context, data);
  const buyer = mapBuyer(context, data, format);
  const foreign = buyer.Sede.Nazione !== '' && buyer.Sede.Nazione !== 'IT';
  const recipient = mapRecipient(context, data.counterpart, format, foreign);
  const transmission = mapTransmission(context, data, options, format, recipient);
  const discount = documentDiscount(context, data, format);
  const goods = mapLines(context, data, discount.spread);
  const lines = [...goods, ...adjustmentLines(context, discount.separate, goods)];
  if (goods.length === 0) {
    missing(context, 'FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee');
  }
  const model = format === 'FSM10' ? buildSimplified(context, data, type, seller, buyer, transmission, lines) : buildOrdinary(context, data, type, format, seller, buyer, transmission, lines, options.linkedInvoice);
  return context.issues.length > 0 ? { ok: false, issues: context.issues } : { ok: true, model, warnings: context.warnings };
}

function buildOrdinary(
  context: MapContext,
  data: QueueRecord,
  type: string,
  format: 'FPR12' | 'FPA12',
  seller: Seller,
  buyer: Buyer,
  transmission: DatiTrasmissione,
  lines: readonly MappedLine[],
  original: LinkedInvoice | undefined,
): InvoiceModel {
  const reference = format === 'FPA12' ? optionalCode(context, `${HEADER}.CedentePrestatore.RiferimentoAmministrazione`, data.counterpart.administrationReference, 20) : undefined;
  const sellerBlock: CedentePrestatore = {
    DatiAnagrafici: {
      IdFiscaleIVA: seller.IdFiscaleIVA,
      ...has('CodiceFiscale', seller.CodiceFiscale),
      Anagrafica: { Denominazione: seller.Denominazione },
      RegimeFiscale: seller.RegimeFiscale,
    },
    Sede: seller.Sede,
    ...has('IscrizioneREA', seller.IscrizioneREA),
    ...has('RiferimentoAmministrazione', reference),
  };
  const buyerBlock: CessionarioCommittente = {
    DatiAnagrafici: {
      ...has('IdFiscaleIVA', buyer.IdFiscaleIVA),
      ...has('CodiceFiscale', buyer.CodiceFiscale),
      Anagrafica: buyer.nominativo,
    },
    Sede: buyer.Sede,
  };
  return {
    versione: format,
    FatturaElettronicaHeader: { DatiTrasmissione: transmission, CedentePrestatore: sellerBlock, CessionarioCommittente: buyerBlock },
    FatturaElettronicaBody: mapOrdinaryBody(context, data, type, lines, original),
  };
}

function buildSimplified(
  context: MapContext,
  data: QueueRecord,
  type: string,
  seller: Seller,
  buyer: Buyer,
  transmission: DatiTrasmissione,
  lines: readonly MappedLine[],
): InvoiceModel {
  const sellerBlock: CedentePrestatoreSemplificata = {
    IdFiscaleIVA: seller.IdFiscaleIVA,
    ...has('CodiceFiscale', seller.CodiceFiscale),
    Denominazione: seller.Denominazione,
    Sede: seller.Sede,
    ...has('IscrizioneREA', seller.IscrizioneREA),
    RegimeFiscale: seller.RegimeFiscale,
  };
  const buyerBlock: CessionarioCommittenteSemplificata = {
    IdentificativiFiscali: { ...has('IdFiscaleIVA', buyer.IdFiscaleIVA), ...has('CodiceFiscale', buyer.CodiceFiscale) },
    AltriDatiIdentificativi: { ...buyer.nominativo, Sede: buyer.Sede },
  };
  const rectified = mapRectified(context, data.xml.rectified);
  return {
    versione: 'FSM10',
    FatturaElettronicaHeader: { DatiTrasmissione: transmission, CedentePrestatore: sellerBlock, CessionarioCommittente: buyerBlock },
    FatturaElettronicaBody: {
      DatiGenerali: {
        DatiGeneraliDocumento: {
          TipoDocumento: type,
          Divisa: requiredCode(context, `${DOCUMENT}.Divisa`, data.company.currencyCode.toUpperCase(), 3, /^[A-Z]{3}$/),
          Data: requiredInvoiceDate(context, `${DOCUMENT}.Data`, data.date),
          Numero: mapNumber(context, data),
        },
        ...has('DatiFatturaRettificata', rectified),
      },
      DatiBeniServizi: mapSimplifiedGoods(context, groupByVat(lines)),
    },
  };
}
