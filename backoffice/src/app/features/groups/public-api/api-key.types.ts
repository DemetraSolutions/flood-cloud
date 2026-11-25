/** Permissions of the public catalog a key may hold (`/public/v1`), not those of the backoffice. */
export const PUBLIC_PERMISSIONS = [
  'places:read',
  'companies:read',
  'catalog:read',
  'catalog:write',
  'contacts:read',
  'contacts:write',
  'fidelityCards:read',
  'fidelityCards:write',
] as const;

/** A permission of the public catalog. */
export type PublicPermission = (typeof PUBLIC_PERMISSIONS)[number];

/** Dictionary key of the label (`LABEL`) or the description (`HINT`) of a public permission. */
export function permissionTextKey(permission: PublicPermission, part: 'LABEL' | 'HINT'): string {
  return `PUBLIC_API.PERMISSION.${permission.replace(':', '_').toUpperCase()}.${part}`;
}

/** Limits of the platform, used by the group until it sets its own. */
export const PLATFORM_DEFAULTS = {
  enabled: false,
  defaultRateLimitPerMinute: 60,
  defaultDailyQuota: 10_000,
  groupRateLimitPerMinute: 120,
  groupDailyQuota: 20_000,
} as const;

/** Most requests per minute and per day a limit may be set to. */
export const MAX_PER_MINUTE = 6000;
export const MAX_PER_DAY = 10_000_000;
/** Most days of a usage reading. */
export const MAX_USAGE_DAYS = 92;
/** Days of a usage reading when the range is not chosen. */
export const DEFAULT_USAGE_DAYS = 30;
/** Years ahead an expiry may be set. */
export const MAX_EXPIRY_YEARS = 3;
/** Most ids of one restriction (the backend accepts 1 to 100). */
export const MAX_RESTRICTION_IDS = 100;

/** The public API settings of a group (`group.publicApi`, seen by PSA and dealers). */
export interface PublicApiSettings {
  readonly enabled: boolean;
  readonly defaultRateLimitPerMinute: number;
  readonly defaultDailyQuota: number;
  readonly groupRateLimitPerMinute: number;
  readonly groupDailyQuota: number;
}

/** Lists of ids a key is limited to; `null` is no restriction of that kind. */
export interface ApiKeyRestrictions {
  readonly companyIds: readonly string[] | null;
  readonly placeIds: readonly string[] | null;
}

/** Who created or revoked a key. */
export interface ApiKeyActor {
  readonly id: string;
  readonly role: string;
}

/** What the backend stores of a key: never the hash and never the secret. */
export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly permissions: readonly PublicPermission[];
  readonly restrictions: ApiKeyRestrictions;
  readonly rateLimitPerMinute: number;
  readonly dailyQuota: number;
  readonly expiresAt: string | null;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly createdBy: ApiKeyActor | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: ApiKeyActor | null;
}

/** Status of a key as the page shows it: `expired` is computed from `expiresAt`. */
export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

/** A key that is neither revoked nor expired: the only one that can be changed. */
export function keyStatus(key: ApiKey, now: Date): ApiKeyStatus {
  if (key.status === 'revoked') {
    return 'revoked';
  }
  return key.expiresAt !== null && new Date(key.expiresAt).getTime() <= now.getTime()
    ? 'expired'
    : 'active';
}

/** Body of `POST …/api-keys`: only what the user filled in. */
export interface ApiKeyCreateBody {
  name: string;
  permissions: PublicPermission[];
  restrictions?: { companyIds?: string[]; placeIds?: string[] };
  expiresAt?: string;
  rateLimitPerMinute?: number;
  dailyQuota?: number;
}

/** Body of `PATCH …/api-keys/{keyId}` (JSON Merge Patch): only what changed. */
export interface ApiKeyPatch {
  name?: string;
  permissions?: PublicPermission[];
  restrictions?: { companyIds?: string[] | null; placeIds?: string[] | null };
  expiresAt?: string | null;
  rateLimitPerMinute?: number;
  dailyQuota?: number;
}

/** Totals of the usage of a key (also the counts of one row). */
export interface UsageCounts {
  readonly calls: number;
  readonly errors4xx: number;
  readonly errors5xx: number;
  readonly rateLimited: number;
  readonly aborted: number;
}

/** Usage of a key on one day and route. */
export interface UsageRow extends UsageCounts {
  readonly day: string;
  readonly route: string;
}

/** `GET …/api-keys/{keyId}/usage`. */
export interface ApiKeyUsage {
  readonly keyId: string;
  readonly from: string;
  readonly to: string;
  readonly totals: UsageCounts;
  readonly rows: readonly UsageRow[];
}

/** One day of the usage with its totals, as the page shows the daily table. */
export interface UsageDay extends UsageCounts {
  readonly day: string;
}

/** Sums the rows of each day (the backend sends them ordered by day and route). */
export function dailyTotals(rows: readonly UsageRow[]): UsageDay[] {
  const days = new Map<string, UsageDay>();
  for (const row of rows) {
    const day = days.get(row.day);
    days.set(row.day, {
      day: row.day,
      calls: (day?.calls ?? 0) + row.calls,
      errors4xx: (day?.errors4xx ?? 0) + row.errors4xx,
      errors5xx: (day?.errors5xx ?? 0) + row.errors5xx,
      rateLimited: (day?.rateLimited ?? 0) + row.rateLimited,
      aborted: (day?.aborted ?? 0) + row.aborted,
    });
  }
  return [...days.values()];
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` of a date in UTC (the days of the API are UTC days). */
export function utcDay(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
}

/** The UTC day `days` days after (or before, when negative) `date`. */
export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Whether a text is the `YYYY-MM-DD` of a day that exists. */
export function isRealDay(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    return false;
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && utcDay(date) === text;
}

/** Number of days of the range `from`…`to`, both included (both must be real days). */
export function daysInRange(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
}

/**
 * Issue of a usage range, with the names the backend uses: a day that does not exist (`format`),
 * `from` after `to` (`incorrect`) or a range over {@link MAX_USAGE_DAYS} days (`maximum`).
 * `undefined` when the range is valid.
 */
export function usageRangeIssue(
  from: string,
  to: string,
): { field: 'from' | 'to'; issue: 'format' | 'incorrect' | 'maximum' } | undefined {
  if (!isRealDay(from)) {
    return { field: 'from', issue: 'format' };
  }
  if (!isRealDay(to)) {
    return { field: 'to', issue: 'format' };
  }
  const days = daysInRange(from, to);
  if (days < 1) {
    return { field: 'from', issue: 'incorrect' };
  }
  return days > MAX_USAGE_DAYS ? { field: 'from', issue: 'maximum' } : undefined;
}

/**
 * Latest day an expiry may be set to: the expiry is the end of the chosen day (UTC), and the
 * backend accepts at most three years from now, so the day before the third anniversary of today.
 */
export function latestExpiryDay(now: Date): string {
  const limit = new Date(now.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_EXPIRY_YEARS);
  return utcDay(addUtcDays(limit, -1));
}

/** Instant sent for an expiry day: the last millisecond of that UTC day. */
export function expiryInstant(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/** The expiry day (UTC) of a stored expiry, `''` for a key that does not expire. */
export function expiryDay(expiresAt: string | null): string {
  return expiresAt === null ? '' : utcDay(new Date(expiresAt));
}
