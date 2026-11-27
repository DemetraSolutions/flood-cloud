/**
 * Serialization of the invoice model to the FatturaPA XML.
 *
 * The output is the document the SdI schemas describe: `<?xml ... encoding="UTF-8"?>`, root `p:FatturaElettronica`
 * (ordinary, namespace `.../fatture/v1.2`) or `p:FatturaElettronicaSemplificata` (namespace `.../fatture/v1.0`),
 * the `versione` attribute equal to the transmission format, and the children **unqualified** (the schemas have no
 * `elementFormDefault`, so only the root is in the namespace). Elements follow the order of the XSD sequences, an
 * absent datum is not written (no empty elements), and the same model always gives the same bytes. Text is escaped by
 * the writer; the model must have been sanitized (`text.ts`) beforehand.
 *
 * Decimals are written with exactly the digits the type wants: `Amount2DecimalType` and `RateType` two, `PesoType`
 * two, `Amount8DecimalType` and `QuantitaType` from two to eight (trailing zeros beyond the second are dropped).
 *
 * @module
 */
import { formatDecimal } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import type {
  Anagrafica,
  CedentePrestatore,
  CedentePrestatoreSemplificata,
  CessionarioCommittente,
  CessionarioCommittenteSemplificata,
  DatiBeniServiziSemplificata,
  DatiDocumentiCorrelati,
  DatiPagamento,
  DatiRiepilogo,
  DatiTrasmissione,
  DatiTrasporto,
  DettaglioLinee,
  FatturaElettronica,
  FatturaElettronicaBody,
  FatturaElettronicaSemplificata,
  IdFiscale,
  Indirizzo,
  InvoiceModel,
  IscrizioneREA,
  Nominativo,
  ScontoMaggiorazione,
} from './model.ts';
import { parentElement, textElement, writeXml } from './xml-writer.ts';
import type { XmlNode } from './xml-writer.ts';

/** Namespace of the ordinary invoice schemas (`FPR12`, `FPA12`). */
export const NAMESPACE_ORDINARY = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2';
/** Namespace of the simplified invoice schema (`FSM10`). */
export const NAMESPACE_SIMPLIFIED = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.0';

const NAMESPACE_XMLDSIG = 'http://www.w3.org/2000/09/xmldsig#';
const NAMESPACE_XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const text = textElement;
const group = parentElement;

function decimalElement(name: string, value: Decimal | undefined, minDecimals: number, maxDecimals: number): XmlNode | undefined {
  return text(name, value === undefined ? undefined : formatDecimal(value, minDecimals, maxDecimals));
}

/** `Amount2DecimalType`, `RateType`, `PesoType`: exactly two decimals. */
function fixed2(name: string, value: Decimal | undefined): XmlNode | undefined {
  return decimalElement(name, value, 2, 2);
}

/** `Amount8DecimalType`, `QuantitaType`: two to eight decimals. */
function upTo8(name: string, value: Decimal | undefined): XmlNode | undefined {
  return decimalElement(name, value, 2, 8);
}

function idFiscale(name: string, id: IdFiscale | undefined): XmlNode | undefined {
  return id === undefined ? undefined : group(name, text('IdPaese', id.IdPaese), text('IdCodice', id.IdCodice));
}

function nominativo(value: Nominativo): (XmlNode | undefined)[] {
  return 'Denominazione' in value
    ? [text('Denominazione', value.Denominazione)]
    : [text('Nome', value.Nome), text('Cognome', value.Cognome)];
}

function anagrafica(value: Anagrafica): XmlNode {
  return group('Anagrafica', ...nominativo(value), text('Titolo', value.Titolo), text('CodEORI', value.CodEORI));
}

function indirizzo(name: string, value: Indirizzo | undefined): XmlNode | undefined {
  return value === undefined
    ? undefined
    : group(
        name,
        text('Indirizzo', value.Indirizzo),
        text('NumeroCivico', value.NumeroCivico),
        text('CAP', value.CAP),
        text('Comune', value.Comune),
        text('Provincia', value.Provincia),
        text('Nazione', value.Nazione),
      );
}

