import type { IndexSpec } from './collections.ts';

/** Days a revoked store key is kept for the support (the same retention as the `security` events of the activity log). */
export const REVOKED_STORE_KEY_RETENTION_DAYS = 365;

/** Indexes of `common.storeActivationCodes`: the unique hash (the lookup of an exchange), one pending code per place, and the TTL (which only cleans: the expiry is checked in every query). */
export const STORE_ACTIVATION_CODES_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'codeHash_1', key: { codeHash: 1 }, unique: true },
  { name: 'placeId_1', key: { placeId: 1 }, unique: true },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

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
