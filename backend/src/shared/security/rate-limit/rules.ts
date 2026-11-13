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
  /** Every `/v1` request per authenticated user (always applied to `user` routes by the route builder). */
  readonly apiPerUser: RateLimitRule;
}

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
    apiPerUser: Object.freeze({ bucket: 'api:user', limit: config.rateLimitApiPerUser, key: perUser }),
  });
}
