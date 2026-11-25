import { MongoBulkWriteError } from 'mongodb';
import type { Collection, Document, ObjectId } from 'mongodb';
import { API_USAGE_RETENTION_DAYS } from '../../db/api-keys-schema.ts';
import type { Databases } from '../../db/databases.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { LIST_MAX_TIME_MS, listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListParams } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { MirrorCollection } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { API_KEYS_LIST } from './api-keys.list.ts';
import { API_KEY_PROJECTION, fromDocument, toUsageRow } from './api-keys.mapper.ts';
import { PUBLIC_API_MAX_DAILY_QUOTA, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE, PUBLIC_API_MIN_LIMIT } from '../../shared/security/public-api-limits.ts';
import type { PublicApiLimits } from '../../shared/security/public-api-limits.ts';
import { BUILT_IN_PUBLIC_API_LIMITS } from '../groups/group.mapper.ts';
import type { ApiKey, KeyManager, PublicGroupState, UsageIncrement, UsageRow, UsageWriteResult } from './api-keys.types.ts';

const DAY_MS = 86_400_000;

/** Most usage rows one consultation reads: 92 days of at most a few dozen routes, with a wide margin. */
export const MAX_USAGE_ROWS = 20_000;

/** A key to insert: the whole document, built by the service (the hash of the secret, never the secret). */
export type NewApiKey = Omit<ApiKey, 'id'>;

/** A page of keys. */
export interface ApiKeyPage {
  readonly keys: readonly ApiKey[];
  readonly page: PageInfo;
}

