import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthRoutes, READINESS_CHECK_TIMEOUT_MS } from '../../src/modules/health/health.routes.ts';
import { memoryLogger } from '../helpers/app.ts';

describe('createHealthRoutes', () => {
  it('declares both routes as anonymous with a reason', () => {
    const routes = createHealthRoutes({ isShuttingDown: () => false, checks: [] }, memoryLogger().logger);
    assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), ['GET /live', 'GET /ready']);
    for (const route of routes) {
      assert.equal(route.auth.kind, 'anonymous');
      assert.notEqual(route.auth.reason, '');
    }
    assert.equal(READINESS_CHECK_TIMEOUT_MS, 2000);
  });
});
