import type { IndexSpec } from './collections.ts';

const SHA256_HEX = '^[0-9a-f]{64}$';

/** Days a revoked store key is kept for the support (the same retention as the `security` events of the activity log). */
export const REVOKED_STORE_KEY_RETENTION_DAYS = 365;

/** Roles that issue activation codes: only the PSA and the dealers manage a store key (D-24). */
const ISSUER_ROLES = ['PSA', 'D'];

/** Who generated the activation code, as stored on a code and on the key activated with it. */
const ISSUER = {
  bsonType: 'object',
  required: ['userId', 'role'],
  additionalProperties: false,
  properties: { userId: { bsonType: 'objectId' }, role: { enum: ISSUER_ROLES } },
} as const;

/**
 * `$jsonSchema` of `common.storeActivationCodes` (`doc/Security-Model.md` section 5): one document per pending activation code, at most one per place. Only the SHA-256 of the
 * code is stored, never the code. `companyId` is informative: the company is read again from the place on every request.
 */
export const STORE_ACTIVATION_CODES_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['groupId', 'companyId', 'placeId', 'codeHash', 'createdBy', 'createdAt', 'expiresAt'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    groupId: { bsonType: 'objectId' },
    companyId: { bsonType: 'objectId' },
    placeId: { bsonType: 'objectId' },
    codeHash: { bsonType: 'string', pattern: SHA256_HEX },
    createdBy: ISSUER,
    createdAt: { bsonType: 'date' },
    expiresAt: { bsonType: 'date' },
  },
});

/** Indexes of `common.storeActivationCodes`: the unique hash (the lookup of an exchange), one pending code per place, and the TTL (which only cleans: the expiry is checked in every query). */
export const STORE_ACTIVATION_CODES_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'codeHash_1', key: { codeHash: 1 }, unique: true },
  { name: 'placeId_1', key: { placeId: 1 }, unique: true },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

const INSTALLATION_TEXT = { bsonType: ['string', 'null'], maxLength: 200 } as const;

/**
 * `$jsonSchema` of `common.storeKeys` (`doc/Security-Model.md` section 5): one document per store key of a place, at most one active. Only the SHA-256 of the key is stored (plus its first
 * four characters to recognize it), never the key. There is no `companyId`: a place can change company, so the company is read from the place on every request. `purgeAt` exists only on the revoked ones.
 */
export const STORE_KEYS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['groupId', 'placeId', 'keyHash', 'keyHint', 'status', 'activatedAt', 'activatedBy', 'installation', 'activationIp', 'lastSeenAt', 'lastSeenIp', 'lastSeenUserAgent', 'revokedAt', 'revokedBy', 'revokeReason'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    groupId: { bsonType: 'objectId' },
    placeId: { bsonType: 'objectId' },
    keyHash: { bsonType: 'string', pattern: SHA256_HEX },
    keyHint: { bsonType: 'string', minLength: 4, maxLength: 4 },
    status: { enum: ['active', 'revoked'] },
    activatedAt: { bsonType: 'date' },
    activatedBy: ISSUER,
    installation: {
      bsonType: 'object',
      required: ['userAgent', 'appVersion', 'platform'],
      additionalProperties: false,
      properties: { userAgent: INSTALLATION_TEXT, appVersion: INSTALLATION_TEXT, platform: INSTALLATION_TEXT },
    },
    activationIp: { bsonType: ['string', 'null'], maxLength: 64 },
    lastSeenAt: { bsonType: 'date' },
    lastSeenIp: { bsonType: ['string', 'null'], maxLength: 64 },
    lastSeenUserAgent: INSTALLATION_TEXT,
    revokedAt: { bsonType: ['date', 'null'] },
    revokedBy: {
      bsonType: ['object', 'null'],
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { enum: ['user', 'system'] }, userId: { bsonType: 'objectId' }, role: { enum: ['PSA', 'D', 'SA', 'CA', 'PA', 'E'] } },
    },
    revokeReason: { enum: ['revoked', 'replaced', 'placeTrashed', 'placeDeleted', null] },
    purgeAt: { bsonType: 'date' },
  },
});

/**
 * Indexes of `common.storeKeys`: the unique hash (the lookup of every request), **one active key per place** (a unique partial index: the database guarantees it, not only the service), the history
 * of a place, and the TTL on `purgeAt` (the keys that are active have none and never expire).
 */
export const STORE_KEYS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'keyHash_1', key: { keyHash: 1 }, unique: true },
  { name: 'placeId_1_active', key: { placeId: 1 }, unique: true, partialFilterExpression: Object.freeze({ status: 'active' }) },
  { name: 'groupId_1_placeId_1_activatedAt_-1', key: { groupId: 1, placeId: 1, activatedAt: -1 } },
  { name: 'purgeAt_1', key: { purgeAt: 1 }, expireAfterSeconds: 0 },
]);
