/**
 * Typed, defensive reader of a record of the legacy e-invoicing queue (`<prefix><env>_queue.documents`).
 *
 * A queue record is a full copy of a fiscal document of a group plus the `company` and `counterpart` snapshots,
 * written by the legacy services and by the point of sale: nothing in it can be trusted. `readQueueRecord` turns an
 * `unknown` value into a {@link QueueRecord} whose fields have the right JavaScript type (strings, `Decimal`s,
 * `Date`s, booleans, arrays), or reports every field of the wrong type as an issue. An absent field is **not** an
 * issue here (it reads as an empty string, `null`, `false` or an empty array): whether a datum is required depends on
 * the invoice format and is decided by the mapper (`from-queue.ts`).
 *
 * Only the fields the XML needs are read, and values are never copied into the issues (issues carry a path and a
 * code, never data: records hold personal data).
 *
 * @module
 */
import { fromNumber, parseDecimal } from './decimal.ts';
import type { Decimal } from './decimal.ts';

/** A data problem found while reading a record or mapping it to an invoice. */
export interface MappingIssue {
  /** Where: a record path (`records[2].qt`) or the XSD path of the element (`...CedentePrestatore.Sede.CAP`). */
  readonly path: string;
  /** `missing` a required datum is absent, `invalid` it has the wrong type or shape, `unsupported` it is valid but not handled. */
  readonly issue: 'missing' | 'invalid' | 'unsupported';
}

/** A purchase order or a linked invoice as stored in the optional `XML` block. */
export interface QueueCorrelated {
  readonly IdDocumento: string;
  readonly Data: Date | null;
  readonly CodiceCUP: string;
  readonly CodiceCIG: string;
}

/** Address of the delivery of a transport. */
export interface QueueAddress {
  readonly Indirizzo: string;
  readonly NumeroCivico: string;
  readonly CAP: string;
  readonly Comune: string;
  readonly Provincia: string;
  readonly Nazione: string;
}

/** Transport block of the optional `XML` field. */
export interface QueueTransport {
  readonly carrier: {
    readonly IdPaese: string;
    readonly IdCodice: string;
    readonly CodiceFiscale: string;
    readonly Denominazione: string;
    readonly Nome: string;
    readonly Cognome: string;
    readonly Titolo: string;
    readonly CodEORI: string;
    readonly NumeroLicenzaGuida: string;
  };
  readonly MezzoTrasporto: string;
  readonly CausaleTrasporto: string;
  readonly NumeroColli: Decimal | null;
  readonly Descrizione: string;
  readonly UnitaMisuraPeso: string;
  readonly PesoLordo: Decimal | null;
  readonly PesoNetto: Decimal | null;
  readonly DataOraRitiro: Date | null;
  readonly DataInizioTrasporto: Date | null;
  readonly TipoResa: string;
  readonly IndirizzoResa: QueueAddress;
  readonly DataOraConsegna: Date | null;
}

/** A row of the payment details of the optional `XML` field. */
export interface QueuePaymentDetail {
  readonly Beneficiario: string;
  readonly ModalitaPagamento: string;
  readonly DataScadenzaPagamento: Date | null;
  readonly ImportoPagamento: Decimal | null;
  readonly IstitutoFinanziario: string;
  readonly IBAN: string;
  readonly ABI: string;
  readonly CAB: string;
  readonly BIC: string;
}

/** The optional `XML` field: data the user typed in the invoice form (all of it optional). */
export interface QueueXml {
  /** `Tipo` of the document discount (`SC` or `MG`), as written. */
  readonly discountType: string;
  /** The summary asks for split payment (`EsigibilitaIVA` equal to `S`). */
  readonly splitPayment: boolean;
  readonly orders: readonly QueueCorrelated[];
  readonly linkedInvoices: readonly QueueCorrelated[];
  readonly rectified: { readonly NumeroFR: string; readonly DataFR: Date | null; readonly ElementiRettificati: string };
  readonly transport: QueueTransport;
  readonly paymentConditions: string;
  readonly paymentDetails: readonly QueuePaymentDetail[];
}

