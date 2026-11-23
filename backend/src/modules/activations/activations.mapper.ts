import type { Document, ObjectId } from 'mongodb';
import type { DetailKey } from './activations.cursor.ts';
import type { PriceList } from '../settings/price-list.ts';
import type { ActivationTotals, Closure, DealerRef, FeeItem, Line, LineDevices, LineFlag, RenewalTotals } from './activations.types.ts';

/** The name the groups with no dealer are collected under. */
export const NO_DEALER_NAME = 'Senza rivenditore';

/** The `dealerId` of the path and the query that stands for the groups with no dealer. */
export const NO_DEALER = 'none';

/** The totals of nothing. */
export const NO_ACTIVATIONS: ActivationTotals = Object.freeze({ places: 0, monthlyCents: 0, amountCents: 0, projection12Cents: 0, anomalies: 0 });

/** The renewals of nothing. */
export const NO_RENEWALS: RenewalTotals = Object.freeze({ places: 0, annualCents: 0, instalmentCents: 0, anomalies: 0 });

/** The order of the lines of a statement: group, company and place by name (in the Italian collation, so `alfa` is before `Zeta`), then by id, so that the order is total and stable. */
const COLLATOR = new Intl.Collator('it', { numeric: true });

/** The sort key of a line: what the cursor of a statement holds. */
export interface LineKey {
  readonly groupName: string;
  readonly companyName: string;
  readonly placeName: string;
  readonly placeId: string;
}

/** The sort key of a line. */
export function keyOf(line: Pick<Line, 'groupName' | 'companyName' | 'placeName'> & { readonly placeId: ObjectId }): LineKey {
  return { groupName: line.groupName, companyName: line.companyName, placeName: line.placeName, placeId: line.placeId.toHexString() };
}

/**
 * Compares two sort keys: negative when `a` comes first.
 *
 * @param a A key.
 * @param b Another key.
 */
export function compareKeys(a: LineKey, b: LineKey): number {
  return COLLATOR.compare(a.groupName, b.groupName) || COLLATOR.compare(a.companyName, b.companyName) || COLLATOR.compare(a.placeName, b.placeName) || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0);
}

/** A line of the detail view with its dealer. */
export interface DetailEntry {
  readonly dealer: DealerRef;
  readonly line: Line;
}

/** The sort key of a line of the detail view. */
export function detailKeyOf(entry: DetailEntry): DetailKey {
  return { at: entry.line.activatedAt.getTime(), dealerName: entry.dealer.name, groupName: entry.line.groupName, placeName: entry.line.placeName, placeId: entry.line.placeId.toHexString() };
}

/**
 * Compares two keys of the detail view: the activation date descending, then dealer, group and place name, then id. Negative when `a` comes first.
 *
 * @param a A key.
 * @param b Another key.
 */
export function compareDetailKeys(a: DetailKey, b: DetailKey): number {
  return b.at - a.at || COLLATOR.compare(a.dealerName, b.dealerName) || COLLATOR.compare(a.groupName, b.groupName) || COLLATOR.compare(a.placeName, b.placeName) || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0);
}

/** A line of the detail view as the API shows it: the line of a statement and its dealer. */
export type DetailLineView = LineView & { readonly dealer: DealerView };

/**
 * The lines of the detail view in its order.
 *
 * @param entries The lines with their dealers, in any order.
 * @returns A new array.
 */
export function sortDetail(entries: readonly DetailEntry[]): DetailEntry[] {
  return [...entries].sort((a, b) => compareDetailKeys(detailKeyOf(a), detailKeyOf(b)));
}

/**
 * The lines of a statement in the order of the statement (group name, company name, place name, id).
 *
 * @param lines The lines, in any order.
 * @returns A new array.
 */
export function sortLines(lines: readonly Line[]): Line[] {
  return [...lines].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
}

/** The dealer of a row or a statement as the API shows it. */
export interface DealerView {
  readonly id: string | null;
  readonly name: string;
}

/** A line as the API shows it: ids in hexadecimal, the date in ISO 8601, and the 12-month projection (the monthly fee times twelve). */
export interface LineView {
  readonly groupId: string;
  readonly groupName: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly placeId: string;
  readonly placeName: string;
  readonly activatedAt: string;
  readonly plan: string | null;
  readonly items: readonly FeeItem[];
  readonly monthlyCents: number;
  readonly months: number;
  readonly amountCents: number;
  readonly projection12Cents: number;
  readonly flags: readonly LineFlag[];
}

/**
 * The response form of a line: an explicit allowlist.
 *
 * @param line The line.
 */
