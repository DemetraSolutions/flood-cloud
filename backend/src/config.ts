import { isIP } from 'node:net';
import { PUBLIC_API_MAX_DAILY_QUOTA, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE, PUBLIC_API_MIN_LIMIT } from './shared/security/public-api-limits.ts';
import { Secret } from './shared/security/secret.ts';

/** Execution environments accepted for `APP_ENV`. */
export const APP_ENVS = ['development', 'production'] as const;

/** Execution environment of the process. */
export type AppEnv = (typeof APP_ENVS)[number];

/** Identifier of a MongoDB cluster (`cluster0`, `cluster1`…): never a host, never a credential. */
export type ClusterId = string;

/** Connection strings of one MongoDB cluster. */
export interface ClusterConfig {
  /** Read/write connection string, a secret. */
  readonly uri: Secret;
  /**
   * Connection string of the analytics node (a more powerful node for heavy reads), a secret.
   * `null` when none is configured: analytics reads then use {@link ClusterConfig.uri} with `secondaryPreferred`.
   */
  readonly analyticsUri: Secret | null;
}

/** Where the uploaded media are stored and how the server authenticates to the storage. */
export type MediaConfig =
  /** No storage: the upload route answers `503 SERVICE_UNAVAILABLE`, the list of the images still works. */
  | { readonly kind: 'disabled' }
  /** Google Cloud Storage in one bucket. */
  | {
      readonly kind: 'gcs';
      /** Name of the bucket (`GCS_MEDIA_BUCKET`). */
      readonly bucket: string;
      /** `metadata`: the token of the metadata server (GKE Workload Identity). `service-account-file`: a JWT signed with the key of a credentials file, read once at start-up. */
      readonly auth: { readonly mode: 'metadata' } | { readonly mode: 'service-account-file'; readonly file: string };
    };

/** A single configuration problem: only the variable name and a reason, never the value. */
export interface ConfigIssue {
  readonly variable: string;
  readonly reason: string;
}

