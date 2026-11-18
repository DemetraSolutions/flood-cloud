import type { IndexSpec } from './collections.ts';
import { MAX_PLANS } from '../modules/settings/price-list.ts';
import { priceListSchema } from './price-schema.ts';

/** Indexes of `common.settings`: one document per key. */
export const SETTINGS_INDEXES: readonly IndexSpec[] = Object.freeze([{ name: 'key_1', key: { key: 1 }, unique: true }]);

/**
 * `$jsonSchema` of `common.settings`: the settings of the platform, one document per key (`{ _id, key, value, updatedAt, updatedBy }`). The keys are `PRICE_LIST`, the monthly prices of the plans and of the
 * services, and `BILLING_LOCK:<year>`, the lock document of the billing of a year; a new key needs its own entry here.
 */
export const SETTINGS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['key', 'value', 'updatedAt', 'updatedBy'],
  additionalProperties: false,
  properties: Object.freeze({
    _id: { bsonType: 'objectId' },
    // `PRICE_LIST`, or the lock of the billing of a year (`BILLING_LOCK:2026`).
    key: { bsonType: 'string', pattern: '^(PRICE_LIST|BILLING_LOCK:[0-9]{4})$' },
    value: {
      anyOf: [
        priceListSchema(MAX_PLANS),
        // The lock of a year: a counter that every freeze, unfreeze, close and reopen of the year increments, so that two of them at once conflict.
        { bsonType: 'object', required: ['counter'], additionalProperties: false, properties: { counter: { bsonType: 'number', minimum: 1 } } },
      ],
    },
    updatedAt: { bsonType: 'date' },
    updatedBy: { bsonType: 'objectId' },
  }),
});
