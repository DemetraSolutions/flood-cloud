import { ApiError } from '../../core/api/api-error';
import { formatDate, formatMoney } from '../../core/i18n/format';
import { Language } from '../../core/i18n/language';
import { PriceList, SERVICE_KEYS, SERVICE_LABEL_KEYS } from '../price-list/price-list.types';

/** Sections of a dealer statement. */
export const STATEMENT_SECTIONS = ['activations', 'renewals'] as const;

/** A section of a dealer statement. */
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

/** Whether a value is a section of the statement. */
export function isSection(value: unknown): value is StatementSection {
  return STATEMENT_SECTIONS.some((section) => section === value);
}

/** Path segment of the dealer of a statement that has none ("Senza rivenditore"). */
export const NO_DEALER = 'none';

/** Allowed shape of an invoice month, years 2020 to 2100 (the same as the backend). */
export const MONTH_PATTERN = /^(?:20[2-9]\d|2100)-(?:0[1-9]|1[0-2])$/;

/** Time zone in which the months of the activations are counted. */
const TIME_ZONE = 'Europe/Rome';

/** Whether a value is a valid invoice month (`YYYY-MM`). */
export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

/**
 * The current month in Italy (the month the activations are counted in).
 *
 * @param now The instant to read; defaults to now.
 * @returns `YYYY-MM`.
 */
export function currentMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value as string;
  return `${part('year')}-${part('month')}`;
}

/** The month before another one (January gives the December of the previous year). */
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number === 1 ? `${year - 1}-12` : `${year}-${String(number - 1).padStart(2, '0')}`;
}

/** The year of a month. */
export function yearOf(month: string): number {
  return Number(month.slice(0, 4));
}

/**
 * A month in words in Italian terms, e.g. `giugno 2026`.
 *
 * @param month `YYYY-MM`.
 * @param language Language of the output.
 */