/** Validated and deeply frozen application configuration. */
export interface Config {
  /** Execution environment (`APP_ENV`). */
  readonly appEnv: AppEnv;
  /** TCP port to listen on (`PORT`). */
  readonly port: number;
  /** Address to bind (`HOST`): an IP literal or a hostname; `undefined` binds every interface. */
  readonly host: string | undefined;
  /**
   * The configured MongoDB clusters by id. Single-cluster mode (`MONGODB_CLUSTERS` unset) has just `cluster0`,
   * built from `MONGODB_URI` and `MONGODB_ANALYTICS_URI`; otherwise one entry per listed id, built from
   * `MONGODB_URI_<ID>` and `MONGODB_ANALYTICS_URI_<ID>`.
   */
  readonly clusters: ReadonlyMap<ClusterId, ClusterConfig>;
  /** Cluster of the common database: login and common data always live here (`MONGODB_COMMON_CLUSTER`). */
  readonly commonCluster: ClusterId;
  /** Cluster of the groups whose document has no `dataCluster` (`MONGODB_DEFAULT_GROUP_CLUSTER`). */
  readonly defaultGroupCluster: ClusterId;
  /** Prefix of every database name (`DB_NAME_PREFIX`). */
  readonly dbNamePrefix: string;
  /** MongoDB server selection and connect timeout in milliseconds (`MONGODB_SERVER_SELECTION_TIMEOUT_MS`). */
  readonly mongodbServerSelectionTimeoutMs: number;
  /** Maximum size of the MongoDB connection pool (`MONGODB_MAX_POOL_SIZE`). */
  readonly mongodbMaxPoolSize: number;
  /** Exact number of reverse proxies in front of the server (`TRUST_PROXY`); 0 means none. */
  readonly trustProxy: number;
  /** Exact origins allowed by CORS on `/v1` (`CORS_ALLOWED_ORIGINS`). */
  readonly corsAllowedOrigins: readonly string[];
  /** Lifetime of an access token in seconds (`ACCESS_TOKEN_TTL_SECONDS`). */
  readonly accessTokenTtlSeconds: number;
  /** Idle lifetime of a refresh token in seconds (`REFRESH_IDLE_TTL_SECONDS`). */
  readonly refreshIdleTtlSeconds: number;
  /** Absolute lifetime of a session in seconds (`SESSION_MAX_TTL_SECONDS`). */
  readonly sessionMaxTtlSeconds: number;
  /** Seconds after a refresh during which a retry of the old token is tolerated as a network race (`REFRESH_REUSE_GRACE_SECONDS`). */
  readonly refreshReuseGraceSeconds: number;
  /** Pause between the shutdown signal and the closing of the server (`SHUTDOWN_DRAIN_MS`). */
  readonly shutdownDrainMs: number;
  /** Request timeout in milliseconds (`REQUEST_TIMEOUT_MS`). */
  readonly requestTimeoutMs: number;
  /** Pepper of the legacy password hashes (`LEGACY_PASSWORD_PEPPER`), a secret. */
  readonly legacyPasswordPepper: Secret;
  /**
   * Key of the HMAC-SHA256 that signs the version (`ETag`) of the companies and places of a group (`VERSION_HMAC_KEY`), a secret: base64 or base64url of at least 32 bytes
   * (for example `openssl rand -base64 32`). Without it the version would be a plain hash of data (credentials included) that anyone who reads the `ETag` could check offline.
   */
  readonly versionHmacKey: Secret;
  /**
   * Public base URL of the API as the browser sees it (`API_PUBLIC_BASE_URL`), normalized without trailing slash: it must equal the base URL the backoffice calls.
   * Used to check the `htu` claim of DPoP proofs; never rebuilt from `Host` or `X-Forwarded-*`.
   */
  readonly apiPublicBaseUrl: string;
  /** Whether the legacy system still runs, so password changes also write the legacy hash (`LEGACY_PASSWORD_COEXISTENCE`). */
  readonly legacyPasswordCoexistence: boolean;
  /** Requests per minute allowed to a login username (`RATE_LIMIT_LOGIN_PER_USERNAME`). */
  readonly rateLimitLoginPerUsername: number;
  /** Requests per minute allowed to a login IP address (`RATE_LIMIT_LOGIN_PER_IP`). */
  readonly rateLimitLoginPerIp: number;
  /** Requests per minute allowed to a refresh IP address (`RATE_LIMIT_REFRESH_PER_IP`). */
  readonly rateLimitRefreshPerIp: number;
  /** Username availability checks per minute allowed to a user (`RATE_LIMIT_USERNAME_CHECK_PER_USER`). */
  readonly rateLimitUsernameCheckPerUser: number;
  /** Creations and password resets of users per minute allowed to a user (`RATE_LIMIT_USER_CREDENTIALS_PER_USER`): each costs a scrypt run. */
  readonly rateLimitUserCredentialsPerUser: number;
  /** Browser error reports per minute allowed to a user (`RATE_LIMIT_CLIENT_ERRORS_PER_USER`). */
  readonly rateLimitClientErrorsPerUser: number;
  /** Requests per minute allowed to a user on the `/v1` API (`RATE_LIMIT_API_PER_USER`). */
  readonly rateLimitApiPerUser: number;
  /** Requests per hour allowed to an authenticated user on the `/v1` API, next to the per-minute rule (`RATE_LIMIT_API_PER_USER_HOUR`). */
  readonly rateLimitApiPerUserHour: number;
  /** Requests per day (UTC) allowed to an authenticated user on the `/v1` API (`RATE_LIMIT_API_PER_USER_DAY`). */
  readonly rateLimitApiPerUserDay: number;
  /** What happens over the hourly and daily limits of a user: `report` records a security event and lets the request pass, `enforce` answers `429` (PSA and D are never refused) (`RATE_LIMIT_API_SUSTAINED_MODE`). */
  readonly rateLimitApiSustainedMode: 'report' | 'enforce';
  /** `on` (default) reports the `/v1` requests of a user that do not look like a browser's; `off` turns the signal off (`REQUEST_ORIGIN_SIGNAL`). */
  readonly requestOriginSignal: 'on' | 'off';
  /** `on` forces both settings of the security policy to report only, whatever the database says: the emergency exit of the block and of the limits (`SECURITY_POLICY_FORCE_REPORT`, default `off`). */
  readonly securityPolicyForceReport: 'on' | 'off';
  /** Failed authentications per minute allowed to a client IP on `/v1` (`RATE_LIMIT_UNAUTHENTICATED_PER_IP`). */
  readonly rateLimitUnauthenticatedPerIp: number;
  /** Requests per minute allowed to a store key on the `/v1` API (`RATE_LIMIT_API_PER_STORE`). */
  readonly rateLimitApiPerStore: number;
  /** Activation code exchanges per minute allowed to a client IP address (`RATE_LIMIT_STORE_ACTIVATION_PER_IP`). */
  readonly rateLimitStoreActivationPerIp: number;
  /** Activation code creations, cancellations and key revocations per minute allowed to a user (`RATE_LIMIT_STORE_KEY_ADMIN_PER_USER`). */
  readonly rateLimitStoreKeyAdminPerUser: number;
  /** Writes of the catalog allowed to a store key per minute (`RATE_LIMIT_STORE_CATALOG_WRITE_PER_STORE`). */
  readonly rateLimitStoreCatalogWritePerStore: number;
  /** Writes of the catalog allowed to a public API key per minute (`RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY`). */
  readonly rateLimitPublicCatalogWritePerKey: number;
  /** Creations, changes and revocations of public API keys per minute allowed to a user (`RATE_LIMIT_API_KEY_ADMIN_PER_USER`). */
  readonly rateLimitApiKeyAdminPerUser: number;
  /** Creations, changes and deletions of countries and provinces per minute allowed to a user (`RATE_LIMIT_COUNTRIES_ADMIN_PER_USER`). */
  readonly rateLimitCountriesAdminPerUser: number;
  /** Bulk restores, deletions and emptying of the trash per minute allowed to a user (`RATE_LIMIT_TRASH_ADMIN_PER_USER`): one call counts as one request. */
  readonly rateLimitTrashAdminPerUser: number;
  /** Writes of the price list, of the price overrides of a dealer, of the renewal bases and of the month closures per minute allowed to a user (`RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER`, the PSA only). */
  readonly rateLimitActivationsAdminPerUser: number;
  /** CSV exports of the statements of the activations per minute allowed to a user (`RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER`). */
  readonly rateLimitActivationsExportPerUser: number;
  /** Requests per minute a public API key gets when its group sets no default of its own (`PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE`). */
  readonly publicApiDefaultRateLimitPerMinute: number;
  /** Requests per UTC day a public API key gets when its group sets no default of its own (`PUBLIC_API_DEFAULT_DAILY_QUOTA`). */
  readonly publicApiDefaultDailyQuota: number;
  /** Requests per minute allowed to all the public API keys of a group together, when the group sets no cap of its own (`PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE`). */
  readonly publicApiDefaultGroupRateLimitPerMinute: number;
  /** Requests per UTC day allowed to all the public API keys of a group together, when the group sets no cap of its own (`PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA`). */
  readonly publicApiDefaultGroupDailyQuota: number;
  /** Failed authentications per minute allowed to a client IP on `/public/v1` (`RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP`), counted apart from the ones of `/v1`. */
  readonly rateLimitUnauthenticatedPublicPerIp: number;
  /** Seconds between two writes of the usage counters of the public API (`PUBLIC_API_USAGE_FLUSH_SECONDS`). */
  readonly publicApiUsageFlushSeconds: number;
  /** CSV exports of the diagnostics per minute allowed to a user (`RATE_LIMIT_DIAGNOSTICS_EXPORT_PER_USER`). */
  readonly rateLimitDiagnosticsExportPerUser: number;
  /** CSV exports of the electronic documents in error per minute allowed to a user (`RATE_LIMIT_ERROR_DOCUMENTS_EXPORT_PER_USER`). */
  readonly rateLimitErrorDocumentsExportPerUser: number;
  /** Imports of the tobacco price list per hour allowed to a user (`RATE_LIMIT_TOBACCOS_IMPORT_PER_USER`). */
  readonly rateLimitTobaccosImportPerUser: number;
  /** Company lookups on Cerved per minute allowed to a user (`RATE_LIMIT_CERVED_LOOKUP_PER_USER`): each is two paid calls to the provider. */
  readonly rateLimitCervedLookupPerUser: number;
  /** Company lookups on Cerved per day allowed to a user (`RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY`). */
  readonly rateLimitCervedLookupPerUserDaily: number;
  /** Key of the Cerved API (`CERVED_API_KEY`), a secret; `null` when not configured: the VAT lookup then answers `503`. */
  readonly cervedApiKey: Secret | null;
  /** Base URL of the Cerved API (`CERVED_BASE_URL`): an `https` origin (`http` only for `localhost` and `127.0.0.1`), without trailing slash. */
  readonly cervedBaseUrl: string;
  /** Files host written in the `filesHost` of the groups the onboarding creates (`GROUP_FILES_HOST`, an `https` URL without trailing slash), `''` when unset. */
  readonly groupFilesHost: string;
  /** Minutes an activation code of a store key stays valid (`STORE_ACTIVATION_CODE_TTL_MINUTES`). */
  readonly storeActivationCodeTtlMinutes: number;
  /** Image uploads per minute allowed to a user (`RATE_LIMIT_MEDIA_UPLOAD_PER_USER`): each decodes and resizes an image and writes five objects. */
  readonly rateLimitMediaUploadPerUser: number;
  /** Image uploads per day allowed to a user (`RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY`). */
  readonly rateLimitMediaUploadPerUserDaily: number;
  /** Image uploads per day allowed to a group (`RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY`). */
  readonly rateLimitMediaUploadPerGroupDaily: number;
  /** The media storage (`MEDIA_STORAGE`, `GCS_MEDIA_BUCKET`, `GCS_AUTH`, `GCS_SERVICE_ACCOUNT_FILE`). */
  readonly media: MediaConfig;
  /** Days the `data` and `security` activity log entries are kept (`ACTIVITY_LOG_RETENTION_DAYS`). */
  readonly activityLogRetentionDays: number;
  /** Days the `error` activity log entries are kept (`ACTIVITY_LOG_ERROR_RETENTION_DAYS`). */
  readonly activityLogErrorRetentionDays: number;
}

