import type { ObjectId } from 'mongodb';
import type { PriceList } from '../settings/price-list.ts';

/** The two invoices of a month: the activations of the month before, and the instalment of the renewals of the year. */
export const SECTIONS = Object.freeze(['activations', 'renewals'] as const);

/** One of the two invoices. */
export type Section = (typeof SECTIONS)[number];

/** The reasons a line needs attention, in the order they are reported. */
export const LINE_FLAGS = Object.freeze(['unpricedPlan', 'activationDateFromId', 'expired', 'groupSuspended', 'companyDisabled'] as const);

/** A reason a line needs attention: the plan has no price, the date of the activation is the one of the id, the licence expired, the group is suspended, the company is disabled. */
export type LineFlag = (typeof LINE_FLAGS)[number];

/** One item of the monthly fee of a place. `unitCents` is `null` for a plan without a price. */
export interface FeeItem {
  readonly key: string;
  readonly quantity: number;
  readonly unitCents: number | null;
  readonly amountCents: number;
  /** Only on the `api` item: the integrations that make it (the provider keys, and `statmanager` when the group has it on). */
  readonly providers?: readonly string[];
}

/** The devices of a place that matter to its fee: the desks (the first is included in the plan), the kiosks, and the handhelds, which are free. */
export interface LineDevices {
  readonly desks: number;
  readonly kiosks: number;
  readonly handhelds: number;
}

/** One line of a statement: a place with its monthly fee, the months charged and the amount. */
export interface Line {
  readonly groupId: ObjectId;
  readonly groupName: string;
  readonly companyId: ObjectId;
  readonly companyName: string;
  readonly placeId: ObjectId;
  readonly placeName: string;
  readonly activatedAt: Date;
  readonly plan: string | null;
  readonly items: readonly FeeItem[];
  readonly monthlyCents: number;
  readonly months: number;
  readonly amountCents: number;
  readonly flags: readonly LineFlag[];
  /** The devices counted (absent in a line stored before they were). */
  readonly devices?: LineDevices;
}

/** The totals of the activations of a month. */
export interface ActivationTotals {
  readonly places: number;
  readonly monthlyCents: number;
  readonly amountCents: number;
  readonly projection12Cents: number;
  /** The places left out because their company is missing or in the trash. */
  readonly anomalies: number;
}

/** The totals of the renewals of a year: the annual fee of the park and the instalment, one twelfth of it. */
export interface RenewalTotals {
  readonly places: number;
  readonly annualCents: number;
  readonly instalmentCents: number;
  readonly anomalies: number;
}

/** The dealer of a row: `id` is `null` for the groups with no dealer. */
export interface DealerRef {
  readonly id: ObjectId | null;
  readonly name: string;
}

/** What a closure document holds of one section: the lines (for a month, only those of the activations) and the totals. */
export interface FrozenSection<TTotals> {
  readonly lines: readonly Line[];
  readonly totals: TTotals;
}

/** A closure document of `common.billingClosures`. */
export interface Closure {
  readonly kind: 'renewalBase' | 'month';
  readonly period: string;
  readonly dealerId: ObjectId | null;
  readonly dealerName: string;
  readonly prices: PriceList;
  readonly activations: FrozenSection<ActivationTotals>;
  readonly renewals: { readonly lines?: readonly Line[]; readonly totals: RenewalTotals };
  readonly closedAt: Date;
  readonly closedBy: ObjectId;
}