/** Free data of a line (`XML.AltriDatiGestionali`). */
export interface QueueOtherData {
  readonly TipoDato: string;
  readonly RiferimentoTesto: string;
  readonly RiferimentoData: Date | null;
}

/** A line of the document (`records[]`). */
export interface QueueLine {
  readonly name: string;
  readonly qt: Decimal | null;
  /** Net unit price (`price.price`). */
  readonly price: Decimal | null;
  /** VAT rate in percent (`price.tax`). */
  readonly tax: Decimal | null;
  /** Line discount in percent (`price.discount`). */
  readonly discount: Decimal | null;
  /** Nature of a zero-rate operation (`price.taxData.natura`). */
  readonly natura: string;
  /** Legal reference of the tax (`price.taxData.description`). */
  readonly taxDescription: string;
  readonly otherData: readonly QueueOtherData[];
}

/** The `company` snapshot: the seller. */
export interface QueueCompany {
  /** VAT number (`code`). */
  readonly code: string;
  /** Fiscal code (`code2`). */
  readonly code2: string;
  readonly name: string;
  readonly address: string;
  readonly postcode: string;
  readonly city: string;
  readonly countryAreaCode: string;
  readonly currencyCode: string;
  /** Where the section of the number goes: `prefix`, `suffix` or none. */
  readonly invoicesPS: string;
  /** The document discount is spread over the lines (`settings.global.discountLines`). */
  readonly discountLines: boolean;
  readonly transmitterCountry: string;
  readonly transmitterCode: string;
  readonly regime: string;
  readonly reaOffice: string;
  readonly reaNumber: string;
  readonly reaCapital: Decimal | null;
  readonly reaPartners: string;
  readonly reaLiquidation: string;
}

/** The `counterpart` snapshot: the buyer. */
export interface QueueCounterpart {
  readonly companyCode: string;
  readonly companyCode2: string;
  readonly companyName: string;
  readonly companyAddress: string;
  readonly companyPostcode: string;
  readonly companyCity: string;
  readonly companyCountryCode: string;
  readonly companyCountryAreaCode: string;
  readonly code: string;
  readonly name: string;
  readonly surname: string;
  readonly address: string;
  readonly postcode: string;
  readonly city: string;
  readonly countryCode: string;
  readonly countryAreaCode: string;
  /** `fattura_elettronica.formato_trasmissione` */
  readonly format: string;
  /** `fattura_elettronica.identificativo`: `CD` or `PEC`. */
  readonly channel: string;
  readonly recipientCode: string;
  readonly pec: string;
  readonly administrationReference: string;
}

/** A queue record as the mapper uses it. */
export interface QueueRecord {
  readonly date: Date | null;
  readonly number: string;
  readonly prefixSuffix: string;
  readonly note: string;
  readonly total: Decimal | null;
  readonly customerType: Decimal | null;
  readonly discountPercentage: Decimal | null;
  readonly discountValue: Decimal | null;
  readonly totalTaxableWithoutDiscount: Decimal | null;
  readonly lines: readonly QueueLine[];
  readonly fullMeal: { readonly status: boolean; readonly quantity: Decimal | null };
  /** `fattura_elettronica.tipo` (`TD01`...). */
  readonly documentType: string;
  /** `fattura_elettronica.progressivo_invio`. */
  readonly progressive: string;
  readonly company: QueueCompany;
  readonly counterpart: QueueCounterpart;
  readonly xml: QueueXml;
}

/** Result of {@link readQueueRecord}. */
export type ReadResult = { readonly ok: true; readonly value: QueueRecord } | { readonly ok: false; readonly issues: MappingIssue[] };

type Obj = Readonly<Record<string, unknown>>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

/** Path of a field of an object at `path` (the top-level object has the empty path). */
function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Collector of the issues found while reading, with typed accessors that never throw. */
class Reader {
  readonly issues: MappingIssue[] = [];

  /** Records an issue. */
  invalid(path: string): void {
    this.issues.push({ path, issue: 'invalid' });
  }

