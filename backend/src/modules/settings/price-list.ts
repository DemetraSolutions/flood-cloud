/** The services of the price list, in the order the pages show them. */
export const SERVICE_KEYS = Object.freeze(['extraDesk', 'kiosk', 'api', 'tobaccos', 'reservationWidget', 'floodPay', 'arubaEInvoicing', 'reserveWithGoogle', 'bizerba'] as const);

/** A service of the price list. */
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** The format of a plan key: the plan as the places store it (`basic`, `enterprice`, `desk-secondary`). */
export const PLAN_KEY_FORMAT = /^[A-Za-z0-9_-]{1,30}$/;

/** Most plans a price list, or the overrides of a dealer, may price. */
export const MAX_PLANS = 30;

/** The highest price: 100 000,00 EUR a month, in cents. */
export const MAX_PRICE_CENTS = 10_000_000;

/** The monthly price, in cents of euro net of VAT, of each plan and of each service, for one place. */
export interface PriceList {
  readonly plans: Readonly<Record<string, number>>;
  readonly services: Readonly<Record<ServiceKey, number>>;
}

/** The prices a dealer pays instead of the ones of the price list, key by key: partial, every part optional. */
export interface PriceOverrides {
  readonly plans?: Readonly<Record<string, number>>;
  readonly services?: Readonly<Partial<Record<ServiceKey, number>>>;
}

/**
 * The prices in force while the PSA has set none (the values of the legacy page): `basic` 20, `advanced` 30, `enterprice` 40 (the historical spelling of the value), `tgm-secondary` 0 and `desk-secondary` 5 EUR;
 * an extra desk 5, the kiosk 15, the API 5, the tobacconist 13, the reservation widget 10 and Flood Pay 15 EUR; the other services are free. Deeply frozen.
 */
export const DEFAULT_PRICE_LIST: PriceList = Object.freeze({
  plans: Object.freeze({ basic: 2000, advanced: 3000, enterprice: 4000, 'tgm-secondary': 0, 'desk-secondary': 500 }),
  services: Object.freeze({ extraDesk: 500, kiosk: 1500, api: 500, tobaccos: 1300, reservationWidget: 1000, floodPay: 1500, arubaEInvoicing: 0, reserveWithGoogle: 0, bizerba: 0 }),
});

/** Whether a value is a price: an integer number of cents from 0 to {@link MAX_PRICE_CENTS}. */
function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRICE_CENTS;
}

/** Whether a value is a plain stored object (a sub-document). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The valid prices of a map of plans, by key in alphabetical order (a key that is not a plan key, a value that is not a price and anything beyond {@link MAX_PLANS} are dropped). */
function plansOf(raw: unknown): Record<string, number> {
  const plans: Record<string, number> = {};
  if (isRecord(raw)) {
    for (const key of Object.keys(raw).sort()) {
      const price = raw[key];
      if (PLAN_KEY_FORMAT.test(key) && isPrice(price) && Object.keys(plans).length < MAX_PLANS) {
        plans[key] = price;
      }
    }
  }
  return plans;
}

/**
 * The price list of a stored value, read tolerantly: the plans that are well formed, and for every service its price or, when the value holds none, the default one. The database validator makes anything else impossible,
 * so this only protects the arithmetic from a document that was changed behind the back of the application.
 *
 * @param raw The stored `value`, or `null` when no price list is stored.
 * @returns The price list, `DEFAULT_PRICE_LIST` for `null`.
 */
export function priceListOf(raw: unknown): PriceList {
  if (raw === null) {
    return DEFAULT_PRICE_LIST;
  }
  const services = isRecord(raw) && isRecord(raw['services']) ? raw['services'] : {};
  return {
    plans: plansOf(isRecord(raw) ? raw['plans'] : undefined),
    services: Object.fromEntries(SERVICE_KEYS.map((key) => [key, isPrice(services[key]) ? services[key] : DEFAULT_PRICE_LIST.services[key]])) as Record<ServiceKey, number>,
  };
}

/**
 * The overrides of a stored dealer, read tolerantly: the valid entries only, and nothing for a part that has none.
 *
 * @param raw The stored `priceOverrides`, of unknown shape (`undefined` when the dealer has none).
 * @returns The overrides: `{}` when there are none.
 */
export function overridesOf(raw: unknown): PriceOverrides {
  const plans = plansOf(isRecord(raw) ? raw['plans'] : undefined);
  const stored = isRecord(raw) && isRecord(raw['services']) ? raw['services'] : {};
  const services = Object.fromEntries(SERVICE_KEYS.flatMap((key) => (isPrice(stored[key]) ? [[key, stored[key]]] : []))) as Partial<Record<ServiceKey, number>>;
  return { ...(Object.keys(plans).length === 0 ? {} : { plans }), ...(Object.keys(services).length === 0 ? {} : { services }) };
}

/**
 * The prices a dealer pays: the price list with the overrides of the dealer on top, key by key.
 *
 * @param list The price list in force.
 * @param overrides The overrides of the dealer, `{}` for none.
 */
export function effectivePrices(list: PriceList, overrides: PriceOverrides): PriceList {
  return { plans: { ...list.plans, ...overrides.plans }, services: { ...list.services, ...overrides.services } };
}

/**
 * The price of a plan: only a plan the list prices itself (an own key, never one inherited from `Object.prototype`).
 *
 * @param plans The prices of the plans.
 * @param plan The plan as stored in the place.
 * @returns The price in cents, or `null` when the plan has none.
 */
export function planPrice(plans: Readonly<Record<string, number>>, plan: string): number | null {
  return Object.hasOwn(plans, plan) ? plans[plan]! : null;
}
