import { MAX_CURSOR_LENGTH, MAX_LIMIT } from '../../shared/http/list.ts';
import { PUBLIC_API_MAX_DAILY_QUOTA, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE, PUBLIC_API_MIN_LIMIT } from '../../shared/security/public-api-limits.ts';
import { PUBLIC_PERMISSIONS } from '../../shared/security/rbac/public-permissions.ts';
import { array, enumOf, integer, integerString, isoDate, nullable, object, objectId, optional, personName, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Body limit of the creation and the modification of a key: a name, a few lists of ids and some numbers. */
export const API_KEY_BODY_LIMIT = '16kb';

/** Longest name of a key. */
export const MAX_KEY_NAME = 100;

/** Most companies, and most places, a key can be restricted to. */
export const MAX_RESTRICTION_IDS = 100;

const permissions = () => array(enumOf(PUBLIC_PERMISSIONS), { min: 1, max: PUBLIC_PERMISSIONS.length, unique: true });
const ids = () => array(objectId(), { min: 1, max: MAX_RESTRICTION_IDS });
const rateLimit = () => integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE });
const quota = () => integer({ min: PUBLIC_API_MIN_LIMIT, max: PUBLIC_API_MAX_DAILY_QUOTA });

/** The restrictions of a key: a list of companies, a list of places, each `null` (or left out) for no restriction on that kind. A modification changes only the lists it names. */
const restrictions = () => object({ companyIds: optional(nullable(ids())), placeIds: optional(nullable(ids())) });

/**
 * Body of the creation of a key (`POST /v1/groups/{groupId}/api-keys`). The limits are the PSA's: the service refuses them from a dealer (`403 notAllowed`), and a key without them gets the ones of its group.
 * The expiry (in the future, within three years) is checked by the service, which holds the clock.
 */
export const createApiKeyBody = object({
  name: personName(MAX_KEY_NAME),
  permissions: permissions(),
  restrictions: optional(restrictions()),
  expiresAt: optional(nullable(isoDate())),
  rateLimitPerMinute: optional(rateLimit()),
  dailyQuota: optional(quota()),
});

/** Validated body of the creation of a key. */
export type CreateApiKeyBody = Infer<typeof createApiKeyBody>;

/** Body of the modification of a key (`PATCH`, JSON Merge Patch): any of the fields of the creation. `expiresAt: null` removes the expiry. */
export const patchApiKeyBody = object({
  name: optional(personName(MAX_KEY_NAME)),
  permissions: optional(permissions()),
  restrictions: optional(restrictions()),
  expiresAt: optional(nullable(isoDate())),
  rateLimitPerMinute: optional(rateLimit()),
  dailyQuota: optional(quota()),
});

/** Validated body of the modification of a key. */
export type PatchApiKeyBody = Infer<typeof patchApiKeyBody>;

/** Path parameters of the routes on one key; the group was already verified by the route. */
export const apiKeyParams = object({ keyId: objectId() }, { allowUnknown: true });

/** Query of `GET /v1/groups/{groupId}/api-keys`: the page size, the cursor and the status of the keys to show. The order is fixed (newest first). */
export const apiKeysQuery = object({
  limit: optional(integerString({ min: 1, max: MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })),
  status: optional(enumOf(['active', 'revoked'])),
});

/** Validated query of the list of keys. */
export type ApiKeysQuery = Infer<typeof apiKeysQuery>;

/** A calendar date of the query of the usage (`YYYY-MM-DD`): its text is checked by the schema, the date itself by the service. */
const day = () => string({ min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });

/** Query of `GET /v1/groups/{groupId}/api-keys/{keyId}/usage`: the first and the last day of the range, both optional (the last 30 days by default). */
export const usageQuery = object({ from: optional(day()), to: optional(day()) });

/** Validated query of the usage of a key. */
export type UsageQuery = Infer<typeof usageQuery>;
