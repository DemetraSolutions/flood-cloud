/**
 * `$jsonSchema` of `common.userCredentials` (`doc/Tasks.md` 3.1.4): one document per user, keyed by
 * the user id. Only `failedLogins`, `createdAt` and `updatedAt` are always there: a user who has
 * only ever failed a login with a legacy password has no hash yet.
 */
export const USER_CREDENTIALS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['failedLogins', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    passwordHash: { bsonType: 'string', minLength: 1, maxLength: 512 },
    legacyHashFingerprint: { bsonType: ['string', 'null'], maxLength: 128 },
    passwordChangedAt: { bsonType: 'date' },
    failedLogins: { bsonType: ['int', 'long'], minimum: 0 },
    lockedUntil: { bsonType: ['date', 'null'] },
    lastLoginAt: { bsonType: 'date' },
    createdAt: { bsonType: 'date' },
    updatedAt: { bsonType: 'date' },
  },
});