function iscrizioneREA(value: IscrizioneREA | undefined): XmlNode | undefined {
  return value === undefined
    ? undefined
    : group(
        'IscrizioneREA',
        text('Ufficio', value.Ufficio),
        text('NumeroREA', value.NumeroREA),
        fixed2('CapitaleSociale', value.CapitaleSociale),
        text('SocioUnico', value.SocioUnico),
        text('StatoLiquidazione', value.StatoLiquidazione),
      );
}

function datiTrasmissione(value: DatiTrasmissione): XmlNode {
  return group(
    'DatiTrasmissione',
    idFiscale('IdTrasmittente', value.IdTrasmittente),
    text('ProgressivoInvio', value.ProgressivoInvio),
    text('FormatoTrasmissione', value.FormatoTrasmissione),
    text('CodiceDestinatario', value.CodiceDestinatario),
    text('PECDestinatario', value.PECDestinatario),
  );
}

function cedentePrestatore(value: CedentePrestatore): XmlNode {
  const data = value.DatiAnagrafici;
  return group(
    'CedentePrestatore',
    group(
      'DatiAnagrafici',
      idFiscale('IdFiscaleIVA', data.IdFiscaleIVA),
      text('CodiceFiscale', data.CodiceFiscale),
      anagrafica(data.Anagrafica),
      text('RegimeFiscale', data.RegimeFiscale),
    ),
    indirizzo('Sede', value.Sede),
    iscrizioneREA(value.IscrizioneREA),
    text('RiferimentoAmministrazione', value.RiferimentoAmministrazione),
  );
}

function cessionarioCommittente(value: CessionarioCommittente): XmlNode {
  const data = value.DatiAnagrafici;
  return group(
    'CessionarioCommittente',
    group('DatiAnagrafici', idFiscale('IdFiscaleIVA', data.IdFiscaleIVA), text('CodiceFiscale', data.CodiceFiscale), anagrafica(data.Anagrafica)),
    indirizzo('Sede', value.Sede),
  );
}

function scontoMaggiorazione(value: ScontoMaggiorazione): XmlNode {
  return group('ScontoMaggiorazione', text('Tipo', value.Tipo), fixed2('Percentuale', value.Percentuale), upTo8('Importo', value.Importo));
}

function documentiCorrelati(name: string, value: DatiDocumentiCorrelati): XmlNode {
  return group(
    name,
    text('IdDocumento', value.IdDocumento),
    text('Data', value.Data),
    text('CodiceCUP', value.CodiceCUP),
    text('CodiceCIG', value.CodiceCIG),
  );
}

function datiTrasporto(value: DatiTrasporto | undefined): XmlNode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const carrier = value.DatiAnagraficiVettore;
  return group(
    'DatiTrasporto',
    carrier === undefined
      ? undefined
      : group(
          'DatiAnagraficiVettore',
          idFiscale('IdFiscaleIVA', carrier.IdFiscaleIVA),
          text('CodiceFiscale', carrier.CodiceFiscale),
          anagrafica(carrier.Anagrafica),
          text('NumeroLicenzaGuida', carrier.NumeroLicenzaGuida),
        ),
    text('MezzoTrasporto', value.MezzoTrasporto),
    text('CausaleTrasporto', value.CausaleTrasporto),
    text('NumeroColli', value.NumeroColli?.toString()),
    text('Descrizione', value.Descrizione),
    text('UnitaMisuraPeso', value.UnitaMisuraPeso),
    fixed2('PesoLordo', value.PesoLordo),
    fixed2('PesoNetto', value.PesoNetto),
    text('DataOraRitiro', value.DataOraRitiro),
    text('DataInizioTrasporto', value.DataInizioTrasporto),
    text('TipoResa', value.TipoResa),
    indirizzo('IndirizzoResa', value.IndirizzoResa),
    text('DataOraConsegna', value.DataOraConsegna),
  );
}

