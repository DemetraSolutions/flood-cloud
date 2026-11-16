import { randomBytes } from 'node:crypto';
import type { Document, ObjectId } from 'mongodb';
import { createBackofficeModules } from '../../src/composition.ts';
import type { MediaStorage } from '../../src/integrations/gcs/index.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { memoryActivityLog, memoryRateLimiter } from './activity.ts';
import type { MemoryActivityLog } from './activity.ts';
import { memoryLogger, startApp, testConfig } from './app.ts';
import type { TestServer } from './app.ts';
import { seedIsolationCluster } from './isolation.ts';
import { legacyUser } from './legacy-fixtures.ts';
import type { IsolationCluster } from './isolation.ts';
import type { TestDatabases } from './mongo.ts';
import { quietLogger } from './indexes.ts';
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
  /** A request to `/v1` with a Bearer access token. */
  call(method: string, path: string, accessToken: string | undefined, body?: unknown, headers?: Record<string, string>): Promise<Response>;
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
}

/** Thresholds high enough for tests that are not about rate limits. */
const GENEROUS = {
  RATE_LIMIT_LOGIN_PER_USERNAME: '100000',
  RATE_LIMIT_LOGIN_PER_IP: '100000',
  RATE_LIMIT_REFRESH_PER_IP: '100000',
  RATE_LIMIT_API_PER_USER: '100000',
  RATE_LIMIT_USER_CREDENTIALS_PER_USER: '100000',
  RATE_LIMIT_UNAUTHENTICATED_PER_IP: '100000',
  RATE_LIMIT_API_PER_STORE: '100000',
  RATE_LIMIT_STORE_ACTIVATION_PER_IP: '100000',
  RATE_LIMIT_STORE_KEY_ADMIN_PER_USER: '100000',
};

/**
 * Seeds the isolation cluster (every user with {@link TEST_PASSWORD}), applies the indexes and
 * starts the app with the real modules.
 *
 * @param ctx Throw-away databases.
 * @param options Environment, limiter and extra routes.
 */
export async function startBackoffice(ctx: TestDatabases, options: BackofficeOptions = {}): Promise<Backoffice> {
  await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
  const cluster = await seedIsolationCluster(ctx.databases);
  await ctx.databases.common().collection('users').updateMany({}, { $set: { password: hashWithTestPepper(TEST_PASSWORD) } });
  let current = Date.now();
  const clock: Clock = { now: () => current, advance: (ms) => void (current += ms) };
  const activity = memoryActivityLog();
  const env = { LEGACY_PASSWORD_PEPPER: TEST_PEPPER, ...GENEROUS, ...options.env };
  const config = testConfig(env);
  const logs = memoryLogger();
  const rateLimiter = options.rateLimiter ?? memoryRateLimiter();
  const modules = createBackofficeModules({ config, databases: ctx.databases, activityLog: activity, logger: logs.logger, now: clock.now, rateLimiter, mediaStorage: options.mediaStorage ?? null });
  const app = await startApp(
    {
      config,
      logger: logs.logger,
      activityLog: activity,
      now: clock.now,
      rateLimiter,
      routes: { v1: [...modules.routes, ...(options.extraRoutes ?? [])] },
      authenticate: { v1: modules.authenticate, store: modules.authenticateStore },
      groupAccess: { groups: modules.groups },
    },
    env,
  );
  const call: Backoffice['call'] = (method, path, accessToken, body, headers = {}) =>
    fetch(`${app.baseUrl}/v1${path}`, {
      method,
      headers: {
        ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
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
