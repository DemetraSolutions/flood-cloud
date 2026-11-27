/**
 * Catalogue of systematic mutations of a valid invoice, one per schema rule, shared by the unit tests of the schema
 * validator and by the equivalence test with `xmllint`.
 *
 * Each mutation sets (or removes, with `undefined`) values of a rich valid model by dotted path and says where the
 * schema validator must report the problem. `xml` tells what the real schema says about the serialized document:
 * `invalid` (rejected), `valid` (accepted: the mutation is allowed by the schema, e.g. a value the writer rounds),
 * `model-only` (the model is wrong but the writer hides it, so the XML is accepted) or `unserializable` (the writer
 * cannot write it: a character XML forbids, or a mandatory block that is absent).
 */
import { d } from './models.ts';

export interface Mutation {
  readonly name: string;
  readonly format: 'ordinary' | 'simplified';
  readonly set: Readonly<Record<string, unknown>>;
  /** Path of the expected issue (`undefined`: no issue expected). */
  readonly path: string | undefined;
  readonly xml: 'invalid' | 'valid' | 'model-only' | 'unserializable';
}

const text = (length: number, character = 'a'): string => character.repeat(length);

/** Dotted property path to the path the validator reports: `Body` becomes `Body[0]` and numeric segments `[n]`. */
export function reportedPath(key: string): string {
  if (key === 'versione') {
    return '@versione';
  }
  return key.replace(/^FatturaElettronicaBody/, 'FatturaElettronicaBody[0]').replace(/\.(\d+)(?=\.|$)/g, '[$1]');
}

function make(format: Mutation['format']) {
  return (name: string, key: string, value: unknown, xml: Mutation['xml'] = 'invalid'): Mutation => ({
    name,
    format,
    set: { [key]: value },
    path: xml === 'valid' ? undefined : reportedPath(key),
    xml,
  });
}

const o = make('ordinary');
const s = make('simplified');

const H = 'FatturaElettronicaHeader';
const T = `${H}.DatiTrasmissione`;
const SELLER = `${H}.CedentePrestatore`;
const SELLER_DATA = `${SELLER}.DatiAnagrafici`;
const BUYER = `${H}.CessionarioCommittente`;
const BUYER_DATA = `${BUYER}.DatiAnagrafici`;
const GEN = 'FatturaElettronicaBody.DatiGenerali';
const DOC = `${GEN}.DatiGeneraliDocumento`;
const TRANSPORT = `${GEN}.DatiTrasporto`;
const GOODS = 'FatturaElettronicaBody.DatiBeniServizi';
const LINE = `${GOODS}.DettaglioLinee.0`;
const SUMMARY = `${GOODS}.DatiRiepilogo.0`;
const PAYMENT = 'FatturaElettronicaBody.DatiPagamento.0.DettaglioPagamento.0';