function dettaglioLinee(value: DettaglioLinee): XmlNode {
  return group(
    'DettaglioLinee',
    text('NumeroLinea', value.NumeroLinea.toString()),
    text('Descrizione', value.Descrizione),
    upTo8('Quantita', value.Quantita),
    text('UnitaMisura', value.UnitaMisura),
    upTo8('PrezzoUnitario', value.PrezzoUnitario),
    ...(value.ScontoMaggiorazione ?? []).map(scontoMaggiorazione),
    upTo8('PrezzoTotale', value.PrezzoTotale),
    fixed2('AliquotaIVA', value.AliquotaIVA),
    text('Natura', value.Natura),
    ...(value.AltriDatiGestionali ?? []).map((other) =>
      group('AltriDatiGestionali', text('TipoDato', other.TipoDato), text('RiferimentoTesto', other.RiferimentoTesto), text('RiferimentoData', other.RiferimentoData)),
    ),
  );
}

function datiRiepilogo(value: DatiRiepilogo): XmlNode {
  return group(
    'DatiRiepilogo',
    fixed2('AliquotaIVA', value.AliquotaIVA),
    text('Natura', value.Natura),
    fixed2('ImponibileImporto', value.ImponibileImporto),
    fixed2('Imposta', value.Imposta),
    text('EsigibilitaIVA', value.EsigibilitaIVA),
    text('RiferimentoNormativo', value.RiferimentoNormativo),
  );
}

function datiPagamento(value: DatiPagamento): XmlNode {
  return group(
    'DatiPagamento',
    text('CondizioniPagamento', value.CondizioniPagamento),
    ...value.DettaglioPagamento.map((detail) =>
      group(
        'DettaglioPagamento',
        text('Beneficiario', detail.Beneficiario),
        text('ModalitaPagamento', detail.ModalitaPagamento),
        text('DataScadenzaPagamento', detail.DataScadenzaPagamento),
        fixed2('ImportoPagamento', detail.ImportoPagamento),
        text('IstitutoFinanziario', detail.IstitutoFinanziario),
        text('IBAN', detail.IBAN),
        text('ABI', detail.ABI),
        text('CAB', detail.CAB),
        text('BIC', detail.BIC),
      ),
    ),
  );
}

function body(value: FatturaElettronicaBody): XmlNode {
  const general = value.DatiGenerali;
  const document = general.DatiGeneraliDocumento;
  return group(
    'FatturaElettronicaBody',
    group(
      'DatiGenerali',
      group(
        'DatiGeneraliDocumento',
        text('TipoDocumento', document.TipoDocumento),
        text('Divisa', document.Divisa),
        text('Data', document.Data),
        text('Numero', document.Numero),
        ...(document.ScontoMaggiorazione ?? []).map(scontoMaggiorazione),
        fixed2('ImportoTotaleDocumento', document.ImportoTotaleDocumento),
        ...(document.Causale ?? []).map((reason) => text('Causale', reason)),
      ),
      ...(general.DatiOrdineAcquisto ?? []).map((order) => documentiCorrelati('DatiOrdineAcquisto', order)),
      ...(general.DatiFattureCollegate ?? []).map((linked) => documentiCorrelati('DatiFattureCollegate', linked)),
      datiTrasporto(general.DatiTrasporto),
    ),
    group('DatiBeniServizi', ...value.DatiBeniServizi.DettaglioLinee.map(dettaglioLinee), ...value.DatiBeniServizi.DatiRiepilogo.map(datiRiepilogo)),
    ...(value.DatiPagamento ?? []).map(datiPagamento),
  );
}

function rootAttributes(namespace: string, versione: string): Record<string, string> {
  return { 'xmlns:p': namespace, 'xmlns:ds': NAMESPACE_XMLDSIG, 'xmlns:xsi': NAMESPACE_XSI, versione };
}

