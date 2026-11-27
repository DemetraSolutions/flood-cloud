/**
 * Lines, document discount and VAT grouping of the mapping from a queue record (see `from-queue.ts`).
 *
 * The amounts are built **by construction** so that the SdI calculation checks pass ("Elenco dei controlli" 2.1):
 * `PrezzoTotale` is the unit price with its discounts times the quantity, the taxable amount of a summary is the sum
 * of the line totals of its (rate, nature) group rounded to two decimals, and the tax is computed on that rounded
 * taxable amount.
 *
 * @module
 */
import { AMOUNT8_SCALE, lineTotal, priceAfterPercent, taxableAmount, taxAmount } from './amounts.ts';
import { compare, decimal, divide, formatDecimal, isZero, round, ZERO } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import { formatDate, freeText, has, invalid, missing, optionalCode, requiredText } from './map-support.ts';
import type { MapContext } from './map-support.ts';
import type { AltriDatiGestionali, ScontoMaggiorazione } from './model.ts';
import type { QueueLine, QueueRecord } from './queue-record.ts';

/** `Natura` values the schemas accept. */
const NATURE: ReadonlySet<string> = new Set([
  'N1', 'N2', 'N2.1', 'N2.2', 'N3', 'N3.1', 'N3.2', 'N3.3', 'N3.4', 'N3.5', 'N3.6', 'N4', 'N5',
  'N6', 'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5', 'N6.6', 'N6.7', 'N6.8', 'N6.9', 'N7',
]);

const ONE = decimal(1n);
const HUNDRED = decimal(100n);
/** Description and rate of the single line that replaces the lines of a "full meal" sale (legacy behaviour). */
const FULL_MEAL_NAME = 'Pasto completo';
const FULL_MEAL_RATE = decimal(10n);

/** A line ready for the model, with what the VAT summary needs to group it. */
export interface MappedLine {
  readonly Descrizione: string;
  readonly Quantita: Decimal;
  readonly PrezzoUnitario: Decimal;
  readonly ScontoMaggiorazione: readonly ScontoMaggiorazione[];
  readonly PrezzoTotale: Decimal;
  readonly AliquotaIVA: Decimal;
  readonly Natura?: string;
  /** Legal reference of a zero-rate operation. */
  readonly RiferimentoNormativo?: string;
  readonly AltriDatiGestionali: readonly AltriDatiGestionali[];
}

/** The lines of a VAT summary: same rate and same nature. */
export interface VatGroup {
  readonly rate: Decimal;
  readonly natura?: string;
  normative?: string;
  readonly totals: Decimal[];
  readonly descriptions: string[];
}

/** The document discount, split by how it is written. */
export interface DocumentDiscount {
  /** A percentage applied (cascade) to every line: set when the company spreads the discount over the lines. */
  readonly spread: ScontoMaggiorazione | undefined;
  /** Set when the discount is not spread: it becomes one adjustment line per VAT summary (see `adjustmentLines`). */
  readonly separate: { readonly Tipo: 'SC' | 'MG'; readonly value: Decimal | null; readonly percentage: Decimal } | undefined;
}

const DISCOUNT_TYPE_PATH = 'XML.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.ScontoMaggiorazione.Tipo';

/**
 * Reads the document discount of a record. The percentage is written with two decimals (`RateType`) and the lines
 * are computed with that same percentage, so the figures stay consistent. The discount is spread over the lines
 * when the company asks for it (`settings.global.discountLines`) or the format cannot carry a document-level block
 * (the simplified invoice); otherwise it becomes adjustment lines (see {@link adjustmentLines}). The block
 * `DatiGeneraliDocumento/ScontoMaggiorazione` is never written: the SdI does not subtract it from the VAT summary
 * (check 00422), so an unconditional discount has to reduce the taxable amount through the lines.
 *
 * @param context Issues and warnings collector.
 * @param record The queue record.
 * @param format The invoice format.
 * @returns Where the discount goes.
 */
