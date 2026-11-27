/**
 * Typed model of an Italian electronic invoice (FatturaPA), the contract between the mapping from the queue record
 * (`from-queue.ts`), the validator (EI4) and the XML writer (`serialize.ts`).
 *
 * **Naming exception.** Property names are the element names of the official XSD (`DatiTrasmissione`,
 * `CedentePrestatore`, `DettaglioLinee`...), exactly and in Italian: the model mirrors an external standard
 * (`doc/fatturazione-elettronica/11-01-2027/`, schemas VFPR12/VFPA12 1.2.4 and VFSM10 1.0.3), so a field is found by
 * the name the standard gives it. This is the only place of the worker where the "English names" rule is waived.
 *
 * Only what Flood produces, and what the XSD needs around it, is modelled. Amounts are `Decimal` values (never
 * floats); dates are `YYYY-MM-DD` strings; date-times are ISO 8601 strings. Properties are optional exactly where
 * the XSD says `minOccurs="0"`, and a model never holds an empty string: an absent datum is an absent property.
 *
 * @module
 */
import type { Decimal } from './decimal.ts';

/** Fiscal identifier: ISO 3166 alpha-2 country and the code assigned in that country. */
export interface IdFiscale {
  readonly IdPaese: string;
  readonly IdCodice: string;
}

/** Name of a company (`Denominazione`) or of a natural person (`Nome` and `Cognome`): the XSD `choice`. */
export type Nominativo = { readonly Denominazione: string } | { readonly Nome: string; readonly Cognome: string };

/** The `Anagrafica` block: the name choice plus the optional title and EORI code. */
export type Anagrafica = Nominativo & { readonly Titolo?: string; readonly CodEORI?: string };

/** Address (`IndirizzoType`). */
export interface Indirizzo {
  readonly Indirizzo: string;
  readonly NumeroCivico?: string;
  readonly CAP: string;
  readonly Comune: string;
  /** Only for addresses in Italy. */
  readonly Provincia?: string;
  readonly Nazione: string;
}

/** Company register entry of the seller (`IscrizioneREA`). */
export interface IscrizioneREA {
  /** Province of the office. */
  readonly Ufficio: string;
  readonly NumeroREA: string;
  readonly CapitaleSociale?: Decimal;
  /** `SU` sole shareholder, `SM` several shareholders. */
  readonly SocioUnico?: 'SU' | 'SM';
  /** `LS` in liquidation, `LN` not in liquidation. */
  readonly StatoLiquidazione: 'LS' | 'LN';
}

/** Transmission data of an ordinary invoice (`DatiTrasmissione`). */
export interface DatiTrasmissione {
  readonly IdTrasmittente: IdFiscale;
  readonly ProgressivoInvio: string;
  readonly FormatoTrasmissione: 'FPR12' | 'FPA12' | 'FSM10';
  readonly CodiceDestinatario: string;
  /** Only with `CodiceDestinatario` `0000000`. */
  readonly PECDestinatario?: string;
}

/** Seller data of an ordinary invoice (`CedentePrestatore`). */
export interface CedentePrestatore {
  readonly DatiAnagrafici: {
    readonly IdFiscaleIVA: IdFiscale;
    readonly CodiceFiscale?: string;
    readonly Anagrafica: Anagrafica;
    /** Code of the tax regime (`RF01`...). */
    readonly RegimeFiscale: string;
  };
  readonly Sede: Indirizzo;
  readonly IscrizioneREA?: IscrizioneREA;
  /** Administrative reference, written for invoices to the public administration. */
  readonly RiferimentoAmministrazione?: string;
}

/** Buyer data of an ordinary invoice (`CessionarioCommittente`); at least one of the two fiscal ids is present. */
export interface CessionarioCommittente {
  readonly DatiAnagrafici: {
    readonly IdFiscaleIVA?: IdFiscale;
    readonly CodiceFiscale?: string;
    readonly Anagrafica: Anagrafica;
  };
  readonly Sede: Indirizzo;
}

