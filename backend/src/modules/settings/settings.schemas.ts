import { integer, object, optional, record } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { MAX_PLANS, MAX_PRICE_CENTS, PLAN_KEY_FORMAT, SERVICE_KEYS } from './price-list.ts';
import type { ServiceKey } from './price-list.ts';

/** Body limit of the writes of prices: at most 30 plans and 9 services. */
export const PRICES_BODY_LIMIT = '8kb';

/** A price in cents of euro: an integer from 0 to 10 000 000. */
export const price = (): Schema<number, false> => integer({ min: 0, max: MAX_PRICE_CENTS });

/** The prices of the plans: at most {@link MAX_PLANS}, each key a plan key. */
export const planPrices = (): Schema<Record<string, number>, false> => record(price(), { max: MAX_PLANS, key: PLAN_KEY_FORMAT });

/** Body of `PUT /v1/settings/price-list`: the whole list, every service priced. Nothing else is accepted. */
export const priceListBody = object({
  plans: planPrices(),
  services: object(Object.fromEntries(SERVICE_KEYS.map((key) => [key, price()])) as Record<ServiceKey, Schema<number, false>>),
});

/** Validated body of the price list. */
export type PriceListBody = Infer<typeof priceListBody>;

/** Body of `PUT /v1/dealers/{dealerId}/price-overrides`: a partial price list; `{}` removes every override. */
export const priceOverridesBody = object({
  plans: optional(planPrices()),
  services: optional(object(Object.fromEntries(SERVICE_KEYS.map((key) => [key, optional(price())])) as Record<ServiceKey, Schema<number, true>>)),
});

/** Validated body of the price overrides. */
export type PriceOverridesBody = Infer<typeof priceOverridesBody>;