export function documentDiscount(context: MapContext, record: QueueRecord, format: 'FPR12' | 'FPA12' | 'FSM10'): DocumentDiscount {
  const percentage = record.discountPercentage ?? ZERO;
  if (compare(percentage, ZERO) < 0 || compare(percentage, HUNDRED) > 0) {
    invalid(context, 'discountPercentage');
    return { spread: undefined, separate: undefined };
  }
  const rounded = round(percentage, 2);
  if (isZero(rounded)) {
    return { spread: undefined, separate: undefined };
  }
  const type = record.xml.discountType.trim().toUpperCase();
  if (type !== '' && type !== 'SC' && type !== 'MG') {
    invalid(context, DISCOUNT_TYPE_PATH);
  }
  const Tipo = type === 'MG' ? 'MG' : 'SC';
  if (format === 'FSM10' || record.company.discountLines) {
    return { spread: { Tipo, Percentuale: rounded }, separate: undefined };
  }
  return { spread: undefined, separate: { Tipo, value: record.discountValue, percentage: rounded } };
}

/** The synthetic line of a "full meal" sale, or the lines of the record. */
function sourceLines(context: MapContext, record: QueueRecord): readonly QueueLine[] {
  if (!record.fullMeal.status) {
    return record.lines;
  }
  const total = record.totalTaxableWithoutDiscount;
  if (total === null) {
    missing(context, 'totalTaxableWithoutDiscount');
    return [];
  }
  const given = record.fullMeal.quantity;
  if (given !== null && compare(given, ZERO) < 0) {
    invalid(context, 'sale.fullMeal.quantity');
    return [];
  }
  const quantity = given === null || isZero(given) ? ONE : given;
  return [
    {
      name: FULL_MEAL_NAME,
      qt: quantity,
      price: divide(total, quantity, AMOUNT8_SCALE),
      tax: FULL_MEAL_RATE,
      discount: null,
      natura: '',
      taxDescription: '',
      otherData: [],
    },
  ];
}

function mapLine(context: MapContext, line: QueueLine, index: number, spread: ScontoMaggiorazione | undefined): MappedLine | undefined {
  const path = `records[${index}]`;
  if (line.qt === null) {
    missing(context, `${path}.qt`);
    return undefined;
  }
  const quantity = round(line.qt, AMOUNT8_SCALE);
  if (compare(quantity, ZERO) <= 0) {
    return undefined;
  }
  if (line.price === null) {
    missing(context, `${path}.price.price`);
  }
  const rate = line.tax;
  if (rate === null) {
    missing(context, `${path}.price.tax`);
  } else if (
    compare(rate, ZERO) < 0 ||
    compare(rate, HUNDRED) > 0 ||
    (!isZero(rate) && compare(rate, ONE) < 0)
  ) {
    // The SdI rejects a rate that is not a percentage (check 00424): 0.22 instead of 22.00.
    invalid(context, `${path}.price.tax`);
  }
  const discount = line.discount ?? ZERO;
  if (compare(discount, ZERO) < 0 || compare(discount, HUNDRED) > 0) {
    invalid(context, `${path}.price.discount`);
  }
  const description = requiredText(context, `${path}.name`, line.name, 'latin', 1000);
  if (line.price === null || rate === null) {
    return undefined;
  }
  const zeroRate = isZero(rate);
  const natura = line.natura.trim().toUpperCase();
  if (zeroRate && natura === '') {
    missing(context, `${path}.price.taxData.natura`);
  } else if (zeroRate && !NATURE.has(natura)) {
    invalid(context, `${path}.price.taxData.natura`);
  }
  const normative = zeroRate ? freeText(context, `${path}.price.taxData.description`, line.taxDescription, 'latin', 100) : undefined;
  const adjustments = spread === undefined ? [] : [spread];
  const unitPrice = priceAfterPercent(line.price, discount);
  return {
    Descrizione: description,
    Quantita: quantity,
    PrezzoUnitario: unitPrice,
    ScontoMaggiorazione: adjustments,
    PrezzoTotale: lineTotal(unitPrice, quantity, adjustments),
    AliquotaIVA: round(rate, 2),
    ...has('Natura', zeroRate && NATURE.has(natura) ? natura : undefined),
    ...has('RiferimentoNormativo', normative),
    AltriDatiGestionali: line.otherData.flatMap((other, otherIndex): AltriDatiGestionali[] => {
      const otherPath = `${path}.XML.AltriDatiGestionali[${otherIndex}]`;
      const kind = optionalCode(context, `${otherPath}.TipoDato`, other.TipoDato, 10);
      if (kind === undefined) {
        return [];
      }
      const text = freeText(context, `${otherPath}.RiferimentoTesto`, other.RiferimentoTesto, 'latin', 60);
      const date = other.RiferimentoData === null ? undefined : formatDate(other.RiferimentoData, context.timeZone);
      return [{ TipoDato: kind, ...has('RiferimentoTesto', text), ...has('RiferimentoData', date) }];
    }),
  };
}

