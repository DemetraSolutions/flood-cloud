import { randomBytes } from 'node:crypto';
import type { Document, ObjectId } from 'mongodb';
import { createBackofficeModules, createPublicApiModules } from '../../src/composition.ts';
import type { UsageMeter } from '../../src/modules/api-keys/usage-meter.ts';
import type { IntegrationsDeps } from '../../src/integrations/index.ts';
import type { CervedHttpOptions } from '../../src/integrations/cerved/index.ts';
import type { MediaStorage } from '../../src/infrastructure/gcs/index.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { newBrowserKey, signProof } from './dpop.ts';
import type { BrowserKey } from './dpop.ts';
import { memoryActivityLog, memoryRateLimiter } from './activity.ts';
import type { MemoryActivityLog } from './activity.ts';
import { memoryLogger, startApp, testConfig } from './app.ts';
import type { TestServer } from './app.ts';
import { seedIsolationCluster } from './isolation.ts';
import { legacyUser } from './legacy-fixtures.ts';
import type { IsolationCluster } from './isolation.ts';
import type { TestDatabases } from './mongo.ts';
import { COLLECTIONS } from '../../src/db/collections.ts';

/** Pepper of the fixtures' legacy password hashes (throw-away). */
export const TEST_PEPPER = randomBytes(16).toString('hex');

/** The password every seeded user has, as a legacy hash (throw-away value, valid for the policy). */
export const TEST_PASSWORD = `pw-${randomBytes(8).toString('hex')}-fixture`;

/** The legacy hash of a password, with the fixtures' pepper. */
export function hashWithTestPepper(password: string): string {
  return legacyPasswordHash(password, new Secret(TEST_PEPPER));
}

/** Tokens returned by the login and refresh. */
export interface Tokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly sessionId: string;
}

/** A manually moved clock. */
export interface Clock {
  now(): number;
  advance(ms: number): void;
}

/** What a test may change in the proof that {@link Backoffice.userHeaders} signs. */
export interface ProofOptions {
  /** Sign with this key instead of the one of the token. */
  readonly key?: BrowserKey;
  /** `iat` in seconds since the epoch; by default the clock of the app. */
  readonly iat?: number;
  /** `htm` of the proof; by default the method of the request. */
  readonly method?: string;
  /** Path of the proof (`htu`) relative to `/v1`; by default the one of the request. */
  readonly path?: string;
  /** Token the proof is bound to (`ath`) instead of the presented one. */
  readonly boundTo?: string;
}

