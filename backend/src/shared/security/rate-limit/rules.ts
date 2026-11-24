import type { Request, Response } from 'express';
import { clientIpKey } from '../client-ip.ts';
import { normalizeUsername } from '../username.ts';
import type { Config } from '../../../config.ts';
import type { RateLimitRule } from './rate-limit.ts';

/** The rate limit rules of the platform (`doc/Security-Model.md` section 7). */
export interface RateLimitRules {
  /** Login attempts per username (normalized: trimmed, lower case). Reads the body. */
  readonly loginPerUsername: RateLimitRule;
  /** Login attempts per client IP address. */
  readonly loginPerIp: RateLimitRule;
  /** Refresh attempts per client IP address. */
  readonly refreshPerIp: RateLimitRule;
  /** Username availability checks per authenticated user. */
  readonly usernameCheckPerUser: RateLimitRule;
  /** User creations and password resets per authenticated user: each runs a scrypt hash. */
  readonly userCredentialsPerUser: RateLimitRule;
  /** Attempts to change the password per authenticated user (same threshold as the login per username). */
  readonly passwordChangePerUser: RateLimitRule;
  /** Failed authentications per client IP on `/v1`; successful requests never count (offices behind NAT). */
  readonly unauthenticatedPerIp: RateLimitRule;
  /** Browser error reports per authenticated user. */
  readonly clientErrorsPerUser: RateLimitRule;
  /** Image uploads per authenticated user: each decodes and resizes an image and writes five objects to the storage. */
  readonly mediaUploadPerUser: RateLimitRule;
  /** Image uploads per authenticated user per day (a quota: the storage has no deletion in step 6B). */
  readonly mediaUploadPerUserDaily: RateLimitRule;
  /** Image uploads per group per day, whoever uploads them. Runs after the group is verified. */
  readonly mediaUploadPerGroupDaily: RateLimitRule;
  /** CSV exports of the diagnostics per authenticated user: each reads every device of the perimeter. */
  readonly diagnosticsExportPerUser: RateLimitRule;
  /** CSV exports of the electronic documents in error per authenticated user: each reads every document of the perimeter. */
  readonly errorDocumentsExportPerUser: RateLimitRule;
  /** Imports of the tobacco price list per authenticated user per hour: each parses a workbook of up to 10 MB and replaces the whole collection. */
  readonly tobaccosImportPerUser: RateLimitRule;
  /** Company lookups on Cerved per authenticated user: each is two paid calls to the provider. */
  readonly cervedLookupPerUser: RateLimitRule;
  /** Company lookups on Cerved per authenticated user per day (a cap on the cost, next to the per-minute rule). */
  readonly cervedLookupPerUserDaily: RateLimitRule;
  /** Failed authentications per client IP on `/public/v1`, apart from the ones of `/v1` (the public surface is called by servers, `/v1` by offices behind a NAT). */
  readonly unauthenticatedPublicPerIp: RateLimitRule;
  /** Every `/v1` request per authenticated user (always applied to `user` routes by the route builder). */
  readonly apiPerUser: RateLimitRule;
  /** Every `/v1` request per authenticated user per hour: the sustained use, applied after {@link RateLimitRules.apiPerUser} by `sustainedRateLimit`. */
  readonly apiPerUserHour: RateLimitRule;
  /** Every `/v1` request per authenticated user per day (UTC), like {@link RateLimitRules.apiPerUserHour}. */
  readonly apiPerUserDay: RateLimitRule;
  /** Every `/v1` request per store key (the route builder applies it to every route a store key may call, and to no other: the per-user rule would let a store through with no limit, its key being the user's). */
  readonly apiPerStore: RateLimitRule;
  /** Activation code exchanges per client IP address: the route is anonymous, so this runs before the body is read. */
  readonly storeActivationPerIp: RateLimitRule;
  /** Writes of the catalog (products and categories) per store key per minute, declared by the write routes of `/store-context/catalog`. */
  readonly storeCatalogWritePerStore: RateLimitRule;
  /** Writes of the catalog (products and categories) per public API key per minute, declared by the write routes of `/public/v1`. */
  readonly publicCatalogWritePerKey: RateLimitRule;
  /** Creations and cancellations of activation codes and revocations of store keys per authenticated user. */
  readonly storeKeyAdminPerUser: RateLimitRule;
  /** Creations, changes and revocations of public API keys per authenticated user. */
  readonly apiKeyAdminPerUser: RateLimitRule;
  /** Creations, changes and deletions of countries and provinces per authenticated user per minute (the PSA only). */
  readonly countriesAdminPerUser: RateLimitRule;
  /** Bulk restores, deletions and emptying of the trash per authenticated user per minute: one call is one request, whatever the number of items. */
  readonly trashAdminPerUser: RateLimitRule;
  /** Writes of the price list, of the price overrides of a dealer, of the renewal bases and of the month closures per authenticated user per minute (the PSA only). */
  readonly activationsAdminPerUser: RateLimitRule;
  /** CSV exports of the statements of the activations per authenticated user: each reads the lines of a dealer for a month. */
  readonly activationsExportPerUser: RateLimitRule;
}