/**
 * Thrown by {@link loadConfig} when the environment is not valid.
 * The message lists every problem, naming variables but never printing values.
 */
export class ConfigError extends Error {
  /** Every problem found, in declaration order. */
  readonly issues: readonly ConfigIssue[];

  /**
   * @param issues The problems found; must not contain configuration values.
   */
  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue.variable}: ${issue.reason}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const DECIMAL = /^[0-9]+$/;
/** MongoDB limits database names to 63 bytes: 27 + "development" (11) + "_" + 24 hex = 63. */
const DB_PREFIX = /^[A-Za-z0-9_-]{0,27}$/;
/** Shape of a cluster id. */
const CLUSTER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Upper bound on the number of clusters. */
const MAX_CLUSTERS = 16;
/** Id of the only cluster in single-cluster mode. */
export const SINGLE_CLUSTER_ID: ClusterId = 'cluster0';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Reads an optional variable: unset and the empty string (as in `.env.example`) both mean "use the default".
 *
 * @returns The value, or `undefined` when unset or empty.
 */
function optionalVariable(env: Env, variable: string): string | undefined {
  const raw = env[variable];
  return raw === '' ? undefined : raw;
}

/** A DNS hostname: dot-separated labels of letters, digits and inner hyphens, at most 253 characters overall. */
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Reads the optional `HOST` variable (the address the server binds) and records an issue if it is neither an IP literal nor a hostname.
 *
 * @returns The host, or `undefined` when unset (bind every interface) or after recording an issue.
 */
function readHost(env: Env, issues: ConfigIssue[]): string | undefined {
  const raw = optionalVariable(env, 'HOST');
  if (raw === undefined) {
    return undefined;
  }
  if (isIP(raw) === 0 && !HOSTNAME.test(raw)) {
    issues.push({ variable: 'HOST', reason: 'must be an IP address or a hostname' });
    return undefined;
  }
  return raw;
}

/**
 * Reads an optional decimal integer variable and records an issue if invalid.
 *
 * @returns The parsed value, the default when unset, or `undefined` after recording an issue.
 */
function readInteger(
  env: Env,
  issues: ConfigIssue[],
  variable: string,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  const raw = optionalVariable(env, variable);
  if (raw === undefined) {
    return fallback;
  }
  const value = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
    issues.push({ variable, reason: `must be a decimal integer ${range}` });
    return undefined;
  }
  return value;
}

/**
 * Reads `RATE_LIMIT_API_SUSTAINED_MODE`: `report` (default) or `enforce`, exactly as written.
 *
 * @returns The mode, `report` when unset, or `undefined` after recording an issue.
 */
function readSustainedMode(env: Env, issues: ConfigIssue[]): 'report' | 'enforce' | undefined {
  const raw = optionalVariable(env, 'RATE_LIMIT_API_SUSTAINED_MODE');
  if (raw === undefined || raw === 'report' || raw === 'enforce') {
    return raw ?? 'report';
  }
  issues.push({ variable: 'RATE_LIMIT_API_SUSTAINED_MODE', reason: 'must be report or enforce' });
  return undefined;
}

/**
 * Reads a switch that is `on` or `off`, exactly as written.
 *
 * @returns The value, the fallback when unset, or `undefined` after recording an issue.
 */
function readOnOff(env: Env, issues: ConfigIssue[], variable: string, fallback: 'on' | 'off'): 'on' | 'off' | undefined {
  const raw = optionalVariable(env, variable);
  if (raw === undefined || raw === 'on' || raw === 'off') {
    return raw ?? fallback;
  }
  issues.push({ variable, reason: 'must be on or off' });
  return undefined;
}

const INSECURE_TLS_OPTIONS = new Set([
  'tlsinsecure',
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
  'tlsdisableocspendpointcheck',
  'tlsdisablecertificaterevocationcheck',
]);

/**
 * Checks the TLS requirements of a production MongoDB URI. Option names are case-insensitive.
 * `tls`/`ssl` must be `true` when present; `mongodb://` must enable TLS explicitly while
 * `mongodb+srv://` enables it by default; no option may weaken certificate or hostname checks.
 *
 * @param uri The connection string; never echoed.
 * @returns The reason it is unacceptable, or `undefined`.
 */
function tlsProblem(uri: string): string | undefined {
  const queryStart = uri.indexOf('?');
  const params = new URLSearchParams(queryStart === -1 ? '' : uri.slice(queryStart + 1));
  let enabled = false;
  for (const [rawKey, rawValue] of params) {
    const key = rawKey.toLowerCase();
    const value = rawValue.toLowerCase();
    if (key === 'tls' || key === 'ssl') {
      if (value !== 'true') {
        return 'must use TLS in production (tls and ssl, when present, must be true)';
      }
      enabled = true;
    } else if (INSECURE_TLS_OPTIONS.has(key) && value === 'true') {
      return 'must use TLS in production without options that weaken certificate or hostname checks';
    }
  }
  if (!enabled && !uri.startsWith('mongodb+srv://')) {
    return 'must use TLS in production (mongodb+srv:// or mongodb:// with tls=true)';
  }
  return undefined;
}

/**
 * Validates one CORS origin entry.
 *
 * @returns A reason when the entry is not acceptable, `undefined` when it is.
 */
