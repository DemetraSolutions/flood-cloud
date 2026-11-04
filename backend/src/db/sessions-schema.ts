import type { IndexSpec } from './collections.ts';

/** Hashes kept in `previousRefreshHashes` to detect the reuse of a rotated refresh token. */
export const MAX_PREVIOUS_REFRESH_HASHES = 50;

const SHA256_HEX = '^[0-9a-f]{64}$';

/**
 * `$jsonSchema` of `common.sessions` (`doc/Tasks.md` 3.2.3): one document per session family. Only
 * hashes of the tokens are stored, never the tokens.
 */
export const SESSIONS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: [
    'userId',
    'accessTokenHash',
    'accessExpiresAt',
    'refreshTokenHash',
    'previousRefreshHashes',
    'refreshExpiresAt',
    'familyExpiresAt',
    'createdAt',
    'lastUsedAt',
    'rotatedAt',
    'userAgent',
    'ip',
    'revokedAt',
    'revokeReason',
    'expiresAt',
  ],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    userId: { bsonType: 'objectId' },
    accessTokenHash: { bsonType: 'string', pattern: SHA256_HEX },
    accessExpiresAt: { bsonType: 'date' },
    refreshTokenHash: { bsonType: 'string', pattern: SHA256_HEX },
    previousRefreshHashes: { bsonType: 'array', maxItems: MAX_PREVIOUS_REFRESH_HASHES, items: { bsonType: 'string', pattern: SHA256_HEX } },
    refreshExpiresAt: { bsonType: 'date' },
    familyExpiresAt: { bsonType: 'date' },
    createdAt: { bsonType: 'date' },
    lastUsedAt: { bsonType: 'date' },
    rotatedAt: { bsonType: ['date', 'null'] },
    userAgent: { bsonType: ['string', 'null'], maxLength: 256 },
    ip: { bsonType: ['string', 'null'], maxLength: 64 },
    revokedAt: { bsonType: ['date', 'null'] },
    revokeReason: { bsonType: ['string', 'null'], maxLength: 64 },
    expiresAt: { bsonType: 'date' },
  },
});

/** Indexes of `common.sessions`: unique token hashes, reuse detection, per-user listing and the TTL. */
export const SESSIONS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'accessTokenHash_1', key: { accessTokenHash: 1 }, unique: true },
  { name: 'refreshTokenHash_1', key: { refreshTokenHash: 1 }, unique: true },
  { name: 'previousRefreshHashes_1', key: { previousRefreshHashes: 1 } },
  { name: 'userId_1_revokedAt_1', key: { userId: 1, revokedAt: 1 } },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);
