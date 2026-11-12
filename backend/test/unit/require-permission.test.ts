import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestHandler } from 'express';
import { errorHandler } from '../../src/shared/http/error-handler.ts';
import { defineRoute, mountRoutes } from '../../src/shared/http/routes.ts';
import { requirePermission } from '../../src/shared/security/rbac/require-permission.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryRateLimitMount, testIpLimit, recordingErrorReporter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { principalOf } from '../helpers/principal.ts';

let current: AuthPrincipal | undefined;
const calls: string[] = [];
let server: Server;
let baseUrl: string;

const authenticate: RequestHandler = (_req, res, next) => {
  calls.push('authenticate');
  if (current !== undefined) {
    res.locals.auth = current;
  }
  next();
};

before(async () => {
  const app = express();
  const router = express.Router();
  mountRoutes(
    router,
    [
      defineRoute({
        method: 'GET',
        path: '/places',
        auth: { kind: 'user', permission: 'places:read' },
        handler: (_req, res) => {
          calls.push('handler');
          res.json({ data: 'ok' });
        },
      }),
      defineRoute({
        method: 'POST',
        path: '/places',
        auth: { kind: 'user', permission: 'places:create' },
        handler: (req, res) => void res.status(201).json({ data: req.body as unknown }),
      }),
      defineRoute({ method: 'GET', path: '/open', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: testIpLimit, handler: (_req, res) => void res.json({ data: 'open' }) }),
    ],
    { authenticate, allowedAuth: ['anonymous', 'user'], rateLimit: memoryRateLimitMount() },
  );
  app.use('/v1', router);
  app.use(errorHandler(memoryLogger().logger, recordingErrorReporter().reporter));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = async (path: string, init?: RequestInit): Promise<{ status: number; code: string | undefined }> => {
  calls.length = 0;
  const response = await fetch(`${baseUrl}/v1${path}`, init);
  const body = (await response.json()) as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
};

describe('user routes: authenticate, beforePermission, permission, handler', () => {
  it('answers 401 when authenticate leaves no principal, and never reaches the handler', async () => {
    current = undefined;
    assert.deepEqual(await call('/places'), { status: 401, code: 'UNAUTHENTICATED' });
    assert.ok(!calls.includes('handler'));
  });

  it('answers 403 when the principal lacks the permission', async () => {
    current = principalOf('PSA', { permissions: new Set(['places:create']) });
    assert.deepEqual(await call('/places'), { status: 403, code: 'FORBIDDEN' });
    assert.ok(!calls.includes('handler'));
  });

  it('answers 403 to E, whose ceiling is empty', async () => {
    current = principalOf('E');
    assert.equal((await call('/places')).status, 403);
  });

  it('answers 200 when the permission is held, running authenticate before the handler', async () => {
    current = principalOf('PA', { placeIds: [] });
    assert.deepEqual(await call('/places'), { status: 200, code: undefined });
    assert.deepEqual(calls, ['authenticate', 'handler']);
  });

  it('checks the permission before parsing a body', async () => {
    current = principalOf('PA');
    const denied = await call('/places', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.deepEqual(denied, { status: 403, code: 'FORBIDDEN' });
    current = principalOf('CA');
    assert.deepEqual(await call('/places', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }), { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    assert.equal((await call('/places', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })).status, 201);
  });

  it('does not run authentication for anonymous routes', async () => {
    current = undefined;
    assert.deepEqual(await call('/open'), { status: 200, code: undefined });
    assert.deepEqual(calls, []);
  });
});

describe('requirePermission', () => {
  it('works on its own as a handler, telling the hook the outcome before denying', async () => {
    const decisions: boolean[] = [];
    const handler = requirePermission('users:read', (_principal, granted) => void decisions.push(granted));
    let nextCalled = false;
    await handler({} as never, { locals: { auth: principalOf('SA') } } as never, () => void (nextCalled = true));
    assert.equal(nextCalled, true);
    await assert.rejects(async () => handler({} as never, { locals: {} } as never, () => undefined), { code: 'UNAUTHENTICATED' });
    await assert.rejects(async () => handler({} as never, { locals: { auth: principalOf('E') } } as never, () => undefined), { code: 'FORBIDDEN' });
    assert.deepEqual(decisions, [true, false]);
  });

  it('accepts a list of alternatives: one held permission is enough, none is a denial', async () => {
    const handler = requirePermission(['dealers:read', 'users:read']);
    let nextCalled = false;
    await handler({} as never, { locals: { auth: principalOf('SA') } } as never, () => void (nextCalled = true));
    assert.equal(nextCalled, true);
    await assert.rejects(async () => handler({} as never, { locals: { auth: principalOf('E') } } as never, () => undefined), { code: 'FORBIDDEN' });
  });

  it('works without a hook', async () => {
    await assert.rejects(async () => requirePermission('users:read')({} as never, { locals: { auth: principalOf('E') } } as never, () => undefined), { code: 'FORBIDDEN' });
  });
});
