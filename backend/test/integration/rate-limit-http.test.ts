import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { buildPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { startApp, testConfig } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const env = { RATE_LIMIT_API_PER_USER: '3', RATE_LIMIT_LOGIN_PER_IP: '6', RATE_LIMIT_LOGIN_PER_USERNAME: '2', RATE_LIMIT_USERNAME_CHECK_PER_USER: '1' };
const rules = createRateLimitRules(testConfig(env));
const ok = (_req: unknown, res: { json(body: unknown): void }): void => res.json({ data: 'ok' });

async function principalOf(role: 'SA' | 'E', userId = new ObjectId()) {
  const { principal } = await buildPrincipal(
    { userId, role, groupId: null, companyIds: [], placeIds: [], legacyPermissions: { status: true, places: { r: true, w: true } } },
    { dealerGroupIds: async () => [], companyPlaceIds: async () => [] } as never,
  );
  return principal;
}

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases);
});
after(async () => {
  await ctx.cleanup();
});

/** Authenticator for tests: the user id comes from the `x-user` header; `x-user: none` is a 401. */
const authenticate = (role: 'SA' | 'E' = 'SA') => async (req: { get(name: string): string | undefined }, res: { locals: { auth?: unknown } }, next: () => void): Promise<void> => {
  const id = req.get('x-user');
  if (id === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  res.locals.auth = await principalOf(role, ObjectId.createFromHexString(id));
  next();
};

const routes: RouteDefinition[] = [
  defineRoute({ method: 'GET', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: ok }),
  defineRoute({ method: 'GET', path: '/checks', auth: { kind: 'user', permission: 'places:read' }, rateLimit: [rules.usernameCheckPerUser], handler: ok }),
  defineRoute({ method: 'POST', path: '/login', auth: { kind: 'anonymous', reason: 'test login' }, rateLimit: [rules.loginPerIp, rules.loginPerUsername], handler: ok }),
];

describe('rate limit on the routes (real MongoDB)', () => {
  const activity = memoryActivityLog();
  let app: TestServer;
  before(async () => {
    app = await startApp(
      {
        routes: { v1: routes },
        authenticate: { v1: authenticate() as never },
        activityLog: activity,
        rateLimiter: createRateLimiter(ctx.databases),
      },
      env,
    );
  });
  after(() => app.close());

  const user = new ObjectId().toHexString();
  const get = (path: string, id = user) => fetch(`${app.baseUrl}/v1${path}`, { headers: { 'x-user': id } });

  it('puts the headers on every response and answers 429 with Retry-After over the limit', async () => {
    const id = new ObjectId().toHexString();
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await get('/things', id);
      seen.push({ status: response.status, limit: response.headers.get('ratelimit-limit'), remaining: response.headers.get('ratelimit-remaining') });
      if (i === 3) {
        assert.ok(Number(response.headers.get('retry-after')) >= 1);
        assert.ok(Number(response.headers.get('ratelimit-reset')) >= 1);
        assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      }
    }
    assert.deepEqual(seen, [
      { status: 200, limit: '3', remaining: '2' },
      { status: 200, limit: '3', remaining: '1' },
      { status: 200, limit: '3', remaining: '0' },
      { status: 429, limit: '3', remaining: '0' },
    ]);
  });

  it('limits each user separately and records the first excess only, without the key', async () => {
    const before = activity.entries.length;
    const id = new ObjectId().toHexString();
    for (let i = 0; i < 6; i += 1) {
      await get('/things', id);
    }
    const other = await get('/things', new ObjectId().toHexString());
    assert.equal(other.status, 200);
    const entries = activity.entries.slice(before);
    assert.equal(entries.length, 1);
    assert.deepEqual(
      { category: entries[0]?.category, action: entries[0]?.action, outcome: entries[0]?.outcome, kind: entries[0]?.actor.kind, id: entries[0]?.actor.id?.toHexString(), metadata: entries[0]?.metadata },
      { category: 'security', action: 'rateLimit.exceeded', outcome: 'denied', kind: 'user', id, metadata: { bucket: 'api:user' } },
    );
    assert.ok(entries[0]?.requestId !== undefined && entries[0].ip !== undefined);
  });

  it('shows the headers of the rule with the fewest requests left when several apply', async () => {
    const id = new ObjectId().toHexString();
    const first = await get('/checks', id);
    assert.equal(first.status, 200);
    assert.deepEqual([first.headers.get('ratelimit-limit'), first.headers.get('ratelimit-remaining')], ['1', '0']);
    const second = await get('/checks', id);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('ratelimit-limit'), '1');
  });

  it('limits anonymous routes by IP and, after the body parser, by normalized username', async () => {
    const post = (body: unknown, type = 'application/json') => fetch(`${app.baseUrl}/v1/login`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    // 415 and malformed bodies are refused before the username rule counts anything.
    assert.equal((await post('x', 'text/plain')).status, 415);
    assert.equal((await post('{', 'application/json')).status, 400);
    // Three usernames differing only by case and spaces are one subject (limit 2).
    const statuses: number[] = [];
    for (const username of ['Mario', ' mario ', 'MARIO']) {
      statuses.push((await post({ username })).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    // No username: that rule does not apply; the IP rule (limit 6) has counted 5 requests so far.
    assert.equal((await post({ other: 1 })).status, 200);
    const byIp = await post({ username: 'someone else' });
    assert.equal(byIp.status, 429);
    assert.equal(byIp.headers.get('ratelimit-limit'), '6');
  });

  it('checks authentication before counting anything', async () => {
    const before = activity.entries.length;
    const anonymous = await fetch(`${app.baseUrl}/v1/things`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('ratelimit-limit'), null);
    assert.equal(activity.entries.length, before);
  });
});

describe('rate limit failure and order', () => {
  it('fails closed with 500 when the limiter cannot reach the database', async () => {
    const limiter: RateLimiter = { ...memoryRateLimiter(), consume: () => Promise.reject(new Error('mongo down')) };
    const app = await startApp({ routes: { v1: routes }, authenticate: { v1: authenticate() as never }, rateLimiter: limiter }, env);
    try {
      const response = await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } });
      assert.equal(response.status, 500);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
      const open = await fetch(`${app.baseUrl}/health/live`);
      assert.notEqual(open.status, 500);
    } finally {
      await app.close();
    }
  });

  it('runs authenticate, then the rate limit, then the permission check, and never limits /health', async () => {
    const limiter = memoryRateLimiter();
    const app = await startApp({ routes: { v1: routes }, authenticate: { v1: authenticate('E') as never }, rateLimiter: limiter }, { ...env, RATE_LIMIT_API_PER_USER: '1' });
    try {
      const id = new ObjectId().toHexString();
      // E has no permissions: 403, but the request was counted first.
      const forbidden = await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': id } });
      assert.equal(forbidden.status, 403);
      assert.deepEqual(limiter.calls.map((call) => call.bucket), ['api:user']);
      // Over the limit the answer is 429, not 403: the rate limit precedes the authorization.
      const limited = await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': id } });
      assert.equal(limited.status, 429);
      await fetch(`${app.baseUrl}/health/live`);
      await fetch(`${app.baseUrl}/health/ready`);
      assert.equal(limiter.calls.length, 2);
    } finally {
      await app.close();
    }
  });
});

