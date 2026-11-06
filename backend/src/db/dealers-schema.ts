import type { IndexSpec } from './collections.ts';

/**
 * Indexes of `common.dealers` (`doc/Tasks.md` D-09): a VAT number identifies one dealer, so it is unique
 * among the documents that have one. The index is partial (`vatNumber` is a string) because most dealers
 * start without a VAT number, and many documents may hold `null`.
 */
export const DEALERS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'vatNumber_1', key: { vatNumber: 1 }, unique: true, partialFilterExpression: Object.freeze({ vatNumber: Object.freeze({ $type: 'string' }) }) },
]);

/**
 * `$jsonSchema` of `common.dealers`: the registry of a dealer's company data. `_id` is the id of the dealer's
 * user (role `D`), so `groups.dealerId` keeps pointing at the same value. The country-dependent rules (the
 * Italian VAT number, fiscal code and province) are checked by the service, which sees the whole document.
 */
export const DEALERS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['businessName', 'vatNumber', 'fiscalCode', 'address', 'pec', 'sdiCode', 'email', 'phone', 'createdAt', 'updatedAt', 'createdBy', 'source'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    businessName: { bsonType: 'string', minLength: 1, maxLength: 200 },
    vatNumber: { bsonType: ['string', 'null'], maxLength: 30 },
    fiscalCode: { bsonType: ['string', 'null'], maxLength: 30 },
    address: {
      bsonType: ['object', 'null'],
      required: ['street', 'postcode', 'city', 'province', 'countryCode'],
      additionalProperties: false,
      properties: {
        street: { bsonType: 'string', minLength: 1, maxLength: 200 },
        postcode: { bsonType: 'string', minLength: 1, maxLength: 16 },
        city: { bsonType: 'string', minLength: 1, maxLength: 100 },
        province: { bsonType: ['string', 'null'], maxLength: 8 },
        countryCode: { bsonType: 'string', minLength: 2, maxLength: 2 },
      },
    },
    pec: { bsonType: ['string', 'null'], maxLength: 254 },
    sdiCode: { bsonType: ['string', 'null'], maxLength: 7 },
    email: { bsonType: ['string', 'null'], maxLength: 254 },
    phone: { bsonType: ['string', 'null'], maxLength: 32 },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
    createdBy: { bsonType: ['objectId', 'null'] },
    source: { enum: ['manual', 'migration', 'user'] },
  },
});