function checkOrigin(entry: string): string | undefined {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return 'every entry must be an origin (scheme, host and optional port, no path)';
  }
  if (url.origin !== entry) {
    return 'every entry must be an origin (scheme, host and optional port, no path)';
  }
  if (url.protocol === 'https:') {
    return undefined;
  }
  // A loopback origin is the developer's own browser, in any environment: the production configuration can be run locally as it is. CORS carries no credentials here
  // (no cookies, no Allow-Credentials: the tokens live in the memory of the page), so such an origin gains nothing a request without CORS would not have.
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return undefined;
  }
  return 'https is required (http is allowed only for localhost and 127.0.0.1)';
}

/**
 * Reads `GROUP_FILES_HOST`, the host of the files of the groups the onboarding creates: unset is `''`; a value must be an `https` URL without credentials, query or fragment.
 *
 * @returns The URL without the trailing slashes, `''` when unset, or `undefined` after recording an issue.
 */
function readFilesHost(env: Env, issues: ConfigIssue[]): string | undefined {
  const raw = optionalVariable(env, 'GROUP_FILES_HOST');
  if (raw === undefined) {
    return '';
  }
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '') {
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    }
  }
  issues.push({ variable: 'GROUP_FILES_HOST', reason: 'must be an https URL without credentials, query or fragment' });
  return undefined;
}

/** Base URL of the Cerved API when `CERVED_BASE_URL` is not set. */
export const DEFAULT_CERVED_BASE_URL = 'https://api.cerved.com';

/** A usable Cerved key: at least 16 printable ASCII characters, no space (it travels in an HTTP header). */
const CERVED_KEY = /^[\x21-\x7e]{16,512}$/;

/**
 * Reads `CERVED_API_KEY`: optional, and when present at least 16 printable characters without spaces. The value is never echoed.
 *
 * @returns The secret, `null` when unset, or `undefined` after recording an issue.
 */
function readCervedKey(env: Env, issues: ConfigIssue[]): Secret | null | undefined {
  const raw = optionalVariable(env, 'CERVED_API_KEY');
  if (raw === undefined) {
    return null;
  }
  if (!CERVED_KEY.test(raw)) {
    issues.push({ variable: 'CERVED_API_KEY', reason: 'must be at least 16 printable characters without spaces' });
    return undefined;
  }
  return new Secret(raw);
}

/**
 * Reads `CERVED_BASE_URL`: an `https` URL without credentials, query or fragment (`http` only for `localhost` and `127.0.0.1` when `APP_ENV=development`, for the tests).
 *
 * @returns The URL without the trailing slashes, the default when unset, or `undefined` after recording an issue.
 */
function readCervedBaseUrl(env: Env, issues: ConfigIssue[], appEnv: AppEnv | undefined): string | undefined {
  const raw = optionalVariable(env, 'CERVED_BASE_URL');
  if (raw === undefined) {
    return DEFAULT_CERVED_BASE_URL;
  }
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && appEnv === 'development');
    if (secure && url.username === '' && url.password === '' && url.search === '' && url.hash === '') {
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    }
  }
  issues.push({ variable: 'CERVED_BASE_URL', reason: 'must be an https URL without credentials, query or fragment (http only for localhost and 127.0.0.1 when APP_ENV=development)' });
  return undefined;
}

/**
 * Reads the required `API_PUBLIC_BASE_URL`: an `https` URL without credentials, query or fragment. Plain `http` is accepted
 * only for `localhost` and `127.0.0.1`, in every environment (like `CORS_ALLOWED_ORIGINS`, to run any configuration locally;
 * browsers treat the loopback as a secure context, so WebCrypto works there).
 *
 * @returns The URL without the trailing slashes, or `undefined` after recording an issue.
 */
function readApiPublicBaseUrl(env: Env, issues: ConfigIssue[]): string | undefined {
  const raw = optionalVariable(env, 'API_PUBLIC_BASE_URL');
  if (raw === undefined) {
    issues.push({ variable: 'API_PUBLIC_BASE_URL', reason: 'is required' });
    return undefined;
  }
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    if (secure && url.username === '' && url.password === '' && url.search === '' && url.hash === '') {
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    }
  }
  issues.push({ variable: 'API_PUBLIC_BASE_URL', reason: 'must be an https URL without credentials, query or fragment (http only for localhost and 127.0.0.1)' });
  return undefined;
}

/** Shape of a Google Cloud Storage bucket name (3 to 63 characters, lower case letters, digits, dashes, underscores and dots, starting and ending with a letter or a digit). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

/**
 * Reads the media storage settings. `MEDIA_STORAGE` is `disabled` (the default) or `gcs`; `gcs` needs `GCS_MEDIA_BUCKET` and `GCS_AUTH`
 * (`metadata` or `service-account-file`), and the latter needs `GCS_SERVICE_ACCOUNT_FILE`. The variables of a mode that is not chosen are ignored.
 *
 * @returns The settings, or `undefined` after recording issues.
 */
function readMedia(env: Env, issues: ConfigIssue[]): MediaConfig | undefined {
  const storage = optionalVariable(env, 'MEDIA_STORAGE') ?? 'disabled';
  if (storage === 'disabled') {
    return Object.freeze({ kind: 'disabled' as const });
  }
  if (storage !== 'gcs') {
    issues.push({ variable: 'MEDIA_STORAGE', reason: 'must be gcs or disabled' });
    return undefined;
  }
  const bucket = optionalVariable(env, 'GCS_MEDIA_BUCKET');
  const authMode = optionalVariable(env, 'GCS_AUTH');
  const file = optionalVariable(env, 'GCS_SERVICE_ACCOUNT_FILE');
  const before = issues.length;
  if (bucket === undefined) {
    issues.push({ variable: 'GCS_MEDIA_BUCKET', reason: 'is required when MEDIA_STORAGE is gcs' });
  } else if (!BUCKET_NAME.test(bucket)) {
    issues.push({ variable: 'GCS_MEDIA_BUCKET', reason: 'must be a bucket name (3 to 63 characters: lower case letters, digits, dots, dashes and underscores)' });
  }
  if (authMode !== 'metadata' && authMode !== 'service-account-file') {
    issues.push({ variable: 'GCS_AUTH', reason: authMode === undefined ? 'is required when MEDIA_STORAGE is gcs (metadata or service-account-file)' : 'must be metadata or service-account-file' });
  } else if (authMode === 'service-account-file' && (file === undefined || file.includes('\0'))) {
    issues.push({ variable: 'GCS_SERVICE_ACCOUNT_FILE', reason: 'is required, as a path without NUL characters, when GCS_AUTH is service-account-file' });
  }
  if (issues.length > before || bucket === undefined || authMode === undefined) {
    return undefined;
  }
  return Object.freeze({ kind: 'gcs' as const, bucket, auth: Object.freeze(authMode === 'metadata' ? { mode: 'metadata' as const } : { mode: 'service-account-file' as const, file: file as string }) });
}