export function monthLabel(month: string, language: Language): string {
  return formatDate(`${month}-15T12:00:00Z`, language, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The name of a month with no year, e.g. `giugno`.
 *
 * @param month `YYYY-MM`.
 * @param language Language of the output.
 */
export function monthName(month: string, language: Language): string {
  return formatDate(`${month}-15T12:00:00Z`, language, { month: 'long', timeZone: 'UTC' });
}

/** Formats cents as euro. */
export function formatCents(cents: number, language: Language): string {
  return formatMoney(cents, 'EUR', language);
}

/** A dealer of the summary; `id` is `null` for the groups without a dealer. */
export interface DealerRef {
  readonly id: string | null;
  readonly name: string;
}

/** Whether the invoices of a dealer for the month are computed live or stored. */
export type ClosureStatus = 'open' | 'closed';

/** One row of the summary: what Flood invoices a dealer for the invoice month. */
export interface ActivationRow {
  readonly dealer: DealerRef;
  readonly status: ClosureStatus;
  readonly activations: {
    /** Month of the activations invoiced (`YYYY-MM`). */
    readonly activityMonth: string;
    readonly places: number;
    readonly monthlyCents: number;
    readonly amountCents: number;
    readonly projection12Cents: number;
  };
  readonly renewals: {
    readonly year: number;
    readonly places: number;
    readonly annualCents: number;
    readonly instalmentCents: number;
    readonly frozen: boolean;
  };
  readonly totalCents: number;
  /** Places left out of the count (a count). */
  readonly anomalies: number;
}

/** Overall totals of the summary. */
export interface ActivationTotals {
  readonly activations: {
    readonly places: number;
    readonly amountCents: number;
    readonly projection12Cents: number;
  };
  readonly renewals: { readonly instalmentCents: number };
  readonly totalCents: number;
  readonly anomalies: number;
}

/** Renewal base of the year of the invoice month. */
export interface RenewalBase {
  readonly year: number;
  readonly frozen: boolean;
}

/** `GET /v1/activations`: one row per dealer, the overall totals and the state of the base. */
export interface ActivationsSummary {
  readonly data: readonly ActivationRow[];
  readonly totals: ActivationTotals;
  /** `null` only before the summary is read. */
  readonly renewalBase: RenewalBase | null;
  /** Status of the whole month. */
  readonly status: ClosureStatus;
}

/** An item of the monthly fee of a place. */
export interface FeeItem {
  /** `plan:<stored plan>` or a service key. */
  readonly key: string;
  readonly quantity: number;
  /** Unit price in cents; `null` for a plan with no price. */
  readonly unitCents: number | null;
  readonly amountCents: number;
  /** Providers behind the `api` item (keys as the backend sends them). */
  readonly providers?: readonly string[];
}

/** Devices of a place (older closures lack them). */
export interface PlaceDevices {
  readonly desks: number;
  readonly kiosks: number;
  readonly handhelds: number;
}

/** One place of a statement. */
export interface StatementLine {
  readonly groupId: string;
  readonly groupName: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly placeId: string;
  readonly placeName: string;
  /** ISO instant of the activation. */
  readonly activatedAt: string;
  readonly plan: string | null;
  readonly items: readonly FeeItem[];
  readonly monthlyCents: number;
  readonly months: number;
  readonly amountCents: number;
  /** Notes on the place: `unpricedPlan`, `expired`, `groupSuspended`, `companyDisabled`, `activationDateFromId`. */
  readonly flags: readonly string[];
  /** Expected revenue of the next 12 months. */
  readonly projection12Cents: number;
  readonly devices?: PlaceDevices;
}

/** Totals of a section of a statement. */
export interface SectionTotals {
  readonly places: number;
  readonly amountCents: number;
  /** Expected revenue of the next 12 months (activations only). */
  readonly projection12Cents?: number;
}

/** `GET /v1/activations/statements/{dealerId}`: a page of lines, the section totals and the prices applied. */
export interface StatementResponse {
  readonly data: readonly StatementLine[];
  readonly page: { readonly limit: number; readonly next: string | null };
  readonly totals: SectionTotals;
  readonly prices: PriceList;
  readonly dealer: DealerRef;
  /** Status of the whole month. */
  readonly status: ClosureStatus;
  readonly renewalBase: RenewalBase;
}

/** Dictionary key of the badge of each flag of a line. */
export const FLAG_KEYS: Readonly<Record<string, string>> = {
  unpricedPlan: 'ACTIVATIONS.FLAG.UNPRICED_PLAN',
  expired: 'ACTIVATIONS.FLAG.EXPIRED',
  groupSuspended: 'ACTIVATIONS.FLAG.GROUP_SUSPENDED',
  companyDisabled: 'ACTIVATIONS.FLAG.COMPANY_DISABLED',
  activationDateFromId: 'ACTIVATIONS.FLAG.DATE_FROM_ID',
};

/** Flags that call for a check by who prepares the invoice (the others only describe the place). */
export const WARNING_FLAGS: ReadonlySet<string> = new Set(['unpricedPlan', 'activationDateFromId']);

/** Translates a key (the signature of `I18nService.t`). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The text of a flag of a line.
 *
 * @param t Translation function.
 * @param flag Flag as sent by the backend; an unknown one is shown as it is.
 */
export function flagText(t: Translate, flag: string): string {
  return Object.hasOwn(FLAG_KEYS, flag) ? t(FLAG_KEYS[flag]) : flag;
}

const PLAN_PREFIX = 'plan:';

/**
 * The text of an item of the monthly fee ("Piano basic", "2 casse aggiuntive", "Kiosk").
 *
 * @param t Translation function.
 * @param item The item; a key that is neither a plan nor a known service is shown as it is.
 */
export function itemText(t: Translate, item: FeeItem): string {
  if (item.key === PLAN_PREFIX) {
    return t('ACTIVATIONS.ITEM.NO_PLAN');
  }
  if (item.key.startsWith(PLAN_PREFIX)) {
    return t('ACTIVATIONS.ITEM.PLAN', { plan: item.key.slice(PLAN_PREFIX.length) });
  }
  if (item.key === 'extraDesk' && item.quantity > 1) {
    return t('ACTIVATIONS.ITEM.EXTRA_DESKS', { count: item.quantity });
  }
  const known = SERVICE_KEYS.find((key) => key === item.key);
  return known === undefined ? item.key : t(SERVICE_LABEL_KEYS[known]);
}

/** Lines of one company of a group (in the order of the statement). */
export interface CompanyBlock {
  readonly companyId: string;
  readonly companyName: string;
  readonly lines: StatementLine[];
}

/** Companies of one group. */
export interface GroupBlock {
  readonly groupId: string;
  readonly groupName: string;
  readonly companies: readonly CompanyBlock[];
}

/**
 * Groups the lines of a statement (already sorted by group, company and place) by group and
 * company, for the visual grouping of the page.
 */
export function groupLines(lines: readonly StatementLine[]): GroupBlock[] {
  const groups: { groupId: string; groupName: string; companies: CompanyBlock[] }[] = [];
  for (const line of lines) {
    let group = groups.at(-1);
    if (group?.groupId !== line.groupId) {
      group = { groupId: line.groupId, groupName: line.groupName, companies: [] };
      groups.push(group);
    }
    let company = group.companies.at(-1);
    if (company?.companyId !== line.companyId) {
      company = { companyId: line.companyId, companyName: line.companyName, lines: [] };
      group.companies.push(company);
    }
    company.lines.push(line);
  }
  return groups;
}

/** Issues the backend names on a `409` of freeze, unfreeze, close and reopen. */
export const CONFLICT_KEYS: Readonly<Record<string, string>> = {
  baseNotFrozen: 'ACTIVATIONS.CONFLICT.BASE_NOT_FROZEN',
  monthInFuture: 'ACTIVATIONS.CONFLICT.MONTH_IN_FUTURE',
  alreadyClosed: 'ACTIVATIONS.CONFLICT.ALREADY_CLOSED',
  monthClosed: 'ACTIVATIONS.CONFLICT.MONTH_CLOSED',
  tooManyLines: 'ACTIVATIONS.CONFLICT.TOO_MANY_LINES',
  alreadyFrozen: 'ACTIVATIONS.CONFLICT.ALREADY_FROZEN',
  empty: 'ACTIVATIONS.CONFLICT.EMPTY',
  notFrozen: 'ACTIVATIONS.CONFLICT.NOT_FROZEN',
  notClosed: 'ACTIVATIONS.CONFLICT.NOT_CLOSED',
  yearInFuture: 'ACTIVATIONS.CONFLICT.YEAR_IN_FUTURE',
};

/**
 * Dictionary key of the notice for a refused freeze, unfreeze, close or reopen: the reason when
 * the backend names a known one, a general text for any other conflict.
 *
 * @param error The caught error.
 * @returns The key, or `null` when the error is not a conflict (the central mapping applies).
 */
export function conflictKey(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  const issue = error.details.find((detail) => Object.hasOwn(CONFLICT_KEYS, detail.issue));
  return issue === undefined ? 'ACTIVATIONS.CONFLICT.GENERIC' : CONFLICT_KEYS[issue.issue];
}

/** What a PSA can do on the month and on the renewal base of its year. */
export type BillingAction = 'freeze' | 'unfreeze' | 'close' | 'reopen';

/** Dictionary keys of the texts of each {@link BillingAction}. */
export const ACTION_TEXTS: Readonly<
  Record<
    BillingAction,
    { label: string; title: string; message: string; confirm: string; done: string }
  >
> = {
  freeze: {
    label: 'ACTIVATIONS.ACTION.FREEZE.LABEL',
    title: 'ACTIVATIONS.ACTION.FREEZE.TITLE',
    message: 'ACTIVATIONS.ACTION.FREEZE.MESSAGE',
    confirm: 'ACTIVATIONS.ACTION.FREEZE.CONFIRM',
    done: 'ACTIVATIONS.ACTION.FREEZE.DONE',
  },
  unfreeze: {
    label: 'ACTIVATIONS.ACTION.UNFREEZE.LABEL',
    title: 'ACTIVATIONS.ACTION.UNFREEZE.TITLE',
    message: 'ACTIVATIONS.ACTION.UNFREEZE.MESSAGE',
    confirm: 'ACTIVATIONS.ACTION.UNFREEZE.CONFIRM',
    done: 'ACTIVATIONS.ACTION.UNFREEZE.DONE',
  },
  close: {
    label: 'ACTIVATIONS.ACTION.CLOSE.LABEL',
    title: 'ACTIVATIONS.ACTION.CLOSE.TITLE',
    message: 'ACTIVATIONS.ACTION.CLOSE.MESSAGE',
    confirm: 'ACTIVATIONS.ACTION.CLOSE.CONFIRM',
    done: 'ACTIVATIONS.ACTION.CLOSE.DONE',
  },
  reopen: {
    label: 'ACTIVATIONS.ACTION.REOPEN.LABEL',
    title: 'ACTIVATIONS.ACTION.REOPEN.TITLE',
    message: 'ACTIVATIONS.ACTION.REOPEN.MESSAGE',
    confirm: 'ACTIVATIONS.ACTION.REOPEN.CONFIRM',
    done: 'ACTIVATIONS.ACTION.REOPEN.DONE',
  },
};

/** Tabs of the activations page. */
export const ACTIVATION_TABS = ['invoices', 'detail'] as const;

/** A tab of the activations page. */
export type ActivationTab = (typeof ACTIVATION_TABS)[number];

/** Whether a value is a tab of the activations page. */
export function isActivationTab(value: unknown): value is ActivationTab {
  return ACTIVATION_TABS.some((tab) => tab === value);
}

/** Position of a month on a line of months (`YYYY-MM` to a whole number). */
function monthIndex(month: string): number {
  return yearOf(month) * 12 + Number(month.slice(5, 7));
}

/**
 * Whether a period of activation months is in order (there is no limit on its length).
 *
 * @param from First month, a valid `YYYY-MM`.
 * @param to Last month, a valid `YYYY-MM`.
 * @returns `false` when it ends before it starts.
 */
export function isPeriodInOrder(from: string, to: string): boolean {
  return monthIndex(to) >= monthIndex(from);
}

/** A place of the detail view: a statement line with its dealer. */
export interface DetailLine extends StatementLine {
  readonly dealer: DealerRef;
}

/** Totals of the whole filtered set of the detail view. */
export interface DetailTotals {
  readonly places: number;
  readonly monthlyCents: number;
  readonly amountCents: number;
  readonly projection12Cents: number;
  readonly anomalies: number;
}

/**
 * `GET /v1/activations/lines`: a page of places, the totals of the whole period and the period
 * (`from` is `null` when the query had no start: everything up to `to`).
 */
export interface DetailResponse {
  readonly data: readonly DetailLine[];
  readonly page: { readonly limit: number; readonly next: string | null };
  readonly totals: DetailTotals;
  readonly from: string | null;
  readonly to: string;
  /** The current year the months of the lines are counted in (earlier years count 12). */
  readonly referenceYear: number;
}

/** Dictionary key of the name of each provider behind the `api` item. */
export const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  qodeup: 'ACTIVATIONS.PROVIDER.QODEUP',
  googleMaps: 'ACTIVATIONS.PROVIDER.GOOGLE_MAPS',
  yellgo: 'ACTIVATIONS.PROVIDER.YELLGO',
  leggimenu: 'ACTIVATIONS.PROVIDER.LEGGIMENU',
  plateform: 'ACTIVATIONS.PROVIDER.PLATEFORM',
  cooperto: 'ACTIVATIONS.PROVIDER.COOPERTO',
  tomatoai: 'ACTIVATIONS.PROVIDER.TOMATOAI',
  keenon: 'ACTIVATIONS.PROVIDER.KEENON',
  phlex: 'ACTIVATIONS.PROVIDER.PHLEX',
  statmanager: 'ACTIVATIONS.PROVIDER.STATMANAGER',
};

/**
 * The label of an item of the fee without its quantity (it has its own column), with the
 * providers in brackets for the `api` item ("API (Qodeup, Phlex)"); an unknown provider is
 * shown as it is.
 */
export function feeItemName(t: Translate, item: FeeItem): string {
  const name = itemText(t, { ...item, quantity: 1 });
  const providers = item.providers ?? [];
  if (providers.length === 0) {
    return name;
  }
  const labels = providers.map((key) =>
    Object.hasOwn(PROVIDER_KEYS, key) ? t(PROVIDER_KEYS[key]) : key,
  );
  return `${name} (${labels.join(', ')})`;
}