/**
 * Maps the lines of a record. Lines whose quantity is not positive are skipped, as the legacy does (they carry no
 * amount); the remaining ones are numbered in order from 1 by the caller. A "full meal" sale is a single line at 10%.
 *
 * @param context Issues and warnings collector.
 * @param record The queue record.
 * @param spread The document discount spread over the lines, if any.
 * @returns The mapped lines (empty when a problem prevented any).
 */
export function mapLines(context: MapContext, record: QueueRecord, spread: ScontoMaggiorazione | undefined): MappedLine[] {
  return sourceLines(context, record).flatMap((line, index) => mapLine(context, line, index, spread) ?? []);
}

/**
 * Groups lines by (rate, nature), in order of first appearance.
 *
 * @param lines The mapped lines.
 * @returns One group per VAT summary.
 */
export function groupByVat(lines: readonly MappedLine[]): VatGroup[] {
  const groups = new Map<string, VatGroup>();
  for (const line of lines) {
    const key = `${formatDecimal(line.AliquotaIVA, 2, 2)}|${line.Natura ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { rate: line.AliquotaIVA, ...has('natura', line.Natura), totals: [], descriptions: [] };
      groups.set(key, group);
    }
    group.totals.push(line.PrezzoTotale);
    if (!group.descriptions.includes(line.Descrizione)) {
      group.descriptions.push(line.Descrizione);
    }
    if (group.normative === undefined && line.RiferimentoNormativo !== undefined) {
      group.normative = line.RiferimentoNormativo;
    }
  }
  return [...groups.values()];
}

/**
 * Adjustment lines for a document discount that is not spread over the lines. The discount amount is `discountValue`
 * or, when the record has none, the percentage of the total of the goods lines (two decimals). It is split across the
 * VAT summaries proportionally to their taxable amount, in cents, with the largest-remainder method (the shares add
 * up exactly to the amount; ties go to the earlier summary); each summary with a non-zero share gets one line
 * ("Sconto", negative, or "Maggiorazione", positive) with the rate and nature of the summary. A summary share of
 * 0.00 gets no line.
 *
 * @param context Issues and warnings collector.
 * @param separate The discount, from {@link documentDiscount}.
 * @param goods The goods lines.
 * @returns The adjustment lines, numbered by the caller after the goods lines.
 */
export function adjustmentLines(context: MapContext, separate: DocumentDiscount['separate'], goods: readonly MappedLine[]): MappedLine[] {
  if (separate === undefined) {
    return [];
  }
  const groups = groupByVat(goods);
  const weights = groups.map((group) => taxableAmount(group.totals).units);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  const amount =
    separate.value !== null && compare(separate.value, ZERO) > 0 ? round(separate.value, 2) : taxAmount(taxableAmount(goods.map((line) => line.PrezzoTotale)), separate.percentage);
  if (weightSum <= 0n || weights.some((weight) => weight < 0n)) {
    invalid(context, 'discountValue');
    return [];
  }
  const numerators = weights.map((weight) => amount.units * weight);
  const shares = numerators.map((numerator) => numerator / weightSum);
  let leftover = amount.units - shares.reduce((sum, share) => sum + share, 0n);
  const byRemainder = numerators.map((numerator, index) => ({ index, remainder: numerator % weightSum })).sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of byRemainder) {
    if (leftover > 0n) {
      shares[index] = (shares[index] as bigint) + 1n;
      leftover -= 1n;
    }
  }
  const sign = separate.Tipo === 'SC' ? -1n : 1n;
  return groups.flatMap((group, index): MappedLine[] => {
    const share = (shares[index] as bigint) * sign;
    if (share === 0n) {
      return [];
    }
    const price = decimal(share, 2);
    return [
      {
        Descrizione: separate.Tipo === 'SC' ? 'Sconto' : 'Maggiorazione',
        Quantita: ONE,
        PrezzoUnitario: price,
        ScontoMaggiorazione: [],
        PrezzoTotale: price,
        AliquotaIVA: group.rate,
        ...has('Natura', group.natura),
        ...has('RiferimentoNormativo', group.normative),
        AltriDatiGestionali: [],
      },
    ];
  });
}