/** The settings needed to open the databases; tools that only read data load just these. */
export type DatabaseConfig = Pick<
  Config,
  | 'appEnv'
  | 'clusters'
  | 'commonCluster'
  | 'defaultGroupCluster'
  | 'dbNamePrefix'
  | 'mongodbServerSelectionTimeoutMs'
  | 'mongodbMaxPoolSize'
>;

/**
 * Validates one MongoDB connection string variable.
 *
 * @param required When true a missing variable is an issue; otherwise it yields `null`.
 * @returns The secret, `null` for an optional variable that is unset, or `undefined` after recording an issue.
 */
function readMongoUri(
  env: Env,
  issues: ConfigIssue[],
  variable: string,
  appEnv: AppEnv | undefined,
  required: boolean,
): Secret | null | undefined {
  const raw = required ? env[variable] : optionalVariable(env, variable);
  if (raw === undefined) {
    if (required) {
      issues.push({ variable, reason: 'is required' });
      return undefined;
    }
    return null;
  }
  if (!raw.startsWith('mongodb://') && !raw.startsWith('mongodb+srv://')) {
    issues.push({ variable, reason: 'must start with mongodb:// or mongodb+srv://' });
    return undefined;
  }
  const problem = appEnv === 'production' ? tlsProblem(raw) : undefined;
  if (problem !== undefined) {
    issues.push({ variable, reason: problem });
    return undefined;
  }
  return new Secret(raw);
}

/**
 * Reads the cluster list and every connection string. Without `MONGODB_CLUSTERS` there is one cluster,
 * `cluster0`, from `MONGODB_URI`; with it, each id `x-y` reads `MONGODB_URI_X_Y` and the optional
 * `MONGODB_ANALYTICS_URI_X_Y`, and `MONGODB_URI` must be unset.
 *
 * @returns The clusters, or `undefined` after recording issues.
 */
function readClusters(env: Env, issues: ConfigIssue[], appEnv: AppEnv | undefined): ReadonlyMap<ClusterId, ClusterConfig> | undefined {
  const listRaw = optionalVariable(env, 'MONGODB_CLUSTERS');
  const clusters = new Map<ClusterId, ClusterConfig>();
  let valid = true;
  const readOne = (id: ClusterId, uriVariable: string, analyticsVariable: string): void => {
    const uri = readMongoUri(env, issues, uriVariable, appEnv, true);
    const analyticsUri = readMongoUri(env, issues, analyticsVariable, appEnv, false);
    if (uri === undefined || uri === null || analyticsUri === undefined) {
      valid = false;
    } else {
      clusters.set(id, { uri, analyticsUri });
    }
  };
  if (listRaw === undefined) {
    readOne(SINGLE_CLUSTER_ID, 'MONGODB_URI', 'MONGODB_ANALYTICS_URI');
    return valid ? clusters : undefined;
  }
  const ids = listRaw.split(',').map((entry) => entry.trim());
  if (ids.some((id) => !CLUSTER_ID.test(id))) {
    issues.push({ variable: 'MONGODB_CLUSTERS', reason: 'every id must match ^[a-z][a-z0-9-]{0,31}$' });
    return undefined;
  }
  if (ids.length > MAX_CLUSTERS) {
    issues.push({ variable: 'MONGODB_CLUSTERS', reason: `at most ${MAX_CLUSTERS} clusters are allowed` });
    return undefined;
  }
  if (new Set(ids).size !== ids.length) {
    issues.push({ variable: 'MONGODB_CLUSTERS', reason: 'ids must be unique' });
    return undefined;
  }
  if (optionalVariable(env, 'MONGODB_URI') !== undefined) {
    issues.push({ variable: 'MONGODB_URI', reason: 'must not be set together with MONGODB_CLUSTERS (use MONGODB_URI_<ID>)' });
    valid = false;
  }
  if (optionalVariable(env, 'MONGODB_ANALYTICS_URI') !== undefined) {
    issues.push({ variable: 'MONGODB_ANALYTICS_URI', reason: 'must not be set together with MONGODB_CLUSTERS (use MONGODB_ANALYTICS_URI_<ID>)' });
    valid = false;
  }
  for (const id of ids) {
    const suffix = id.toUpperCase().replaceAll('-', '_');
    readOne(id, `MONGODB_URI_${suffix}`, `MONGODB_ANALYTICS_URI_${suffix}`);
  }
  return valid ? clusters : undefined;
}

/**
 * Reads a cluster-id variable that must name a configured cluster.
 *
 * @returns The id, the fallback when unset, or `undefined` after recording an issue.
 */
function readClusterChoice(
  env: Env,
  issues: ConfigIssue[],
  variable: string,
  clusters: ReadonlyMap<ClusterId, ClusterConfig>,
  fallback: ClusterId,
): ClusterId | undefined {
  const raw = optionalVariable(env, variable);
  if (raw === undefined) {
    return fallback;
  }
  if (!clusters.has(raw)) {
    issues.push({ variable, reason: 'must be one of the ids in the cluster list' });
    return undefined;
  }
  return raw;
}

/**
 * Validates the database variables, recording every problem in `issues`.
 *
 * @returns The settings, or `undefined` when any of them is invalid.
 */
