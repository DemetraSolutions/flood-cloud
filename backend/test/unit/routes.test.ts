import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { defineRoute, mountRoutes } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';

const handler = (): void => undefined;
const auth = { kind: 'anonymous', reason: 'public test route' } as const;

function route(overrides: Record<string, unknown> = {}): RouteDefinition {
  return defineRoute({ method: 'GET', path: '/things', auth, handler, ...overrides } as RouteDefinition);
}

function mountError(routes: RouteDefinition[]): string {
  try {
    mountRoutes(express.Router(), routes);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('expected mountRoutes to throw');
}

describe('mountRoutes validation', () => {
  it('mounts valid routes of every method', () => {
    const router = express.Router();
    mountRoutes(
      router,
      (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => route({ method, path: '/ok' })),
    );
    assert.ok(router.stack.length > 0);
  });

  it('accepts an empty list', () => {
    mountRoutes(express.Router(), []);
  });

  it('rejects a route without auth', () => {
    assert.match(mountError([route({ auth: undefined })]), /GET \/things: missing auth declaration/);
    assert.match(mountError([route({ auth: null })]), /missing auth declaration/);
  });

  it('rejects an unknown auth kind', () => {
    assert.match(mountError([route({ auth: { kind: 'bearer' } })]), /unknown auth kind/);
  });

  it('rejects an anonymous route without reason', () => {
    for (const reason of [undefined, '', '   ', 5]) {
      assert.match(mountError([route({ auth: { kind: 'anonymous', reason } })]), /non-empty reason/);
    }
  });

  it('rejects a disallowed method and a bad path', () => {
    assert.match(mountError([route({ method: 'OPTIONS' })]), /method not allowed/);
    assert.match(mountError([route({ path: 'things' })]), /path must be a string starting with "\/"/);
    assert.match(mountError([route({ path: 5 })]), /path must be a string/);
  });

  it('rejects duplicate method and path but allows the same path with another method', () => {
    assert.match(mountError([route(), route()]), /GET \/things: duplicate route/);
    mountRoutes(express.Router(), [route(), route({ method: 'POST' })]);
  });

  it('reports every problem at once', () => {
    const message = mountError([route({ auth: undefined }), route({ path: '/b', auth: { kind: 'anonymous', reason: '' } })]);
    assert.match(message, /missing auth declaration/);
    assert.match(message, /non-empty reason/);
  });

  it('detects duplicates after normalizing case, trailing slash and param names', () => {
    for (const other of ['/Things', '/things/']) {
      assert.match(mountError([route(), route({ path: other })]), /duplicate route/);
    }
    assert.match(mountError([route({ path: '/a/:id' }), route({ path: '/a/:name' })]), /duplicate route/);
    mountRoutes(express.Router(), [route({ path: '/' }), route({ path: '/a/:id' }), route({ path: '/a/:id/b' })]);
  });
});

describe('mountRoutes with user routes', () => {
  const authenticate = (): void => undefined;
  const groupAccess = { groups: { findAvailability: async () => null }, onCrossGroupAccess: () => undefined };
  const options = { authenticate, allowedAuth: ['anonymous', 'user'] } as const;
  const userRoute = (overrides: Record<string, unknown> = {}): RouteDefinition =>
    route({ auth: { kind: 'user', permission: 'places:read' }, ...overrides });
  const mountMessage = (routes: RouteDefinition[], mountOptions: Parameters<typeof mountRoutes>[2]): string => {
    try {
      mountRoutes(express.Router(), routes, mountOptions);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('expected mountRoutes to throw');
  };

  it('mounts a user route when the surface allows it and an authenticate middleware is given', () => {
    mountRoutes(express.Router(), [userRoute()], options);
  });

  it('fails at startup when a user route has no authenticate middleware (deny by default)', () => {
    assert.match(mountMessage([userRoute()], { allowedAuth: ['user'] }), /GET \/things: user route needs an authenticate middleware/);
    // Anonymous routes alone do not need it.
    mountRoutes(express.Router(), [route()]);
  });

  it('fails at startup on a surface that does not allow user routes (the default)', () => {
    assert.match(mountError([userRoute()]), /auth kind "user" is not allowed on this surface/);
    assert.match(mountMessage([userRoute()], { authenticate }), /auth kind "user" is not allowed on this surface/);
    assert.match(mountMessage([route()], { allowedAuth: ['user'] }), /auth kind "anonymous" is not allowed on this surface/);
    mountRoutes(express.Router(), [route()], { allowedAuth: ['anonymous'] });
  });

  it('rejects a permission outside the catalog', () => {
    for (const permission of ['places:delete', '', undefined, 5]) {
      assert.match(mountMessage([userRoute({ auth: { kind: 'user', permission } })], options), /unknown permission/);
    }
  });

  it('requires group: true exactly when the path has :groupId', () => {
    const grouped = { kind: 'user', permission: 'places:read', group: true };
    const both = { ...options, groupAccess };
    mountRoutes(express.Router(), [userRoute({ path: '/groups/:groupId/places', auth: grouped })], both);
    mountRoutes(express.Router(), [userRoute({ path: '/groups/:groupId', auth: grouped }), userRoute({ path: '/groups/:groupId/x/:id', auth: grouped })], both);
    assert.match(mountMessage([userRoute({ path: '/groups/:groupId/places' })], both), /exactly when the auth declares group: true/);
    assert.match(mountMessage([userRoute({ path: '/places', auth: grouped })], both), /exactly when the auth declares group: true/);
    assert.match(mountMessage([userRoute({ path: '/groups/:groupId/places', auth: { ...grouped, group: false } })], both), /exactly when/);
    // Any other name after /groups/ is refused, on every kind of route.
    assert.match(mountMessage([userRoute({ path: '/groups/:id/places' })], both), /must be named :groupId, not :id/);
    assert.match(mountMessage([route({ path: '/groups/:groupIds' })], both), /must be named :groupId, not :groupIds/);
    mountRoutes(express.Router(), [route({ path: '/groups' }), route({ path: '/groups/list' })]);
    // A different parameter name elsewhere does not count.
    mountRoutes(express.Router(), [userRoute({ path: '/g/:groupIds/places' })], both);
    assert.match(mountMessage([userRoute({ path: '/g/:groupIds/places', auth: grouped })], both), /exactly when/);
  });

  it('requires the group access dependencies for a group route', () => {
    const grouped = { kind: 'user', permission: 'places:read', group: true };
    assert.match(mountMessage([userRoute({ path: '/g/:groupId', auth: grouped })], options), /needs the groupAccess dependencies/);
  });
});