describe('failed authentications per IP (real MongoDB)', () => {
  const at = (minute: number) => () => Date.UTC(2026, 2, 1, 10, minute, 5);
  const start = async (minute: number, calls: { authenticated: number }) => {
    const inner = authenticate();
    const counted = async (req: Parameters<typeof inner>[0], res: Parameters<typeof inner>[1], next: () => void): Promise<void> => {
      calls.authenticated += 1;
      await inner(req, res, next);
    };
    return startApp({ routes: { v1: routes }, authenticate: { v1: counted as never }, rateLimiter: createRateLimiter(ctx.databases, at(minute)) }, { ...env, RATE_LIMIT_UNAUTHENTICATED_PER_IP: '2', RATE_LIMIT_API_PER_USER: '1000' });
  };
  const failures = () => ctx.databases.common().collection<{ _id: string; count: number }>('rateLimits').find({ _id: { $regex: '^auth-fail:ip:' } }).toArray();

  it('blocks an IP after its failed authentications, before authenticate runs', async () => {
    const calls = { authenticated: 0 };
    const app = await start(1, calls);
    try {
      assert.equal((await fetch(`${app.baseUrl}/v1/things`)).status, 401);
      assert.equal((await fetch(`${app.baseUrl}/v1/things`)).status, 401);
      const blocked = await fetch(`${app.baseUrl}/v1/things`);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
      assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
      assert.equal(calls.authenticated, 2);
      // Not even valid credentials pass from a blocked address in that window.
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } })).status, 429);
      assert.equal(calls.authenticated, 2);
    } finally {
      await app.close();
    }
  });

  it('does not count successful requests, so an office behind one address is not blocked', async () => {
    const calls = { authenticated: 0 };
    const app = await start(2, calls);
    try {
      for (let i = 0; i < 8; i += 1) {
        assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } })).status, 200);
      }
      assert.equal((await fetch(`${app.baseUrl}/v1/things`)).status, 401);
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } })).status, 200);
      const counters = (await failures()).filter((counter) => counter._id.endsWith(`:${Date.UTC(2026, 2, 1, 10, 2, 0) / 1000}`));
      assert.deepEqual(counters.map((counter) => counter.count), [1]);
    } finally {
      await app.close();
    }
  });

  it('starts over in the next window', async () => {
    const calls = { authenticated: 0 };
    const first = await start(3, calls);
    try {
      await fetch(`${first.baseUrl}/v1/things`);
      await fetch(`${first.baseUrl}/v1/things`);
      assert.equal((await fetch(`${first.baseUrl}/v1/things`)).status, 429);
    } finally {
      await first.close();
    }
    const next = await start(4, calls);
    try {
      assert.equal((await fetch(`${next.baseUrl}/v1/things`)).status, 401);
    } finally {
      await next.close();
    }
  });
});
