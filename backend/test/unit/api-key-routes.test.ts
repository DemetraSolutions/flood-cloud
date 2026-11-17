import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute, mountRoutes } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { frozenSet } from '../../src/shared/security/frozen.ts';
import type { PublicPermission } from '../../src/shared/security/rbac/public-permissions.ts';
import { isPublicPermission, PUBLIC_PERMISSIONS } from '../../src/shared/security/rbac/public-permissions.ts';
import { memoryRateLimitMount } from '../helpers/activity.ts';
import { startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';

const handler: RequestHandler = (_req, res) => void res.json({ data: { ok: true } });
const authenticate: RequestHandler = (req, res, next) => {
  const held = req.get('x-test-permissions');
  if (req.get('x-test-key') === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  if (req.get('x-test-no-principal') === undefined) {
    res.locals.apiKey = { kind: 'apiKey', keyId: new ObjectId(), permissions: frozenSet<PublicPermission>((held ?? '').split(',').filter(isPublicPermission)) } as never;
  }
  next();
};

const route = (overrides: Record<string, unknown> = {}): RouteDefinition => defineRoute({ method: 'GET', path: '/things', auth: { kind: 'apiKey', permission: 'places:read' }, handler, ...overrides } as RouteDefinition);
const withKeys = { allowedAuth: ['apiKey'] as const, authenticate, rateLimit: memoryRateLimitMount() };

function mountError(routes: RouteDefinition[], options: Parameters<typeof mountRoutes>[2] = withKeys): string {
  try {
    mountRoutes(express.Router(), routes, options);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('expected mountRoutes to throw');
}

describe('the public catalog of permissions', () => {
  it('lists places, companies and the catalog, and recognizes only them', () => {
    assert.deepEqual([...PUBLIC_PERMISSIONS], ['places:read', 'companies:read', 'catalog:read']);
    for (const value of PUBLIC_PERMISSIONS) {
      assert.equal(isPublicPermission(value), true);
    }
    for (const value of ['products:read', 'storeKeys:read', 'places:update', '', 'toString', 5, null, undefined]) {
      assert.equal(isPublicPermission(value), false);
    }
  });
});

describe('the routes of the public surface', () => {
  it('mounts a route with a permission of the public catalog and one with null', () => {
    mountRoutes(express.Router(), [route(), route({ path: '/me', auth: { kind: 'apiKey', permission: null } })], withKeys);
  });

  it('refuses a route that does not declare its permission, or one outside the public catalog', () => {
    for (const permission of [undefined, 'products:read', 'storeKeys:read', 'places:update', '', 5]) {
      assert.match(mountError([route({ auth: { kind: 'apiKey', permission } })]), /an API key route declares a permission of the public catalog, or null/);
    }
  });

  it('refuses what is not for an API key route: groups, features, lists of permissions, store and pending password', () => {
    for (const extra of [{ group: true }, { feature: 'rooms' }, { anyPermission: ['places:read'] }, { allowWithPendingPasswordChange: true }, { store: true }]) {
      assert.match(mountError([route({ auth: { kind: 'apiKey', permission: 'places:read', ...extra } })]), /declares nothing but its kind and its permission/);
    }
  });

  it('needs the authentication and the rate limit dependencies of the surface', () => {
    assert.match(mountError([route()], { allowedAuth: ['apiKey'], rateLimit: memoryRateLimitMount() }), /API key route needs an authenticate middleware/);
    assert.match(mountError([route()], { allowedAuth: ['apiKey'], authenticate }), /API key route needs the rateLimit dependencies/);
  });

  it('is accepted on the public surface only: the other surfaces, by default, refuse it', () => {
    assert.match(mountError([route()], { authenticate, rateLimit: memoryRateLimitMount() }), /auth kind "apiKey" is not allowed on this surface/);
    assert.match(mountError([route()], { allowedAuth: ['anonymous', 'user', 'store'], authenticate, rateLimit: memoryRateLimitMount() }), /auth kind "apiKey" is not allowed on this surface/);
  });

  it('refuses on the public surface every route that is not an API key route', () => {
    const anonymous = defineRoute({ method: 'GET', path: '/open', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: [{ bucket: 'x', limit: 1, key: () => 'k' }], handler });
    const user = defineRoute({ method: 'GET', path: '/users', auth: { kind: 'user', permission: 'places:read' }, handler });
    const store = defineRoute({ method: 'GET', path: '/store', auth: { kind: 'store' }, handler });
    const message = mountError([anonymous, user, store], withKeys);
    assert.match(message, /GET \/open: auth kind "anonymous" is not allowed on this surface/);
    assert.match(message, /GET \/users: auth kind "user" is not allowed on this surface/);
    assert.match(message, /GET \/store: auth kind "store" is not allowed on this surface/);
  });
});

describe('the chain of an API key route', () => {
  let server: TestServer;
  before(async () => {
    server = await startApp({
      routes: {
        public: [
          route({ path: '/places' }),
          route({ path: '/companies', auth: { kind: 'apiKey', permission: 'companies:read' } }),
          route({ path: '/me', auth: { kind: 'apiKey', permission: null } }),
          route({ method: 'POST', path: '/posted', auth: { kind: 'apiKey', permission: 'places:read' }, handler: ((req, res) => void res.json({ data: req.body as unknown })) as RequestHandler }),
        ],
      },
      authenticate: { public: authenticate },
    });
  });
  after(() => server.close());
  const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => fetch(`${server.baseUrl}/public/v1${path}`, { headers, ...init });

  it('authenticates first, then checks the permission: 401, 403 or the handler', async () => {
    assert.equal((await get('/places')).status, 401);
    assert.equal((await get('/places', { 'x-test-key': '1', 'x-test-permissions': 'companies:read' })).status, 403);
    assert.equal((await get('/places', { 'x-test-key': '1', 'x-test-permissions': 'places:read,catalog:read' })).status, 200);
    assert.equal((await get('/companies', { 'x-test-key': '1', 'x-test-permissions': 'places:read' })).status, 403);
    assert.equal((await get('/companies', { 'x-test-key': '1', 'x-test-permissions': 'companies:read' })).status, 200);
  });

  it('lets a key with no permission at all call the route that declares null', async () => {
    assert.equal((await get('/me', { 'x-test-key': '1' })).status, 200);
    assert.equal((await get('/me')).status, 401);
  });

  it('answers 401 when the authentication lets a request through without a principal: deny by default', async () => {
    const reply = await get('/me', { 'x-test-key': '1', 'x-test-no-principal': '1' });
    assert.equal(reply.status, 401);
  });

  it('reads the body of a write only after the permission, and refuses a body that is not JSON', async () => {
    const headers = { 'x-test-key': '1', 'x-test-permissions': 'places:read', 'content-type': 'application/json' };
    assert.deepEqual(await (await get('/posted', headers, { method: 'POST', body: '{"a":1}' })).json(), { data: { a: 1 } });
    assert.equal((await get('/posted', { ...headers, 'x-test-permissions': 'companies:read' }, { method: 'POST', body: 'not json' })).status, 403);
    assert.equal((await get('/posted', { ...headers, 'content-type': 'text/plain' }, { method: 'POST', body: 'x' })).status, 415);
  });
});