/** Reads and writes `common.apiKeys` and `common.apiUsage` (`doc/Security-Model.md` sections 6 and 7). */
export interface ApiKeysRepository {
  /**
   * Inserts a key.
   *
   * @param key The key, without its id.
   * @returns The key as stored, with its id.
   */
  insert(key: NewApiKey): Promise<ApiKey>;
  /**
   * Finds a key by the SHA-256 of its secret, hash included: the lookup of the authentication.
   *
   * @param hash SHA-256 of the key, lower case hexadecimal.
   * @returns The key, or `null` when none has this hash.
   */
  findByHash(hash: string): Promise<ApiKey | null>;
  /**
   * Finds a key of a group, whatever its status. The hash is not read.
   *
   * @param groupId Id of the group (from a verified access).
   * @param keyId Id of the key.
   * @returns The key, or `null` when the group has none with this id.
   */
  findInGroup(groupId: ObjectId, keyId: ObjectId): Promise<ApiKey | null>;
  /**
   * Reads a page of the keys of a group, newest first. The hash is not read.
   *
   * @param groupId Id of the group (from a verified access).
   * @param params Validated list parameters.
   * @param status Only the keys in this status, or `null` for all of them.
   */
  list(groupId: ObjectId, params: ListParams, status: ApiKey['status'] | null): Promise<ApiKeyPage>;
  /**
   * Counts the keys of a group that still work: not revoked and not expired.
   *
   * @param groupId Id of the group (from a verified access).
   * @param now The current time, to tell the keys that expired.
   */
  countActive(groupId: ObjectId, now: Date): Promise<number>;
  /**
   * Changes an active key (`$set` of the given fields). A revoked key, or one that has expired, is never changed.
   *
   * @param groupId Id of the group (from a verified access).
   * @param keyId Id of the key.
   * @param fields The fields to set, each one an owned field of the key.
   * @param now The current time, to tell a key that expired.
   * @returns The key as it is now, or `null` when the group has no key with this id that is active and not expired.
   */
  updateActive(groupId: ObjectId, keyId: ObjectId, fields: Readonly<Record<string, unknown>>, now: Date): Promise<ApiKey | null>;
  /**
   * Revokes an active key with one conditional write, so it is recorded once.
   *
   * @param groupId Id of the group (from a verified access).
   * @param keyId Id of the key.
   * @param revocation When and by whom.
   * @returns The key as it is now, or `null` when the group has none with this id; `changed` is `false` when it was already revoked.
   */
  revoke(groupId: ObjectId, keyId: ObjectId, revocation: { readonly at: Date; readonly by: KeyManager }): Promise<{ readonly key: ApiKey; readonly changed: boolean } | null>;
  /**
   * Records that a key was used, at most once in a window: nothing is written when the last use is newer than `olderThan` (the condition is in the write, so it holds across instances).
   *
   * @param keyId Id of the key.
   * @param at The use.
   * @param olderThan The last use must be at or before this instant (or never) for the write to happen.
   */
  touch(keyId: ObjectId, at: Date, olderThan: Date): Promise<void>;
  /**
   * What the group says about its public API: its name, whether its keys may work (active, not in the trash, switch on) and the cap of all its keys together (a stored value that is not valid, or none, is the platform default).
   *
   * @param groupId Id of the group of a stored key.
   * @returns The state, or `null` when the group does not exist.
   */
  groupState(groupId: ObjectId): Promise<PublicGroupState | null>;
  /**
   * Tells which of the companies or places of a request do not exist in the group (or are in the trash): the restrictions of a key must name real ones.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param collection `companies` or `places`.
   * @param ids The ids to check, at most a hundred.
   * @returns The positions, in the list, of the ids that are missing.
   */
  missing(principal: AuthPrincipal, access: GroupAccess, collection: MirrorCollection, ids: readonly ObjectId[]): Promise<Set<number>>;
  /**
   * Adds the counters of the metering to the rows of key, day and route (`$inc` with upsert, in one unordered write).
   *
   * @param rows What to add.
   * @returns The rows the database refused, with their codes, and whether the write was left unacknowledged (see {@link UsageWriteResult}). A failure of the whole write rejects.
   */
  addUsage(rows: readonly UsageIncrement[]): Promise<UsageWriteResult>;
  /**
   * Reads the usage of a key in a range of days, by day and route.
   *
   * @param groupId Id of the group (from a verified access).
   * @param keyId Id of the key.
   * @param from First day, `YYYY-MM-DD`.
   * @param to Last day, `YYYY-MM-DD`.
   */
  usage(groupId: ObjectId, keyId: ObjectId, from: string, to: string): Promise<UsageRow[]>;
  /**
   * Counts the keys of a group and their usage rows. Read only; used by the audit of the purge of trashed groups.
   *
   * @param groupId Id of the group.
   */
  countOfGroup(groupId: ObjectId): Promise<GroupPurgeCounts>;
  /**
   * Deletes for good every key of a group and every usage row of those keys, in batches. The usage rows go first, so a run that fails halfway can be repeated and never leaves rows
   * that no key points to. Used only by the purge of trashed groups; the API never deletes a key.
   *
   * @param groupId Id of the group.
   * @returns How many documents were deleted from each collection.
   */
  deleteAllOfGroup(groupId: ObjectId): Promise<GroupPurgeCounts>;
}

/** How many keys and usage rows of a group a purge counts or deletes. */
export interface GroupPurgeCounts {
  readonly keys: number;
  readonly usageRows: number;
}

/** Keys handled by each step of the purge of a group. */
const PURGE_BATCH = 100;

/**
 * Builds the repository of the public API keys over the common database.
 *
 * @param databases Database accessor.
 * @param defaults The platform defaults of the limits, for a group that has none of its own.
 */
/**
 * The names of some public API keys of a group, by hexadecimal id, revoked and expired keys included (the history of a loyalty card names the key that moved a credit long after it was revoked). Only the name is read, never the hash.
 *
 * @param databases Database accessor.
 * @param groupId The group of the verified access: a key of another group is never named.
 * @param ids The keys to name (at most as many as the movements of one page).
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
 */
