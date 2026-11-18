/** Keys of the services of the price list, in the order the pages show them. */
export const SERVICE_KEYS = [
  'extraDesk',
  'kiosk',
  'api',
  'tobaccos',
  'reservationWidget',
  'floodPay',
  'arubaEInvoicing',
  'reserveWithGoogle',
  'bizerba',
] as const;

/** A service of the price list. */
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** Allowed shape of a plan key (the same as the backend allowlist). */
export const PLAN_KEY_PATTERN = /^[A-Za-z0-9_-]{1,30}$/;
/** Most plans a price list can hold. */
export const MAX_PLANS = 30;
/** Highest amount of a price, in cents. */
export const MAX_CENTS = 10_000_000;

/** The price list: monthly fee, in cents, of each plan and of each service. */
export interface PriceList {
  readonly plans: Readonly<Record<string, number>>;
  readonly services: Readonly<Record<string, number>>;
}

/** Overrides of a dealer: partial, absent or empty means no override. */
export interface PriceOverrides {
  readonly plans?: Readonly<Record<string, number>>;
  readonly services?: Readonly<Record<string, number>>;
}

/** `GET /v1/dealers/{dealerId}/price-overrides`: the overrides and the prices that result. */
export interface DealerPrices {
  readonly overrides: PriceOverrides;
  readonly effective: PriceList;
}

/** A value with the version (`ETag`) it was read with. */
export interface Versioned<T> {
  readonly value: T;
  readonly etag: string | null;
}

/** One plan of a price form: the key and the price as the user types it, in euro. */
export interface PlanRow {
  key: string;
  price: string;
}

/** Model of a price form: plans (a list) and services (always the same ones). */
export interface PriceFormModel {
  plans: PlanRow[];
  services: Record<ServiceKey, string>;
}

/** Reasons the price of a field is refused (names of `FORM.ISSUE.*`). */
export type PriceIssue = 'required' | 'pattern' | 'maximum';

const EURO_TEXT = /^(\d{1,8})(?:[.,](\d{1,2}))?$/;

/**
 * Converts the euro amount a user typed into cents, without floating point arithmetic.
 *
 * @param text Amount such as `20`, `20,5` or `20.50`.
 * @returns The cents, or `null` when the text is not an amount or exceeds {@link MAX_CENTS}.
 */
export function euroTextToCents(text: string): number | null {
  const match = EURO_TEXT.exec(text.trim());
  if (match === null) {
    return null;
  }
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > MAX_CENTS ? null : cents;
}

/**
 * Formats cents as the euro amount an input shows (two decimals, decimal comma).
 *
 * @param cents Amount in cents.
 * @returns For example `20,00`.
 */
export function centsToEuroText(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Why a typed price is refused.
 *
 * @param text What the user typed.
 * @param optional Whether an empty text is fine (an override that is not set).
 * @returns The issue, or `undefined` when the price is acceptable.
 */
export function priceIssue(text: string, optional = false): PriceIssue | undefined {
  if (text.trim() === '') {
    return optional ? undefined : 'required';
  }
  if (euroTextToCents(text) !== null) {
    return undefined;
  }
  return EURO_TEXT.test(text.trim()) ? 'maximum' : 'pattern';
}

/** The services of a form, every one as euro text (`''` when the list has none). */
export function servicesToModel(
  services: Readonly<Record<string, number>> | undefined,
): Record<ServiceKey, string> {
  return Object.fromEntries(
    SERVICE_KEYS.map((key) => {
      const cents = services !== undefined && Object.hasOwn(services, key) ? services[key] : null;
      return [key, cents === null ? '' : centsToEuroText(cents)];
    }),
  ) as Record<ServiceKey, string>;
}

/** The plans of a form, sorted by key. */
export function plansToRows(plans: Readonly<Record<string, number>>): PlanRow[] {
  return Object.keys(plans)
    .sort((a, b) => a.localeCompare(b, 'it'))
    .map((key) => ({ key, price: centsToEuroText(plans[key]) }));
}

/**
 * The prices of a form as the cents the backend takes; an empty text is left out.
 *
 * @param entries Key and euro text of each price.
 */
export function pricesToCents(
  entries: readonly (readonly [string, string])[],
): Record<string, number> {
  return Object.fromEntries(
    entries
      .filter(([, text]) => text.trim() !== '')
      .map(([key, text]) => [key, euroTextToCents(text) as number]),
  );
}

/** Dictionary key of the name of each service (shared by the price list, the overrides and the statements). */
export const SERVICE_LABEL_KEYS: Readonly<Record<ServiceKey, string>> = {
  extraDesk: 'PRICE_SERVICE.EXTRA_DESK',
  kiosk: 'PRICE_SERVICE.KIOSK',
  api: 'PRICE_SERVICE.API',
  tobaccos: 'PRICE_SERVICE.TOBACCOS',
  reservationWidget: 'PRICE_SERVICE.RESERVATION_WIDGET',
  floodPay: 'PRICE_SERVICE.FLOOD_PAY',
  arubaEInvoicing: 'PRICE_SERVICE.ARUBA_E_INVOICING',
  reserveWithGoogle: 'PRICE_SERVICE.RESERVE_WITH_GOOGLE',
  bizerba: 'PRICE_SERVICE.BIZERBA',
};
