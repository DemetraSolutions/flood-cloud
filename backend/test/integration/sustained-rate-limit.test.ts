import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import type { Role } from '../../src/shared/security/rbac/permissions.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { buildPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const HOUR = 3600_000;
const DAY = 86_400_000;
// Anchored at 01:00:05 of tomorrow (UTC): counters have a TTL and must never be born expired, and the hours a test
// moves the clock on must never cross the end of the UTC day, whatever the time the suite runs at.
const BASE = (Math.floor(Date.now() / DAY) + 1) * DAY + HOUR + 5000;
// The minute limit may not exceed the hourly one: each request of a test moves the clock a minute on, so the minute window never fills.
const env = { RATE_LIMIT_API_PER_USER: '3', RATE_LIMIT_API_PER_USER_HOUR: '3', RATE_LIMIT_API_PER_USER_DAY: '5' };
const MINUTE = 61_000;

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS);
});
after(async () => {
  await ctx.cleanup();
});

/** Authenticator for tests: `x-user` is the id and `x-role` the role. */
const authenticate = async (req: { get(name: string): string | undefined }, res: { locals: { auth?: unknown } }, next: () => void): Promise<void> => {
  const id = req.get('x-user');
  if (id === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  const role = (req.get('x-role') ?? 'SA') as Role;
  const { principal } = await buildPrincipal(
    { userId: ObjectId.createFromHexString(id), role, groupId: null, companyIds: [], placeIds: [], legacyPermissions: { status: true, places: { r: true, w: true } } },
    { listDealerGroupIds: async () => [], listCompanyPlaceIds: async () => [] } as never,
  );
  res.locals.auth = principal;
  next();
};
const ok = (_req: unknown, res: { json(body: unknown): void }): void => res.json({ data: 'ok' });
const routes = [
  defineRoute({ method: 'GET', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: ok }),
  defineRoute({ method: 'GET', path: '/forbidden', auth: { kind: 'user', permission: 'users:create' }, handler: ok }),
  defineRoute({ method: 'GET', path: '/invalid', auth: { kind: 'user', permission: 'places:read' }, middleware: [() => { throw new AppError('VALIDATION_ERROR'); }], handler: ok }),
  defineRoute({ method: 'POST', path: '/auth/logout', auth: { kind: 'user', permission: 'places:read' }, sustainedExempt: true, handler: (_req, res) => void res.status(204).end() }),
  defineRoute({ method: 'PUT', path: '/me/password', auth: { kind: 'user', permission: 'places:read' }, sustainedExempt: true, handler: ok }),
  defineRoute({ method: 'POST', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: ok }),
  defineRoute({ method: 'GET', path: '/open', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: [{ bucket: 'test:ip', limit: 1_000_000, key: (req) => req.ip ?? 'unknown' }], handler: ok }),
];

async function start(mode: 'report' | 'enforce', clock: { now: number }, extra: Record<string, string> = {}) {
  const activity = memoryActivityLog();
  const app: TestServer = await startApp(
    { routes: { v1: routes }, authenticate: { v1: authenticate as never }, activityLog: activity, rateLimiter: createRateLimiter(ctx.databases, () => clock.now) },
    { ...env, ...extra, RATE_LIMIT_API_SUSTAINED_MODE: mode },
  );
  const get = (user: string, role: Role = 'SA', path = '/things', advance = true) => {
    if (advance) {
      clock.now += MINUTE;
    }
    return fetch(`${app.baseUrl}/v1${path}`, { headers: { 'x-user': user, 'x-role': role } });
  };
  const send = (method: string, path: string, user: string, role: Role = 'SA', headers: Record<string, string> = {}) => {
    clock.now += MINUTE;
    return fetch(`${app.baseUrl}/v1${path}`, { method, headers: { 'x-user': user, 'x-role': role, 'content-type': 'application/json', ...headers }, ...(method === 'POST' || method === 'PUT' ? { body: '{}' } : {}) });
  };
  const counters = async (user: string) => {
    const hash = createHash('sha256').update(user).digest('hex');
    const found = await ctx.databases.common().collection<{ _id: string; count: number }>('rateLimits').find({ _id: { $regex: `^api-(hour|day):user:${hash}:` } }).toArray();
    return found.map((counter) => counter.count);
  };
  const sustained = () => activity.entries.filter((entry) => entry.action === 'rateLimit.sustainedExceeded');
  return { app, get, send, counters, sustained, activity };
}
const newUser = () => new ObjectId().toHexString();

describe('sustained use limits of /v1 (real MongoDB)', () => {
  it('report: under the limits nothing happens; over them the requests pass and one event is recorded per user and window, even with concurrent requests', async () => {
    const clock = { now: BASE };
    const { app, get, sustained } = await start('report', clock, { RATE_LIMIT_API_PER_USER: '4', RATE_LIMIT_API_PER_USER_HOUR: '4', RATE_LIMIT_API_PER_USER_DAY: '12' });
    try {
      const user = newUser();
      // Four concurrent requests share one minute: the clock moves once, then they all fly.
      const burst = async () => {
        clock.now += MINUTE;
        return Promise.all(Array.from({ length: 4 }, () => get(user, 'SA', '/things', false)));
      };
      const firstBurst = await burst();
      assert.deepEqual(firstBurst.map((reply) => reply.status), [200, 200, 200, 200]);
      assert.equal(firstBurst[0]?.headers.get('ratelimit-limit'), '4', 'report mode shows the per-minute headers only');
      assert.equal(sustained().length, 0, 'the hour is at its limit (4), not over it');
      // Minute 2: the hour is crossed by concurrent requests (reported once); minute 3 reaches the day (12); minute 4 crosses it, once.
      for (let minute = 0; minute < 3; minute += 1) {
        assert.deepEqual((await burst()).map((reply) => reply.status), [200, 200, 200, 200]);
      }
      assert.deepEqual(
        sustained().map((entry) => [entry.metadata?.['window'], entry.metadata?.['bucket'], entry.metadata?.['limit'], entry.metadata?.['mode'], entry.outcome, entry.actor.kind, entry.actor.id?.toHexString()]).sort(),
        [['day', 'api-day:user', 12, 'report', 'success', 'user', user], ['hour', 'api-hour:user', 4, 'report', 'success', 'user', user]],
      );
    } finally {
      await app.close();
    }
  });

  it('enforce: over the hour limit 429 with Retry-After to the end of the hour, one event, then the window reopens', async () => {
    const clock = { now: BASE };
    const { app, get, sustained } = await start('enforce', clock, { RATE_LIMIT_API_PER_USER_DAY: '50' });
    try {
      const user = newUser();
      const seen: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        seen.push((await get(user)).status);
      }
      const first = await get(user);
      const second = await get(user);
      assert.deepEqual([...seen, first.status, second.status], [200, 200, 200, 429, 429]);
      assert.deepEqual(await first.json(), { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      assert.equal(first.headers.get('ratelimit-limit'), '3');
      assert.equal(first.headers.get('ratelimit-remaining'), '0');
      const retry = Number(first.headers.get('retry-after'));
      assert.ok(retry >= 1 && retry <= 3600 - 5, `Retry-After ${retry}`);
      assert.equal(first.headers.get('ratelimit-reset'), String(retry));
      assert.deepEqual(sustained().map((entry) => [entry.metadata?.['window'], entry.outcome, entry.metadata?.['mode']]), [['hour', 'denied', 'enforce']]);
      // The next hour is a new window: the user is served again, and the event can be recorded again at the next excess.
      clock.now = BASE + HOUR;
      const reopened = await get(user);
      assert.equal(reopened.status, 200);
      assert.equal(reopened.headers.get('ratelimit-remaining'), '2');
    } finally {
      await app.close();
    }
  });

  it('enforce: the daily limit refuses with Retry-After to the end of the UTC day, and the day window is the one shown when it ends last', async () => {
    const clock = { now: BASE };
    const { app, get, sustained } = await start('enforce', clock);
    try {
      const user = newUser();
      const statuses: number[] = [];
      for (let hour = 0; hour < 2; hour += 1) {
        clock.now = BASE + hour * HOUR;
        for (let i = 0; i < 3; i += 1) {
          statuses.push((await get(user)).status);
        }
      }
      // Hour 0: 3 served. Hour 1: 2 served (day total 5), then the third is over the day limit.
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
      const refused = await get(user);
      assert.equal(refused.status, 429);
      const dayEnd = (Math.floor(clock.now / DAY) + 1) * DAY;
      assert.equal(Number(refused.headers.get('retry-after')), Math.max(1, Math.floor(dayEnd / 1000) - Math.floor(clock.now / 1000)));
      assert.equal(refused.headers.get('ratelimit-limit'), '5');
      assert.deepEqual(sustained().map((entry) => entry.metadata?.['window']).sort(), ['day', 'hour']);
    } finally {
      await app.close();
    }
  });

  it('PSA and D are never refused, only reported, even in enforce', async () => {
    const clock = { now: BASE };
    const { app, get, sustained } = await start('enforce', clock);
    try {
      for (const role of ['PSA', 'D'] as const) {
        const user = newUser();
        const statuses = [];
        for (let i = 0; i < 8; i += 1) {
          statuses.push((await get(user, role)).status);
        }
        assert.deepEqual(new Set(statuses), new Set([200]), role);
        const own = sustained().filter((entry) => entry.actor.id?.toHexString() === user);
        assert.deepEqual(own.map((entry) => [entry.metadata?.['window'], entry.metadata?.['mode'], entry.outcome, entry.actor.role]).sort(), [['day', 'report', 'success', role], ['hour', 'report', 'success', role]]);
      }
    } finally {
      await app.close();
    }
  });

  it('counts each user apart, and counts neither anonymous routes nor requests refused by authentication or by the per-minute rule', async () => {
    const clock = { now: BASE };
    const { app, get } = await start('enforce', clock);
    try {
      const [a, b] = [newUser(), newUser()];
      for (let i = 0; i < 4; i += 1) {
        await get(a);
      }
      assert.equal((await get(a)).status, 429);
      assert.equal((await get(b)).status, 200);
      for (let i = 0; i < 6; i += 1) {
        assert.equal((await fetch(`${app.baseUrl}/v1/open`)).status, 200);
        assert.equal((await fetch(`${app.baseUrl}/v1/things`)).status, 401);
      }
      const hashes = [a, b].map((id) => createHash('sha256').update(id).digest('hex')).join('|');
      const stored = await ctx.databases.common().collection<{ _id: string; count: number }>('rateLimits').find({ _id: { $regex: `^api-(hour|day):user:(${hashes}):` } }).toArray();
      assert.deepEqual(stored.map((counter) => counter.count).sort(), [1, 1, 5, 5], 'two counters per user, nothing for the anonymous callers');
      assert.ok(stored.every((counter) => /^api-(hour|day):user:[0-9a-f]{64}:\d+$/.test(counter._id)), 'the key is hashed, the id never stored in clear');
    } finally {
      await app.close();
    }
  });

  it('does not count a request refused by the per-minute rule', async () => {
    const clock = { now: BASE };
    const activity = memoryActivityLog();
    const app = await startApp(
      { routes: { v1: routes }, authenticate: { v1: authenticate as never }, activityLog: activity, rateLimiter: createRateLimiter(ctx.databases, () => clock.now) },
      { ...env, RATE_LIMIT_API_PER_USER: '2', RATE_LIMIT_API_SUSTAINED_MODE: 'enforce' },
    );
    try {
      const user = newUser();
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user } })).status);
      }
      assert.deepEqual(statuses, [200, 200, 429, 429, 429, 429]);
      assert.equal(activity.entries.filter((entry) => entry.action === 'rateLimit.sustainedExceeded').length, 0);
      const hash = createHash('sha256').update(user).digest('hex');
      const counters = await ctx.databases.common().collection<{ _id: string; count: number }>('rateLimits').find({ _id: { $regex: `^api-(hour|day):user:${hash}:` } }).toArray();
      assert.deepEqual(counters.map((entry) => entry.count), [2, 2]);
    } finally {
      await app.close();
    }
  });

  it('enforce: a user over the limit can still log out, change his password, always counted and reported; every other route is 429', async () => {
    const clock = { now: BASE };
    const { app, get, send, counters, sustained } = await start('enforce', clock);
    try {
      const user = newUser();
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await get(user)).status, 200);
      }
      assert.equal((await get(user)).status, 429);
      assert.equal((await send('POST', '/things', user)).status, 429);
      const logout = await send('POST', '/auth/logout', user);
      assert.equal(logout.status, 204);
      const password = await send('PUT', '/me/password', user);
      assert.deepEqual([password.status, await password.json()], [200, { data: 'ok' }]);
      assert.equal((await get(user)).status, 429, 'the exemption is the route, not the user');
      assert.deepEqual(await counters(user), [8, 8].sort(), 'the exempt requests are counted like any other');
      assert.deepEqual(sustained().map((entry) => [entry.metadata?.['window'], entry.metadata?.['mode'], entry.outcome]), [['hour', 'enforce', 'denied'], ['day', 'report', 'success']]);
      // The day was first crossed by an exempt route: reported, not refused. Over it too: the exempt routes still pass.
      assert.equal((await send('POST', '/auth/logout', user)).status, 204);
    } finally {
      await app.close();
    }
  });

  it('counts a request that ends in 403 or 422, a HEAD, and the requests of two sessions of the same user on the same counters; never a CORS preflight', async () => {
    const clock = { now: BASE };
    const { app, get, send, counters, activity } = await start('report', clock, { RATE_LIMIT_API_PER_USER: '50', RATE_LIMIT_API_PER_USER_HOUR: '50', RATE_LIMIT_API_PER_USER_DAY: '50', CORS_ALLOWED_ORIGINS: 'https://backoffice.example.com' });
    try {
      const user = newUser();
      assert.equal((await send('GET', '/forbidden', user, 'E')).status, 403);
      assert.deepEqual(await counters(user), [1, 1]);
      assert.equal((await send('GET', '/invalid', user)).status, 422);
      assert.deepEqual(await counters(user), [2, 2]);
      assert.equal((await send('HEAD', '/things', user)).status, 200);
      assert.deepEqual(await counters(user), [3, 3]);
      // Two sessions (two tokens, here two session headers) of the same user: the counter is the user's.
      assert.equal((await send('GET', '/things', user, 'SA', { 'x-session': 'one' })).status, 200);
      assert.equal((await send('GET', '/things', user, 'SA', { 'x-session': 'two' })).status, 200);
      assert.deepEqual(await counters(user), [5, 5]);
      const preflight = await fetch(`${app.baseUrl}/v1/things`, { method: 'OPTIONS', headers: { origin: 'https://backoffice.example.com', 'access-control-request-method': 'GET', 'x-user': user } });
      assert.equal(preflight.status, 204);
      assert.deepEqual(await counters(user), [5, 5]);
      assert.equal(activity.entries.filter((entry) => entry.action === 'rateLimit.sustainedExceeded').length, 0);
      assert.equal((await get(user)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('holds the emergency exit in a composition without the security policy: SECURITY_POLICY_FORCE_REPORT keeps the limits in report whatever the environment says', async () => {
    const clock = { now: BASE };
    const { app, get, sustained } = await start('enforce', clock, { SECURITY_POLICY_FORCE_REPORT: 'on' });
    try {
      const user = newUser();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await get(user)).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
      assert.deepEqual(sustained().map((entry) => [entry.metadata?.['window'], entry.metadata?.['mode']]), [['hour', 'report']], 'the hourly limit was crossed, reported, not enforced');
    } finally {
      await app.close();
    }
  });
});
