import type { IndexSpec } from './collections.ts';

/** Days a daily usage row is kept before the TTL index removes it. */
export const API_USAGE_RETENTION_DAYS = 400;

/** Indexes of `common.apiKeys`: the unique hash (the lookup of every request) and the keys of a group, newest first (the list and the count of the active ones). */
export const API_KEYS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'hash_1', key: { hash: 1 }, unique: true },
  { name: 'groupId_1_createdAt_-1', key: { groupId: 1, createdAt: -1 } },
]);

/** Indexes of `common.apiUsage`: one row per key, day and route (the target of the `$inc` upserts) and the TTL on `expireAt`. */
export const API_USAGE_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'keyId_1_day_1_route_1', key: { keyId: 1, day: 1, route: 1 }, unique: true },
  { name: 'expireAt_1', key: { expireAt: 1 }, expireAfterSeconds: 0 },
]);