/** The app under test with the real backoffice modules over a throw-away MongoDB. */
export interface Backoffice {
  readonly app: TestServer;
  readonly cluster: IsolationCluster;
  readonly activity: MemoryActivityLog;
  readonly clock: Clock;
  /** `POST /v1/auth/login` with the given user name and password (the shared test password by default). */
  login(userName: string, password?: string, headers?: Record<string, string>): Promise<Response>;
  /** Logs in and returns the tokens (the response must be a 200). */
  tokens(userName: string, headers?: Record<string, string>): Promise<Tokens>;
  /**
   * The `Authorization: DPoP` and `DPoP` headers of a request to `/v1` made with `accessToken`, signed with the key of the login that issued it (a token the helper does not know gets a fresh key).
   * For the requests a test builds by hand (uploads, wrong content types); `path` is relative to `/v1`.
   */
  userHeaders(method: string, path: string, accessToken: string, options?: ProofOptions): Record<string, string>;
  /** The browser key of the login (or refresh) that issued a token; a token the helper does not know gets a fresh key. */
  keyOf(token: string): BrowserKey;
  /**
   * A request to `/v1`. With an access token it carries `Authorization: DPoP` and a proof of the key of that token (a store key, `fc_sk_…`, is sent as a plain `Bearer`). The login and the refresh carry their own proof (a new key at each login, the key of the
   * refresh token at each refresh) and the helper remembers the key of the tokens they return.
   */
  call(method: string, path: string, accessToken: string | undefined, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** A request to `/public/v1` with an `X-Api-Key` (none when `apiKey` is `undefined`); the body of the response is not read. */
  publicCall(method: string, path: string, apiKey: string | undefined, headers?: Record<string, string>, body?: unknown): Promise<Response>;
  /** The usage meter of the public API (never started here: a test calls `flush`). */
  readonly meter: UsageMeter;
  /** Events of the application logger (parsed lines). */
  readonly logEvents: Array<Record<string, unknown>>;
  /** Stops the server. */
  close(): Promise<void>;
}

/** User names of the isolation cluster: `user-<n>` with n padded to three digits. */
export const userName = (id: ObjectId): string => `user-${String(parseInt(id.toHexString().slice(2), 16)).padStart(3, '0')}`;

/** Options of {@link startBackoffice}. */
export interface BackofficeOptions {
  /** Environment overrides for the configuration. */
  readonly env?: Record<string, string | undefined>;
  /** Limiter to use; a generous in-memory one by default. */
  readonly rateLimiter?: RateLimiter;
  /** Extra routes mounted on `/v1` next to the real ones. */
  readonly extraRoutes?: readonly RouteDefinition[];
  /** The media storage; none (the upload answers 503) by default. */
  readonly mediaStorage?: MediaStorage | null;
  /** The `fetch`, timeout and size limit of the calls to Cerved (its base URL and key are set through `env`). */
  readonly cervedHttp?: CervedHttpOptions;
  /** The `fetch`, timeout and size limit of the calls to every provider of the integrations module (their base URLs and keys are set through `env`); `cervedHttp` is the same for Cerved alone. */
  readonly integrationsHttp?: IntegrationsDeps['http'];
}

/** Thresholds high enough for tests that are not about rate limits. */
const GENEROUS = {
  RATE_LIMIT_LOGIN_PER_USERNAME: '100000',
  RATE_LIMIT_LOGIN_PER_IP: '100000',
  RATE_LIMIT_REFRESH_PER_IP: '100000',
  RATE_LIMIT_API_PER_USER: '100000',
  RATE_LIMIT_API_PER_USER_HOUR: '1000000',
  RATE_LIMIT_API_PER_USER_DAY: '10000000',
  RATE_LIMIT_USER_CREDENTIALS_PER_USER: '100000',
  RATE_LIMIT_UNAUTHENTICATED_PER_IP: '100000',
  RATE_LIMIT_API_PER_STORE: '100000',
  RATE_LIMIT_STORE_ACTIVATION_PER_IP: '100000',
  RATE_LIMIT_STORE_KEY_ADMIN_PER_USER: '100000',
  RATE_LIMIT_API_KEY_ADMIN_PER_USER: '100000',
  RATE_LIMIT_COUNTRIES_ADMIN_PER_USER: '100000',
  RATE_LIMIT_TRASH_ADMIN_PER_USER: '100000',
  RATE_LIMIT_ACTIVATIONS_ADMIN_PER_USER: '100000',
  RATE_LIMIT_ACTIVATIONS_EXPORT_PER_USER: '100000',
};

/**
 * Seeds the isolation cluster (every user with {@link TEST_PASSWORD}), applies the indexes and
 * starts the app with the real modules.
 *
 * @param ctx Throw-away databases.
 * @param options Environment, limiter and extra routes.
 */
export async function startBackoffice(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<Backoffice> {
  await ensureIndexes(ctx.databases, COLLECTIONS);
  const cluster = await seedIsolationCluster(ctx.databases);
  await ctx.databases.common().collection('users').updateMany({}, { $set: { password: hashWithTestPepper(TEST_PASSWORD) } });
  let current = Date.now();
  const clock: Clock = { now: () => current, advance: (ms) => void (current += ms) };
  const activity = memoryActivityLog();
  const env = { LEGACY_PASSWORD_PEPPER: TEST_PEPPER, ...GENEROUS, ...options.env };
  const config = testConfig(env);
  const logs = memoryLogger();
  const rateLimiter = options.rateLimiter ?? memoryRateLimiter();
  const modules = createBackofficeModules({ config, databases: ctx.databases, activityLog: activity, logger: logs.logger, now: clock.now, rateLimiter, mediaStorage: options.mediaStorage ?? null, ...(options.cervedHttp === undefined && options.integrationsHttp === undefined ? {} : { integrationsHttp: { ...(options.cervedHttp === undefined ? {} : { cerved: options.cervedHttp }), ...options.integrationsHttp } }) });
  const publicApi = createPublicApiModules({ config, databases: ctx.databases, activityLog: activity, logger: logs.logger, rateLimiter, catalog: modules.catalog, crm: modules.crm, now: clock.now });
  const app = await startApp(
    {
      config,
      logger: logs.logger,
      activityLog: activity,
      now: clock.now,
      rateLimiter,
      routes: { v1: [...modules.routes, ...(options.extraRoutes ?? [])], public: publicApi.routes },
      authenticate: { v1: modules.authenticate, store: modules.authenticateStore, public: publicApi.authenticate },
      groupAccess: { groups: modules.groups },
      securityPolicy: modules.securityPolicy,
      ...(modules.nonBrowserGuard === undefined ? {} : { nonBrowserGuard: modules.nonBrowserGuard }),
    },
    env,
  );
  const keys = new Map<string, BrowserKey>();
  const keyOf = (token: string): BrowserKey => {
    let key = keys.get(token);
    if (key === undefined) {
      key = newBrowserKey();
      keys.set(token, key);
    }
    return key;
  };
  const nowSeconds = (): number => Math.floor(clock.now() / 1000);
  const userHeaders: Backoffice['userHeaders'] = (method, path, accessToken, options = {}) => ({
    authorization: `DPoP ${accessToken}`,
    dpop: signProof(options.key ?? keyOf(accessToken), {
      method: options.method ?? method,
      path: `/v1${options.path ?? path}`,
      iat: options.iat ?? nowSeconds(),
      accessToken: options.boundTo ?? accessToken,
    }),
  });
  const call: Backoffice['call'] = async (method, path, accessToken, body, headers = {}) => {
    const refreshToken = (body as { refreshToken?: unknown } | undefined)?.refreshToken;
    const issuing = accessToken === undefined && method === 'POST' && (path === '/auth/login' || path === '/auth/refresh');
    const key = path === '/auth/refresh' && typeof refreshToken === 'string' ? keyOf(refreshToken) : newBrowserKey();
    const proof = (): Record<string, string> => ({
      dpop: signProof(key, { method, path: `/v1${path}`, iat: nowSeconds(), ...(path === '/auth/refresh' && typeof refreshToken === 'string' ? { refreshToken } : {}) }),
    });
    const response = await fetch(`${app.baseUrl}/v1${path}`, {
      method,
      headers: {
        ...(accessToken === undefined ? (issuing ? proof() : {}) : accessToken.startsWith('fc_sk_') ? { authorization: `Bearer ${accessToken}` } : userHeaders(method, path, accessToken)),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (issuing && response.status === 200) {
      const issued = ((await response.clone().json()) as { data: Tokens }).data;
      keys.set(issued.accessToken, key);
      keys.set(issued.refreshToken, key);
    }
    return response;
  };
  const publicCall: Backoffice['publicCall'] = (method, path, apiKey, headers = {}, body) =>
    fetch(`${app.baseUrl}/public/v1${path}`, {
      method,
      headers: { ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login: Backoffice['login'] = (name, password = TEST_PASSWORD, headers) =>
    call('POST', '/auth/login', undefined, { username: name, password }, headers);
  return {
    app,
    cluster,
    activity,
    clock,
    logEvents: logs.events,
    login,
    call,
    userHeaders,
    keyOf,
    publicCall,
    meter: publicApi.meter,
    tokens: async (name, headers) => {
      const response = await login(name, TEST_PASSWORD, headers);
      if (response.status !== 200) {
        throw new Error(`login of ${name} answered ${String(response.status)}`);
      }
      return ((await response.json()) as { data: Tokens }).data;
    },
    close: () => app.close(),
  };
}

let nextUser = 100;

/**
 * Adds a user of the first group with the shared test password (an SA unless overridden), so that a
 * test can change it without disturbing the others.
 *
 * @param ctx Throw-away databases.
 * @param office The running app (for the cluster).
 * @param overrides Fields of the legacy document to change.
 * @returns The id and the user name.
 */
export async function addUser(ctx: TestDatabases, office: Pick<Backoffice, 'cluster'>, overrides: Document = {}): Promise<{ id: ObjectId; name: string }> {
  const group = office.cluster.groups[0]!;
  const user = legacyUser(nextUser++, { role: 'SA', groupId: group.groupId, dealerId: group.dealerId, password: hashWithTestPepper(TEST_PASSWORD), ...overrides });
  await ctx.databases.common().collection('users').insertOne(user);
  return { id: user['_id'] as ObjectId, name: user['userName'] as string };
}
