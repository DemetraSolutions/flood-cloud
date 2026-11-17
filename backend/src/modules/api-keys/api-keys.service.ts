import type { ObjectId } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { generateSecret, hashSecret } from '../../shared/security/secrets.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ApiKeyRestrictions, AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { ManagedGroupsRepository } from '../groups/groups.repository.ts';
import { auditApiKey } from './api-keys.audit.ts';
import { API_KEYS_LIST } from './api-keys.list.ts';
import type { ApiKeyPage, ApiKeysRepository } from './api-keys.repository.ts';
import type { ApiKeysQuery, CreateApiKeyBody, PatchApiKeyBody, UsageQuery } from './api-keys.schemas.ts';
import type { ApiKey, KeyManager, UsageRow } from './api-keys.types.ts';

/** Most keys that work at the same time in a group. */
export const MAX_ACTIVE_KEYS = 50;

/** Longest life a key can be given: three years (366 days a year would be longer; the bound is the same for every key). */
export const MAX_KEY_LIFETIME_DAYS = 3 * 365;

/** Longest range, in days, the consultation of the usage answers. */
export const MAX_USAGE_DAYS = 92;

/** Days the consultation of the usage shows when the client names no range. */
export const DEFAULT_USAGE_DAYS = 30;

/** Characters of a key that are shown in a list: the prefix `fc_pk_` and six more. */
export const KEY_PREFIX_LENGTH = 12;

const DAY_MS = 86_400_000;

/** A created key with its secret, which is shown this once and never again. */
export interface CreatedApiKey {
  readonly key: ApiKey;
  readonly secret: string;
}

/** The totals of a range of usage. */
export interface UsageTotals {
  readonly calls: number;
  readonly errors4xx: number;
  readonly errors5xx: number;
  readonly rateLimited: number;
  readonly aborted: number;
}

/** The usage of a key in a range of days. */
export interface KeyUsage {
  readonly keyId: ObjectId;
  /** First day of the range, `YYYY-MM-DD`. */
  readonly from: string;
  /** Last day of the range, `YYYY-MM-DD`. */
  readonly to: string;
  readonly totals: UsageTotals;
  readonly rows: readonly UsageRow[];
}

/** The management of the public API keys of a group, for the PSA and the dealers (`doc/Security-Model.md` section 6). */
export interface ApiKeysService {
  /**
   * Lists the keys of a group, newest first.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: ApiKeysQuery): Promise<ApiKeyPage>;
  /**
   * Reads one key of the group.
   *
   * @throws {AppError} `NOT_FOUND` when the group has no such key.
   */
  get(principal: AuthPrincipal, access: GroupAccess, keyId: ObjectId): Promise<ApiKey>;
  /**
   * Creates a key and records `apiKey.created`. The secret is generated here and returned once; only its hash is stored. Without limits in the body the key gets the ones of its group.
   *
   * @param principal The authenticated caller (a PSA or a dealer).
   * @param access Verified access to the group.
   * @param body Validated body.
   * @param client Request context.
   * @throws {AppError} `FORBIDDEN` (`notAllowed` on a limit) when a dealer sends limits; `VALIDATION_ERROR` for an expiry that is not in the future or is more than three years away, and for a restriction that names a company
   * or a place the group does not have (or twice the same one); `CONFLICT` when the group already has {@link MAX_ACTIVE_KEYS} keys that work.
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: CreateApiKeyBody, client: ClientContext): Promise<CreatedApiKey>;
  /**
   * Changes an active key (JSON Merge Patch) and records `apiKey.updated` with the names of the fields it changed; a request that changes nothing writes nothing.
   *
   * @throws {AppError} `VALIDATION_ERROR` for an empty body and for the same reasons as {@link ApiKeysService.create}; `FORBIDDEN` for limits from a dealer; `NOT_FOUND`; `CONFLICT` for a revoked key or one that has expired (an expired key is not revived).
   */
  update(principal: AuthPrincipal, access: GroupAccess, keyId: ObjectId, patch: PatchApiKeyBody, client: ClientContext): Promise<ApiKey>;
  /**
   * Revokes a key and records `apiKey.revoked`. Idempotent: a key that is already revoked is returned as it is, and nothing is recorded again.
   *
   * @throws {AppError} `NOT_FOUND` when the group has no such key.
   */
  revoke(principal: AuthPrincipal, access: GroupAccess, keyId: ObjectId, client: ClientContext): Promise<ApiKey>;
  /**
   * Reads the usage of a key in a range of days (the last 30 by default, at most 92).
   *
   * @throws {AppError} `NOT_FOUND`; `VALIDATION_ERROR` for a date that does not exist, a range that ends before it begins or is longer than 92 days.
   */
  usage(principal: AuthPrincipal, access: GroupAccess, keyId: ObjectId, query: UsageQuery): Promise<KeyUsage>;
}

