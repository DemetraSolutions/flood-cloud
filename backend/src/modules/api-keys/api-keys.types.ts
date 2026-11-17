import type { ObjectId } from 'mongodb';
import type { PublicPermission } from '../../shared/security/rbac/public-permissions.ts';
import type { ApiKeyRestrictions } from '../../shared/security/scope/principal.ts';

/** Roles that create, change and revoke public API keys: the PSA and the dealers. */
export type KeyManagerRole = 'PSA' | 'D';

/** Who created or revoked a key. */
export interface KeyManager {
  readonly userId: ObjectId;
  readonly role: KeyManagerRole;
}

/** Whether a key still works: a revoked key stays in the list for its history and never works again. */
export type ApiKeyStatus = 'active' | 'revoked';

/** A public API key of a group, as stored in `common.apiKeys` (`doc/Security-Model.md` section 6). The secret itself is never stored: only its SHA-256 and its first characters. */
export interface ApiKey {
  readonly id: ObjectId;
  readonly groupId: ObjectId;
  readonly name: string;
  /** The first twelve characters of the key (`fc_pk_` and six more), which recognize it in a list. */
  readonly prefix: string;
  /** SHA-256 of the key (lower case hexadecimal): what authentication looks up. Never leaves the repository's readers of the authentication. */
  readonly hash: string;
  readonly permissions: readonly PublicPermission[];
  readonly restrictions: ApiKeyRestrictions;
  readonly rateLimitPerMinute: number;
  readonly dailyQuota: number;
  readonly expiresAt: Date | null;
  readonly status: ApiKeyStatus;
  readonly revokedAt: Date | null;
  readonly revokedBy: KeyManager | null;
  readonly createdAt: Date;
  readonly createdBy: KeyManager;
  readonly lastUsedAt: Date | null;
}

/** What the group says about its public API to the authentication of a key. */
export interface PublicGroupState {
  /** Name of the group, for `GET /public/v1/me`. */
  readonly name: string;
  /** `true` only when the group is active, not in the trash and has the public API switched on: otherwise no key of the group works. */
  readonly usable: boolean;
  /** Requests per minute all the keys of the group may make together. */
  readonly groupRateLimitPerMinute: number;
  /** Requests per UTC day all the keys of the group may make together. */
  readonly groupDailyQuota: number;
}

/** One row of the daily usage of a key: the calls of one UTC day to one route, as the consultation shows them. */
export interface UsageRow {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  /** `<METHOD> <route pattern>`, for example `GET /public/v1/places/:placeId`. */
  readonly route: string;
  readonly calls: number;
  /** Responses `4xx` other than `429`. */
  readonly errors4xx: number;
  /** Responses `5xx`. */
  readonly errors5xx: number;
  /** Responses `429` (rate limit or daily quota). */
  readonly rateLimited: number;
  /** Requests the client dropped before the response was complete. */
  readonly aborted: number;
}

/** What the metering adds to the row of a key, a day and a route. */
export interface UsageIncrement extends UsageRow {
  readonly keyId: ObjectId;
  readonly groupId: ObjectId;
}

/** The outcome of a block written by the metering. */
export interface UsageWriteResult {
  /** The rows the database refused, each with its error code (`undefined` when it has none): the rest of the block is written. */
  readonly failed: ReadonlyArray<{ readonly row: UsageIncrement; readonly code: number | undefined }>;
  /** `true` when the write was applied but the database did not confirm it at the level asked (a write concern error): the rows must not be written again. */
  readonly unacknowledged: boolean;
}
