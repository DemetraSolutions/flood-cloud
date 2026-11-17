import { numberIssue } from '../catalogs/catalog-fields';
import {
  ApiKey,
  ApiKeyCreateBody,
  ApiKeyPatch,
  expiryDay,
  expiryInstant,
  isRealDay,
  latestExpiryDay,
  MAX_PER_DAY,
  MAX_PER_MINUTE,
  MAX_RESTRICTION_IDS,
  PUBLIC_PERMISSIONS,
  PublicApiSettings,
  PublicPermission,
  utcDay,
} from './api-key.types';

/** The key form as the user edits it: numbers and the expiry day are text. */
export interface KeyModel {
  name: string;
  permissions: Record<PublicPermission, boolean>;
  companyIds: string[];
  placeIds: string[];
  /** `YYYY-MM-DD` (UTC), `''` when the key does not expire. */
  expiresOn: string;
  rateLimitPerMinute: string;
  dailyQuota: string;
}

/**
 * Form values for a key, or for a new one: no permission chosen, no restriction, no expiry, and
 * the limits the key inherits from the group.
 */
export function toKeyModel(key: ApiKey | null, inherited: PublicApiSettings): KeyModel {
  return {
    name: key?.name ?? '',
    permissions: Object.fromEntries(
      PUBLIC_PERMISSIONS.map((permission) => [
        permission,
        key?.permissions.includes(permission) ?? false,
      ]),
    ) as Record<PublicPermission, boolean>,
    companyIds: [...(key?.restrictions.companyIds ?? [])],
    placeIds: [...(key?.restrictions.placeIds ?? [])],
    expiresOn: expiryDay(key?.expiresAt ?? null),
    rateLimitPerMinute: String(key?.rateLimitPerMinute ?? inherited.defaultRateLimitPerMinute),
    dailyQuota: String(key?.dailyQuota ?? inherited.defaultDailyQuota),
  };
}

/** The permissions ticked, in the order of the catalog. */
export function chosenPermissions(model: KeyModel): PublicPermission[] {
  return PUBLIC_PERMISSIONS.filter((permission) => model.permissions[permission]);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const sorted = [...b].sort();
  return a.length === b.length && [...a].sort().every((id, i) => id === sorted[i]);
}

/**
 * Body of the creation: only what the user filled in. Limits are sent only when the user may set
 * them (the platform administrator) and changed them from the inherited ones; otherwise the key
 * inherits.
 */
export function buildCreateBody(
  model: KeyModel,
  inherited: PublicApiSettings,
  canSetLimits: boolean,
): ApiKeyCreateBody {
  const body: ApiKeyCreateBody = { name: model.name.trim(), permissions: chosenPermissions(model) };
  const restrictions: NonNullable<ApiKeyCreateBody['restrictions']> = {};
  if (model.companyIds.length > 0) {
    restrictions.companyIds = [...model.companyIds];
  }
  if (model.placeIds.length > 0) {
    restrictions.placeIds = [...model.placeIds];
  }
  if (Object.keys(restrictions).length > 0) {
    body.restrictions = restrictions;
  }
  if (model.expiresOn !== '') {
    body.expiresAt = expiryInstant(model.expiresOn);
  }
  if (canSetLimits) {
    if (Number(model.rateLimitPerMinute) !== inherited.defaultRateLimitPerMinute) {
      body.rateLimitPerMinute = Number(model.rateLimitPerMinute);
    }
    if (Number(model.dailyQuota) !== inherited.defaultDailyQuota) {
      body.dailyQuota = Number(model.dailyQuota);
    }
  }
  return body;
}

/**
 * Merge patch of a modification: only what differs from the stored key (`null` removes a
 * restriction or the expiry). A dealer never sends limits, even unchanged: the backend refuses them.
 */
export function buildPatch(model: KeyModel, key: ApiKey, canSetLimits: boolean): ApiKeyPatch {
  const patch: ApiKeyPatch = {};
  if (model.name.trim() !== key.name) {
    patch.name = model.name.trim();
  }
  const permissions = chosenPermissions(model);
  if (!sameIds(permissions, key.permissions)) {
    patch.permissions = permissions;
  }
  const restrictions: NonNullable<ApiKeyPatch['restrictions']> = {};
  if (!sameIds(model.companyIds, key.restrictions.companyIds ?? [])) {
    restrictions.companyIds = model.companyIds.length === 0 ? null : [...model.companyIds];
  }
  if (!sameIds(model.placeIds, key.restrictions.placeIds ?? [])) {
    restrictions.placeIds = model.placeIds.length === 0 ? null : [...model.placeIds];
  }
  if (Object.keys(restrictions).length > 0) {
    patch.restrictions = restrictions;
  }
  if (model.expiresOn !== expiryDay(key.expiresAt)) {
    patch.expiresAt = model.expiresOn === '' ? null : expiryInstant(model.expiresOn);
  }
  if (canSetLimits) {
    if (Number(model.rateLimitPerMinute) !== key.rateLimitPerMinute) {
      patch.rateLimitPerMinute = Number(model.rateLimitPerMinute);
    }
    if (Number(model.dailyQuota) !== key.dailyQuota) {
      patch.dailyQuota = Number(model.dailyQuota);
    }
  }
  return patch;
}

/** Issue of the expiry day (backend names), `undefined` when empty or acceptable. */
export function expiryIssue(day: string, now: Date): 'format' | 'minimum' | 'maximum' | undefined {
  if (day === '') {
    return undefined;
  }
  if (!isRealDay(day)) {
    return 'format';
  }
  if (day < utcDay(now)) {
    return 'minimum';
  }
  return day > latestExpiryDay(now) ? 'maximum' : undefined;
}

/** Issue of a limit text (per minute or per day), `undefined` when valid. */
export function limitIssue(
  text: string,
  kind: 'minute' | 'day',
): 'required' | 'type' | 'minimum' | 'maximum' | undefined {
  return numberIssue(text, {
    min: 1,
    max: kind === 'minute' ? MAX_PER_MINUTE : MAX_PER_DAY,
    integer: true,
  });
}

/** Whether a list of restriction ids is within what the backend accepts. */
export function tooManyIds(ids: readonly string[]): boolean {
  return ids.length > MAX_RESTRICTION_IDS;
}
