import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { ObjectId } from 'mongodb';
import type { RequestHandler } from 'express';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { buildPrincipal } from '../../src/shared/security/scope/principal.ts';
import { STORE_PROFILE } from '../../src/shared/security/rbac/policy.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { securityPolicyOf } from '../../src/shared/security/security-policy.ts';
import { createNonBrowserGuard } from '../../src/shared/security/non-browser-signal.ts';
import { memoryLogger, startApp } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const APP = 'https://backoffice.example.com';
const KEY = `fc_sk_${'a'.repeat(43)}`;
let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS);
});
after(async () => {
  await ctx.cleanup();
});

const authenticate: RequestHandler = async (req, res, next) => {
  if (req.get('authorization') === `Bearer ${KEY}`) {
    res.locals.store = { kind: 'store', keyId: new ObjectId(), permissions: STORE_PROFILE } as never;
    next();
    return;
  }
  const id = req.get('x-user');
  if (id === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  const { principal } = await buildPrincipal(
    { userId: ObjectId.createFromHexString(id), role: 'SA', groupId: null, companyIds: [], placeIds: [], legacyPermissions: { status: true, places: { r: true, w: true } } },
    { listDealerGroupIds: async () => [], listCompanyPlaceIds: async () => [] } as never,
  );
  res.locals.auth = principal;
  next();
};
const ok: RequestHandler = (_req, res) => void res.json({ data: 'ok' });
const publicAuthenticate: RequestHandler = (_req, res, next) => {
  res.locals.apiKey = { kind: 'apiKey', keyId: new ObjectId(), permissions: new Set(['places:read']) } as never;
  next();
};
const v1 = [
  defineRoute({ method: 'GET', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: ok }),
  defineRoute({ method: 'POST', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: ok }),
  defineRoute({ method: 'GET', path: '/open', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: [{ bucket: 'test:ip', limit: 1_000_000, key: (req) => req.ip ?? 'unknown' }], handler: ok }),
  defineRoute({ method: 'GET', path: '/store-only', auth: { kind: 'store' }, handler: ok }),
];
const publicRoutes = [defineRoute({ method: 'GET', path: '/things', auth: { kind: 'apiKey', permission: 'places:read' }, handler: ok })];

/** A request with any headers, `Sec-Fetch-*` included (`fetch` of Node owns those names). */
const raw = (url: string, headers: Record<string, string>, method = 'GET'): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });

const START = (env: Record<string, string>, limiter = memoryRateLimiter()) => {
  const activity = memoryActivityLog();
  const guard = createNonBrowserGuard({ activityLog: activity, rateLimiter: limiter, logger: memoryLogger().logger, allowedOrigins: env['CORS_ALLOWED_ORIGINS'] === undefined ? [APP] : env['CORS_ALLOWED_ORIGINS'] === '' ? [] : [env['CORS_ALLOWED_ORIGINS']], policy: { get: () => Promise.resolve(securityPolicyOf({ nonBrowserRequests: 'report' }, 'report')) } });
  return startApp({ routes: { v1, public: publicRoutes }, authenticate: { v1: authenticate, store: authenticate, public: publicAuthenticate }, activityLog: activity, rateLimiter: limiter, nonBrowserGuard: guard }, { REQUEST_ORIGIN_SIGNAL: 'on', CORS_ALLOWED_ORIGINS: APP, ...env }).then((app) => ({ app, activity, limiter }));
};
const events = (activity: { entries: Array<{ action: string }> }) => activity.entries.filter((entry) => entry.action === 'request.nonBrowser');

