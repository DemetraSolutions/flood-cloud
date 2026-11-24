import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuthRoutes } from '../../src/modules/auth/auth.routes.ts';
import { createMeRoutes } from '../../src/modules/me/me.routes.ts';
import { defineRoute, mountRoutes, SUSTAINED_EXEMPT_ROUTES } from '../../src/shared/http/routes.ts';
import type { RouteDefinition } from '../../src/shared/http/routes.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { memoryRateLimitMount } from '../helpers/activity.ts';
import { testConfig } from '../helpers/app.ts';

const rules = createRateLimitRules(testConfig());
const handler = (): void => undefined;
const dependencies = { authenticate: handler, rateLimit: memoryRateLimitMount(), allowedAuth: ['anonymous', 'user'] as const };
const mount = (routes: RouteDefinition[]) => mountRoutes(express.Router(), routes, dependencies);

describe('the routes the hourly and daily limits never refuse', () => {
  it('are a closed set: logout, logout of all sessions, own password, own PIN, revocation of an own session', () => {
    assert.deepEqual([...SUSTAINED_EXEMPT_ROUTES].sort(), ['DELETE /me/sessions/:sessionId', 'POST /auth/logout', 'POST /auth/logout-all', 'PUT /me/password', 'PUT /me/pin']);
    assert.ok(Object.isFrozen(SUSTAINED_EXEMPT_ROUTES) || SUSTAINED_EXEMPT_ROUTES instanceof Set);
  });

  it('are exactly the routes of the code that declare the flag, and no other', () => {
    const declared = [...createAuthRoutes({} as never, rules), ...createMeRoutes({} as never, rules)].filter((route) => route.sustainedExempt === true).map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(declared.sort(), [...SUSTAINED_EXEMPT_ROUTES].sort());
  });

  it('block the start when another route, a non user route or a value other than true declares it', () => {
    const user = { kind: 'user', permission: 'profile:read' } as const;
    assert.doesNotThrow(() => mount([defineRoute({ method: 'POST', path: '/auth/logout', auth: user, sustainedExempt: true, handler })]));
    assert.throws(() => mount([defineRoute({ method: 'GET', path: '/things', auth: user, sustainedExempt: true, handler })]), /GET \/things: sustainedExempt can only be true, on a user route of SUSTAINED_EXEMPT_ROUTES/);
    // No pattern: the same path with another method, or another path under the same prefix, is refused.
    assert.throws(() => mount([defineRoute({ method: 'GET', path: '/auth/logout', auth: user, sustainedExempt: true, handler })]), /sustainedExempt/);
    assert.throws(() => mount([defineRoute({ method: 'DELETE', path: '/me/sessions/:id', auth: user, sustainedExempt: true, handler })]), /sustainedExempt/);
    assert.throws(() => mount([defineRoute({ method: 'POST', path: '/auth/logout', auth: user, sustainedExempt: false as never, handler })]), /sustainedExempt/);
    assert.throws(() => mountRoutes(express.Router(), [defineRoute({ method: 'POST', path: '/auth/logout', auth: { kind: 'anonymous', reason: 'x' }, rateLimit: [rules.loginPerIp], sustainedExempt: true, handler })], dependencies), /sustainedExempt/);
  });
});
