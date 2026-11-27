/**
 * The "extra schema" checks of the SdI that can be verified offline, applied to the invoice model.
 *
 * Source of truth: `Elenco-Controlli-versione-2.1.pdf` (pseudo-code of every check, tolerances at pages 24 to 27), the
 * tabular representations and the transmission rules of the technical specifications. Where the tabular documents
 * and the Elenco disagree the Elenco wins (e.g. check 00471 applies to `TD16`..`TD20` and `TD29`, check 00472 only to
 * `TD21`). Each check below names its SdI code; severity is `error` unless stated.
 *
 * What is not here, and why:
 * - 00411, 00413, 00414, 00415 and the cash-fund parts of 00419, 00422, 00443, 00444, 00445 concern `DatiRitenuta`,
 *   `DatiCassaPrevidenziale` and `Ritenuta`, which the model does not hold (Flood never writes them), so the
 *   conditions can never occur;
 * - 00409 (duplicate inside a batch): the model holds exactly one body, and Flood never sends batches;
 * - 00404 (duplicate invoice) needs history: see `duplicates.ts`;
 * - the checks against registries (00300 to 00327, 00311, 00312, 00398, 00399) and 00477 (declarations of intent)
 *   are left to the SdI.
 *
 * Amounts are compared the way the SdI sees them, that is after the rounding the XML writer applies (two decimals
 * for `Amount2DecimalType` and `RateType`, eight for `Amount8DecimalType`).
 *
 * @module
 */
import { add, compare, decimal, isZero, mul, negate, round, sub } from '../invoice/decimal.ts';
import type { Decimal } from '../invoice/decimal.ts';
import type { DatiGeneraliDocumento, IdFiscale, InvoiceModel, ScontoMaggiorazione } from '../invoice/model.ts';
import { child, error, warning } from './issue.ts';
import type { ValidationIssue } from './issue.ts';

/** What the checks need to know about the environment. */
export interface SdiContext {
  /** Day the file will be received by the SdI, `YYYY-MM-DD` in the Europe/Rome time zone (check 00403). */
  readonly sendDate: string;
}

const HEADER = 'FatturaElettronicaHeader';
const BODY = 'FatturaElettronicaBody[0]';
const GENERAL = `${BODY}.DatiGenerali`;
const DOCUMENT = `${GENERAL}.DatiGeneraliDocumento`;
const GOODS = `${BODY}.DatiBeniServizi`;
const TRANSMISSION = `${HEADER}.DatiTrasmissione`;

const ZERO = decimal(0n);
const ONE = decimal(1n);
const CENT = decimal(1n, 2);
const EURO = decimal(1n);
const SIMPLIFIED_LIMIT = decimal(40000n, 2);

const SELF_INVOICE_TYPES: ReadonlySet<string> = new Set(['TD16', 'TD17', 'TD18', 'TD19', 'TD20', 'TD29']);
const FOREIGN_SELLER_TYPES: ReadonlySet<string> = new Set(['TD17', 'TD18', 'TD19', 'TD28']);
const VAT_NUMBER_REQUIRED_TYPES: ReadonlySet<string> = new Set(['TD16', 'TD17', 'TD18', 'TD19', 'TD20', 'TD22', 'TD23', 'TD28', 'TD29']);
const GENERIC_NATURES: ReadonlySet<string> = new Set(['N2', 'N3', 'N6']);
const SDI_MAILBOX = /^sdi\d*@pec\.fatturapa\.it$/i;
const CODE_PEC_ONLY = '0000000';
const CODE_FOREIGN = 'XXXXXXX';

/** What the checks that are common to every format need, extracted from the model. */
interface Facts {
  readonly versione: string;
  readonly transmission: InvoiceModel['FatturaElettronicaHeader']['DatiTrasmissione'];
  readonly type: string;
  readonly date: string;
  readonly number: string;
  readonly seller: IdFiscale;
  readonly sellerRegime: string;
  readonly buyerVat: IdFiscale | undefined;
  readonly buyerFiscalCode: string | undefined;
  /** Path of the block that holds the buyer's `IdFiscaleIVA` and `CodiceFiscale`. */
  readonly buyerPath: string;
  readonly sellerIdPath: string;
}

/** A line (or, for the simplified format, a goods block) with its rate and nature. */
interface RateItem {
  readonly ratePath: string;
  readonly naturePath: string;
  readonly rate: Decimal | undefined;
  readonly nature: string | undefined;
}

function absolute(value: Decimal): Decimal {
  return compare(value, ZERO) < 0 ? negate(value) : value;
}

