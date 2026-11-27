import { HUB_PATTERN, parseHub } from './accounts/hub.ts';
import { parsePrivateKey } from './accounts/credentials.ts';
import type { KeyObject } from 'node:crypto';
import { Secret } from './secret.ts';

/** Execution environments accepted for `APP_ENV` (the same set as the backend). */
export const APP_ENVS = ['development', 'production'] as const;

/** Execution environment of the process. */
export type AppEnv = (typeof APP_ENVS)[number];

/** Aruba environments accepted for `ARUBA_ENVIRONMENT`: the demo hosts or the production ones. */
export const ARUBA_ENVIRONMENTS = ['demo', 'production'] as const;

/** Aruba environment the adapter talks to. */
export type ArubaEnvironment = (typeof ARUBA_ENVIRONMENTS)[number];

/** Log levels, from the most to the least verbose. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Minimum severity written by the logger. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Operating modes accepted for `WORKER_MODE`: `shadow` only analyses the queue, `send` sends to the providers. */
export const WORKER_MODES = ['shadow', 'send'] as const;

/** Operating mode of the worker. */
export type WorkerMode = (typeof WORKER_MODES)[number];

/** The hubs the shadow mode analyses: every hub (`*`) or an allowlist (empty means none). */
export type ShadowHubs = '*' | readonly string[];

/** One configuration problem: the variable and the reason, never the value. */
export interface ConfigIssue {
  readonly variable: string;
  readonly reason: string;
}

/** Validated configuration of the worker. */
export interface Config {
  /** Execution environment (`APP_ENV`). */
  readonly appEnv: AppEnv;
  /** Connection string of the common cluster, a secret. */
  readonly mongodbUri: Secret;
  /** Prefix of every database name (`DB_NAME_PREFIX`). */
  readonly dbNamePrefix: string;
  /** Identity of this instance in the lease. */
  readonly instanceId: string;
  /** Lease lifetime in milliseconds. */
  readonly leaseTtlMs: number;
  /** Lease renewal and acquisition period in milliseconds (less than half of {@link Config.leaseTtlMs}). */
  readonly leaseRenewMs: number;
  /** Pause between two rounds of jobs in milliseconds. */
  readonly loopIntervalMs: number;
  /** TCP port of the liveness probe. */
  readonly healthPort: number;
  /** Maximum age of the last tick, in milliseconds, before the probe fails. */
  readonly healthStaleMs: number;
  /** Minimum log level. */
  readonly logLevel: LogLevel;
  /** Operating mode (`WORKER_MODE`, default `shadow`): in `shadow` nothing is ever sent and no credential is read. */
  readonly workerMode: WorkerMode;
  /** Hubs this worker may process in `send` mode (`WORKER_HUBS`); empty means it processes nothing. */
  readonly workerHubs: readonly string[];
  /** Hubs the `shadow` mode analyses (`SHADOW_HUBS`): `*` for all, a list, or empty for none. */
  readonly shadowHubs: ShadowHubs;
  /** Most queue records the `shadow` mode analyses per round (`SHADOW_BATCH`). */
  readonly shadowBatch: number;
  /** How far back the `shadow` mode looks, in days (`SHADOW_LOOKBACK_DAYS`): older queue records are ignored. */
  readonly shadowLookbackDays: number;
  /** Identifier of the build (`BUILD_SHA`, the image tag), part of the shadow code version; `undefined` when unset. */
  readonly buildSha: string | undefined;
  /** Private key and id of the credentials (`CREDENTIALS_PRIVATE_KEY`, `CREDENTIALS_PRIVATE_KEY_ID`); only the parsed key object is kept, never the PEM text; present whenever a hub is enabled. */
  readonly credentials: { readonly privateKey: KeyObject; readonly keyId: string } | undefined;
  /** Aruba environment (`ARUBA_ENVIRONMENT`); present whenever an `aruba` hub is enabled. */
  readonly arubaEnvironment: ArubaEnvironment | undefined;
  /** How often the provider accounts are read again, in milliseconds. */
  readonly accountsRefreshMs: number;
  /** Lifetime of the claim on a queue record, in milliseconds. */
  readonly recordLeaseMs: number;
  /** Time budget of one round of the engine jobs, in milliseconds (at startup the worker lowers it to {@link Config.healthStaleMs} minus the longest provider call and a margin). */
  readonly tickBudgetMs: number;
}