  /** The value as an object; absent reads as an empty object, anything else that is not a plain object is an issue. */
  object(value: unknown, path: string): Obj {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
      this.invalid(path);
      return {};
    }
    return value as Obj;
  }

  /** The value as an array; absent reads as an empty array. */
  array(value: unknown, path: string): unknown[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.invalid(path);
      return [];
    }
    return value;
  }

  /** A string field; numbers are accepted (legacy stores numbers where codes are expected); absent reads as `''`. */
  text(source: Obj, key: string, path: string): string {
    const value = source[key];
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    this.invalid(at(path, key));
    return '';
  }

  /** A numeric field (number or numeric text); absent or empty reads as `null`. */
  decimal(source: Obj, key: string, path: string): Decimal | null {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      return null;
    }
    const parsed = typeof value === 'number' ? fromNumber(value) : typeof value === 'string' ? parseDecimal(value) : null;
    if (parsed === null) {
      this.invalid(at(path, key));
    }
    return parsed;
  }

  /** A boolean field; absent reads as `false`. */
  flag(source: Obj, key: string, path: string): boolean {
    const value = source[key];
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value !== 'boolean') {
      this.invalid(at(path, key));
      return false;
    }
    return value;
  }

  /**
   * A date field: a `Date`, an ISO date-time text, or a `YYYY-MM-DD` text (read as noon UTC so that the calendar day
   * is the same in every time zone of the world that matters here); absent or empty reads as `null`.
   */
  date(source: Obj, key: string, path: string): Date | null {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      return null;
    }
    let parsed: Date | null = null;
    if (value instanceof Date) {
      parsed = value;
    } else if (typeof value === 'string' && DATE_ONLY.test(value)) {
      parsed = new Date(`${value}T12:00:00Z`);
    } else if (typeof value === 'string' && DATE_TIME.test(value)) {
      parsed = new Date(value);
    }
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      this.invalid(at(path, key));
      return null;
    }
    return parsed;
  }

  /** A localized name: a text, or an object by language (`it` first, otherwise the first text). */
  name(value: unknown, path: string): string {
    if (typeof value === 'string') {
      return value;
    }
    const names = this.object(value, path);
    const italian = names['it'];
    if (typeof italian === 'string') {
      return italian;
    }
    return Object.values(names).find((entry): entry is string => typeof entry === 'string') ?? '';
  }
}

function readCorrelated(reader: Reader, value: unknown, path: string): QueueCorrelated {
  const source = reader.object(value, path);
  return {
    IdDocumento: reader.text(source, 'IdDocumento', path),
    Data: reader.date(source, 'Data', path),
    CodiceCUP: reader.text(source, 'CodiceCUP', path),
    CodiceCIG: reader.text(source, 'CodiceCIG', path),
  };
}

/** A block that the form stores as one object or as a list: always read as a list. */
function readCorrelatedList(reader: Reader, value: unknown, path: string): QueueCorrelated[] {
  if (value === undefined || value === null) {
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => readCorrelated(reader, entry, Array.isArray(value) ? `${path}[${index}]` : path));
}

function readAddress(reader: Reader, value: unknown, path: string): QueueAddress {
  const source = reader.object(value, path);
  return {
    Indirizzo: reader.text(source, 'Indirizzo', path),
    NumeroCivico: reader.text(source, 'NumeroCivico', path),
    CAP: reader.text(source, 'CAP', path),
    Comune: reader.text(source, 'Comune', path),
    Provincia: reader.text(source, 'Provincia', path),
    Nazione: reader.text(source, 'Nazione', path),
  };
}