function readDatabaseConfig(env: Env, issues: ConfigIssue[]): DatabaseConfig | undefined {
  const appEnvRaw = env['APP_ENV'];
  let appEnv: AppEnv | undefined;
  if (appEnvRaw === undefined) {
    issues.push({ variable: 'APP_ENV', reason: 'is required' });
  } else if ((APP_ENVS as readonly string[]).includes(appEnvRaw)) {
    appEnv = appEnvRaw as AppEnv;
  } else {
    issues.push({ variable: 'APP_ENV', reason: `must be one of: ${APP_ENVS.join(', ')}` });
  }

  const clusters = readClusters(env, issues, appEnv);
  let commonCluster: ClusterId | undefined;
  let defaultGroupCluster: ClusterId | undefined;
  if (clusters !== undefined) {
    commonCluster = readClusterChoice(env, issues, 'MONGODB_COMMON_CLUSTER', clusters, [...clusters.keys()][0] as ClusterId);
    defaultGroupCluster = readClusterChoice(env, issues, 'MONGODB_DEFAULT_GROUP_CLUSTER', clusters, commonCluster ?? '');
  }

  const mongodbServerSelectionTimeoutMs = readInteger(
    env,
    issues,
    'MONGODB_SERVER_SELECTION_TIMEOUT_MS',
    5000,
    1000,
    60000,
  );
  const mongodbMaxPoolSize = readInteger(env, issues, 'MONGODB_MAX_POOL_SIZE', 20, 1, 500);

  const dbNamePrefix = optionalVariable(env, 'DB_NAME_PREFIX') ?? '';
  if (!DB_PREFIX.test(dbNamePrefix)) {
    issues.push({ variable: 'DB_NAME_PREFIX', reason: 'must match ^[A-Za-z0-9_-]{0,27}$ (database names are limited to 63 bytes)' });
  }

  if (
    appEnv === undefined ||
    clusters === undefined ||
    commonCluster === undefined ||
    defaultGroupCluster === undefined ||
    mongodbServerSelectionTimeoutMs === undefined ||
    mongodbMaxPoolSize === undefined ||
    !DB_PREFIX.test(dbNamePrefix)
  ) {
    return undefined;
  }
  return { appEnv, clusters, commonCluster, defaultGroupCluster, dbNamePrefix, mongodbServerSelectionTimeoutMs, mongodbMaxPoolSize };
}

/**
 * Reads and validates only the database settings (`APP_ENV`, the cluster variables, `DB_NAME_PREFIX`,
 * `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `MONGODB_MAX_POOL_SIZE`) with the same rules as
 * {@link loadConfig}, so that tools receive no secret they do not use (least privilege).
 *
 * @param env Environment variables.
 * @returns The validated database configuration.
 * @throws {ConfigError} When any of those variables is missing or invalid; names only, never values.
 */
export function loadDatabaseConfig(env: Env): DatabaseConfig {
  const issues: ConfigIssue[] = [];
  const database = readDatabaseConfig(env, issues);
  if (database === undefined) {
    throw new ConfigError(issues);
  }
  return database;
}

/**
 * Reads and validates the whole configuration from an environment map.
 * Pure: it never touches `process.env`, so it is trivially testable.
 * All problems are collected and reported together.
 *
 * @param env Environment variables (for example `process.env`).
 * @returns The validated configuration, deeply frozen.
 * @throws {ConfigError} When any variable is missing or invalid; the message names variables only.
 * @example
 * const config = loadConfig({ APP_ENV: 'development', MONGODB_URI: 'mongodb://localhost', LEGACY_PASSWORD_PEPPER: 'x', VERSION_HMAC_KEY: '<base64 of 32 bytes>' });
 */