export function toLineView(line: Line): LineView {
  return {
    groupId: line.groupId.toHexString(),
    groupName: line.groupName,
    companyId: line.companyId.toHexString(),
    companyName: line.companyName,
    placeId: line.placeId.toHexString(),
    placeName: line.placeName,
    activatedAt: line.activatedAt.toISOString(),
    plan: line.plan,
    items: line.items.map((item) => ({ key: item.key, quantity: item.quantity, unitCents: item.unitCents, amountCents: item.amountCents, ...(item.providers === undefined ? {} : { providers: [...item.providers] }) })),
    monthlyCents: line.monthlyCents,
    months: line.months,
    amountCents: line.amountCents,
    projection12Cents: line.monthlyCents * 12,
    flags: [...line.flags],
    ...(line.devices === undefined ? {} : { devices: { desks: line.devices.desks, kiosks: line.devices.kiosks, handhelds: line.devices.handhelds } }),
  };
}


/** The dealer as the API shows it. */
export const toDealerView = (dealer: DealerRef): DealerView => ({ id: dealer.id === null ? null : dealer.id.toHexString(), name: dealer.name });

/** What the activations of a row show. */
export interface ActivationsView {
  readonly activityMonth: string;
  readonly places: number;
  readonly monthlyCents: number;
  readonly amountCents: number;
  readonly projection12Cents: number;
}

/** What the renewals of a row show. */
export interface RenewalsView {
  readonly year: number;
  readonly places: number;
  readonly annualCents: number;
  readonly instalmentCents: number;
  readonly frozen: boolean;
}

/** One row of the summary: a dealer with its two invoices. */
export interface RowView {
  readonly dealer: DealerView;
  readonly status: 'open' | 'closed';
  readonly activations: ActivationsView;
  readonly renewals: RenewalsView;
  readonly totalCents: number;
  readonly anomalies: number;
}

/** The inputs of a row. */
export interface RowParts {
  readonly dealer: DealerRef;
  readonly status: 'open' | 'closed';
  readonly activityMonth: string;
  readonly activations: ActivationTotals;
  readonly year: number;
  readonly frozen: boolean;
  readonly renewals: RenewalTotals;
}

/**
 * One row of the summary. The total of the month is the invoice of the activations plus the instalment of the renewals.
 *
 * @param parts The dealer, the totals of the two sections and the state.
 */
export function toRowView(parts: RowParts): RowView {
  const { activations, renewals } = parts;
  return {
    dealer: toDealerView(parts.dealer),
    status: parts.status,
    activations: { activityMonth: parts.activityMonth, places: activations.places, monthlyCents: activations.monthlyCents, amountCents: activations.amountCents, projection12Cents: activations.projection12Cents },
    renewals: { year: parts.year, places: renewals.places, annualCents: renewals.annualCents, instalmentCents: renewals.instalmentCents, frozen: parts.frozen },
    totalCents: activations.amountCents + renewals.instalmentCents,
    anomalies: activations.anomalies + renewals.anomalies,
  };
}

/** The totals of the whole summary: the sums of the rows, in the shape of a row without the dealer and the state. */
export interface TotalsView {
  readonly activations: Omit<ActivationsView, 'activityMonth'>;
  readonly renewals: Omit<RenewalsView, 'year' | 'frozen'>;
  readonly totalCents: number;
  readonly anomalies: number;
}

/**
 * The sums of the rows of the summary.
 *
 * @param rows The rows.
 */
export function totalsOf(rows: readonly RowView[]): TotalsView {
  const sum = (pick: (row: RowView) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  return {
    activations: { places: sum((row) => row.activations.places), monthlyCents: sum((row) => row.activations.monthlyCents), amountCents: sum((row) => row.activations.amountCents), projection12Cents: sum((row) => row.activations.projection12Cents) },
    renewals: { places: sum((row) => row.renewals.places), annualCents: sum((row) => row.renewals.annualCents), instalmentCents: sum((row) => row.renewals.instalmentCents) },
    totalCents: sum((row) => row.totalCents),
    anomalies: sum((row) => row.anomalies),
  };
}

/**
 * A stored closure document as a {@link Closure}. A document read without its lines gets empty lists.
 *
 * @param document The stored document (this backend is the only writer of the collection, so the stored types are trusted).
 */
export function closureOf(document: Document): Closure {
  const activations = document['activations'] as { lines?: Line[]; totals: ActivationTotals };
  const renewals = document['renewals'] as { lines?: Line[]; totals: RenewalTotals };
  return {
    kind: document['kind'] as Closure['kind'],
    period: document['period'] as string,
    dealerId: document['dealerId'] as ObjectId | null,
    dealerName: document['dealerName'] as string,
    prices: document['prices'] as PriceList,
    activations: { lines: activations.lines ?? [], totals: activations.totals },
    renewals: { ...(renewals.lines === undefined ? {} : { lines: renewals.lines }), totals: renewals.totals },
    closedAt: document['closedAt'] as Date,
    closedBy: document['closedBy'] as ObjectId,
  };
}
