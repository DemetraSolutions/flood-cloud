import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestHandler } from 'express';
import { createApp } from '../../src/app.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute, mountRoutes } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { STORE_PROFILE } from '../../src/shared/security/rbac/policy.ts';
import type { StorePrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryActivityLog, memoryRateLimitMount, memoryRateLimiter, testIpLimit } from '../helpers/activity.ts';
import { memoryLogger, startApp, testConfig } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const GROUP = fixtureId('group', 1);
const PLACE = fixtureId('place', 1);
const COMPANY = fixtureId('company', 1);
const KEY = `fc_sk_${'a'.repeat(43)}`;
const STORE: StorePrincipal = Object.freeze({
  kind: 'store',
  keyId: fixtureId('user', 77),
  groupId: GROUP,
  companyId: COMPANY,
  placeId: PLACE,
  activatedAt: new Date('2026-01-01T00:00:00.000Z'),
  permissions: STORE_PROFILE,
  scope: Object.freeze({ kind: 'store', groupId: GROUP, companyId: COMPANY, placeId: PLACE }),
});

/** The authentication of the users: a header names the one who calls (a test double of the Bearer check). */
const userAuthenticate: RequestHandler = (req, res, next) => {
  if (req.get('x-test-user') === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  res.locals.auth = principalOf('SA', { groupId: GROUP });
  next();
};

/** The authentication of the store keys: one key is good. */
const storeAuthenticate: RequestHandler = (req, res, next) => {
  if (req.get('authorization') !== `Bearer ${KEY}`) {
    throw new AppError('UNAUTHENTICATED');
  }
  res.locals.store = STORE;
  next();
};

const who: RequestHandler = (_req, res) => {
  res.json({ data: { caller: res.locals.store === undefined ? 'user' : 'store' } });
};

const one = '/groups/:groupId/places/:placeId';
const routes: RouteDefinition[] = [
  defineRoute({ method: 'GET', path: one, auth: { kind: 'user', permission: 'places:read', group: true, store: true }, handler: who }),
  defineRoute({ method: 'GET', path: '/groups/:groupId/places', auth: { kind: 'user', permission: 'places:read', group: true }, handler: who }),
  defineRoute({ method: 'GET', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: who }),
  defineRoute({ method: 'GET', path: '/store-only', auth: { kind: 'store' }, handler: who }),
  defineRoute({ method: 'GET', path: '/store-grouped', auth: { kind: 'store', group: true }, handler: (_req, res) => void res.json({ data: { group: (res.locals.groupAccess as { groupId: { toHexString(): string } } | undefined)?.groupId.toHexString() ?? null } }) }),
  defineRoute({ method: 'GET', path: '/public', auth: { kind: 'anonymous', reason: 'test route' }, rateLimit: testIpLimit, handler: who }),
];

const groups = {
  findAccess: async (id: unknown) => ({ availability: 'available' as const, group: { _id: id as never } }),
  resolveCluster: () => 'cluster0',
};

describe('the route builder and the store key', () => {
  const limiter = memoryRateLimiter();
  let app: TestServer;
  before(async () => {
    app = await startApp({ routes: { v1: routes }, authenticate: { v1: userAuthenticate, store: storeAuthenticate }, groupAccess: { groups }, rateLimiter: limiter }, {});
  });
  after(() => app.close());
  beforeEach(() => limiter.reset());

  const call = (path: string, headers: Record<string, string>) => fetch(`${app.baseUrl}/v1${path}`, { headers });
  const asStore = (path: string) => call(path, { authorization: `Bearer ${KEY}` });
  const asUser = (path: string) => call(path, { 'x-test-user': '1' });
  const place = (id = PLACE, group = GROUP) => `/groups/${group.toHexString()}/places/${id.toHexString()}`;

  it('lets a store key reach the route that opted in, on its own place, and a user reach it as he always did', async () => {
    limiter.reset();
    const store = await asStore(place());
    assert.deepEqual([store.status, await store.json()], [200, { data: { caller: 'store' } }]);
    const user = await asUser(place(fixtureId('place', 99)));
    assert.deepEqual([user.status, await user.json()], [200, { data: { caller: 'user' } }]);
  });

  it('is 404, and the same 404, for any other place or group, an invalid id and a place that does not exist', async () => {
    const bodies = new Set<string>();
    for (const path of [place(fixtureId('place', 2)), place(PLACE, fixtureId('group', 2)), `/groups/${GROUP.toHexString()}/places/not-an-id`, `/groups/zzz/places/${PLACE.toHexString()}`, `/groups/${GROUP.toHexString()}/places/${PLACE.toHexString()}0`]) {
      limiter.reset();
      const response = await asStore(path);
      assert.equal(response.status, 404, path);
      bodies.add(JSON.stringify(await response.json()));
    }
    assert.equal(bodies.size, 1);
  });

  it('refuses a store key on every route that did not opt in, with 403: the default is deny', async () => {
    for (const path of ['/groups/' + GROUP.toHexString() + '/places', '/things']) {
      const response = await asStore(path);
      assert.deepEqual([response.status, ((await response.json()) as { error: { code: string } }).error.code], [403, 'FORBIDDEN'], path);
    }
  });

  it('refuses without credentials, with a wrong key and with a key of another kind (401), and never confuses the kinds', async () => {
    for (const headers of [{}, { authorization: `Bearer fc_sk_${'b'.repeat(43)}` }, { authorization: 'Bearer fc_sk_short' }, { authorization: `Bearer fc_pk_${'a'.repeat(43)}` }, { authorization: `Bearer fc_at_${'a'.repeat(43)}` }, { authorization: `Basic ${KEY}` }]) {
      const response = await call(place(), headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
    }
    // A user's authentication is never asked about a store key: the header the user double reads does not make a store key a user.
    const mixed = await call(place(fixtureId('place', 2)), { authorization: `Bearer ${KEY}`, 'x-test-user': '1' });
    assert.equal(mixed.status, 404, 'the store key decides: it is a store, so another place is 404, not a user reading it');
  });

  it('serves a route only a store may call, to a store only', async () => {
    const store = await asStore('/store-only');
    assert.deepEqual([store.status, await store.json()], [200, { data: { caller: 'store' } }]);
    assert.equal((await asUser('/store-only')).status, 403, 'a user is not a store');
    assert.deepEqual((await (await asStore('/store-grouped')).json()).data, { group: GROUP.toHexString() }, 'the builder issues the access to the group of the store, and only where the route asks');
    assert.equal((await (await asStore('/store-only')).json()).data.group, undefined);
    assert.equal((await asUser('/store-grouped')).status, 403);
    assert.equal((await call('/store-only', {})).status, 401);
  });

  it('does not authenticate the anonymous routes, a store key or not', async () => {
    assert.equal((await asStore('/public')).status, 200);
    assert.equal((await call('/public', {})).status, 200);
  });

  it('counts a bad store key in the failed authentications of its address, and a good one never', async () => {
    limiter.reset();
    limiter.calls.length = 0;
    await call(place(), { authorization: `Bearer fc_sk_${'b'.repeat(43)}` });
    assert.deepEqual(limiter.calls.map((entry) => entry.bucket), ['auth-fail:ip']);
    limiter.calls.length = 0;
    await asStore(place());
    assert.ok(!limiter.calls.some((entry) => entry.bucket === 'auth-fail:ip'));
  });
});

describe('the surface that does not accept store keys', () => {
  it('is deaf to a store key and cannot mount a route open to one', async () => {
    const rest = routes.filter((candidate) => candidate.auth.kind === 'user' && candidate.auth.store === undefined);
    const app = await startApp({ routes: { v1: rest }, authenticate: { v1: userAuthenticate }, groupAccess: { groups } });
    try {
      assert.equal((await fetch(`${app.baseUrl}/v1/things`, { headers: { authorization: `Bearer ${KEY}` } })).status, 401);
    } finally {
      await app.close();
    }
    const create = (list: RouteDefinition[]) => () =>
      createApp({ config: testConfig(), logger: memoryLogger().logger, activityLog: memoryActivityLog(), rateLimiter: memoryRateLimiter(), readiness: { isShuttingDown: () => false, checks: [] }, routes: { v1: list }, authenticate: { v1: userAuthenticate }, groupAccess: { groups } });
    assert.throws(create([routes[0]!]), /needs a surface that accepts store keys/);
    assert.throws(create([routes[3]!]), /a store route needs a surface that accepts store keys/);
  });
});

describe('mountRoutes: the declarations about store keys', () => {
  const dependencies = { authenticate: userAuthenticate, groupAccess: { groups: { ...groups }, onCrossGroupAccess: () => undefined }, rateLimit: memoryRateLimitMount(), allowedAuth: ['anonymous', 'user', 'store'] as const, storeKeys: true as const };
  const user = (overrides: Record<string, unknown>, path = one, permission = 'places:read') =>
    defineRoute({ method: 'GET', path, auth: { kind: 'user', permission, group: true, store: true, ...overrides }, handler: who } as RouteDefinition);
  const problem = (list: RouteDefinition[], options: Record<string, unknown> = dependencies): string => {
    try {
      mountRoutes(express.Router(), list, options);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('expected mountRoutes to throw');
  };

  it('mounts the opt-in on a group route with :placeId whose permission is in the profile of the store', () => {
    mountRoutes(express.Router(), [user({})], dependencies);
    mountRoutes(express.Router(), [defineRoute({ method: 'GET', path: '/store-context', auth: { kind: 'store' }, handler: who })], dependencies);
  });

  it('rejects a store that is not literally true, and one on an anonymous route', () => {
    assert.match(problem([user({ store: false })]), /store can only be true/);
    assert.match(problem([user({ store: 'yes' })]), /store can only be true/);
    assert.match(problem([defineRoute({ method: 'GET', path: '/x', auth: { kind: 'anonymous', reason: 'r', store: true }, rateLimit: testIpLimit, handler: who } as unknown as RouteDefinition)]), /only user routes can be opened to a store key/);
  });

  it('rejects a permission that is not in the profile of the store, and anyPermission: a store never widens by a route', () => {
    assert.match(problem([user({}, one, 'places:update')]), /single permission that is in the profile of the store/);
    assert.match(problem([user({ permission: undefined, anyPermission: ['places:read'] })]), /single permission that is in the profile of the store/);
    assert.match(problem([user({}, one, 'storeKeys:manage')]), /in the profile of the store/);
  });

  it('rejects a route that is not on a group and on a place: a store never reaches lists or other places', () => {
    assert.match(problem([user({}, '/groups/:groupId/places')]), /must be on a group and on a :placeId/);
    assert.match(problem([user({}, '/groups/:groupId/places/:placeIdentifier')]), /must be on a group and on a :placeId/);
    assert.match(problem([user({ group: false }, '/places/:placeId')]), /must be on a group and on a :placeId/);
    assert.match(problem([user({}, '/things/:groupId/x/:placeId')]), /must be on a group and on a :placeId/);
  });

  it('rejects a pending password change on a route open to a store', () => {
    assert.match(problem([user({ allowWithPendingPasswordChange: true })]), /cannot allow a pending password change/);
  });

  it('needs the surface to accept store keys', () => {
    const { storeKeys: _unused, ...withoutFlag } = dependencies;
    assert.match(problem([user({})], withoutFlag), /needs a surface that accepts store keys/);
  });

  it('keeps a store route to its kind: no permission, group, feature, path parameter', () => {
    const only = (auth: Record<string, unknown>, path = '/store-context') => defineRoute({ method: 'GET', path, auth, handler: who } as unknown as RouteDefinition);
    assert.match(problem([only({ kind: 'store', permission: 'places:read' })]), /declares nothing but its kind/);
    assert.match(problem([only({ kind: 'store', group: false })]), /group can only be true/);
    assert.match(problem([only({ kind: 'store', group: true })], { ...dependencies, groupAccess: undefined }), /needs the groupAccess dependencies/);
    assert.doesNotThrow(() => mountRoutes(express.Router(), [only({ kind: 'store', group: true })], dependencies));
    assert.match(problem([only({ kind: 'store', store: true })]), /declares nothing but its kind/);
    assert.match(problem([only({ kind: 'store' }, '/store/:id')]), /no path parameter/);
    const { storeKeys: _unused, ...withoutFlag } = dependencies;
    assert.match(problem([only({ kind: 'store' })], withoutFlag), /a store route needs a surface that accepts store keys/);
    assert.match(problem([only({ kind: 'store' })], { ...dependencies, authenticate: undefined }), /a store route needs a surface that accepts store keys/);
    assert.match(problem([only({ kind: 'store' })], { ...dependencies, allowedAuth: ['anonymous', 'user'] }), /auth kind "store" is not allowed on this surface/);
  });
});

describe('mountRoutes: the ids and the operator of a store route', () => {
  const dependencies = { authenticate: userAuthenticate, groupAccess: { groups: { ...groups }, onCrossGroupAccess: () => undefined }, rateLimit: memoryRateLimitMount(), allowedAuth: ['anonymous', 'user', 'store'] as const, storeKeys: true as const };
  const operator: RequestHandler = (_req, _res, next) => next();
  const route = (auth: Record<string, unknown>, path: string, method = 'GET') => defineRoute({ method, path, auth: { kind: 'store', group: true, ...auth }, handler: who } as unknown as RouteDefinition);
  const problem = (list: RouteDefinition[]): string => {
    try {
      mountRoutes(express.Router(), list, dependencies);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('expected mountRoutes to throw');
  };

  it('mounts the ids of the catalog on a path that has exactly them, and the operator on a write', () => {
    mountRoutes(express.Router(), [route({ params: ['productId'] }, '/store/products/:productId'), route({ params: ['categoryId'], operator }, '/store/categories/:categoryId', 'PATCH'), route({ operator }, '/store/products', 'POST')], dependencies);
  });

  it('refuses a parameter that is not a declared id of the catalog: the group, the place and any other name never come from a path', () => {
    assert.match(problem([route({}, '/store/products/:productId')]), /no path parameter other than the ids it declares in params/);
    assert.match(problem([route({ params: ['productId'] }, '/store/products')]), /no path parameter other than the ids it declares in params/);
    assert.match(problem([route({ params: ['productId'] }, '/store/products/:categoryId')]), /no path parameter other than the ids it declares in params/);
    assert.match(problem([route({ params: ['productId'] }, '/store/products/:productId/:other')]), /no path parameter other than the ids it declares in params/);
    assert.match(problem([route({ params: ['productId'] }, '/store/products/:productId:x')]), /no path parameter other than the ids it declares in params/);
    for (const params of [['groupId'], ['placeId'], ['id'], [], ['productId', 'productId'], 'productId', [1]]) {
      assert.match(problem([route({ params }, '/store/:groupId')]), /params are a list, without repetitions, of productId, categoryId/);
    }
  });

  it('wants group: true with params or an operator, and no wildcard or group in the path', () => {
    assert.match(problem([route({ group: undefined, params: ['productId'] }, '/store/products/:productId')]), /with params or an operator must declare group: true/);
    assert.match(problem([route({ group: undefined, operator }, '/store/products', 'POST')]), /with params or an operator must declare group: true/);
    for (const path of ['/store/*', '/store/{products}', '/store/products{/:productId}', '/store/*rest', '/store/a}']) {
      assert.match(problem([route({}, path)]), /no wildcard or group/);
    }
  });

  it('wants an operator exactly on a write, and a function', () => {
    assert.match(problem([route({}, '/store/products', 'POST')]), /declares an operator exactly when it writes/);
    assert.match(problem([route({}, '/store/products/x', 'DELETE')]), /declares an operator exactly when it writes/);
    assert.match(problem([route({ operator }, '/store/products', 'GET')]), /declares an operator exactly when it writes/);
    assert.match(problem([route({ operator: 'yes' }, '/store/products', 'POST')]), /operator must be a function/);
  });

  it('runs the ids and the operator before the body of a write is read, and refuses an id that is not one', async () => {
    const seen: string[] = [];
    const verify: RequestHandler = (req, _res, next) => {
      seen.push(`operator:${req.get('x-operator') ?? 'none'}`);
      if (req.get('x-operator') !== 'ok') {
        throw new AppError('OPERATOR_NOT_ALLOWED');
      }
      next();
    };
    const limiter = memoryRateLimiter();
    const app = await startApp(
      {
        routes: { v1: [route({ params: ['productId'], operator: verify }, '/store/products/:productId', 'PATCH'), route({ params: ['productId'] }, '/store/products/:productId', 'GET')].map((definition) => ({ ...definition, handler: (req, res) => void res.json({ data: { id: req.params['productId'], body: req.body ?? null } }) })) },
        authenticate: { v1: userAuthenticate, store: storeAuthenticate },
        groupAccess: { groups },
        rateLimiter: limiter,
      },
      {},
    );
    try {
      const call = (method: string, id: string, headers: Record<string, string>, body?: string) =>
        fetch(`${app.baseUrl}/v1/store/products/${id}`, { method, headers: { authorization: `Bearer ${KEY}`, ...headers }, ...(body === undefined ? {} : { body }) });
      const id = 'a'.repeat(24);
      assert.equal((await call('GET', id, {})).status, 200);
      assert.equal((await call('GET', id.toUpperCase(), {})).status, 200);
      for (const bad of ['not-an-id', 'a'.repeat(23), 'g'.repeat(24), `${id}0`]) {
        const reply = await call('GET', bad, {});
        assert.deepEqual([reply.status, ((await reply.json()) as { error: { code: string; details: unknown } }).error.details], [422, [{ field: 'productId', issue: 'format' }]], bad);
      }
      // A write whose operator is refused: 403 even though the body is not JSON, so the body was never read; an id that is not one is refused before the operator is asked.
      seen.length = 0;
      const refused = await call('PATCH', id, { 'content-type': 'application/json', 'x-operator': 'no' }, '{"broken":');
      assert.deepEqual([refused.status, ((await refused.json()) as { error: { code: string } }).error.code], [403, 'OPERATOR_NOT_ALLOWED']);
      assert.equal((await call('PATCH', 'nope', { 'content-type': 'application/json', 'x-operator': 'ok' }, '{}')).status, 422);
      assert.deepEqual(seen, ['operator:no']);
      const written = await call('PATCH', id, { 'content-type': 'application/json', 'x-operator': 'ok' }, '{"a":1}');
      assert.deepEqual(await written.json(), { data: { id, body: { a: 1 } } });
      assert.equal((await call('PATCH', id, { 'content-type': 'application/json' }, '{}')).status, 403);
    } finally {
      await app.close();
    }
  });
});