export function loadConfig(env: Env): Config {
  const issues: ConfigIssue[] = [];

  const database = readDatabaseConfig(env, issues);
  const appEnv = database?.appEnv;
  // 0 asks the operating system for a free port: the tests use it so no other process can take the port between choosing and binding it.
  const port = readInteger(env, issues, 'PORT', 3000, 0, 65535);

  const host = readHost(env, issues);

  const trustProxy = readInteger(env, issues, 'TRUST_PROXY', 0, 0, 5);

  const corsRaw = env['CORS_ALLOWED_ORIGINS'] ?? '';
  const corsAllowedOrigins = corsRaw.trim() === '' ? [] : corsRaw.split(',').map((entry) => entry.trim());
  for (const entry of corsAllowedOrigins) {
    const reason = checkOrigin(entry);
    if (reason !== undefined) {
      issues.push({ variable: 'CORS_ALLOWED_ORIGINS', reason });
      break;
    }
  }

  const accessTokenTtlSeconds = readInteger(env, issues, 'ACCESS_TOKEN_TTL_SECONDS', 900, 1, Number.MAX_SAFE_INTEGER);
  const refreshIdleTtlSeconds = readInteger(env, issues, 'REFRESH_IDLE_TTL_SECONDS', 604800, 1, Number.MAX_SAFE_INTEGER);
  const sessionMaxTtlSeconds = readInteger(env, issues, 'SESSION_MAX_TTL_SECONDS', 2592000, 1, Number.MAX_SAFE_INTEGER);
  const refreshReuseGraceSeconds = readInteger(env, issues, 'REFRESH_REUSE_GRACE_SECONDS', 30, 0, 300);
  if (
    refreshIdleTtlSeconds !== undefined &&
    sessionMaxTtlSeconds !== undefined &&
    sessionMaxTtlSeconds < refreshIdleTtlSeconds
  ) {
    issues.push({
      variable: 'SESSION_MAX_TTL_SECONDS',
      reason: 'must be greater than or equal to REFRESH_IDLE_TTL_SECONDS',
    });
  }

  const requestTimeoutMs = readInteger(env, issues, 'REQUEST_TIMEOUT_MS', 30000, 1000, 300000);

  const shutdownDrainMs = readInteger(env, issues, 'SHUTDOWN_DRAIN_MS', 5000, 0, 20000);

  const rateLimitLoginPerUsername = readInteger(env, issues, 'RATE_LIMIT_LOGIN_PER_USERNAME', 5, 1, 100000);
  const rateLimitLoginPerIp = readInteger(env, issues, 'RATE_LIMIT_LOGIN_PER_IP', 15, 1, 100000);
  const rateLimitRefreshPerIp = readInteger(env, issues, 'RATE_LIMIT_REFRESH_PER_IP', 30, 1, 100000);
  const rateLimitUsernameCheckPerUser = readInteger(env, issues, 'RATE_LIMIT_USERNAME_CHECK_PER_USER', 15, 1, 100000);
  const rateLimitUserCredentialsPerUser = readInteger(env, issues, 'RATE_LIMIT_USER_CREDENTIALS_PER_USER', 20, 1, 100000);
  const rateLimitClientErrorsPerUser = readInteger(env, issues, 'RATE_LIMIT_CLIENT_ERRORS_PER_USER', 30, 1, 100000);
  const rateLimitApiPerUser = readInteger(env, issues, 'RATE_LIMIT_API_PER_USER', 300, 1, 100000);
  const rateLimitApiPerUserHour = readInteger(env, issues, 'RATE_LIMIT_API_PER_USER_HOUR', 2000, 1, 10_000_000);
  const rateLimitApiPerUserDay = readInteger(env, issues, 'RATE_LIMIT_API_PER_USER_DAY', 10_000, 1, 100_000_000);
  const rateLimitApiSustainedMode = readSustainedMode(env, issues);
  const requestOriginSignal = readOnOff(env, issues, 'REQUEST_ORIGIN_SIGNAL', 'on');
  const securityPolicyForceReport = readOnOff(env, issues, 'SECURITY_POLICY_FORCE_REPORT', 'off');
  if (rateLimitApiPerUser !== undefined && rateLimitApiPerUserHour !== undefined && rateLimitApiPerUserDay !== undefined && !(rateLimitApiPerUser <= rateLimitApiPerUserHour && rateLimitApiPerUserHour <= rateLimitApiPerUserDay)) {
    issues.push({ variable: 'RATE_LIMIT_API_PER_USER_HOUR', reason: 'the limits must grow with the window: RATE_LIMIT_API_PER_USER <= RATE_LIMIT_API_PER_USER_HOUR <= RATE_LIMIT_API_PER_USER_DAY' });
  }
  const rateLimitUnauthenticatedPerIp = readInteger(env, issues, 'RATE_LIMIT_UNAUTHENTICATED_PER_IP', 300, 1, 100000);
  const rateLimitMediaUploadPerUser = readInteger(env, issues, 'RATE_LIMIT_MEDIA_UPLOAD_PER_USER', 30, 1, 100000);
  const rateLimitMediaUploadPerUserDaily = readInteger(env, issues, 'RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY', 300, 1, 1_000_000);
  const rateLimitMediaUploadPerGroupDaily = readInteger(env, issues, 'RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY', 2000, 1, 1_000_000);
  const rateLimitApiPerStore = readInteger(env, issues, 'RATE_LIMIT_API_PER_STORE', 600, 1, 1_000_000);
  const rateLimitStoreActivationPerIp = readInteger(env, issues, 'RATE_LIMIT_STORE_ACTIVATION_PER_IP', 10, 1, 100000);
  const rateLimitStoreKeyAdminPerUser = readInteger(env, issues, 'RATE_LIMIT_STORE_KEY_ADMIN_PER_USER', 20, 1, 100000);
  const rateLimitStoreCatalogWritePerStore = readInteger(env, issues, 'RATE_LIMIT_STORE_CATALOG_WRITE_PER_STORE', 120, 1, 1_000_000);
  const rateLimitPublicCatalogWritePerKey = readInteger(env, issues, 'RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY', 60, 1, 1_000_000);
  const rateLimitApiKeyAdminPerUser = readInteger(env, issues, 'RATE_LIMIT_API_KEY_ADMIN_PER_USER', 20, 1, 100000);
  const rateLimitCountriesAdminPerUser = readInteger(env, issues, 'RATE_LIMIT_COUNTRIES_ADMIN_PER_USER', 30, 1, 100000);
  const rateLimitTrashAdminPerUser = readInteger(env, issues, 'RATE_LIMIT_TRASH_ADMIN_PER_USER', 30, 1, 100000);
  const rateLimitActivationsAdminPerUser = readInteger(env, issues, 'RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER', 30, 1, 100000);
  const rateLimitActivationsExportPerUser = readInteger(env, issues, 'RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER', 5, 1, 100000);
  const publicApiDefaultRateLimitPerMinute = readInteger(env, issues, 'PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE', 60, PUBLIC_API_MIN_LIMIT, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE);
  const publicApiDefaultDailyQuota = readInteger(env, issues, 'PUBLIC_API_DEFAULT_DAILY_QUOTA', 10_000, PUBLIC_API_MIN_LIMIT, PUBLIC_API_MAX_DAILY_QUOTA);
  const publicApiDefaultGroupRateLimitPerMinute = readInteger(env, issues, 'PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE', 120, PUBLIC_API_MIN_LIMIT, PUBLIC_API_MAX_RATE_LIMIT_PER_MINUTE);
  const publicApiDefaultGroupDailyQuota = readInteger(env, issues, 'PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA', 20_000, PUBLIC_API_MIN_LIMIT, PUBLIC_API_MAX_DAILY_QUOTA);
  const rateLimitUnauthenticatedPublicPerIp = readInteger(env, issues, 'RATE_LIMIT_UNAUTHENTICATED_PUBLIC_PER_IP', 300, 1, 100000);
  const publicApiUsageFlushSeconds = readInteger(env, issues, 'PUBLIC_API_USAGE_FLUSH_SECONDS', 30, 1, 3600);
  const rateLimitDiagnosticsExportPerUser = readInteger(env, issues, 'RATE_LIMIT_DIAGNOSTICS_EXPORT_PER_USER', 5, 1, 100000);
  const rateLimitErrorDocumentsExportPerUser = readInteger(env, issues, 'RATE_LIMIT_ERROR_DOCUMENTS_EXPORT_PER_USER', 5, 1, 100000);
  const rateLimitTobaccosImportPerUser = readInteger(env, issues, 'RATE_LIMIT_TOBACCOS_IMPORT_PER_USER', 5, 1, 100000);
  const rateLimitCervedLookupPerUser = readInteger(env, issues, 'RATE_LIMIT_CERVED_LOOKUP_PER_USER', 10, 1, 100000);
  const rateLimitCervedLookupPerUserDaily = readInteger(env, issues, 'RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY', 200, 1, 1_000_000);
  const cervedApiKey = readCervedKey(env, issues);
  const cervedBaseUrl = readCervedBaseUrl(env, issues, appEnv);
  const storeActivationCodeTtlMinutes = readInteger(env, issues, 'STORE_ACTIVATION_CODE_TTL_MINUTES', 1440, 5, 10080);
  const groupFilesHost = readFilesHost(env, issues);
  const media = readMedia(env, issues);
  const activityLogRetentionDays = readInteger(env, issues, 'ACTIVITY_LOG_RETENTION_DAYS', 365, 1, 3650);
  const activityLogErrorRetentionDays = readInteger(env, issues, 'ACTIVITY_LOG_ERROR_RETENTION_DAYS', 90, 1, 3650);

  const pepperRaw = env['LEGACY_PASSWORD_PEPPER'];
  let legacyPasswordPepper: Secret | undefined;
  if (pepperRaw === undefined) {
    issues.push({ variable: 'LEGACY_PASSWORD_PEPPER', reason: 'is required' });
  } else if (pepperRaw === '' || pepperRaw !== pepperRaw.trim()) {
    issues.push({
      variable: 'LEGACY_PASSWORD_PEPPER',
      reason: 'must not be empty nor have leading or trailing whitespace',
    });
  } else {
    legacyPasswordPepper = new Secret(pepperRaw);
  }

  const versionKeyRaw = env['VERSION_HMAC_KEY'];
  let versionHmacKey: Secret | undefined;
  if (versionKeyRaw === undefined || versionKeyRaw === '') {
    issues.push({ variable: 'VERSION_HMAC_KEY', reason: 'is required' });
  } else if (!/^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+)$/.test(versionKeyRaw) || Buffer.from(versionKeyRaw, 'base64').length < 32) {
    issues.push({ variable: 'VERSION_HMAC_KEY', reason: 'must be base64 or base64url text of at least 32 bytes' });
  } else {
    versionHmacKey = new Secret(versionKeyRaw);
  }

  const apiPublicBaseUrl = readApiPublicBaseUrl(env, issues);

  const coexistenceRaw = optionalVariable(env, 'LEGACY_PASSWORD_COEXISTENCE');
  let legacyPasswordCoexistence: boolean | undefined = true;
  if (coexistenceRaw === 'true' || coexistenceRaw === 'false') {
    legacyPasswordCoexistence = coexistenceRaw === 'true';
  } else if (coexistenceRaw !== undefined) {
    legacyPasswordCoexistence = undefined;
    issues.push({ variable: 'LEGACY_PASSWORD_COEXISTENCE', reason: 'must be true or false' });
  }

  if (
    issues.length > 0 ||
    database === undefined ||
    port === undefined ||
    trustProxy === undefined ||
    accessTokenTtlSeconds === undefined ||
    refreshIdleTtlSeconds === undefined ||
    sessionMaxTtlSeconds === undefined ||
    refreshReuseGraceSeconds === undefined ||
    requestTimeoutMs === undefined ||
    shutdownDrainMs === undefined ||
    legacyPasswordPepper === undefined ||
    versionHmacKey === undefined ||
    apiPublicBaseUrl === undefined ||
    legacyPasswordCoexistence === undefined ||
    rateLimitLoginPerUsername === undefined ||
    rateLimitLoginPerIp === undefined ||
    rateLimitRefreshPerIp === undefined ||
    rateLimitUsernameCheckPerUser === undefined ||
    rateLimitUserCredentialsPerUser === undefined ||
    rateLimitClientErrorsPerUser === undefined ||
    rateLimitApiPerUser === undefined ||
    rateLimitApiPerUserHour === undefined ||
    rateLimitApiPerUserDay === undefined ||
    rateLimitApiSustainedMode === undefined ||
    requestOriginSignal === undefined ||
    securityPolicyForceReport === undefined ||
    rateLimitUnauthenticatedPerIp === undefined ||
    rateLimitMediaUploadPerUser === undefined ||
    rateLimitMediaUploadPerUserDaily === undefined ||
    rateLimitMediaUploadPerGroupDaily === undefined ||
    rateLimitApiPerStore === undefined ||
    rateLimitStoreActivationPerIp === undefined ||
    rateLimitStoreKeyAdminPerUser === undefined ||
    rateLimitStoreCatalogWritePerStore === undefined ||
    rateLimitPublicCatalogWritePerKey === undefined ||
    rateLimitApiKeyAdminPerUser === undefined ||
    rateLimitCountriesAdminPerUser === undefined ||
    rateLimitTrashAdminPerUser === undefined ||
    rateLimitActivationsAdminPerUser === undefined ||
    rateLimitActivationsExportPerUser === undefined ||
    publicApiDefaultRateLimitPerMinute === undefined ||
    publicApiDefaultDailyQuota === undefined ||
    publicApiDefaultGroupRateLimitPerMinute === undefined ||
    publicApiDefaultGroupDailyQuota === undefined ||
    rateLimitUnauthenticatedPublicPerIp === undefined ||
    publicApiUsageFlushSeconds === undefined ||
    rateLimitDiagnosticsExportPerUser === undefined ||
    rateLimitErrorDocumentsExportPerUser === undefined ||
    rateLimitTobaccosImportPerUser === undefined ||
    rateLimitCervedLookupPerUser === undefined ||
    rateLimitCervedLookupPerUserDaily === undefined ||
    cervedApiKey === undefined ||
    cervedBaseUrl === undefined ||
    storeActivationCodeTtlMinutes === undefined ||
    groupFilesHost === undefined ||
    media === undefined ||
    activityLogRetentionDays === undefined ||
    activityLogErrorRetentionDays === undefined
  ) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    ...database,
    port,
    host,
    trustProxy,
    corsAllowedOrigins: Object.freeze(corsAllowedOrigins),
    accessTokenTtlSeconds,
    refreshIdleTtlSeconds,
    sessionMaxTtlSeconds,
    refreshReuseGraceSeconds,
    shutdownDrainMs,
    requestTimeoutMs,
    legacyPasswordPepper,
    versionHmacKey,
    apiPublicBaseUrl,
    legacyPasswordCoexistence,
    rateLimitLoginPerUsername,
    rateLimitLoginPerIp,
    rateLimitRefreshPerIp,
    rateLimitUsernameCheckPerUser,
    rateLimitUserCredentialsPerUser,
    rateLimitClientErrorsPerUser,
    rateLimitApiPerUser,
    rateLimitApiPerUserHour,
    rateLimitApiPerUserDay,
    rateLimitApiSustainedMode,
    requestOriginSignal,
    securityPolicyForceReport,
    rateLimitUnauthenticatedPerIp,
    rateLimitMediaUploadPerUser,
    rateLimitMediaUploadPerUserDaily,
    rateLimitMediaUploadPerGroupDaily,
    rateLimitApiPerStore,
    rateLimitStoreActivationPerIp,
    rateLimitStoreKeyAdminPerUser,
    rateLimitStoreCatalogWritePerStore,
    rateLimitPublicCatalogWritePerKey,
    rateLimitApiKeyAdminPerUser,
    rateLimitCountriesAdminPerUser,
    rateLimitTrashAdminPerUser,
    rateLimitActivationsAdminPerUser,
    rateLimitActivationsExportPerUser,
    publicApiDefaultRateLimitPerMinute,
    publicApiDefaultDailyQuota,
    publicApiDefaultGroupRateLimitPerMinute,
    publicApiDefaultGroupDailyQuota,
    rateLimitUnauthenticatedPublicPerIp,
    publicApiUsageFlushSeconds,
    rateLimitDiagnosticsExportPerUser,
    rateLimitErrorDocumentsExportPerUser,
    rateLimitTobaccosImportPerUser,
    rateLimitCervedLookupPerUser,
    rateLimitCervedLookupPerUserDaily,
    cervedApiKey,
    cervedBaseUrl,
    storeActivationCodeTtlMinutes,
    groupFilesHost,
    media,
    activityLogRetentionDays,
    activityLogErrorRetentionDays,
  });
}