/** Length of an hourly window. */
const HOUR_SECONDS = 3600;

/** Length of a daily quota window. */
const DAY_SECONDS = 86_400;

/** A request without a resolvable address shares one bucket, so it is limited rather than skipped. */
const ip = (req: Request): string => clientIpKey(req.ip ?? 'unknown');

/**
 * Builds the rules from the configuration. The client IP is `req.ip`, which honors the configured
 * `trust proxy` (`X-Forwarded-For` is never read directly), normalized by `clientIpKey`
 * (IPv4-mapped addresses unwrapped, IPv6 reduced to its /64). Usernames use `normalizeUsername`.
 *
 * @param config Thresholds (`RATE_LIMIT_*`).
 * @returns The frozen rules.
 */
export function createRateLimitRules(config: Config): RateLimitRules {
  const perUser = (_req: Request, res: Response): string | null => res.locals.auth?.userId.toHexString() ?? null;
  return Object.freeze({
    loginPerUsername: Object.freeze({
      bucket: 'login:username',
      limit: config.rateLimitLoginPerUsername,
      needsBody: true,
      key: (req: Request) => {
        const username = (req.body as { username?: unknown } | undefined)?.username;
        const normalized = typeof username === 'string' ? normalizeUsername(username) : '';
        return normalized === '' ? null : normalized;
      },
    }),
    loginPerIp: Object.freeze({ bucket: 'login:ip', limit: config.rateLimitLoginPerIp, key: ip }),
    unauthenticatedPerIp: Object.freeze({ bucket: 'auth-fail:ip', limit: config.rateLimitUnauthenticatedPerIp, key: ip }),
    unauthenticatedPublicPerIp: Object.freeze({ bucket: 'auth-fail:public:ip', limit: config.rateLimitUnauthenticatedPublicPerIp, key: ip }),
    refreshPerIp: Object.freeze({ bucket: 'refresh:ip', limit: config.rateLimitRefreshPerIp, key: ip }),
    usernameCheckPerUser: Object.freeze({ bucket: 'usernameCheck:user', limit: config.rateLimitUsernameCheckPerUser, key: perUser }),
    userCredentialsPerUser: Object.freeze({ bucket: 'user-credentials:user', limit: config.rateLimitUserCredentialsPerUser, key: perUser }),
    passwordChangePerUser: Object.freeze({ bucket: 'password-change:user', limit: config.rateLimitLoginPerUsername, key: perUser }),
    clientErrorsPerUser: Object.freeze({ bucket: 'client-errors:user', limit: config.rateLimitClientErrorsPerUser, key: perUser }),
    mediaUploadPerUser: Object.freeze({ bucket: 'media-upload:user', limit: config.rateLimitMediaUploadPerUser, key: perUser }),
    mediaUploadPerUserDaily: Object.freeze({ bucket: 'media-upload-day:user', limit: config.rateLimitMediaUploadPerUserDaily, windowSeconds: DAY_SECONDS, key: perUser }),
    mediaUploadPerGroupDaily: Object.freeze({
      bucket: 'media-upload-day:group',
      limit: config.rateLimitMediaUploadPerGroupDaily,
      windowSeconds: DAY_SECONDS,
      needsGroup: true,
      key: (_req: Request, res: Response) => res.locals.groupAccess?.groupId.toHexString() ?? null,
    }),
    diagnosticsExportPerUser: Object.freeze({ bucket: 'diagnostics-export:user', limit: config.rateLimitDiagnosticsExportPerUser, key: perUser }),
    errorDocumentsExportPerUser: Object.freeze({ bucket: 'error-documents-export:user', limit: config.rateLimitErrorDocumentsExportPerUser, key: perUser }),
    tobaccosImportPerUser: Object.freeze({ bucket: 'tobaccos-import:user', limit: config.rateLimitTobaccosImportPerUser, windowSeconds: HOUR_SECONDS, key: perUser }),
    cervedLookupPerUser: Object.freeze({ bucket: 'cerved-lookup:user', limit: config.rateLimitCervedLookupPerUser, key: perUser }),
    cervedLookupPerUserDaily: Object.freeze({ bucket: 'cerved-lookup-day:user', limit: config.rateLimitCervedLookupPerUserDaily, windowSeconds: DAY_SECONDS, key: perUser }),
    apiPerUser: Object.freeze({ bucket: 'api:user', limit: config.rateLimitApiPerUser, key: perUser }),
    apiPerUserHour: Object.freeze({ bucket: 'api-hour:user', limit: config.rateLimitApiPerUserHour, windowSeconds: HOUR_SECONDS, key: perUser }),
    apiPerUserDay: Object.freeze({ bucket: 'api-day:user', limit: config.rateLimitApiPerUserDay, windowSeconds: DAY_SECONDS, key: perUser }),
    apiPerStore: Object.freeze({ bucket: 'api:store', limit: config.rateLimitApiPerStore, key: (_req: Request, res: Response) => res.locals.store?.keyId.toHexString() ?? null }),
    storeCatalogWritePerStore: Object.freeze({ bucket: 'store-catalog-write:store', limit: config.rateLimitStoreCatalogWritePerStore, key: (_req: Request, res: Response) => res.locals.store?.keyId.toHexString() ?? null }),
    publicCatalogWritePerKey: Object.freeze({ bucket: 'public-catalog-write:key', limit: config.rateLimitPublicCatalogWritePerKey, key: (_req: Request, res: Response) => res.locals.apiKey?.keyId.toHexString() ?? null }),
    storeActivationPerIp: Object.freeze({ bucket: 'storeActivation:ip', limit: config.rateLimitStoreActivationPerIp, key: ip }),
    storeKeyAdminPerUser: Object.freeze({ bucket: 'storeKeyAdmin:user', limit: config.rateLimitStoreKeyAdminPerUser, key: perUser }),
    apiKeyAdminPerUser: Object.freeze({ bucket: 'apiKeyAdmin:user', limit: config.rateLimitApiKeyAdminPerUser, key: perUser }),
    countriesAdminPerUser: Object.freeze({ bucket: 'countriesAdmin:user', limit: config.rateLimitCountriesAdminPerUser, key: perUser }),
    trashAdminPerUser: Object.freeze({ bucket: 'trashAdmin:user', limit: config.rateLimitTrashAdminPerUser, key: perUser }),
    activationsAdminPerUser: Object.freeze({ bucket: 'activationsAdmin:user', limit: config.rateLimitActivationsAdminPerUser, key: perUser }),
    activationsExportPerUser: Object.freeze({ bucket: 'activations-export:user', limit: config.rateLimitActivationsExportPerUser, key: perUser }),
  });
}
