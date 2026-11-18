import type { IndexSpec } from './collections.ts';
import { MAX_PLANS } from '../modules/settings/price-list.ts';
import { priceListSchema } from './price-schema.ts';

/** Most lines one closure document holds: the document stays far below the 16 MB limit of MongoDB. */
export const MAX_CLOSURE_LINES = 5000;

/** Indexes of `common.billingClosures`: one document per kind, period and dealer (`dealerId` is `null` for the dealer-less groups). */
export const BILLING_CLOSURES_INDEXES: readonly IndexSpec[] = Object.freeze([{ name: 'kind_1_period_1_dealerId_1', key: { kind: 1, period: 1, dealerId: 1 }, unique: true }]);

const COUNT = Object.freeze({ bsonType: 'number', minimum: 0 });

/** One fee item of a line: `{ key, quantity, unitCents, amountCents }`, the unit price `null` for a plan without a price. */
const ITEM_SCHEMA = Object.freeze({
  bsonType: 'object',
  required: ['key', 'quantity', 'unitCents', 'amountCents'],
  additionalProperties: false,
  properties: Object.freeze({ key: { bsonType: 'string', maxLength: 80 }, quantity: COUNT, unitCents: { bsonType: ['number', 'null'], minimum: 0 }, amountCents: COUNT, providers: { bsonType: 'array', maxItems: 20, items: { bsonType: 'string', maxLength: 40 } } }),
});

/** One line of a statement: a place with its monthly fee, the months charged and the amount. */
const LINE_SCHEMA = Object.freeze({
  bsonType: 'object',
  required: ['groupId', 'groupName', 'companyId', 'companyName', 'placeId', 'placeName', 'activatedAt', 'plan', 'items', 'monthlyCents', 'months', 'amountCents', 'flags'],
  additionalProperties: false,
  properties: Object.freeze({
    groupId: { bsonType: 'objectId' },
    groupName: { bsonType: 'string' },
    companyId: { bsonType: 'objectId' },
    companyName: { bsonType: 'string' },
    placeId: { bsonType: 'objectId' },
    placeName: { bsonType: 'string' },
    activatedAt: { bsonType: 'date' },
    plan: { bsonType: ['string', 'null'] },
    items: { bsonType: 'array', maxItems: 20, items: ITEM_SCHEMA },
    monthlyCents: COUNT,
    months: COUNT,
    amountCents: COUNT,
    // Optional: the closures made before the devices were stored have none.
    devices: { bsonType: 'object', required: ['desks', 'kiosks', 'handhelds'], additionalProperties: false, properties: { desks: COUNT, kiosks: COUNT, handhelds: COUNT } },
    flags: { bsonType: 'array', maxItems: 10, items: { enum: ['unpricedPlan', 'activationDateFromId', 'expired', 'groupSuspended', 'companyDisabled'] } },
  }),
});

const LINES = Object.freeze({ bsonType: 'array', maxItems: MAX_CLOSURE_LINES, items: LINE_SCHEMA });

const ACTIVATION_TOTALS = Object.freeze({
  bsonType: 'object',
  required: ['places', 'monthlyCents', 'amountCents', 'projection12Cents', 'anomalies'],
  additionalProperties: false,
  properties: Object.freeze({ places: COUNT, monthlyCents: COUNT, amountCents: COUNT, projection12Cents: COUNT, anomalies: COUNT }),
});

const RENEWAL_TOTALS = Object.freeze({
  bsonType: 'object',
  required: ['places', 'annualCents', 'instalmentCents', 'anomalies'],
  additionalProperties: false,
  properties: Object.freeze({ places: COUNT, annualCents: COUNT, instalmentCents: COUNT, anomalies: COUNT }),
});

/**
 * `$jsonSchema` of `common.billingClosures`, one document per closure and dealer: a `renewalBase` (period `YYYY`) freezes the park of the dealer at the end of the previous year with the lines of the renewals; a
 * `month` (period `YYYY-MM`, the invoice month) freezes the lines of the activations of the month before and only the totals of the renewals. `prices` is the effective price list applied.
 */
export const BILLING_CLOSURES_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['kind', 'period', 'dealerId', 'dealerName', 'prices', 'activations', 'renewals', 'closedAt', 'closedBy'],
  additionalProperties: false,
  properties: Object.freeze({
    _id: { bsonType: 'objectId' },
    kind: { enum: ['renewalBase', 'month'] },
    period: { bsonType: 'string', pattern: '^[0-9]{4}(-[0-9]{2})?$' },
    dealerId: { bsonType: ['objectId', 'null'] },
    dealerName: { bsonType: 'string', maxLength: 200 },
    // The effective list of a dealer: the plans of the price list and the ones of its overrides.
    prices: priceListSchema(2 * MAX_PLANS),
    activations: Object.freeze({ bsonType: 'object', required: ['lines', 'totals'], additionalProperties: false, properties: Object.freeze({ lines: LINES, totals: ACTIVATION_TOTALS }) }),
    renewals: Object.freeze({ bsonType: 'object', required: ['totals'], additionalProperties: false, properties: Object.freeze({ lines: LINES, totals: RENEWAL_TOTALS }) }),
    closedAt: { bsonType: 'date' },
    closedBy: { bsonType: 'objectId' },
  }),
});
