import { PUBLIC_PERMISSIONS } from '../shared/security/rbac/public-permissions.ts';
import type { IndexSpec } from './collections.ts';

const SHA256_HEX = '^[0-9a-f]{64}$';

/** Days a daily usage row is kept before the TTL index removes it. */
export const API_USAGE_RETENTION_DAYS = 400;

/** Roles that create, change and revoke public API keys (`doc/Security-Model.md` section 6): only the PSA and the dealers. */
const ISSUER_ROLES = ['PSA', 'D'];

/** The restriction of a key to some companies or places: a list of ids, or `null` for no restriction. */
const ID_LIST = { bsonType: ['array', 'null'], maxItems: 100, items: { bsonType: 'objectId' } } as const;

/**
 * `$jsonSchema` of `common.apiKeys` (`doc/Security-Model.md` section 6): one document per public API key of a group. Only the SHA-256 of the key is stored (plus its first twelve
 * characters to recognize it), never the key. A revoked key stays for its history; there is no hard delete.
 */
export const API_KEYS_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['groupId', 'name', 'prefix', 'hash', 'permissions', 'restrictions', 'rateLimitPerMinute', 'dailyQuota', 'expiresAt', 'status', 'revokedAt', 'revokedBy', 'createdAt', 'createdBy', 'lastUsedAt'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    groupId: { bsonType: 'objectId' },
    name: { bsonType: 'string', minLength: 1, maxLength: 100 },
    prefix: { bsonType: 'string', minLength: 12, maxLength: 12 },
    hash: { bsonType: 'string', pattern: SHA256_HEX },
    permissions: { bsonType: 'array', minItems: 1, maxItems: PUBLIC_PERMISSIONS.length, items: { enum: [...PUBLIC_PERMISSIONS] } },
    restrictions: {
      bsonType: 'object',
      required: ['companyIds', 'placeIds'],
      additionalProperties: false,
      properties: { companyIds: ID_LIST, placeIds: ID_LIST },
    },
    rateLimitPerMinute: { bsonType: ['int', 'long', 'double'], minimum: 1, maximum: 6000 },
    dailyQuota: { bsonType: ['int', 'long', 'double'], minimum: 1, maximum: 10_000_000 },
    expiresAt: { bsonType: ['date', 'null'] },
    status: { enum: ['active', 'revoked'] },
    revokedAt: { bsonType: ['date', 'null'] },
    revokedBy: {
      bsonType: ['object', 'null'],
      required: ['userId', 'role'],
      additionalProperties: false,
      properties: { userId: { bsonType: 'objectId' }, role: { enum: ISSUER_ROLES } },
    },
    createdAt: { bsonType: 'date' },
    createdBy: {
      bsonType: 'object',
      required: ['userId', 'role'],
      additionalProperties: false,
      properties: { userId: { bsonType: 'objectId' }, role: { enum: ISSUER_ROLES } },
    },
    lastUsedAt: { bsonType: ['date', 'null'] },
  },
});

/** Indexes of `common.apiKeys`: the unique hash (the lookup of every request) and the keys of a group, newest first (the list and the count of the active ones). */
export const API_KEYS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'hash_1', key: { hash: 1 }, unique: true },
  { name: 'groupId_1_createdAt_-1', key: { groupId: 1, createdAt: -1 } },
]);

/**
 * `$jsonSchema` of `common.apiUsage` (`doc/Security-Model.md` section 7): the use of a key on one UTC day and one route (`<METHOD> <route pattern>`), written in blocks by the metering and read by the
 * consultation of the key. `expireAt` is the end of the retention.
 */
export const API_USAGE_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['keyId', 'groupId', 'day', 'route', 'calls', 'errors4xx', 'errors5xx', 'rateLimited', 'aborted', 'expireAt'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    keyId: { bsonType: 'objectId' },
    groupId: { bsonType: 'objectId' },
    day: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    route: { bsonType: 'string', minLength: 1, maxLength: 200 },
    calls: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    errors4xx: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    errors5xx: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    rateLimited: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    aborted: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    expireAt: { bsonType: 'date' },
  },
});

/** Indexes of `common.apiUsage`: one row per key, day and route (the target of the `$inc` upserts) and the TTL on `expireAt`. */
export const API_USAGE_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'keyId_1_day_1_route_1', key: { keyId: 1, day: 1, route: 1 }, unique: true },
  { name: 'expireAt_1', key: { expireAt: 1 }, expireAfterSeconds: 0 },
]);
