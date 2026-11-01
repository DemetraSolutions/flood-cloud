import { Secret } from './shared/security/secret.ts';

/** Execution environments accepted for `APP_ENV`. */
export const APP_ENVS = ['development', 'production'] as const;

/** Execution environment of the process. */
export type AppEnv = (typeof APP_ENVS)[number];

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
  /** MongoDB connection string (`MONGODB_URI`), wrapped because it is a secret. */
  readonly mongodbUri: Secret;
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
  /** Pause between the shutdown signal and the closing of the server (`SHUTDOWN_DRAIN_MS`). */
  readonly shutdownDrainMs: number;
  /** Request timeout in milliseconds (`REQUEST_TIMEOUT_MS`). */
  readonly requestTimeoutMs: number;
  /** Pepper of the legacy password hashes (`LEGACY_PASSWORD_PEPPER`), a secret. */
  readonly legacyPasswordPepper: Secret;
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
function checkOrigin(entry: string, appEnv: string | undefined): string | undefined {
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
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && appEnv === 'development') {
    return undefined;
  }
  return 'https is required (http is allowed only for localhost and 127.0.0.1 when APP_ENV=development)';
}

/** The settings needed to open the databases; tools that only read data load just these. */
export type DatabaseConfig = Pick<
  Config,
  'appEnv' | 'mongodbUri' | 'dbNamePrefix' | 'mongodbServerSelectionTimeoutMs' | 'mongodbMaxPoolSize'
>;

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

  const mongoRaw = env['MONGODB_URI'];
  let mongodbUri: Secret | undefined;
  if (mongoRaw === undefined) {
    issues.push({ variable: 'MONGODB_URI', reason: 'is required' });
  } else if (mongoRaw.startsWith('mongodb://') || mongoRaw.startsWith('mongodb+srv://')) {
    const problem = appEnv === 'production' ? tlsProblem(mongoRaw) : undefined;
    if (problem !== undefined) {
      issues.push({ variable: 'MONGODB_URI', reason: problem });
    } else {
      mongodbUri = new Secret(mongoRaw);
    }
  } else {
    issues.push({ variable: 'MONGODB_URI', reason: 'must start with mongodb:// or mongodb+srv://' });
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
    mongodbUri === undefined ||
    mongodbServerSelectionTimeoutMs === undefined ||
    mongodbMaxPoolSize === undefined ||
    !DB_PREFIX.test(dbNamePrefix)
  ) {
    return undefined;
  }
  return { appEnv, mongodbUri, dbNamePrefix, mongodbServerSelectionTimeoutMs, mongodbMaxPoolSize };
}

/**
 * Reads and validates only the database settings (`APP_ENV`, `MONGODB_URI`, `DB_NAME_PREFIX`,
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
 * const config = loadConfig({ APP_ENV: 'development', MONGODB_URI: 'mongodb://localhost', LEGACY_PASSWORD_PEPPER: 'x' });
 */
export function loadConfig(env: Env): Config {
  const issues: ConfigIssue[] = [];

  const database = readDatabaseConfig(env, issues);
  const appEnv = database?.appEnv;
  const port = readInteger(env, issues, 'PORT', 3000, 1, 65535);

  const trustProxy = readInteger(env, issues, 'TRUST_PROXY', 0, 0, 5);

  const corsRaw = env['CORS_ALLOWED_ORIGINS'] ?? '';
  const corsAllowedOrigins = corsRaw.trim() === '' ? [] : corsRaw.split(',').map((entry) => entry.trim());
  for (const entry of corsAllowedOrigins) {
    const reason = checkOrigin(entry, appEnv);
    if (reason !== undefined) {
      issues.push({ variable: 'CORS_ALLOWED_ORIGINS', reason });
      break;
    }
  }

  const accessTokenTtlSeconds = readInteger(env, issues, 'ACCESS_TOKEN_TTL_SECONDS', 900, 1, Number.MAX_SAFE_INTEGER);
  const refreshIdleTtlSeconds = readInteger(env, issues, 'REFRESH_IDLE_TTL_SECONDS', 604800, 1, Number.MAX_SAFE_INTEGER);
  const sessionMaxTtlSeconds = readInteger(env, issues, 'SESSION_MAX_TTL_SECONDS', 2592000, 1, Number.MAX_SAFE_INTEGER);
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

  if (
    issues.length > 0 ||
    database === undefined ||
    port === undefined ||
    trustProxy === undefined ||
    accessTokenTtlSeconds === undefined ||
    refreshIdleTtlSeconds === undefined ||
    sessionMaxTtlSeconds === undefined ||
    requestTimeoutMs === undefined ||
    shutdownDrainMs === undefined ||
    legacyPasswordPepper === undefined
  ) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    ...database,
    port,
    trustProxy,
    corsAllowedOrigins: Object.freeze(corsAllowedOrigins),
    accessTokenTtlSeconds,
    refreshIdleTtlSeconds,
    sessionMaxTtlSeconds,
    shutdownDrainMs,
    requestTimeoutMs,
    legacyPasswordPepper,
  });
}