function readTransport(reader: Reader, value: unknown, path: string): QueueTransport {
  const source = reader.object(value, path);
  const carrier = reader.object(source['DatiAnagraficiVettore'], `${path}.DatiAnagraficiVettore`);
  const carrierPath = `${path}.DatiAnagraficiVettore`;
  const vat = reader.object(carrier['IdFiscaleIVA'], `${carrierPath}.IdFiscaleIVA`);
  const name = reader.object(carrier['Anagrafica'], `${carrierPath}.Anagrafica`);
  return {
    carrier: {
      IdPaese: reader.text(vat, 'IdPaese', `${carrierPath}.IdFiscaleIVA`),
      IdCodice: reader.text(vat, 'IdCodice', `${carrierPath}.IdFiscaleIVA`),
      CodiceFiscale: reader.text(carrier, 'CodiceFiscale', carrierPath),
      Denominazione: reader.text(name, 'Denominazione', `${carrierPath}.Anagrafica`),
      Nome: reader.text(name, 'Nome', `${carrierPath}.Anagrafica`),
      Cognome: reader.text(name, 'Cognome', `${carrierPath}.Anagrafica`),
      Titolo: reader.text(name, 'Titolo', `${carrierPath}.Anagrafica`),
      CodEORI: reader.text(name, 'CodEORI', `${carrierPath}.Anagrafica`),
      NumeroLicenzaGuida: reader.text(carrier, 'NumeroLicenzaGuida', carrierPath),
    },
    MezzoTrasporto: reader.text(source, 'MezzoTrasporto', path),
    CausaleTrasporto: reader.text(source, 'CausaleTrasporto', path),
    NumeroColli: reader.decimal(source, 'NumeroColli', path),
    Descrizione: reader.text(source, 'Descrizione', path),
    UnitaMisuraPeso: reader.text(source, 'UnitaMisuraPeso', path),
    PesoLordo: reader.decimal(source, 'PesoLordo', path),
    PesoNetto: reader.decimal(source, 'PesoNetto', path),
    DataOraRitiro: reader.date(source, 'DataOraRitiro', path),
    DataInizioTrasporto: reader.date(source, 'DataInizioTrasporto', path),
    TipoResa: reader.text(source, 'TipoResa', path),
    IndirizzoResa: readAddress(reader, source['IndirizzoResa'], `${path}.IndirizzoResa`),
    DataOraConsegna: reader.date(source, 'DataOraConsegna', path),
  };
}

function readPaymentDetail(reader: Reader, value: unknown, path: string): QueuePaymentDetail {
  const source = reader.object(value, path);
  return {
    Beneficiario: reader.text(source, 'Beneficiario', path),
    ModalitaPagamento: reader.text(source, 'ModalitaPagamento', path),
    DataScadenzaPagamento: reader.date(source, 'DataScadenzaPagamento', path),
    ImportoPagamento: reader.decimal(source, 'ImportoPagamento', path),
    IstitutoFinanziario: reader.text(source, 'IstitutoFinanziario', path),
    IBAN: reader.text(source, 'IBAN', path),
    ABI: reader.text(source, 'ABI', path),
    CAB: reader.text(source, 'CAB', path),
    BIC: reader.text(source, 'BIC', path),
  };
}

function readXml(reader: Reader, value: unknown, path: string): QueueXml {
  const root = reader.object(value, path);
  const body = reader.object(root['FatturaElettronicaBody'], `${path}.FatturaElettronicaBody`);
  const bodyPath = `${path}.FatturaElettronicaBody`;
  const general = reader.object(body['DatiGenerali'], `${bodyPath}.DatiGenerali`);
  const generalPath = `${bodyPath}.DatiGenerali`;
  const document = reader.object(general['DatiGeneraliDocumento'], `${generalPath}.DatiGeneraliDocumento`);
  const discount = reader.object(document['ScontoMaggiorazione'], `${generalPath}.DatiGeneraliDocumento.ScontoMaggiorazione`);
  const goods = reader.object(body['DatiBeniServizi'], `${bodyPath}.DatiBeniServizi`);
  const summary = reader.object(goods['DatiRiepilogo'], `${bodyPath}.DatiBeniServizi.DatiRiepilogo`);
  const payment = reader.object(body['DatiPagamento'], `${bodyPath}.DatiPagamento`);
  const rectified = reader.object(general['DatiFatturaRettificata'], `${generalPath}.DatiFatturaRettificata`);
  const rectifiedPath = `${generalPath}.DatiFatturaRettificata`;
  return {
    discountType: reader.text(discount, 'Tipo', `${generalPath}.DatiGeneraliDocumento.ScontoMaggiorazione`),
    splitPayment: reader.text(summary, 'EsigibilitaIVA', `${bodyPath}.DatiBeniServizi.DatiRiepilogo`) === 'S',
    orders: readCorrelatedList(reader, general['DatiOrdineAcquisto'], `${generalPath}.DatiOrdineAcquisto`),
    linkedInvoices: readCorrelatedList(reader, general['DatiFattureCollegate'], `${generalPath}.DatiFattureCollegate`),
    rectified: {
      NumeroFR: reader.text(rectified, 'NumeroFR', rectifiedPath),
      DataFR: reader.date(rectified, 'DataFR', rectifiedPath),
      ElementiRettificati: reader.text(rectified, 'ElementiRettificati', rectifiedPath),
    },
    transport: readTransport(reader, general['DatiTrasporto'], `${generalPath}.DatiTrasporto`),
    paymentConditions: reader.text(payment, 'CondizioniPagamento', `${bodyPath}.DatiPagamento`),
    paymentDetails: reader
      .array(payment['DettaglioPagamento'], `${bodyPath}.DatiPagamento.DettaglioPagamento`)
      .map((detail, index) => readPaymentDetail(reader, detail, `${bodyPath}.DatiPagamento.DettaglioPagamento[${index}]`)),
  };
}