/** `percent` percent of `base`, exact. */
function percentOf(base: Decimal, percent: Decimal): Decimal {
  const product = mul(base, percent);
  return decimal(product.units, product.scale + 2);
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => add(total, value), ZERO);
}

function rateKey(rate: Decimal): string {
  const written = round(rate, 2);
  return `${written.units}`;
}

function sameId(a: IdFiscale, b: IdFiscale): boolean {
  return a.IdPaese === b.IdPaese && a.IdCodice === b.IdCodice;
}

function factsOf(model: InvoiceModel): Facts {
  const transmission = model.FatturaElettronicaHeader.DatiTrasmissione;
  const document = model.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento;
  if (model.versione === 'FSM10') {
    const seller = model.FatturaElettronicaHeader.CedentePrestatore;
    const buyer = model.FatturaElettronicaHeader.CessionarioCommittente.IdentificativiFiscali;
    return {
      versione: model.versione,
      transmission,
      type: document.TipoDocumento,
      date: document.Data,
      number: document.Numero,
      seller: seller.IdFiscaleIVA,
      sellerRegime: seller.RegimeFiscale,
      buyerVat: buyer.IdFiscaleIVA,
      buyerFiscalCode: buyer.CodiceFiscale,
      buyerPath: `${HEADER}.CessionarioCommittente.IdentificativiFiscali`,
      sellerIdPath: `${HEADER}.CedentePrestatore.IdFiscaleIVA`,
    };
  }
  const seller = model.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici;
  const buyer = model.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici;
  return {
    versione: model.versione,
    transmission,
    type: document.TipoDocumento,
    date: document.Data,
    number: document.Numero,
    seller: seller.IdFiscaleIVA,
    sellerRegime: seller.RegimeFiscale,
    buyerVat: buyer.IdFiscaleIVA,
    buyerFiscalCode: buyer.CodiceFiscale,
    buyerPath: `${HEADER}.CessionarioCommittente.DatiAnagrafici`,
    sellerIdPath: `${HEADER}.CedentePrestatore.DatiAnagrafici.IdFiscaleIVA`,
  };
}

/** Checks 00427, 00428, 00313 and the rules on `PECDestinatario`. */
function checkTransmission(facts: Facts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { CodiceDestinatario: code, FormatoTrasmissione: format, PECDestinatario: pec } = facts.transmission;
  const codePath = child(TRANSMISSION, 'CodiceDestinatario');
  const wrongLength = format === 'FPA12' ? code.length === 7 : code.length === 6;
  if (wrongLength) {
    issues.push(error('00427', codePath, 'Codice destinatario di lunghezza non ammessa per il formato di trasmissione'));
  }
  if (format !== facts.versione) {
    issues.push(error('00428', child(TRANSMISSION, 'FormatoTrasmissione'), 'Formato di trasmissione non coerente con l’attributo versione'));
  }
  if (code === CODE_FOREIGN && !(facts.buyerVat !== undefined && facts.buyerVat.IdPaese !== 'IT')) {
    issues.push(error('00313', codePath, 'Il codice XXXXXXX è ammesso solo verso committenti con identificativo IVA estero'));
  }
  if (pec !== undefined) {
    const pecPath = child(TRANSMISSION, 'PECDestinatario');
    if (SDI_MAILBOX.test(pec)) {
      issues.push(error('00330', pecPath, 'Indirizzo PEC di servizio del SdI non ammesso'));
    }
    if (code !== CODE_PEC_ONLY) {
      issues.push(error('00330', pecPath, 'PEC ammessa solo con codice destinatario 0000000'));
    }
    if (format === 'FPA12') {
      issues.push(error('00330', pecPath, 'PEC non ammessa per le fatture verso la pubblica amministrazione'));
    }
  }
  return issues;
}