describe('the non-browser signal on the requests of a user', () => {
  it('stays silent and writes nothing for a simulated browser; reports a script without changing the response', async () => {
    const { app, activity, limiter } = await START({});
    try {
      const user = new ObjectId().toHexString();
      const browser = await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user, origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
      assert.deepEqual([browser.status, await browser.json()], [200, { data: 'ok' }]);
      assert.deepEqual([events(activity).length, limiter.calls.filter((call) => call.bucket === 'non-browser:user').length], [0, 0]);
      const script = await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user, 'user-agent': 'python-requests/2.31' } });
      assert.deepEqual([script.status, await script.json()], [200, { data: 'ok' }]);
      assert.deepEqual([...script.headers.keys()].filter((name) => /signal|browser|origin-check/i.test(name)), []);
      const [event] = events(activity) as unknown as Array<{ metadata: Record<string, unknown>; actor: { kind: string; id: ObjectId } }>;
      assert.deepEqual([event!.actor.kind, event!.actor.id.toHexString(), event!.metadata], ['user', user, { reason: 'noOrigin', source: 'api', outcome: 'reported', userAgent: 'python-requests/2.31' }]);
      // A foreign Origin, inconsistent fetch metadata and a script with a valid Origin but a navigation mode are the other reasons.
      await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user, origin: 'https://evil.example' } });
      assert.equal(await raw(`${app.baseUrl}/v1/things`, { 'x-user': user, origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }), 200);
      assert.deepEqual(events(activity).map((entry) => (entry as unknown as { metadata: { reason: string } }).metadata.reason), ['noOrigin', 'foreignOrigin', 'inconsistentFetchMetadata']);
      // Only fetch metadata missing, with a valid Origin: no signal.
      await fetch(`${app.baseUrl}/v1/things`, { method: 'POST', headers: { 'x-user': user, origin: APP, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(events(activity).length, 3);
    } finally {
      await app.close();
    }
  });

  it('treats a same-origin GET as a browser when the metadata says so (a backoffice served from the API origin, a download)', async () => {
    const { app, activity } = await START({ CORS_ALLOWED_ORIGINS: '' });
    try {
      const user = new ObjectId().toHexString();
      assert.equal(await raw(`${app.baseUrl}/v1/things`, { 'x-user': user, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' }), 200);
      assert.equal(await raw(`${app.baseUrl}/v1/things`, { 'x-user': user, 'sec-fetch-site': 'same-origin' }, 'HEAD'), 200);
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user } })).status, 200, 'no origin allowed and no metadata: an old browser on the same origin');
      assert.equal(events(activity).length, 0);
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: '{}' })).status, 200);
      assert.equal(events(activity).length, 1);
    } finally {
      await app.close();
    }
  });

  it('never evaluates a store key, the public API or an anonymous route, and does nothing when it is turned off', async () => {
    const { app, activity, limiter } = await START({});
    try {
      assert.equal((await fetch(`${app.baseUrl}/v1/store-only`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
      assert.equal((await fetch(`${app.baseUrl}/v1/open`)).status, 200);
      assert.equal((await fetch(`${app.baseUrl}/public/v1/things`)).status, 200);
      assert.deepEqual([events(activity).length, limiter.calls.filter((call) => call.bucket === 'non-browser:user').length], [0, 0]);
    } finally {
      await app.close();
    }
    const off = await START({ REQUEST_ORIGIN_SIGNAL: 'off' });
    try {
      assert.equal((await fetch(`${off.app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } })).status, 200);
      assert.deepEqual([events(off.activity).length, off.limiter.calls.filter((call) => call.bucket === 'non-browser:user').length], [0, 0]);
    } finally {
      await off.app.close();
    }
  });

  it('records one event a day per user and reason even with concurrent requests (real counters), and the next day another one', async () => {
    // Tomorrow (UTC), so no counter is born already expired for the TTL index, whatever the time the suite runs at.
    const clock = { now: (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 + 5000 };
    const { app, activity } = await START({}, createRateLimiter(ctx.databases, () => clock.now) as never);
    try {
      const user = new ObjectId().toHexString();
      const replies = await Promise.all(Array.from({ length: 12 }, () => fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user } })));
      assert.ok(replies.every((reply) => reply.status === 200));
      assert.equal(events(activity).length, 1);
      await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user, origin: 'https://evil.example' } });
      assert.equal(events(activity).length, 2);
      clock.now += 86_400_000;
      await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': user } });
      assert.equal(events(activity).length, 3);
    } finally {
      await app.close();
    }
  });

  it('keeps the request alive when the counters are down', async () => {
    const limiter = { ...memoryRateLimiter(), consume: (bucket: string, ...rest: [string, number, number?]) => (bucket === 'non-browser:user' ? Promise.reject(new Error('mongo down')) : memoryRateLimiter().consume(bucket, ...rest)) };
    const { app, activity } = await START({}, limiter as never);
    try {
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { 'x-user': new ObjectId().toHexString() } })).status, 200);
      assert.equal(events(activity).length, 0);
    } finally {
      await app.close();
    }
  });
});