/** Outcome of {@link loadConfig}: the configuration or every problem found. */
export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Environment variables as read from `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

const DECIMAL = /^[0-9]{1,15}$/;
const DB_PREFIX = /^[A-Za-z0-9_-]{0,27}$/;
const INSTANCE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;
const MAX_HUBS = 100;
const BUILD_SHA = /^[A-Za-z0-9._-]{1,64}$/;
const INSECURE_TLS_OPTIONS = new Set([
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
  'tlsinsecure',
  'tlsdisableocspendpointcheck',
  'tlsdisablecertificaterevocationcheck',
  'sslvalidate',
]);

/** Reads an optional variable: unset and the empty string both mean "use the default". */
function optionalVariable(env: Env, variable: string): string | undefined {
  const raw = env[variable];
  return raw === '' ? undefined : raw;
}

/** Reads an optional decimal integer in `[min, max]`; records an issue and returns `undefined` if invalid. */
function readInteger(env: Env, issues: ConfigIssue[], variable: string, fallback: number, min: number, max: number): number | undefined {
  const raw = optionalVariable(env, variable);
  if (raw === undefined) {
    return fallback;
  }
  const value = DECIMAL.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    issues.push({ variable, reason: `must be a decimal integer between ${min} and ${max}` });
    return undefined;
  }
  return value;
}

/**
 * Checks the TLS requirements of a production MongoDB URI (option names are case-insensitive).
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

/** Reads and validates `MONGODB_URI`. */
function readMongoUri(env: Env, issues: ConfigIssue[], appEnv: AppEnv | undefined): Secret | undefined {
  const raw = optionalVariable(env, 'MONGODB_URI');
  if (raw === undefined) {
    issues.push({ variable: 'MONGODB_URI', reason: 'is required' });
    return undefined;
  }
  if (!raw.startsWith('mongodb://') && !raw.startsWith('mongodb+srv://')) {
    issues.push({ variable: 'MONGODB_URI', reason: 'must start with mongodb:// or mongodb+srv://' });
    return undefined;
  }
  const problem = appEnv === 'production' ? tlsProblem(raw) : undefined;
  if (problem !== undefined) {
    issues.push({ variable: 'MONGODB_URI', reason: problem });
    return undefined;
  }
  return new Secret(raw);
}

/** Reads a comma-separated allowlist of hubs (`WORKER_HUBS`, `SHADOW_HUBS`), empty or absent meaning none. */
function readHubList(env: Env, issues: ConfigIssue[], variable: string): string[] {
  const raw = optionalVariable(env, variable);
  const entries = (raw ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const hubs = [...new Set(entries)];
  if (hubs.some((hub) => !HUB_PATTERN.test(hub))) {
    issues.push({ variable, reason: 'must be a comma-separated list of hubs: <provider> or <provider>__<24 hexadecimal characters>' });
  } else if (hubs.length > MAX_HUBS) {
    issues.push({ variable, reason: `must list at most ${MAX_HUBS} hubs` });
  }
  return hubs;
}

/** Reads `SHADOW_HUBS`: `*` alone for every hub, otherwise a list of hubs. */
function readShadowHubs(env: Env, issues: ConfigIssue[]): ShadowHubs {
  if (optionalVariable(env, 'SHADOW_HUBS')?.trim() === '*') {
    return '*';
  }
  return readHubList(env, issues, 'SHADOW_HUBS');
}

/** Reads `WORKER_MODE`: `shadow` (the default) or `send`. */
function readMode(env: Env, issues: ConfigIssue[]): WorkerMode {
  const raw = optionalVariable(env, 'WORKER_MODE') ?? 'shadow';
  if (!(WORKER_MODES as readonly string[]).includes(raw)) {
    issues.push({ variable: 'WORKER_MODE', reason: `must be one of: ${WORKER_MODES.join(', ')}` });
    return 'shadow';
  }
  return raw as WorkerMode;
}

/** Reads `BUILD_SHA`: optional, a short token (the image tag). */
function readBuildSha(env: Env, issues: ConfigIssue[]): string | undefined {
  const raw = optionalVariable(env, 'BUILD_SHA');
  if (raw !== undefined && !BUILD_SHA.test(raw)) {
    issues.push({ variable: 'BUILD_SHA', reason: 'must match ^[A-Za-z0-9._-]{1,64}$' });
    return undefined;
  }
  return raw;
}

/** Reads the private key of the credentials and its id: both or none, and both whenever a hub is enabled. */
function readCredentials(env: Env, issues: ConfigIssue[], hubsEnabled: boolean): Config['credentials'] {
  const pem = optionalVariable(env, 'CREDENTIALS_PRIVATE_KEY');
  const keyId = optionalVariable(env, 'CREDENTIALS_PRIVATE_KEY_ID');
  if (pem === undefined && keyId === undefined && !hubsEnabled) {
    return undefined;
  }
  let privateKey: KeyObject | undefined;
  if (pem === undefined) {
    issues.push({ variable: 'CREDENTIALS_PRIVATE_KEY', reason: 'is required with CREDENTIALS_PRIVATE_KEY_ID or when WORKER_HUBS is not empty' });
  } else {
    try {
      privateKey = parsePrivateKey(pem);
    } catch (error) {
      issues.push({ variable: 'CREDENTIALS_PRIVATE_KEY', reason: `must be a PEM PKCS#8 X25519 private key (${(error as Error).message})` });
    }
  }
  if (keyId === undefined) {
    issues.push({ variable: 'CREDENTIALS_PRIVATE_KEY_ID', reason: 'is required with CREDENTIALS_PRIVATE_KEY or when WORKER_HUBS is not empty' });
    return undefined;
  }
  if (!KEY_ID.test(keyId)) {
    issues.push({ variable: 'CREDENTIALS_PRIVATE_KEY_ID', reason: 'must match ^[a-z0-9-]{1,32}$' });
    return undefined;
  }
  return privateKey === undefined ? undefined : { privateKey, keyId };
}