/** Mutations of an ordinary invoice (base: `rich()`). */
export const ORDINARY_MUTATIONS: readonly Mutation[] = [
  // Root and transmission.
  o('versione outside the enumeration', 'versione', 'FPX12'),
  o('IdTrasmittente country of three letters', `${T}.IdTrasmittente.IdPaese`, 'ITA'),
  o('IdTrasmittente country in lower case', `${T}.IdTrasmittente.IdPaese`, 'it'),
  o('IdTrasmittente country missing', `${T}.IdTrasmittente.IdPaese`, undefined),
  o('IdTrasmittente code too long', `${T}.IdTrasmittente.IdCodice`, text(29, '1')),
  o('IdTrasmittente code empty', `${T}.IdTrasmittente.IdCodice`, ''),
  o('IdTrasmittente block missing', `${T}.IdTrasmittente`, undefined),
  o('DatiTrasmissione missing', T, undefined, 'unserializable'),
  o('ProgressivoInvio too long', `${T}.ProgressivoInvio`, text(11)),
  o('ProgressivoInvio outside Basic Latin', `${T}.ProgressivoInvio`, 'è1'),
  o('FormatoTrasmissione outside the enumeration', `${T}.FormatoTrasmissione`, 'FPX12'),
  o('FormatoTrasmissione of the simplified format', `${T}.FormatoTrasmissione`, 'FSM10'),
  o('CodiceDestinatario too short', `${T}.CodiceDestinatario`, 'ABCDE'),
  o('CodiceDestinatario too long', `${T}.CodiceDestinatario`, 'ABCDEFGH'),
  o('CodiceDestinatario in lower case', `${T}.CodiceDestinatario`, 'abcdefg'),
  o('PECDestinatario without at sign', `${T}.PECDestinatario`, 'not-an-address'),
  o('PECDestinatario without domain', `${T}.PECDestinatario`, 'mario@'),
  o('PECDestinatario with a space', `${T}.PECDestinatario`, 'ma rio@pec.example.it'),
  o('PECDestinatario too long', `${T}.PECDestinatario`, `${text(252)}@e.it`),
  o('PECDestinatario with lower case and dots is fine', `${T}.PECDestinatario`, 'a.b.c@pec.example.it', 'valid'),
  o('PECDestinatario in quotes does not match the odd quoted branch of the schema', `${T}.PECDestinatario`, '"quoted"@pec.example.it'),
  o('PECDestinatario in the one quoted form the schema allows is fine', `${T}.PECDestinatario`, '"[]!#-a"@pec.example.it', 'valid'),
  o('PECDestinatario with a literal domain is fine', `${T}.PECDestinatario`, 'mario@[192.168.0.1]', 'valid'),
  // Seller.
  o('seller VAT country of one letter', `${SELLER_DATA}.IdFiscaleIVA.IdPaese`, 'I'),
  o('seller VAT code of 28 characters is fine', `${SELLER_DATA}.IdFiscaleIVA.IdCodice`, text(28, '1'), 'valid'),
  o('seller VAT code missing', `${SELLER_DATA}.IdFiscaleIVA.IdCodice`, undefined),
  o('seller VAT block missing', `${SELLER_DATA}.IdFiscaleIVA`, undefined),
  o('seller fiscal code too short', `${SELLER_DATA}.CodiceFiscale`, '1234567890'),
  o('seller fiscal code too long', `${SELLER_DATA}.CodiceFiscale`, text(17, '1')),
  o('seller fiscal code in lower case', `${SELLER_DATA}.CodiceFiscale`, 'rssmra80a01h501u'),
  o('seller name too long', `${SELLER_DATA}.Anagrafica`, { Denominazione: text(81) }),
  o('seller name outside Latin-1', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar Ā' }),
  o('seller name in Latin-1 is fine', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Caffè Ñandú ÿ' }, 'valid'),
  o('seller name and person together', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', Nome: 'Mario', Cognome: 'Rossi' }, 'model-only'),
  o('seller first name without last name', `${SELLER_DATA}.Anagrafica`, { Nome: 'Mario' }),
  o('seller last name without first name', `${SELLER_DATA}.Anagrafica`, { Cognome: 'Rossi' }),
  o('seller with no name at all', `${SELLER_DATA}.Anagrafica`, {}),
  o('seller name block missing', `${SELLER_DATA}.Anagrafica`, undefined, 'unserializable'),
  o('seller first name too long', `${SELLER_DATA}.Anagrafica`, { Nome: text(61), Cognome: 'Rossi' }),
  o('seller title of one character', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', Titolo: 'D' }),
  o('seller title of eleven characters', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', Titolo: text(11) }),
  o('seller title with extra spaces is collapsed', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', Titolo: '  Dott.  ' }, 'valid'),
  o('seller EORI too short', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', CodEORI: text(12) }),
  o('seller EORI too long', `${SELLER_DATA}.Anagrafica`, { Denominazione: 'Bar', CodEORI: text(18) }),
  o('seller tax regime outside the list', `${SELLER_DATA}.RegimeFiscale`, 'RF03'),
  o('seller tax regime in lower case', `${SELLER_DATA}.RegimeFiscale`, 'rf01'),
  o('seller tax regime missing', `${SELLER_DATA}.RegimeFiscale`, undefined),
  o('seller address too long', `${SELLER}.Sede.Indirizzo`, text(61)),
  o('seller address missing', `${SELLER}.Sede.Indirizzo`, undefined),
  o('seller house number too long', `${SELLER}.Sede.NumeroCivico`, text(9)),
  o('seller postcode too short', `${SELLER}.Sede.CAP`, '1000'),
  o('seller postcode with a letter', `${SELLER}.Sede.CAP`, '1000a'),
  o('seller city missing', `${SELLER}.Sede.Comune`, undefined),
  o('seller province in lower case', `${SELLER}.Sede.Provincia`, 'rm'),
  o('seller province of three letters', `${SELLER}.Sede.Provincia`, 'ROM'),
  o('seller country of three letters', `${SELLER}.Sede.Nazione`, 'ITA'),
  o('seller address block missing', `${SELLER}.Sede`, undefined),
  o('seller register office in lower case', `${SELLER}.IscrizioneREA.Ufficio`, 'rm'),
  o('seller register number too long', `${SELLER}.IscrizioneREA.NumeroREA`, text(21)),
  o('seller register capital with twelve digits', `${SELLER}.IscrizioneREA.CapitaleSociale`, d('123456789012.00')),
  o('seller register capital negative is fine', `${SELLER}.IscrizioneREA.CapitaleSociale`, d('-1.00'), 'valid'),
  o('seller register capital with extra decimals is rounded', `${SELLER}.IscrizioneREA.CapitaleSociale`, d('10.004'), 'valid'),
  o('seller sole shareholder outside the list', `${SELLER}.IscrizioneREA.SocioUnico`, 'XX'),
  o('seller liquidation state outside the list', `${SELLER}.IscrizioneREA.StatoLiquidazione`, 'XX'),
  o('seller liquidation state missing', `${SELLER}.IscrizioneREA.StatoLiquidazione`, undefined),
  o('seller administrative reference too long', `${SELLER}.RiferimentoAmministrazione`, text(21)),
  o('seller block missing', SELLER, undefined, 'unserializable'),
  // Buyer.
  o('buyer VAT code missing', `${BUYER_DATA}.IdFiscaleIVA.IdCodice`, undefined),
  o('buyer fiscal code too short', `${BUYER_DATA}.CodiceFiscale`, 'abc'),
  o('buyer without fiscal ids is fine for the schema', `${BUYER_DATA}`, { Anagrafica: { Nome: 'Mario', Cognome: 'Rossi' } }, 'valid'),
  o('buyer name missing', `${BUYER_DATA}.Anagrafica`, undefined, 'unserializable'),
  o('buyer address city too long', `${BUYER}.Sede.Comune`, text(61)),
  o('buyer block missing', BUYER, undefined, 'unserializable'),
  o('header missing', H, undefined, 'unserializable'),
  // Document data.
  o('document type outside the list', `${DOC}.TipoDocumento`, 'TD99'),
  o('document type of the simplified format', `${DOC}.TipoDocumento`, 'TD07'),
  o('document type missing', `${DOC}.TipoDocumento`, undefined),
  o('currency in lower case', `${DOC}.Divisa`, 'eur'),
  o('currency of four letters', `${DOC}.Divisa`, 'EURO'),
  o('date with month thirteen', `${DOC}.Data`, '2026-13-01'),
  o('date of a day that does not exist', `${DOC}.Data`, '2026-02-30'),
  o('date in the wrong layout', `${DOC}.Data`, '27/11/2026'),
  o('date before 1970', `${DOC}.Data`, '1969-12-31'),
  o('date at the lower bound is fine', `${DOC}.Data`, '1970-01-01', 'valid'),
  o('date on a leap day is fine', `${DOC}.Data`, '2024-02-29', 'valid'),
  o('date on a non-leap February 29', `${DOC}.Data`, '2026-02-29'),
  o('date with a time zone is fine', `${DOC}.Data`, '2026-11-27+01:00', 'valid'),
  o('date with an impossible time zone', `${DOC}.Data`, '2026-11-27+15:00'),
  o('date missing', `${DOC}.Data`, undefined),
  o('number too long', `${DOC}.Numero`, text(21, '1')),
  o('number outside Basic Latin', `${DOC}.Numero`, '4è'),
  o('number missing', `${DOC}.Numero`, undefined),
  o('number with a tab is normalized and fine', `${DOC}.Numero`, '4\t2', 'valid'),
  o('document discount type outside the list', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'XX', Importo: d('1.00') }]),
  o('document discount percentage above one hundred', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('100.01') }]),
  o('document discount percentage of one hundred is fine', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('100.00') }], 'valid'),
  o('document discount percentage negative', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('-1.00') }]),
  o('document discount percentage with four integer digits', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('1000.00') }]),
  o('document discount amount with twelve digits', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Importo: d('123456789012.00') }]),
  o('document discount with percentage and amount is fine', `${DOC}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('5.00'), Importo: d('1.00') }], 'valid'),
  o('document total with twelve digits', `${DOC}.ImportoTotaleDocumento`, d('123456789012.00')),
  o('document total with a third decimal is rounded', `${DOC}.ImportoTotaleDocumento`, d('73.204'), 'valid'),
  o('document reason of 201 characters', `${DOC}.Causale`, [text(201)]),
  o('document reason outside Latin-1', `${DOC}.Causale`, ['Prezzo in €']),
  o('document reason of 200 characters is fine', `${DOC}.Causale`, [text(200)], 'valid'),
  o('document reason empty is not written', `${DOC}.Causale`, [''], 'valid'),
  o('document block missing', DOC, undefined, 'unserializable'),
  o('general data missing', GEN, undefined, 'unserializable'),
  // Related documents.
  o('purchase order without id', `${GEN}.DatiOrdineAcquisto.0.IdDocumento`, undefined),
  o('purchase order id too long', `${GEN}.DatiOrdineAcquisto.0.IdDocumento`, text(21)),
  o('purchase order date not a date', `${GEN}.DatiOrdineAcquisto.0.Data`, '2026-11-31'),
  o('purchase order CIG too long', `${GEN}.DatiOrdineAcquisto.0.CodiceCIG`, text(16)),
  o('linked invoice CUP too long', `${GEN}.DatiFattureCollegate.0.CodiceCUP`, text(16)),
  o('linked invoice with only a date', `${GEN}.DatiFattureCollegate.0`, { Data: '2026-11-20' }, 'invalid'),
  // Transport.
  o('carrier VAT country missing', `${TRANSPORT}.DatiAnagraficiVettore.IdFiscaleIVA.IdPaese`, undefined),
  o('carrier fiscal code too short', `${TRANSPORT}.DatiAnagraficiVettore.CodiceFiscale`, 'abc'),
  o('carrier licence too long', `${TRANSPORT}.DatiAnagraficiVettore.NumeroLicenzaGuida`, text(21)),
  o('carrier name too long', `${TRANSPORT}.DatiAnagraficiVettore.Anagrafica`, { Denominazione: text(81) }),
  o('transport means too long', `${TRANSPORT}.MezzoTrasporto`, text(81)),
  o('transport reason too long', `${TRANSPORT}.CausaleTrasporto`, text(101)),
  o('number of parcels zero', `${TRANSPORT}.NumeroColli`, 0),
  o('number of parcels 10000', `${TRANSPORT}.NumeroColli`, 10000),
  o('number of parcels 9999 is fine', `${TRANSPORT}.NumeroColli`, 9999, 'valid'),
  o('number of parcels not an integer', `${TRANSPORT}.NumeroColli`, 1.5),
  o('transport description too long', `${TRANSPORT}.Descrizione`, text(101)),
  o('weight unit too long', `${TRANSPORT}.UnitaMisuraPeso`, text(11)),
  o('gross weight with five digits', `${TRANSPORT}.PesoLordo`, d('12345.00')),
  o('net weight negative', `${TRANSPORT}.PesoNetto`, d('-1.00')),
  o('gross weight with one decimal is written with two', `${TRANSPORT}.PesoLordo`, d('12.5'), 'valid'),
  o('pickup time without time', `${TRANSPORT}.DataOraRitiro`, '2026-11-26'),
  o('pickup time with hour 25', `${TRANSPORT}.DataOraRitiro`, '2026-11-26T25:00:00'),
  o('pickup time with a zone is fine', `${TRANSPORT}.DataOraRitiro`, '2026-11-26T09:00:00+01:00', 'valid'),
  o('pickup time with a fraction is fine', `${TRANSPORT}.DataOraRitiro`, '2026-11-26T09:00:00.123456', 'valid'),
  o('delivery time with no seconds', `${TRANSPORT}.DataOraConsegna`, '2026-11-27T15:30'),
  o('transport start not a date', `${TRANSPORT}.DataInizioTrasporto`, '26-11-2026'),
  o('delivery terms of two letters', `${TRANSPORT}.TipoResa`, 'EX'),
  o('delivery terms in lower case', `${TRANSPORT}.TipoResa`, 'exw'),
  o('delivery address postcode wrong', `${TRANSPORT}.IndirizzoResa.CAP`, '8010'),
  // Lines.
  o('line number zero', `${LINE}.NumeroLinea`, 0),
  o('line number 10000', `${LINE}.NumeroLinea`, 10000),
  o('line number missing', `${LINE}.NumeroLinea`, undefined, 'unserializable'),
  o('line description of 1001 characters', `${LINE}.Descrizione`, text(1001)),
  o('line description of 1000 characters is fine', `${LINE}.Descrizione`, text(1000), 'valid'),
  o('line description missing', `${LINE}.Descrizione`, undefined),
  o('line description with a control character', `${LINE}.Descrizione`, 'a\u0001b', 'unserializable'),
  o('line description with a lone surrogate', `${LINE}.Descrizione`, 'a\ud800b', 'unserializable'),
  o('line description with an astral character', `${LINE}.Descrizione`, 'a😀b'),
  o('line quantity negative', `${LINE}.Quantita`, d('-1.00')),
  o('line quantity with thirteen digits', `${LINE}.Quantita`, d('1234567890123.00')),
  o('line quantity with nine decimals is rounded', `${LINE}.Quantita`, d('1.123456789'), 'valid'),
  o('line unit too long', `${LINE}.UnitaMisura`, text(11)),
  o('line unit price with twelve digits', `${LINE}.PrezzoUnitario`, d('123456789012.00')),
  o('line unit price negative is fine', `${LINE}.PrezzoUnitario`, d('-1.00'), 'valid'),
  o('line unit price missing', `${LINE}.PrezzoUnitario`, undefined),
  o('line total with twelve digits', `${LINE}.PrezzoTotale`, d('123456789012.00')),
  o('line total missing', `${LINE}.PrezzoTotale`, undefined),
  o('line rate above one hundred', `${LINE}.AliquotaIVA`, d('100.01')),
  o('line rate of one hundred is fine', `${LINE}.AliquotaIVA`, d('100.00'), 'valid'),
  o('line rate negative', `${LINE}.AliquotaIVA`, d('-1.00')),
  o('line rate with four integer digits', `${LINE}.AliquotaIVA`, d('1000.00')),
  o('line rate missing', `${LINE}.AliquotaIVA`, undefined),
  o('line nature outside the list', `${LINE}.Natura`, 'N9'),
  o('line nature N7 is fine', `${LINE}.Natura`, 'N7', 'valid'),
  o('line nature in lower case', `${LINE}.Natura`, 'n4'),
  o('line discount type outside the list', `${LINE}.ScontoMaggiorazione`, [{ Tipo: 'sc', Importo: d('1.00') }]),
  o('line discount percentage above one hundred', `${LINE}.ScontoMaggiorazione`, [{ Tipo: 'SC', Percentuale: d('101.00') }]),
  o('line discount amount with a ninth decimal is rounded', `${LINE}.ScontoMaggiorazione`, [{ Tipo: 'SC', Importo: d('0.123456789') }], 'valid'),
  o('line other data without type', `${LINE}.AltriDatiGestionali.0.TipoDato`, undefined),
  o('line other data type too long', `${LINE}.AltriDatiGestionali.0.TipoDato`, text(11)),
  o('line other data text too long', `${LINE}.AltriDatiGestionali.0.RiferimentoTesto`, text(61)),
  o('line other data date wrong', `${LINE}.AltriDatiGestionali.0.RiferimentoData`, '2026-00-10'),
  o('no lines', `${GOODS}.DettaglioLinee`, []),
  o('lines missing', `${GOODS}.DettaglioLinee`, undefined, 'unserializable'),
  o('goods block missing', GOODS, undefined, 'unserializable'),
  // Summaries.
  o('summary rate above one hundred', `${SUMMARY}.AliquotaIVA`, d('100.01')),
  o('summary nature outside the list', `${SUMMARY}.Natura`, 'N2.3'),
  o('summary taxable with twelve digits', `${SUMMARY}.ImponibileImporto`, d('123456789012.00')),
  o('summary taxable negative is fine', `${SUMMARY}.ImponibileImporto`, d('-5.00'), 'valid'),
  o('summary tax with twelve digits', `${SUMMARY}.Imposta`, d('123456789012.00')),
  o('summary tax missing', `${SUMMARY}.Imposta`, undefined),
  o('summary chargeability outside the list', `${SUMMARY}.EsigibilitaIVA`, 'X'),
  o('summary legal reference too long', `${SUMMARY}.RiferimentoNormativo`, text(101)),
  o('summary legal reference of 100 characters is fine', `${SUMMARY}.RiferimentoNormativo`, text(100), 'valid'),
  o('no summaries', `${GOODS}.DatiRiepilogo`, []),
  // Payments.
  o('payment terms outside the list', 'FatturaElettronicaBody.DatiPagamento.0.CondizioniPagamento', 'TP04'),
  o('payment terms missing', 'FatturaElettronicaBody.DatiPagamento.0.CondizioniPagamento', undefined),
  o('payment details missing', 'FatturaElettronicaBody.DatiPagamento.0.DettaglioPagamento', []),
  o('payment method outside the list', `${PAYMENT}.ModalitaPagamento`, 'MP24'),
  o('payment method MP23 is fine', `${PAYMENT}.ModalitaPagamento`, 'MP23', 'valid'),
  o('payment method missing', `${PAYMENT}.ModalitaPagamento`, undefined),
  o('payment beneficiary too long', `${PAYMENT}.Beneficiario`, text(201)),
  o('payment due date impossible', `${PAYMENT}.DataScadenzaPagamento`, '2026-04-31'),
  o('payment amount with twelve digits', `${PAYMENT}.ImportoPagamento`, d('123456789012.00')),
  o('payment amount missing', `${PAYMENT}.ImportoPagamento`, undefined),
  o('payment bank too long', `${PAYMENT}.IstitutoFinanziario`, text(81)),
  o('IBAN too short', `${PAYMENT}.IBAN`, 'IT60X054281110'),
  o('IBAN with a symbol', `${PAYMENT}.IBAN`, 'IT60X0542811101000000123-56'),
  o('IBAN with digits for the country', `${PAYMENT}.IBAN`, '1T60X0542811101000000123456'),
  o('IBAN in lower case is fine', `${PAYMENT}.IBAN`, 'it60x0542811101000000123456', 'valid'),
  o('IBAN of 34 characters is fine', `${PAYMENT}.IBAN`, `IT60${text(30, 'A')}`, 'valid'),
  o('IBAN of 35 characters', `${PAYMENT}.IBAN`, `IT60${text(31, 'A')}`),
  o('ABI of four digits', `${PAYMENT}.ABI`, '0542'),
  o('CAB with a letter', `${PAYMENT}.CAB`, '1110a'),
  o('BIC too short', `${PAYMENT}.BIC`, 'BEPIIT2'),
  o('BIC in lower case', `${PAYMENT}.BIC`, 'bepiit22xxx'),
  o('BIC of eight characters is fine', `${PAYMENT}.BIC`, 'BEPIIT22', 'valid'),
  o('BIC with nine characters', `${PAYMENT}.BIC`, 'BEPIIT22X'),
  o('BIC with a one in the seventh position', `${PAYMENT}.BIC`, 'BEPIIT12'),
  o('payment block missing', 'FatturaElettronicaBody.DatiPagamento.0', undefined, 'valid'),
  // Body.
  o('body missing', 'FatturaElettronicaBody', undefined, 'unserializable'),
];

const SH = `${H}.CedentePrestatore`;
const SB = 'FatturaElettronicaBody.DatiBeniServizi.0';

/** Mutations of a simplified invoice (base: `richSimplified()`). */
export const SIMPLIFIED_MUTATIONS: readonly Mutation[] = [
  s('versione outside the enumeration', 'versione', 'FSM11', 'unserializable'),
  s('transmission format of an ordinary format', `${T}.FormatoTrasmissione`, 'FPR12'),
  s('recipient code of six characters', `${T}.CodiceDestinatario`, 'ABCDEF'),
  s('recipient code of eight characters', `${T}.CodiceDestinatario`, 'ABCDEFGH'),
  s('recipient code of seven characters is fine', `${T}.CodiceDestinatario`, '0000000', 'valid'),
  s('seller VAT country missing', `${SH}.IdFiscaleIVA.IdPaese`, undefined),
  s('seller fiscal code too long', `${SH}.CodiceFiscale`, text(17, '1')),
  s('seller name too long', `${SH}.Denominazione`, text(81)),
  { name: 'seller name and person together', format: 'simplified', set: { [`${SH}.Nome`]: 'Mario', [`${SH}.Cognome`]: 'Rossi' }, path: `${SH}`, xml: 'model-only' },
  { name: 'seller name missing', format: 'simplified', set: { [`${SH}.Denominazione`]: undefined }, path: SH, xml: 'invalid' },
  s('seller address postcode wrong', `${SH}.Sede.CAP`, '123'),
  s('seller tax regime outside the list', `${SH}.RegimeFiscale`, 'RF03'),
  s('seller register state missing', `${SH}.IscrizioneREA.StatoLiquidazione`, undefined),
  s('seller register capital with twelve digits', `${SH}.IscrizioneREA.CapitaleSociale`, d('123456789012.00')),
  s('buyer without any identifier', `${H}.CessionarioCommittente.IdentificativiFiscali`, undefined, 'unserializable'),
  s('buyer with an empty identifier block', `${H}.CessionarioCommittente.IdentificativiFiscali`, {}),
  s('buyer fiscal code only is fine', `${H}.CessionarioCommittente.IdentificativiFiscali`, { CodiceFiscale: 'RSSMRA80A01H501U' }, 'valid'),
  s('buyer VAT code missing', `${H}.CessionarioCommittente.IdentificativiFiscali.IdFiscaleIVA.IdCodice`, undefined),
  s('buyer name too long', `${H}.CessionarioCommittente.AltriDatiIdentificativi.Denominazione`, text(81)),
  s('buyer first name without last name', `${H}.CessionarioCommittente.AltriDatiIdentificativi`, { Nome: 'Mario', Sede: { Indirizzo: 'Via X', CAP: '00100', Comune: 'Roma', Nazione: 'IT' } }),
  s('buyer address missing', `${H}.CessionarioCommittente.AltriDatiIdentificativi.Sede`, undefined),
  s('buyer other data missing is fine', `${H}.CessionarioCommittente.AltriDatiIdentificativi`, undefined, 'valid'),
  s('document type of an ordinary format', `${DOC}.TipoDocumento`, 'TD01'),
  s('document type TD09 is fine', `${DOC}.TipoDocumento`, 'TD09', 'valid'),
  s('document date impossible', `${DOC}.Data`, '2026-06-31'),
  s('document number too long', `${DOC}.Numero`, text(21, '1')),
  s('document number missing', `${DOC}.Numero`, undefined),
  s('rectified number too long', `${GEN}.DatiFatturaRettificata.NumeroFR`, text(21)),
  s('rectified date before 1970', `${GEN}.DatiFatturaRettificata.DataFR`, '1969-12-31'),
  s('rectified elements too long', `${GEN}.DatiFatturaRettificata.ElementiRettificati`, text(1001)),
  s('rectified elements missing', `${GEN}.DatiFatturaRettificata.ElementiRettificati`, undefined),
  s('rectified block missing is fine', `${GEN}.DatiFatturaRettificata`, undefined, 'valid'),
  s('goods description too long', `${SB}.Descrizione`, text(1001)),
  s('goods description missing', `${SB}.Descrizione`, undefined),
  s('goods amount with twelve digits', `${SB}.Importo`, d('123456789012.00')),
  s('goods amount missing', `${SB}.Importo`, undefined),
  s('goods rate above one hundred', `${SB}.DatiIVA.Aliquota`, d('100.01')),
  s('goods tax with twelve digits', `${SB}.DatiIVA`, { Imposta: d('123456789012.00') }),
  s('goods tax and rate together are fine', `${SB}.DatiIVA`, { Imposta: d('0.29'), Aliquota: d('22.00') }, 'valid'),
  s('goods without tax and rate', `${SB}.DatiIVA`, {}),
  s('goods VAT block missing', `${SB}.DatiIVA`, undefined, 'unserializable'),
  s('goods nature N6 is not in the simplified list', `${SB}.Natura`, 'N6'),
  s('goods nature N5 is fine', `${SB}.Natura`, 'N5', 'valid'),
  s('goods legal reference too long', `${SB}.RiferimentoNormativo`, text(101)),
  s('no goods', 'FatturaElettronicaBody.DatiBeniServizi', []),
  s('body missing', 'FatturaElettronicaBody', undefined, 'unserializable'),
];