function readLine(reader: Reader, value: unknown, path: string): QueueLine {
  const source = reader.object(value, path);
  const price = reader.object(source['price'], `${path}.price`);
  const taxData = reader.object(price['taxData'], `${path}.price.taxData`);
  const extra = reader.object(source['XML'], `${path}.XML`);
  return {
    name: reader.name(source['name'], `${path}.name`),
    qt: reader.decimal(source, 'qt', path),
    price: reader.decimal(price, 'price', `${path}.price`),
    tax: reader.decimal(price, 'tax', `${path}.price`),
    discount: reader.decimal(price, 'discount', `${path}.price`),
    natura: reader.text(taxData, 'natura', `${path}.price.taxData`),
    taxDescription: reader.text(taxData, 'description', `${path}.price.taxData`),
    otherData: reader.array(extra['AltriDatiGestionali'], `${path}.XML.AltriDatiGestionali`).map((entry, index) => {
      const otherPath = `${path}.XML.AltriDatiGestionali[${index}]`;
      const other = reader.object(entry, otherPath);
      return {
        TipoDato: reader.text(other, 'TipoDato', otherPath),
        RiferimentoTesto: reader.text(other, 'RiferimentoTesto', otherPath),
        RiferimentoData: reader.date(other, 'RiferimentoData', otherPath),
      };
    }),
  };
}

function readCompany(reader: Reader, value: unknown): QueueCompany {
  const source = reader.object(value, 'company');
  const einvoicing = reader.object(source['fattura_elettronica'], 'company.fattura_elettronica');
  const settings = reader.object(source['settings'], 'company.settings');
  const global = reader.object(settings['global'], 'company.settings.global');
  return {
    code: reader.text(source, 'code', 'company'),
    code2: reader.text(source, 'code2', 'company'),
    name: reader.text(source, 'name', 'company'),
    address: reader.text(source, 'address', 'company'),
    postcode: reader.text(source, 'postcode', 'company'),
    city: reader.text(source, 'city', 'company'),
    countryAreaCode: reader.text(source, 'countryAreaCode', 'company'),
    currencyCode: reader.text(source, 'currencyCode', 'company'),
    invoicesPS: reader.text(source, 'invoicesPS', 'company'),
    discountLines: reader.flag(global, 'discountLines', 'company.settings.global'),
    transmitterCountry: reader.text(einvoicing, 'IdTrasmittente_paese', 'company.fattura_elettronica'),
    transmitterCode: reader.text(einvoicing, 'IdTrasmittente_codice', 'company.fattura_elettronica'),
    regime: reader.text(einvoicing, 'regime_fiscale', 'company.fattura_elettronica'),
    reaOffice: reader.text(einvoicing, 'rea_ufficio', 'company.fattura_elettronica'),
    reaNumber: reader.text(einvoicing, 'rea_numero', 'company.fattura_elettronica'),
    reaCapital: reader.decimal(einvoicing, 'rea_capitale_sociale', 'company.fattura_elettronica'),
    reaPartners: reader.text(einvoicing, 'rea_soci', 'company.fattura_elettronica'),
    reaLiquidation: reader.text(einvoicing, 'rea_liquidazione', 'company.fattura_elettronica'),
  };
}