/** Reads `ARUBA_ENVIRONMENT`: required when a hub of the `aruba` provider is enabled, valid whenever present. */
function readArubaEnvironment(env: Env, issues: ConfigIssue[], hubs: readonly string[]): ArubaEnvironment | undefined {
  const raw = optionalVariable(env, 'ARUBA_ENVIRONMENT');
  if (raw === undefined) {
    if (hubs.some((hub) => parseHub(hub).provider === 'aruba')) {
      issues.push({ variable: 'ARUBA_ENVIRONMENT', reason: 'is required when an aruba hub is enabled in WORKER_HUBS' });
    }
    return undefined;
  }
  if (!(ARUBA_ENVIRONMENTS as readonly string[]).includes(raw)) {
    issues.push({ variable: 'ARUBA_ENVIRONMENT', reason: `must be one of: ${ARUBA_ENVIRONMENTS.join(', ')}` });
    return undefined;
  }
  return raw as ArubaEnvironment;
}

/**
 * Validates the environment of the worker. Pure: it never touches `process.env`.
 * Every problem is reported together, and a problem never contains the offending value.
 *
 * @param env Environment variables (for example `process.env`).
 * @returns The configuration, or the list of issues (variable and reason only).
 * @example
 * const result = loadConfig({ APP_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1', WORKER_INSTANCE_ID: 'w-0' });
 */