/** Checks 00403, 00417, 00425 and the rules that depend on the document type (00471 to 00476). */
function checkDocument(facts: Facts, context: SdiContext, rates: readonly RateItem[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { type, seller, buyerVat } = facts;
  if (facts.date > context.sendDate) {
    issues.push(error('00403', child(DOCUMENT, 'Data'), 'Data del documento successiva alla data di invio'));
  }
  if (buyerVat === undefined && facts.buyerFiscalCode === undefined) {
    issues.push(error('00417', facts.buyerPath, 'Del committente servono la partita IVA o il codice fiscale (almeno uno)'));
  }
  if (!/[0-9]/.test(facts.number)) {
    issues.push(error('00425', child(DOCUMENT, 'Numero'), 'Il numero del documento deve contenere almeno una cifra'));
  }
  if (buyerVat !== undefined && SELF_INVOICE_TYPES.has(type) && sameId(seller, buyerVat)) {
    issues.push(error('00471', facts.sellerIdPath, 'Per questo tipo di documento cedente e committente non possono coincidere'));
  }
  if (buyerVat !== undefined && type === 'TD21' && !sameId(seller, buyerVat)) {
    issues.push(error('00472', facts.sellerIdPath, 'Per questo tipo di documento cedente e committente devono coincidere'));
  }
  if ((FOREIGN_SELLER_TYPES.has(type) && seller.IdPaese === 'IT') || (type === 'TD29' && seller.IdPaese !== 'IT')) {
    issues.push(error('00473', `${facts.sellerIdPath}.IdPaese`, 'Paese del cedente non ammesso per questo tipo di documento'));
  }
  if (type === 'TD21') {
    for (const item of rates) {
      if (item.rate !== undefined && isZero(round(item.rate, 2))) {
        issues.push(error('00474', item.ratePath, 'Per questo tipo di documento non sono ammesse linee con aliquota IVA zero'));
      }
    }
  }
  if (buyerVat === undefined && VAT_NUMBER_REQUIRED_TYPES.has(type)) {
    issues.push(error('00475', `${facts.buyerPath}.IdFiscaleIVA`, 'Per questo tipo di documento serve la partita IVA del committente'));
  }
  if (buyerVat !== undefined && seller.IdPaese !== 'IT' && buyerVat.IdPaese !== 'IT') {
    issues.push(error('00476', `${facts.buyerPath}.IdFiscaleIVA.IdPaese`, 'Cedente e committente non possono avere entrambi un paese diverso da IT'));
  }
  return issues;
}

/**
 * Checks 00400, 00401 (lines) or 00429, 00430 (summaries), 00424 and 00445 on a set of rate and nature pairs.
 *
 * @param items The lines or the summaries.
 * @param codes The codes for "nature missing with a zero rate" and "nature present with a non-zero rate".
 */
function checkRates(items: readonly RateItem[], codes: { readonly missing: string; readonly present: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const item of items) {
    if (item.rate !== undefined) {
      const rate = round(item.rate, 2);
      if (isZero(rate) && item.nature === undefined) {
        issues.push(error(codes.missing, item.naturePath, 'Natura obbligatoria con aliquota IVA zero'));
      }
      if (!isZero(rate) && item.nature !== undefined) {
        issues.push(error(codes.present, item.naturePath, 'Natura non ammessa con aliquota IVA diversa da zero'));
      }
      if (!isZero(rate) && compare(rate, ONE) < 0) {
        issues.push(error('00424', item.ratePath, 'Aliquota IVA non espressa in percentuale (per esempio 22.00, non 0.22)'));
      }
    }
    if (item.nature !== undefined && GENERIC_NATURES.has(item.nature)) {
      issues.push(error('00445', item.naturePath, 'Natura generica N2, N3 o N6 non più ammessa'));
    }
  }
  return issues;
}

/** Checks 00437 and 00438: a discount or surcharge needs a percentage or an amount. */
function checkAdjustments(path: string, adjustments: readonly ScontoMaggiorazione[] | undefined, code: string): ValidationIssue[] {
  return (adjustments ?? []).flatMap((adjustment, index) =>
    adjustment.Percentuale === undefined && adjustment.Importo === undefined
      ? [error(code, `${path}.ScontoMaggiorazione[${index}]`, 'Sconto o maggiorazione senza percentuale né importo')]
      : [],
  );
}

/** Exact total a line should have: the unit price adjusted in cascade, times the quantity (check 00423). */
function expectedLineTotal(unitPrice: Decimal, quantity: Decimal | undefined, adjustments: readonly ScontoMaggiorazione[] | undefined): Decimal {
  let price = round(unitPrice, 8);
  for (const adjustment of adjustments ?? []) {
    const amount = adjustment.Importo === undefined ? percentOf(price, round(adjustment.Percentuale ?? ZERO, 2)) : round(adjustment.Importo, 8);
    price = adjustment.Tipo === 'SC' ? sub(price, amount) : add(price, amount);
  }
  return mul(price, quantity === undefined ? ONE : round(quantity, 8));
}

/** Tolerance of check 00422: up to one cent passes, below one euro warns, from one euro on fails. */
function taxableTolerance(difference: Decimal): 'ok' | 'warning' | 'error' {
  if (compare(difference, CENT) <= 0) {
    return 'ok';
  }
  return compare(difference, EURO) < 0 ? 'warning' : 'error';
}

/** Checks of the ordinary formats on lines, summaries and the document data (everything with `DatiBeniServizi`). */
function checkOrdinaryBody(model: Extract<InvoiceModel, { versione: 'FPR12' | 'FPA12' }>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const body = model.FatturaElettronicaBody;
  const document: DatiGeneraliDocumento = body.DatiGenerali.DatiGeneraliDocumento;
  const lines = body.DatiBeniServizi.DettaglioLinee;
  const summaries = body.DatiBeniServizi.DatiRiepilogo;
  const linePath = (index: number): string => `${GOODS}.DettaglioLinee[${index}]`;
  const summaryPath = (index: number): string => `${GOODS}.DatiRiepilogo[${index}]`;

  issues.push(...checkAdjustments(DOCUMENT, document.ScontoMaggiorazione, '00437'));
  lines.forEach((line, index) => issues.push(...checkAdjustments(linePath(index), line.ScontoMaggiorazione, '00438')));

  // 00423: the line total.
  lines.forEach((line, index) => {
    const expected = expectedLineTotal(line.PrezzoUnitario, line.Quantita, line.ScontoMaggiorazione);
    if (compare(absolute(sub(round(line.PrezzoTotale, 8), expected)), CENT) >= 0) {
      issues.push(error('00423', `${linePath(index)}.PrezzoTotale`, 'Prezzo totale non calcolato secondo le regole del SdI'));
    }
  });

  // 00421: the tax of each summary.
  summaries.forEach((summary, index) => {
    const taxable = round(summary.ImponibileImporto, 2);
    const expected = round(percentOf(taxable, round(summary.AliquotaIVA, 2)), 2);
    if (compare(absolute(sub(round(summary.Imposta, 2), expected)), CENT) >= 0) {
      issues.push(error('00421', `${summaryPath(index)}.Imposta`, 'Imposta non calcolata secondo le regole del SdI'));
    }
  });

  // 00422: per rate, the taxable amounts against the line totals.
  const lineRates = [...new Set(lines.map((line) => rateKey(line.AliquotaIVA)))];
  for (const key of lineRates) {
    const taxable = sum(summaries.filter((summary) => rateKey(summary.AliquotaIVA) === key).map((summary) => round(summary.ImponibileImporto, 2)));
    const totals = sum(lines.filter((line) => rateKey(line.AliquotaIVA) === key).map((line) => round(line.PrezzoTotale, 8)));
    const verdict = taxableTolerance(absolute(sub(taxable, totals)));
    if (verdict !== 'ok') {
      const first = summaries.findIndex((summary) => rateKey(summary.AliquotaIVA) === key);
      const path = first < 0 ? GOODS : `${summaryPath(first)}.ImponibileImporto`;
      const make = verdict === 'error' ? error : warning;
      issues.push(make('00422', path, 'Imponibile non calcolato secondo le regole del SdI (somma dei prezzi totali per aliquota)'));
    }
  }

  // 00419, 00443, 00444: lines against summaries.
  const summaryRates = new Set(summaries.map((summary) => rateKey(summary.AliquotaIVA)));
  const summaryNatures = new Set(summaries.flatMap((summary) => (summary.Natura === undefined ? [] : [summary.Natura])));
  if (summaries.length < lineRates.length) {
    issues.push(error('00419', `${GOODS}.DatiRiepilogo`, 'Manca un blocco di riepilogo per almeno una delle aliquote IVA usate'));
  }
  lines.forEach((line, index) => {
    if (!summaryRates.has(rateKey(line.AliquotaIVA))) {
      issues.push(error('00443', `${linePath(index)}.AliquotaIVA`, 'Aliquota IVA della linea senza corrispondenza nei dati di riepilogo'));
    }
    if (line.Natura !== undefined && !summaryNatures.has(line.Natura)) {
      issues.push(error('00444', `${linePath(index)}.Natura`, 'Natura della linea senza corrispondenza nei dati di riepilogo'));
    }
  });

  // 00420: reverse charge cannot be split payment.
  summaries.forEach((summary, index) => {
    if (summary.EsigibilitaIVA === 'S' && summary.Natura !== undefined && (summary.Natura === 'N6' || summary.Natura.startsWith('N6.'))) {
      issues.push(error('00420', `${summaryPath(index)}.Natura`, 'Natura N6 (inversione contabile) incompatibile con la scissione dei pagamenti'));
    }
  });

  // 00418: a credit note cannot be older than the invoices it refers to.
  (body.DatiGenerali.DatiFattureCollegate ?? []).forEach((linked) => {
    if (document.TipoDocumento === 'TD04' && linked.Data !== undefined && document.Data < linked.Data) {
      issues.push(error('00418', child(DOCUMENT, 'Data'), 'Data della nota di credito antecedente a quella della fattura collegata'));
    }
  });

  // Total of the document against the summaries (no SdI code).
  if (document.ImportoTotaleDocumento !== undefined) {
    const expected = sum(summaries.map((summary) => add(round(summary.ImponibileImporto, 2), round(summary.Imposta, 2))));
    if (compare(absolute(sub(round(document.ImportoTotaleDocumento, 2), expected)), CENT) > 0) {
      issues.push(warning('TOTAL', child(DOCUMENT, 'ImportoTotaleDocumento'), 'Importo totale diverso dalla somma di imponibili e imposte dei riepiloghi'));
    }
  }

  issues.push(
    ...checkRates(
      lines.map((line, index) => ({ ratePath: `${linePath(index)}.AliquotaIVA`, naturePath: `${linePath(index)}.Natura`, rate: line.AliquotaIVA, nature: line.Natura })),
      { missing: '00400', present: '00401' },
    ),
    ...checkRates(
      summaries.map((summary, index) => ({ ratePath: `${summaryPath(index)}.AliquotaIVA`, naturePath: `${summaryPath(index)}.Natura`, rate: summary.AliquotaIVA, nature: summary.Natura })),
      { missing: '00429', present: '00430' },
    ),
  );
  return issues;
}

/** Checks of the simplified format on its goods blocks (00400, 00401, 00424, 00445, 00418, 00460). */
function checkSimplifiedBody(model: Extract<InvoiceModel, { versione: 'FSM10' }>, facts: Facts): ValidationIssue[] {
  const body = model.FatturaElettronicaBody;
  const blocks = body.DatiBeniServizi;
  const issues: ValidationIssue[] = [];
  const rectified = body.DatiGenerali.DatiFatturaRettificata;
  if (facts.type === 'TD08' && rectified !== undefined && facts.date < rectified.DataFR) {
    issues.push(error('00418', child(DOCUMENT, 'Data'), 'Data del documento antecedente a quella della fattura rettificata'));
  }
  const exempt = rectified !== undefined || facts.sellerRegime === 'RF19' || facts.sellerRegime === 'RF20';
  if (!exempt && compare(sum(blocks.map((block) => round(block.Importo, 2))), SIMPLIFIED_LIMIT) > 0) {
    issues.push(error('00460', GOODS, 'Importo totale superiore al limite di 400,00 euro previsto per le fatture semplificate'));
  }
  issues.push(
    ...checkRates(
      blocks.map((block, index) => ({
        ratePath: `${GOODS}[${index}].DatiIVA.Aliquota`,
        naturePath: `${GOODS}[${index}].Natura`,
        rate: block.DatiIVA.Aliquota,
        nature: block.Natura,
      })),
      { missing: '00400', present: '00401' },
    ),
  );
  return issues;
}

/**
 * Runs every offline SdI check on an invoice.
 *
 * @param model The invoice.
 * @param context The expected reception day.
 * @returns The problems found (errors, plus the `warning`s of check 00422 and of the document total), unsorted.
 */
export function checkSdi(model: InvoiceModel, context: SdiContext): ValidationIssue[] {
  const facts = factsOf(model);
  if (model.versione === 'FSM10') {
    const blocks = model.FatturaElettronicaBody.DatiBeniServizi;
    const rates = blocks.map((block, index) => ({
      ratePath: `${GOODS}[${index}].DatiIVA.Aliquota`,
      naturePath: `${GOODS}[${index}].Natura`,
      rate: block.DatiIVA.Aliquota,
      nature: block.Natura,
    }));
    return [...checkTransmission(facts), ...checkDocument(facts, context, rates), ...checkSimplifiedBody(model, facts)];
  }
  const rates = model.FatturaElettronicaBody.DatiBeniServizi.DettaglioLinee.map((line, index) => ({
    ratePath: `${GOODS}.DettaglioLinee[${index}].AliquotaIVA`,
    naturePath: `${GOODS}.DettaglioLinee[${index}].Natura`,
    rate: line.AliquotaIVA,
    nature: line.Natura,
  }));
  return [...checkTransmission(facts), ...checkDocument(facts, context, rates), ...checkOrdinaryBody(model)];
}
