/** Smallest limit of requests per minute (or per day) a public API key can have. */
export const PUBLIC_API_MIN_LIMIT = 1;

/** Largest number of requests per minute a public API key can be given (`doc/Security-Model.md` section 7). */
export const PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE = 6000;

/** Largest number of requests per UTC day a public API key can be given. */
export const PUBLIC_API_MAX_DAILY_QUOTA = 10_000_000;

/** The limits of the public API when nobody sets them: the platform defaults of the configuration, or the ones of the group where the PSA gave it its own. */
export interface PublicApiLimits {
  /** Requests per minute of a key. */
  readonly rateLimitPerMinute: number;
  /** Requests per UTC day of a key. */
  readonly dailyQuota: number;
  /** Requests per minute of all the keys of a group together. */
  readonly groupRateLimitPerMinute: number;
  /** Requests per UTC day of all the keys of a group together. */
  readonly groupDailyQuota: number;
}