export function loadConfig(env: Env): ConfigResult {
  const issues: ConfigIssue[] = [];

  const appEnvRaw = env['APP_ENV'];
  let appEnv: AppEnv | undefined;
  if (appEnvRaw === undefined) {
    issues.push({ variable: 'APP_ENV', reason: 'is required' });
  } else if ((APP_ENVS as readonly string[]).includes(appEnvRaw)) {
    appEnv = appEnvRaw as AppEnv;
  } else {
    issues.push({ variable: 'APP_ENV', reason: `must be one of: ${APP_ENVS.join(', ')}` });
  }

  const mongodbUri = readMongoUri(env, issues, appEnv);

  const dbNamePrefix = optionalVariable(env, 'DB_NAME_PREFIX') ?? '';
  const prefixValid = DB_PREFIX.test(dbNamePrefix);
  if (!prefixValid) {
    issues.push({ variable: 'DB_NAME_PREFIX', reason: 'must match ^[A-Za-z0-9_-]{0,27}$ (database names are limited to 63 bytes)' });
  }

  const instanceId = optionalVariable(env, 'WORKER_INSTANCE_ID');
  let validInstanceId: string | undefined;
  if (instanceId === undefined) {
    issues.push({ variable: 'WORKER_INSTANCE_ID', reason: 'is required' });
  } else if (!INSTANCE_ID.test(instanceId)) {
    issues.push({ variable: 'WORKER_INSTANCE_ID', reason: 'must match ^[A-Za-z0-9._-]{1,128}$' });
  } else {
    validInstanceId = instanceId;
  }

  const leaseTtlMs = readInteger(env, issues, 'LEASE_TTL_MS', 30_000, 10_000, 300_000);
  const leaseRenewMs = readInteger(env, issues, 'LEASE_RENEW_MS', 10_000, 1_000, 300_000);
  if (leaseTtlMs !== undefined && leaseRenewMs !== undefined && leaseRenewMs >= leaseTtlMs / 2) {
    issues.push({ variable: 'LEASE_RENEW_MS', reason: 'must be less than half of LEASE_TTL_MS' });
  }
  const loopIntervalMs = readInteger(env, issues, 'LOOP_INTERVAL_MS', 5_000, 1_000, 600_000);
  const healthPort = readInteger(env, issues, 'HEALTH_PORT', 8080, 1, 65_535);
  const healthStaleMs = readInteger(env, issues, 'HEALTH_STALE_MS', 180_000, 1_000, 3_600_000);
  if (loopIntervalMs !== undefined && healthStaleMs !== undefined && healthStaleMs <= loopIntervalMs) {
    issues.push({ variable: 'HEALTH_STALE_MS', reason: 'must be greater than LOOP_INTERVAL_MS' });
  }

  const logLevelRaw = optionalVariable(env, 'LOG_LEVEL') ?? 'info';
  const logLevelValid = (LOG_LEVELS as readonly string[]).includes(logLevelRaw);
  if (!logLevelValid) {
    issues.push({ variable: 'LOG_LEVEL', reason: `must be one of: ${LOG_LEVELS.join(', ')}` });
  }

  const workerMode = readMode(env, issues);
  const workerHubs = readHubList(env, issues, 'WORKER_HUBS');
  // The shadow settings are validated only in shadow mode: in send mode they are ignored, whatever they hold.
  const shadowing = workerMode === 'shadow';
  const shadowHubs: ShadowHubs = shadowing ? readShadowHubs(env, issues) : [];
  const shadowBatch = shadowing ? readInteger(env, issues, 'SHADOW_BATCH', 50, 1, 1_000) : 50;
  const shadowLookbackDays = shadowing ? readInteger(env, issues, 'SHADOW_LOOKBACK_DAYS', 30, 1, 365) : 30;
  const buildSha = readBuildSha(env, issues);
  // The shadow mode never decrypts a credential nor calls a provider: it neither needs nor reads the key and the Aruba environment.
  const sending = workerMode === 'send';
  const credentials = sending ? readCredentials(env, issues, workerHubs.length > 0) : undefined;
  const arubaEnvironment = sending ? readArubaEnvironment(env, issues, workerHubs) : undefined;
  const accountsRefreshMs = readInteger(env, issues, 'ACCOUNTS_REFRESH_MS', 120_000, 10_000, 3_600_000);
  const recordLeaseMs = readInteger(env, issues, 'RECORD_LEASE_MS', 240_000, 30_000, 900_000);
  const tickBudgetMs = readInteger(env, issues, 'TICK_BUDGET_MS', 30_000, 2_000, 600_000);
  if (recordLeaseMs !== undefined && tickBudgetMs !== undefined && recordLeaseMs <= tickBudgetMs) {
    issues.push({ variable: 'RECORD_LEASE_MS', reason: 'must be greater than TICK_BUDGET_MS' });
  }

  if (
    issues.length > 0 ||
    appEnv === undefined ||
    mongodbUri === undefined ||
    validInstanceId === undefined ||
    leaseTtlMs === undefined ||
    leaseRenewMs === undefined ||
    loopIntervalMs === undefined ||
    healthPort === undefined ||
    healthStaleMs === undefined ||
    shadowBatch === undefined ||
    shadowLookbackDays === undefined ||
    accountsRefreshMs === undefined ||
    recordLeaseMs === undefined ||
    tickBudgetMs === undefined
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    config: {
      appEnv,
      mongodbUri,
      dbNamePrefix,
      instanceId: validInstanceId,
      leaseTtlMs,
      leaseRenewMs,
      loopIntervalMs,
      healthPort,
      healthStaleMs,
      logLevel: logLevelRaw as LogLevel,
      workerMode,
      workerHubs,
      shadowHubs,
      shadowBatch,
      shadowLookbackDays,
      buildSha,
      credentials,
      arubaEnvironment,
      accountsRefreshMs,
      recordLeaseMs,
      tickBudgetMs,
    },
  };
}
