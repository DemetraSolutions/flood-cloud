import { MAX_PLANS, MAX_PRICE_CENTS, SERVICE_KEYS } from '../modules/settings/price-list.ts';

/** `$jsonSchema` of an amount in cents: a number from 0 to {@link MAX_PRICE_CENTS} (the application checks it is an integer). */
const CENTS = Object.freeze({ bsonType: 'number', minimum: 0, maximum: MAX_PRICE_CENTS });

/**
 * The prices of the plans: at most `max` entries, each key a plan key (`^[A-Za-z0-9_-]{1,30}$`).
 *
 * @param max Most plans: {@link MAX_PLANS} for a price list or the overrides of a dealer, twice that for the effective list of a dealer (the plans of both).
 */
export function planPricesSchema(max: number): Readonly<Record<string, unknown>> {
  return Object.freeze({ bsonType: 'object', maxProperties: max, patternProperties: Object.freeze({ '^[A-Za-z0-9_-]{1,30}$': CENTS }), additionalProperties: false });
}

/** The prices of the services: the closed list of {@link SERVICE_KEYS}. */
export const SERVICE_PRICES_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  properties: Object.freeze(Object.fromEntries(SERVICE_KEYS.map((key) => [key, CENTS]))),
});

/**
 * The complete price list: every service has a price.
 *
 * @param maxPlans Most plans, see {@link planPricesSchema}.
 */
export function priceListSchema(maxPlans: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    bsonType: 'object',
    required: ['plans', 'services'],
    additionalProperties: false,
    properties: Object.freeze({ plans: planPricesSchema(maxPlans), services: Object.freeze({ ...SERVICE_PRICES_SCHEMA, required: [...SERVICE_KEYS] }) }),
  });
}

/** The price overrides of a dealer: partial, every part optional. */
export const PRICE_OVERRIDES_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  properties: Object.freeze({ plans: planPricesSchema(MAX_PLANS), services: SERVICE_PRICES_SCHEMA }),
});