function readCounterpart(reader: Reader, value: unknown): QueueCounterpart {
  const source = reader.object(value, 'counterpart');
  const einvoicing = reader.object(source['fattura_elettronica'], 'counterpart.fattura_elettronica');
  return {
    companyCode: reader.text(source, 'companyCode', 'counterpart'),
    companyCode2: reader.text(source, 'companyCode2', 'counterpart'),
    companyName: reader.text(source, 'companyName', 'counterpart'),
    companyAddress: reader.text(source, 'companyAddress', 'counterpart'),
    companyPostcode: reader.text(source, 'companyPostcode', 'counterpart'),
    companyCity: reader.text(source, 'companyCity', 'counterpart'),
    companyCountryCode: reader.text(source, 'companyCountryCode', 'counterpart'),
    companyCountryAreaCode: reader.text(source, 'companyCountryAreaCode', 'counterpart'),
    code: reader.text(source, 'code', 'counterpart'),
    name: reader.text(source, 'name', 'counterpart'),
    surname: reader.text(source, 'surname', 'counterpart'),
    address: reader.text(source, 'address', 'counterpart'),
    postcode: reader.text(source, 'postcode', 'counterpart'),
    city: reader.text(source, 'city', 'counterpart'),
    countryCode: reader.text(source, 'countryCode', 'counterpart'),
    countryAreaCode: reader.text(source, 'countryAreaCode', 'counterpart'),
    format: reader.text(einvoicing, 'formato_trasmissione', 'counterpart.fattura_elettronica'),
    channel: reader.text(einvoicing, 'identificativo', 'counterpart.fattura_elettronica'),
    recipientCode: reader.text(einvoicing, 'codice_destinatario', 'counterpart.fattura_elettronica'),
    pec: reader.text(einvoicing, 'pec', 'counterpart.fattura_elettronica'),
    administrationReference: reader.text(einvoicing, 'riferimento_amministrazione', 'counterpart.fattura_elettronica'),
  };
}

/**
 * Reads a queue record defensively.
 *
 * @param record The value read from the queue collection (anything).
 * @returns The typed record, or every field of the wrong type as an issue (record path, code `invalid`, no value).
 */
export function readQueueRecord(record: unknown): ReadResult {
  const reader = new Reader();
  const source = reader.object(record, 'record');
  const einvoicing = reader.object(source['fattura_elettronica'], 'fattura_elettronica');
  const fullMeal = reader.object(reader.object(source['sale'], 'sale')['fullMeal'], 'sale.fullMeal');
  const value: QueueRecord = {
    date: reader.date(source, 'date', ''),
    number: reader.text(source, 'number', ''),
    prefixSuffix: reader.text(source, 'prefixSuffix', ''),
    note: reader.text(source, 'note', ''),
    total: reader.decimal(source, 'total', ''),
    customerType: reader.decimal(source, 'customerType', ''),
    discountPercentage: reader.decimal(source, 'discountPercentage', ''),
    discountValue: reader.decimal(source, 'discountValue', ''),
    totalTaxableWithoutDiscount: reader.decimal(source, 'totalTaxableWithoutDiscount', ''),
    lines: reader.array(source['records'], 'records').map((line, index) => readLine(reader, line, `records[${index}]`)),
    fullMeal: { status: reader.flag(fullMeal, 'status', 'sale.fullMeal'), quantity: reader.decimal(fullMeal, 'quantity', 'sale.fullMeal') },
    documentType: reader.text(einvoicing, 'tipo', 'fattura_elettronica'),
    progressive: reader.text(einvoicing, 'progressivo_invio', 'fattura_elettronica'),
    company: readCompany(reader, source['company']),
    counterpart: readCounterpart(reader, source['counterpart']),
    xml: readXml(reader, source['XML'], 'XML'),
  };
  return reader.issues.length === 0 ? { ok: true, value } : { ok: false, issues: reader.issues };
}