function ordinary(model: FatturaElettronica): XmlNode {
  const header = model.FatturaElettronicaHeader;
  return {
    name: 'p:FatturaElettronica',
    attributes: rootAttributes(NAMESPACE_ORDINARY, model.versione),
    children: [
      group(
        'FatturaElettronicaHeader',
        datiTrasmissione(header.DatiTrasmissione),
        cedentePrestatore(header.CedentePrestatore),
        cessionarioCommittente(header.CessionarioCommittente),
      ),
      body(model.FatturaElettronicaBody),
    ],
  };
}

function cedenteSemplificata(value: CedentePrestatoreSemplificata): XmlNode {
  return group(
    'CedentePrestatore',
    idFiscale('IdFiscaleIVA', value.IdFiscaleIVA),
    text('CodiceFiscale', value.CodiceFiscale),
    ...nominativo(value),
    indirizzo('Sede', value.Sede),
    iscrizioneREA(value.IscrizioneREA),
    text('RegimeFiscale', value.RegimeFiscale),
  );
}

function cessionarioSemplificata(value: CessionarioCommittenteSemplificata): XmlNode {
  const fiscal = value.IdentificativiFiscali;
  const other = value.AltriDatiIdentificativi;
  return group(
    'CessionarioCommittente',
    group('IdentificativiFiscali', idFiscale('IdFiscaleIVA', fiscal.IdFiscaleIVA), text('CodiceFiscale', fiscal.CodiceFiscale)),
    other === undefined ? undefined : group('AltriDatiIdentificativi', ...nominativo(other), indirizzo('Sede', other.Sede)),
  );
}

function beniServiziSemplificata(value: DatiBeniServiziSemplificata): XmlNode {
  return group(
    'DatiBeniServizi',
    text('Descrizione', value.Descrizione),
    fixed2('Importo', value.Importo),
    group('DatiIVA', fixed2('Imposta', value.DatiIVA.Imposta), fixed2('Aliquota', value.DatiIVA.Aliquota)),
    text('Natura', value.Natura),
    text('RiferimentoNormativo', value.RiferimentoNormativo),
  );
}

function simplified(model: FatturaElettronicaSemplificata): XmlNode {
  const header = model.FatturaElettronicaHeader;
  const general = model.FatturaElettronicaBody.DatiGenerali;
  const document = general.DatiGeneraliDocumento;
  const rectified = general.DatiFatturaRettificata;
  return {
    name: 'p:FatturaElettronicaSemplificata',
    attributes: rootAttributes(NAMESPACE_SIMPLIFIED, model.versione),
    children: [
      group(
        'FatturaElettronicaHeader',
        datiTrasmissione(header.DatiTrasmissione),
        cedenteSemplificata(header.CedentePrestatore),
        cessionarioSemplificata(header.CessionarioCommittente),
      ),
      group(
        'FatturaElettronicaBody',
        group(
          'DatiGenerali',
          group(
            'DatiGeneraliDocumento',
            text('TipoDocumento', document.TipoDocumento),
            text('Divisa', document.Divisa),
            text('Data', document.Data),
            text('Numero', document.Numero),
          ),
          rectified === undefined
            ? undefined
            : group(
                'DatiFatturaRettificata',
                text('NumeroFR', rectified.NumeroFR),
                text('DataFR', rectified.DataFR),
                text('ElementiRettificati', rectified.ElementiRettificati),
              ),
        ),
        ...model.FatturaElettronicaBody.DatiBeniServizi.map(beniServiziSemplificata),
      ),
    ],
  };
}

/**
 * Serializes an invoice model to the FatturaPA XML.
 *
 * @param model An ordinary (`FPR12`, `FPA12`) or simplified (`FSM10`) invoice.
 * @returns The XML document, UTF-8, ready for validation and sending (the size check belongs to the validator).
 * @throws Error When a text of the model has a character XML cannot represent (a model not built by the mapper).
 */
export function serialize(model: InvoiceModel): string {
  return writeXml(model.versione === 'FSM10' ? simplified(model) : ordinary(model));
}
