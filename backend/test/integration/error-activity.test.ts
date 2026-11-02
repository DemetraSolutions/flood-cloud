import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import { memoryActivityLog, testIpLimit } from '../helpers/activity.ts';
import { startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';

const activity = memoryActivityLog();
let app: TestServer;
before(async () => {
  app = await startApp({
    activityLog: activity,
    routes: {
      v1: [
        defineRoute({ method: 'GET', path: '/boom', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: testIpLimit, handler: () => { throw new TypeError('secret internal detail mongodb://user:pw@host'); } }),
        defineRoute({ method: 'GET', path: '/things/:id', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: testIpLimit, handler: () => { throw new Error('boom'); } }),
        defineRoute({ method: 'GET', path: '/missing', auth: { kind: 'anonymous', reason: 'test' }, rateLimit: testIpLimit, handler: () => { throw new AppError('NOT_FOUND'); } }),
      ],
    },
  });
});
after(() => app.close());

describe('errors in the activity log', () => {
  it('records a 500 with request id, route without query and error class, but not message or stack', async () => {
    const response = await fetch(`${app.baseUrl}/v1/boom?token=abc`);
    assert.equal(response.status, 500);
    const requestId = response.headers.get('x-request-id');
    // The write is not awaited by the handler: it is already done when the response has been received.
    const [entry] = activity.entries;
    assert.deepEqual(entry, {
      category: 'error',
      action: 'request.failed',
      outcome: 'failure',
      actor: { kind: 'anonymous' },
      requestId,
      ip: entry?.ip,
      metadata: { method: 'GET', route: '/v1/boom', errorName: 'TypeError' },
    });
    assert.ok(entry?.ip !== undefined);
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('secret') && !serialized.includes('mongodb') && !serialized.includes('token=abc') && !serialized.includes('at '));
    // The message and the stack stay on stdout, redacted.
    assert.ok(app.events.some((event) => event['msg'] === 'unhandled error'));
  });

  it('records the route pattern, never the concrete path', async () => {
    const before = activity.entries.length;
    await fetch(`${app.baseUrl}/v1/things/%66c_at_SECRETTOKEN?x=1`);
    const entry = activity.entries[before];
    assert.equal(entry?.metadata?.['route'], '/v1/things/:id');
    assert.ok(!JSON.stringify(entry).includes('SECRETTOKEN') && !JSON.stringify(entry).includes('fc_at'));
  });

  it('does not record 4xx errors', async () => {
    const before = activity.entries.length;
    assert.equal((await fetch(`${app.baseUrl}/v1/missing`)).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/v1/nowhere`)).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/v1/boom`, { method: 'DELETE' })).status, 405);
    assert.equal(activity.entries.length, before);
  });
});
