import type { Document, ObjectId } from 'mongodb';
import type { PublicPermission } from '../../shared/security/rbac/public-permissions.ts';
import type { ApiKeyRestrictions } from '../../shared/security/scope/principal.ts';
import type { ApiKey, KeyManager, UsageRow } from './api-keys.types.ts';

/** Every field of a stored key except the hash: the projection of every read that is not the authentication, so the hash never leaves the database for a list or a detail. */
export const API_KEY_PROJECTION = Object.freeze({
  groupId: 1,
  name: 1,
  prefix: 1,
  permissions: 1,
  restrictions: 1,
  rateLimitPerMinute: 1,
  dailyQuota: 1,
  expiresAt: 1,
  status: 1,
  revokedAt: 1,
  revokedBy: 1,
  createdAt: 1,
  createdBy: 1,
  lastUsedAt: 1,
} as const);

/**
 * Reads a stored key. The collection has a `$jsonSchema` validator and this backend is its only writer, so the shape is trusted; the hash is empty when the read did not project it.
 *
 * @param document The stored document.
 * @returns The key.
 */
export function fromDocument(document: Document): ApiKey {
  const restrictions = document['restrictions'] as { companyIds: ObjectId[] | null; placeIds: ObjectId[] | null };
  return {
    id: document['_id'] as ObjectId,
    groupId: document['groupId'] as ObjectId,
    name: document['name'] as string,
    prefix: document['prefix'] as string,
    hash: (document['hash'] as string | undefined) ?? '',
    permissions: document['permissions'] as PublicPermission[],
    restrictions: { companyIds: restrictions.companyIds, placeIds: restrictions.placeIds },
    rateLimitPerMinute: document['rateLimitPerMinute'] as number,
    dailyQuota: document['dailyQuota'] as number,
    expiresAt: document['expiresAt'] as Date | null,
    status: document['status'] as ApiKey['status'],
    revokedAt: document['revokedAt'] as Date | null,
    revokedBy: document['revokedBy'] as KeyManager | null,
    createdAt: document['createdAt'] as Date,
    createdBy: document['createdBy'] as KeyManager,
    lastUsedAt: document['lastUsedAt'] as Date | null,
  };
}

/** A restriction as the API shows it: the ids as text, `null` for none. */
function idsOf(ids: readonly ObjectId[] | null): string[] | null {
  return ids === null ? null : ids.map((id) => id.toHexString());
}

/** The restrictions of a key as the API shows them (the backoffice and `GET /public/v1/me`). */
export function toRestrictionsResponse(restrictions: ApiKeyRestrictions): { companyIds: string[] | null; placeIds: string[] | null } {
  return { companyIds: idsOf(restrictions.companyIds), placeIds: idsOf(restrictions.placeIds) };
}

const manager = (value: KeyManager) => ({ id: value.userId.toHexString(), role: value.role });

/**
 * The representation of a key on `/v1`, field by field: the hash and the secret are not in the model of the response, so they cannot appear. The secret is added by the creation alone, once.
 *
 * @param key The key.
 */
export function toApiKeyResponse(key: ApiKey) {
  return {
    id: key.id.toHexString(),
    name: key.name,
    prefix: key.prefix,
    permissions: [...key.permissions],
    restrictions: toRestrictionsResponse(key.restrictions),
    rateLimitPerMinute: key.rateLimitPerMinute,
    dailyQuota: key.dailyQuota,
    expiresAt: key.expiresAt === null ? null : key.expiresAt.toISOString(),
    status: key.status,
    createdAt: key.createdAt.toISOString(),
    createdBy: manager(key.createdBy),
    lastUsedAt: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
    revokedAt: key.revokedAt === null ? null : key.revokedAt.toISOString(),
    revokedBy: key.revokedBy === null ? null : manager(key.revokedBy),
  };
}

/** A stored counter: a row written before a counter existed has none, which reads as zero. */
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * Reads a stored usage row.
 *
 * @param document The stored document.
 */
export function toUsageRow(document: Document): UsageRow {
  return {
    day: document['day'] as string,
    route: document['route'] as string,
    calls: count(document['calls']),
    errors4xx: count(document['errors4xx']),
    errors5xx: count(document['errors5xx']),
    rateLimited: count(document['rateLimited']),
    aborted: count(document['aborted']),
  };
}
