import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger, testConfig } from '../helpers/app.ts';

const userRoute: RouteDefinition = defineRoute({ method: 'GET', path: '/things', auth: { kind: 'user', permission: 'places:read' }, handler: () => undefined });
const groupRoute: RouteDefinition = defineRoute({ method: 'GET', path: '/g/:groupId', auth: { kind: 'user', permission: 'places:read', group: true }, handler: () => undefined });
const build = (extra: Partial<Parameters<typeof createApp>[0]>) =>
  createApp({ config: testConfig(), logger: memoryLogger().logger, activityLog: memoryActivityLog(), rateLimiter: memoryRateLimiter(), readiness: { isShuttingDown: () => false, checks: [] }, ...extra });

describe('which surface accepts which kind of route', () => {
  it('accepts user routes on /v1 with an authenticator', () => {
    build({ routes: { v1: [userRoute] }, authenticate: { v1: (_req, _res, next) => next() } });
  });

  it('refuses user routes on /v1 without an authenticator (deny by default)', () => {
    assert.throws(() => build({ routes: { v1: [userRoute] } }), /user route needs an authenticate middleware/);
  });

  it('refuses group routes on /v1 without the group access dependencies', () => {
    assert.throws(() => build({ routes: { v1: [groupRoute] }, authenticate: { v1: (_req, _res, next) => next() } }), /needs the groupAccess dependencies/);
  });

  it('refuses user routes on the public surface, even with an authenticator', () => {
    assert.throws(() => build({ routes: { public: [userRoute] }, authenticate: { v1: (_req, _res, next) => next() } }), /auth kind "user" is not allowed on this surface/);
  });
});
