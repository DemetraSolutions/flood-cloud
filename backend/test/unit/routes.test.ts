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
