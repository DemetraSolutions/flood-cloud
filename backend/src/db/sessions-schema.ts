import type { IndexSpec } from './collections.ts';

/** Hashes kept in `previousRefreshHashes` to detect the reuse of a rotated refresh token. */
export const MAX_PREVIOUS_REFRESH_HASHES = 50;

/** Indexes of `common.sessions`: unique token hashes, reuse detection, per-user listing and the TTL. */
export const SESSIONS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'accessTokenHash_1', key: { accessTokenHash: 1 }, unique: true },
  { name: 'refreshTokenHash_1', key: { refreshTokenHash: 1 }, unique: true },
  { name: 'previousRefreshHashes_1', key: { previousRefreshHashes: 1 } },
  { name: 'userId_1_revokedAt_1', key: { userId: 1, revokedAt: 1 } },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);