/** Discount (`SC`) or surcharge (`MG`); exactly one of `Percentuale` and `Importo` is present. */
export interface ScontoMaggiorazione {
  readonly Tipo: 'SC' | 'MG';
  readonly Percentuale?: Decimal;
  readonly Importo?: Decimal;
}

/** Related document (`DatiDocumentiCorrelatiType`): purchase order or linked invoice. */
export interface DatiDocumentiCorrelati {
  readonly IdDocumento: string;
  readonly Data?: string;
  readonly CodiceCUP?: string;
  readonly CodiceCIG?: string;
}

/** Carrier of a transport (`DatiAnagraficiVettore`). */
export interface DatiAnagraficiVettore {
  readonly IdFiscaleIVA: IdFiscale;
  readonly CodiceFiscale?: string;
  readonly Anagrafica: Anagrafica;
  readonly NumeroLicenzaGuida?: string;
}

/** Transport data (`DatiTrasporto`). */
export interface DatiTrasporto {
  readonly DatiAnagraficiVettore?: DatiAnagraficiVettore;
  readonly MezzoTrasporto?: string;
  readonly CausaleTrasporto?: string;
  readonly NumeroColli?: number;
  readonly Descrizione?: string;
  readonly UnitaMisuraPeso?: string;
  readonly PesoLordo?: Decimal;
  readonly PesoNetto?: Decimal;
  readonly DataOraRitiro?: string;
  readonly DataInizioTrasporto?: string;
  /** Incoterms code of the delivery terms (three upper case letters). */
  readonly TipoResa?: string;
  readonly IndirizzoResa?: Indirizzo;
  readonly DataOraConsegna?: string;
}

/** General data of the document (`DatiGeneraliDocumento`). */
export interface DatiGeneraliDocumento {
  /** `TD01`... for ordinary invoices (`TD04` is the credit note). */
  readonly TipoDocumento: string;
  readonly Divisa: string;
  readonly Data: string;
  readonly Numero: string;
  readonly ScontoMaggiorazione?: readonly ScontoMaggiorazione[];
  readonly ImportoTotaleDocumento?: Decimal;
  /** One element per block of at most 200 characters. */
  readonly Causale?: readonly string[];
}

/** Free data attached to a line (`AltriDatiGestionali`). */
export interface AltriDatiGestionali {
  readonly TipoDato: string;
  readonly RiferimentoTesto?: string;
  readonly RiferimentoData?: string;
}

/** A line of the invoice (`DettaglioLinee`). */
export interface DettaglioLinee {
  readonly NumeroLinea: number;
  readonly Descrizione: string;
  readonly Quantita?: Decimal;
  readonly UnitaMisura?: string;
  readonly PrezzoUnitario: Decimal;
  readonly ScontoMaggiorazione?: readonly ScontoMaggiorazione[];
  readonly PrezzoTotale: Decimal;
  readonly AliquotaIVA: Decimal;
  /** Present when, and only when, `AliquotaIVA` is zero. */
  readonly Natura?: string;
  readonly AltriDatiGestionali?: readonly AltriDatiGestionali[];
}

/** VAT summary per rate and nature (`DatiRiepilogo`). */
export interface DatiRiepilogo {
  readonly AliquotaIVA: Decimal;
  readonly Natura?: string;
  readonly ImponibileImporto: Decimal;
  readonly Imposta: Decimal;
  /** `I` immediate, `D` deferred, `S` split payment. */
  readonly EsigibilitaIVA?: 'I' | 'D' | 'S';
  readonly RiferimentoNormativo?: string;
}

/** Detail of a payment (`DettaglioPagamento`). */
export interface DettaglioPagamento {
  readonly Beneficiario?: string;
  readonly ModalitaPagamento: string;
  readonly DataScadenzaPagamento?: string;
  readonly ImportoPagamento: Decimal;
  readonly IstitutoFinanziario?: string;
  readonly IBAN?: string;
  readonly ABI?: string;
  readonly CAB?: string;
  readonly BIC?: string;
}

/** Payment data (`DatiPagamento`). */
export interface DatiPagamento {
  /** `TP01` instalments, `TP02` full, `TP03` advance. */
  readonly CondizioniPagamento: string;
  readonly DettaglioPagamento: readonly DettaglioPagamento[];
}