export async function apiKeyNames(databases: Databases, groupId: ObjectId, ids: readonly ObjectId[]): Promise<Map<string, string | null>> {
  const found = await bounded(() => databases.common().collection('apiKeys').find({ _id: { $in: [...ids] }, groupId }, { projection: { name: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
  return new Map(found.map((key) => [(key['_id'] as ObjectId).toHexString(), typeof key['name'] === 'string' ? key['name'] : null]));
}

export function createApiKeysRepository(databases: Databases, defaults: PublicApiLimits = BUILT_IN_PUBLIC_API_LIMITS): ApiKeysRepository {
  const keys = (): Collection<Document> => databases.common().collection('apiKeys');
  const usage = (): Collection<Document> => databases.common().collection('apiUsage');
  const keyIdsOfGroup = async (groupId: ObjectId, after: ObjectId | null): Promise<ObjectId[]> =>
    (await keys().find({ groupId, ...(after === null ? {} : { _id: { $gt: after } }) }, { projection: { _id: 1 }, sort: { _id: 1 }, limit: PURGE_BATCH, maxTimeMS: LIST_MAX_TIME_MS }).toArray()).map((document) => document._id);
  return {
    insert: async (key) => {
      const { hash, ...rest } = key;
      const result = await keys().insertOne({ ...rest, groupId: key.groupId, hash });
      return { ...key, id: result.insertedId };
    },

    findByHash: async (hash) => {
      const document = await keys().findOne({ hash }, { maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : fromDocument(document);
    },

    findInGroup: async (groupId, keyId) => {
      const document = await keys().findOne({ _id: keyId, groupId }, { projection: API_KEY_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : fromDocument(document);
    },

    list: async (groupId, params, status) => {
      const match = { groupId, ...(status === null ? {} : { status }) };
      const documents = await keys().aggregate(listPipeline(match, params, API_KEYS_LIST, API_KEY_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
      const { items, page } = pageOf(documents, params);
      return { keys: items.map(fromDocument), page };
    },

    countActive: (groupId, now) => keys().countDocuments({ groupId, status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { maxTimeMS: LIST_MAX_TIME_MS }),

    updateActive: async (groupId, keyId, fields, now) => {
      const document = await keys().findOneAndUpdate({ _id: keyId, groupId, status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }, { $set: { ...fields } }, { returnDocument: 'after', projection: API_KEY_PROJECTION });
      return document === null ? null : fromDocument(document);
    },

    revoke: async (groupId, keyId, revocation) => {
      const revoked = await keys().findOneAndUpdate(
        { _id: keyId, groupId, status: 'active' },
        { $set: { status: 'revoked', revokedAt: revocation.at, revokedBy: revocation.by } },
        { returnDocument: 'after', projection: API_KEY_PROJECTION },
      );
      if (revoked !== null) {
        return { key: fromDocument(revoked), changed: true };
      }
      const existing = await keys().findOne({ _id: keyId, groupId }, { projection: API_KEY_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS });
      return existing === null ? null : { key: fromDocument(existing), changed: false };
    },

    touch: async (keyId, at, olderThan) => {
      await keys().updateOne({ _id: keyId, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: olderThan } }] }, { $set: { lastUsedAt: at } });
    },

    groupState: async (groupId) => {
      const group = await databases
        .common()
        .collection('groups')
        .findOne({ _id: groupId }, { projection: { name: 1, status: 1, trash: 1, 'publicApi.enabled': 1, 'publicApi.groupRateLimitPerMinute': 1, 'publicApi.groupDailyQuota': 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      if (group === null) {
        return null;
      }
      const publicApi = group['publicApi'] as { enabled?: unknown; groupRateLimitPerMinute?: unknown; groupDailyQuota?: unknown } | null | undefined;
      const limit = (value: unknown, max: number, fallback: number): number => (typeof value === 'number' && Number.isInteger(value) && value >= PUBLIC_API_MIN_LIMIT && value <= max ? value : fallback);
      return {
        name: typeof group['name'] === 'string' ? group['name'] : '',
        usable: group['status'] === true && group['trash'] !== true && typeof publicApi === 'object' && publicApi !== null && publicApi.enabled === true,
        groupRateLimitPerMinute: limit(publicApi?.groupRateLimitPerMinute, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE, defaults.groupRateLimitPerMinute),
        groupDailyQuota: limit(publicApi?.groupDailyQuota, PUBLIC_API_MAX_DAILY_QUOTA, defaults.groupDailyQuota),
      };
    },

    missing: async (principal, access, collection, ids) => {
      const found = await groupMirror(principal, access, databases, collection).find({ _id: { $in: [...ids] }, trash: { $ne: true } }, { projection: { _id: 1 }, limit: ids.length });
      const present = new Set(found.map((document) => (document['_id'] as ObjectId).toHexString()));
      return new Set(ids.flatMap((id, index) => (present.has(id.toHexString()) ? [] : [index])));
    },

    addUsage: async (rows) => {
      if (rows.length === 0) {
        return { failed: [], unacknowledged: false };
      }
      try {
        await usage().bulkWrite(
          rows.map((row) => ({
            updateOne: {
              filter: { keyId: row.keyId, day: row.day, route: row.route },
              update: {
                $inc: { calls: row.calls, errors4xx: row.errors4xx, errors5xx: row.errors5xx, rateLimited: row.rateLimited, aborted: row.aborted },
                $setOnInsert: { groupId: row.groupId, expireAt: new Date(Date.parse(`${row.day}T00:00:00.000Z`) + (API_USAGE_RETENTION_DAYS + 1) * DAY_MS) },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
        return { failed: [], unacknowledged: false };
      } catch (error) {
        if (!(error instanceof MongoBulkWriteError)) {
          throw error;
        }
        // An unordered write applies every row it can: only the rows that failed are given back (with their codes), so a retry never counts a row twice. A write concern error means the
        // rows were applied without the confirmation asked: they are not given back.
        return {
          failed: [error.writeErrors].flat().map((writeError) => ({ row: rows[writeError.index]!, code: writeError.code })),
          unacknowledged: error.writeConcernError !== undefined,
        };
      }
    },

    usage: async (groupId, keyId, from, to) => {
      const documents = await usage()
        .find({ keyId, groupId, day: { $gte: from, $lte: to } }, { projection: { day: 1, route: 1, calls: 1, errors4xx: 1, errors5xx: 1, rateLimited: 1, aborted: 1 }, sort: { day: 1, route: 1 }, limit: MAX_USAGE_ROWS, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return documents.map(toUsageRow);
    },

    countOfGroup: async (groupId) => {
      let counts: GroupPurgeCounts = { keys: 0, usageRows: 0 };
      for (let ids = await keyIdsOfGroup(groupId, null); ids.length > 0; ids = await keyIdsOfGroup(groupId, ids[ids.length - 1] as ObjectId)) {
        const rows = await usage().countDocuments({ keyId: { $in: ids }, groupId }, { maxTimeMS: LIST_MAX_TIME_MS });
        counts = { keys: counts.keys + ids.length, usageRows: counts.usageRows + rows };
      }
      return counts;
    },

    deleteAllOfGroup: async (groupId) => {
      let counts: GroupPurgeCounts = { keys: 0, usageRows: 0 };
      // Nothing is skipped by a cursor here: each pass deletes what it read, so the next pass reads the next keys.
      for (let ids = await keyIdsOfGroup(groupId, null); ids.length > 0; ids = await keyIdsOfGroup(groupId, null)) {
        const rows = await usage().deleteMany({ keyId: { $in: ids }, groupId });
        const removed = await keys().deleteMany({ _id: { $in: ids }, groupId });
        counts = { keys: counts.keys + removed.deletedCount, usageRows: counts.usageRows + rows.deletedCount };
      }
      return counts;
    },
  };
}