/** Collaborators of {@link createApiKeysService}. */
export interface ApiKeysServiceDeps {
  readonly repository: ApiKeysRepository;
  /** The group, for the limits its new keys inherit. */
  readonly groups: Pick<ManagedGroupsRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

const LIMIT_FIELDS = ['rateLimitPerMinute', 'dailyQuota'] as const;

const sameIds = (left: readonly ObjectId[] | null, right: readonly ObjectId[] | null): boolean =>
  left === null || right === null ? left === right : left.length === right.length && left.every((id, index) => id.equals(right[index]!));

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((member) => right.includes(member));

/** The day of a date, `YYYY-MM-DD` (UTC). */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** A `YYYY-MM-DD` that is a real calendar date, as a date at midnight UTC; `null` for `2026-02-30`. */
function parseDay(text: string): Date | null {
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || dayOf(date) !== text ? null : date;
}

/**
 * Builds the service of the public API keys.
 *
 * @param deps Repository, group reader, activity log and clock.
 */
export function createApiKeysService(deps: ApiKeysServiceDeps): ApiKeysService {
  const { repository, groups, activityLog } = deps;
  const date = (): Date => new Date(deps.now());
  const managerOf = (principal: AuthPrincipal): KeyManager => ({ userId: principal.userId, role: principal.role as KeyManager['role'] });

  /** The limits are the PSA's: any other role that sends one is refused, per field. */
  const refuseLimits = (principal: AuthPrincipal, body: Readonly<Partial<Record<(typeof LIMIT_FIELDS)[number], number>>>): void => {
    const sent = LIMIT_FIELDS.filter((field) => body[field] !== undefined);
    if (principal.role !== 'PSA' && sent.length > 0) {
      throw new AppError('FORBIDDEN', { details: sent.map((field) => ({ field, issue: 'notAllowed' })) });
    }
  };

  /** The expiry of a key: in the future and within three years. */
  const checkExpiry = (expiresAt: Date | null | undefined): void => {
    if (expiresAt === null || expiresAt === undefined) {
      return;
    }
    const now = deps.now();
    if (expiresAt.getTime() <= now) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'expiresAt', issue: 'minimum' }] });
    }
    if (expiresAt.getTime() > now + MAX_KEY_LIFETIME_DAYS * DAY_MS) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'expiresAt', issue: 'maximum' }] });
    }
  };

  /** The companies and places a key is restricted to must be ones of the group, outside the trash, each named once. */
  const checkRestrictions = async (principal: AuthPrincipal, access: GroupAccess, restrictions: ApiKeyRestrictions): Promise<void> => {
    const details: ErrorDetail[] = [];
    for (const [field, collection, ids] of [
      ['restrictions.companyIds', 'companies', restrictions.companyIds],
      ['restrictions.placeIds', 'places', restrictions.placeIds],
    ] as const) {
      if (ids !== null) {
        const seen = new Set<string>();
        const missing = await repository.missing(principal, access, collection, ids);
        ids.forEach((id, index) => {
          const hex = id.toHexString();
          if (missing.has(index) || seen.has(hex)) {
            details.push({ field: `${field}.${String(index)}`, issue: 'incorrect' });
          }
          seen.add(hex);
        });
      }
    }
    if (details.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details });
    }
  };

  const find = async (access: GroupAccess, keyId: ObjectId): Promise<ApiKey> => {
    const key = await repository.findInGroup(access.groupId, keyId);
    if (key === null) {
      throw new AppError('NOT_FOUND');
    }
    return key;
  };

  return {
    list: (_principal, access, query) => repository.list(access.groupId, listParamsOf(query, API_KEYS_LIST), query.status ?? null),

    get: (_principal, access, keyId) => find(access, keyId),

    create: async (principal, access, body, client) => {
      refuseLimits(principal, body);
      checkExpiry(body.expiresAt);
      const restrictions: ApiKeyRestrictions = { companyIds: body.restrictions?.companyIds ?? null, placeIds: body.restrictions?.placeIds ?? null };
      await checkRestrictions(principal, access, restrictions);
      const group = await groups.findById(access.groupId);
      if (group === null) {
        throw new AppError('NOT_FOUND');
      }
      if ((await repository.countActive(access.groupId, date())) >= MAX_ACTIVE_KEYS) {
        throw new AppError('CONFLICT');
      }
      const secret = generateSecret('fc_pk_');
      const manager = managerOf(principal);
      const key = await repository.insert({
        groupId: access.groupId,
        name: body.name,
        prefix: secret.slice(0, KEY_PREFIX_LENGTH),
        hash: hashSecret(secret),
        permissions: body.permissions,
        restrictions,
        rateLimitPerMinute: body.rateLimitPerMinute ?? group.group.publicApi.defaultRateLimitPerMinute,
        dailyQuota: body.dailyQuota ?? group.group.publicApi.defaultDailyQuota,
        expiresAt: body.expiresAt ?? null,
        status: 'active',
        revokedAt: null,
        revokedBy: null,
        createdAt: date(),
        createdBy: manager,
        lastUsedAt: null,
      });
      await auditApiKey(activityLog, { action: 'apiKey.created', key, actor: actorOf(principal), client });
      return { key, secret };
    },

    update: async (principal, access, keyId, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      refuseLimits(principal, patch);
      checkExpiry(patch.expiresAt);
      const before = await find(access, keyId);
      // A revoked key, or one whose time is over, is not changed any more: an expired key is not brought back by moving its expiry.
      if (before.status !== 'active' || (before.expiresAt !== null && before.expiresAt.getTime() <= deps.now())) {
        throw new AppError('CONFLICT');
      }
      const restrictions: ApiKeyRestrictions = {
        companyIds: patch.restrictions?.companyIds === undefined ? before.restrictions.companyIds : patch.restrictions.companyIds,
        placeIds: patch.restrictions?.placeIds === undefined ? before.restrictions.placeIds : patch.restrictions.placeIds,
      };
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined && patch.name !== before.name) {
        set['name'] = patch.name;
      }
      if (patch.permissions !== undefined && !sameMembers(patch.permissions, before.permissions)) {
        set['permissions'] = patch.permissions;
      }
      if (!sameIds(restrictions.companyIds, before.restrictions.companyIds) || !sameIds(restrictions.placeIds, before.restrictions.placeIds)) {
        set['restrictions'] = restrictions;
      }
      if (patch.expiresAt !== undefined && (patch.expiresAt?.getTime() ?? null) !== (before.expiresAt?.getTime() ?? null)) {
        set['expiresAt'] = patch.expiresAt;
      }
      for (const field of LIMIT_FIELDS) {
        if (patch[field] !== undefined && patch[field] !== before[field]) {
          set[field] = patch[field];
        }
      }
      const fields = Object.keys(set);
      if (fields.length === 0) {
        return before;
      }
      if (set['restrictions'] !== undefined) {
        await checkRestrictions(principal, access, restrictions);
      }
      const after = await repository.updateActive(access.groupId, keyId, set, date());
      if (after === null) {
        // Revoked, or expired, between the read and the write.
        throw new AppError('CONFLICT');
      }
      await auditApiKey(activityLog, { action: 'apiKey.updated', key: after, actor: actorOf(principal), client, fields });
      return after;
    },

    revoke: async (principal, access, keyId, client) => {
      const revoked = await repository.revoke(access.groupId, keyId, { at: date(), by: managerOf(principal) });
      if (revoked === null) {
        throw new AppError('NOT_FOUND');
      }
      if (revoked.changed) {
        await auditApiKey(activityLog, { action: 'apiKey.revoked', key: revoked.key, actor: actorOf(principal), client });
      }
      return revoked.key;
    },

    usage: async (_principal, access, keyId, query) => {
      await find(access, keyId);
      const to = parseDay(query.to ?? dayOf(date()));
      const from = query.from === undefined ? (to === null ? null : new Date(to.getTime() - (DEFAULT_USAGE_DAYS - 1) * DAY_MS)) : parseDay(query.from);
      const details: ErrorDetail[] = [];
      if (to === null) {
        details.push({ field: 'to', issue: 'format' });
      }
      if (from === null && query.from !== undefined) {
        details.push({ field: 'from', issue: 'format' });
      }
      if (to !== null && from !== null) {
        if (from.getTime() > to.getTime()) {
          details.push({ field: 'from', issue: 'incorrect' });
        } else if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_USAGE_DAYS) {
          details.push({ field: 'from', issue: 'maximum' });
        }
      }
      if (details.length > 0) {
        throw new AppError('VALIDATION_ERROR', { details });
      }
      // No problem found: both ends are real dates.
      const rows = await repository.usage(access.groupId, keyId, dayOf(from!), dayOf(to!));
      const totals = rows.reduce<UsageTotals>(
        (sum, row) => ({ calls: sum.calls + row.calls, errors4xx: sum.errors4xx + row.errors4xx, errors5xx: sum.errors5xx + row.errors5xx, rateLimited: sum.rateLimited + row.rateLimited, aborted: sum.aborted + row.aborted }),
        { calls: 0, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0 },
      );
      return { keyId, from: dayOf(from!), to: dayOf(to!), totals, rows };
    },
  };
}