/** The body of an ordinary invoice (`FatturaElettronicaBody`); Flood always produces exactly one per file. */
export interface FatturaElettronicaBody {
  readonly DatiGenerali: {
    readonly DatiGeneraliDocumento: DatiGeneraliDocumento;
    readonly DatiOrdineAcquisto?: readonly DatiDocumentiCorrelati[];
    readonly DatiFattureCollegate?: readonly DatiDocumentiCorrelati[];
    readonly DatiTrasporto?: DatiTrasporto;
  };
  readonly DatiBeniServizi: {
    readonly DettaglioLinee: readonly DettaglioLinee[];
    readonly DatiRiepilogo: readonly DatiRiepilogo[];
  };
  readonly DatiPagamento?: readonly DatiPagamento[];
}

/** An ordinary invoice, `FPR12` (private) or `FPA12` (public administration): root `FatturaElettronica`. */
export interface FatturaElettronica {
  /** The `versione` attribute; equal to `DatiTrasmissione.FormatoTrasmissione`. */
  readonly versione: 'FPR12' | 'FPA12';
  readonly FatturaElettronicaHeader: {
    readonly DatiTrasmissione: DatiTrasmissione;
    readonly CedentePrestatore: CedentePrestatore;
    readonly CessionarioCommittente: CessionarioCommittente;
  };
  readonly FatturaElettronicaBody: FatturaElettronicaBody;
}

/** Seller of a simplified invoice: the name choice is flat, not wrapped in `Anagrafica`. */
export type CedentePrestatoreSemplificata = Nominativo & {
  readonly IdFiscaleIVA: IdFiscale;
  readonly CodiceFiscale?: string;
  readonly Sede: Indirizzo;
  readonly IscrizioneREA?: IscrizioneREA;
  readonly RegimeFiscale: string;
};

/** Buyer of a simplified invoice. */
export interface CessionarioCommittenteSemplificata {
  readonly IdentificativiFiscali: {
    readonly IdFiscaleIVA?: IdFiscale;
    readonly CodiceFiscale?: string;
  };
  readonly AltriDatiIdentificativi?: Nominativo & { readonly Sede: Indirizzo };
}

/** Block of goods and services of a simplified invoice (`DatiBeniServizi`): one per VAT rate and nature. */
export interface DatiBeniServiziSemplificata {
  readonly Descrizione: string;
  /** Total amount, tax included. */
  readonly Importo: Decimal;
  readonly DatiIVA: { readonly Imposta?: Decimal; readonly Aliquota?: Decimal };
  readonly Natura?: string;
  readonly RiferimentoNormativo?: string;
}

/** Reference to a rectified invoice (`DatiFatturaRettificata`), for the simplified credit note `TD08`. */
export interface DatiFatturaRettificata {
  readonly NumeroFR: string;
  readonly DataFR: string;
  readonly ElementiRettificati: string;
}

/** A simplified invoice `FSM10` (`TD07`, `TD08`, `TD09`): root `FatturaElettronicaSemplificata`. */
export interface FatturaElettronicaSemplificata {
  readonly versione: 'FSM10';
  readonly FatturaElettronicaHeader: {
    readonly DatiTrasmissione: DatiTrasmissione;
    readonly CedentePrestatore: CedentePrestatoreSemplificata;
    readonly CessionarioCommittente: CessionarioCommittenteSemplificata;
  };
  readonly FatturaElettronicaBody: {
    readonly DatiGenerali: {
      readonly DatiGeneraliDocumento: {
        readonly TipoDocumento: string;
        readonly Divisa: string;
        readonly Data: string;
        readonly Numero: string;
      };
      readonly DatiFatturaRettificata?: DatiFatturaRettificata;
    };
    readonly DatiBeniServizi: readonly DatiBeniServiziSemplificata[];
  };
}

/** Any invoice the worker can build; discriminated by `versione`. */
export type InvoiceModel = FatturaElettronica | FatturaElettronicaSemplificata;
