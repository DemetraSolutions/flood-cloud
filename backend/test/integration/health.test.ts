import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers/app.ts';
import type { AppDeps } from '../../src/app.ts';

const never = (): Promise<void> => new Promise<void>(() => undefined);

async function readiness(deps: AppDeps['readiness']): Promise<{ status: number; body: unknown; events: Array<Record<string, unknown>> }> {
  const t = await startApp({ readiness: deps });
  try {
    const res = await fetch(`${t.baseUrl}/health/ready`);
    return { status: res.status, body: await res.json(), events: t.events };
  } finally {
    await t.close();
  }
}

describe('health', () => {
  it('GET /health/live is always 200', async () => {
    const t = await startApp({ readiness: { isShuttingDown: () => true, checks: [] } });
    try {
      const res = await fetch(`${t.baseUrl}/health/live`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { data: { status: 'ok' } });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      await t.close();
    }
  });

  it('GET /health/ready is 200 with no checks and with passing checks', async () => {
    const empty = await readiness({ isShuttingDown: () => false, checks: [] });
    assert.deepEqual([empty.status, empty.body], [200, { data: { status: 'ok' } }]);
    const passing = await readiness({ isShuttingDown: () => false, checks: [async () => undefined, async () => undefined] });
    assert.equal(passing.status, 200);
  });

  it('is 503 while shutting down, without running the checks', async () => {
    let called = false;
    const result = await readiness({
      isShuttingDown: () => true,
      checks: [async () => void (called = true)],
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable' } });
    assert.equal(called, false);
    assert.equal(result.events.find((event) => event['level'] === 'warn')?.['msg'], 'not ready: shutting down');
  });

  it('is 503 when a check fails, hiding the cause from the response and logging it', async () => {
    const result = await readiness({
      isShuttingDown: () => false,
      checks: [async () => undefined, async () => Promise.reject(new Error('db password leaked'))],
    });
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result.body).includes('leaked'));
    const warn = result.events.find((event) => event['level'] === 'warn');
    assert.equal(warn?.['msg'], 'not ready: dependency check failed');
    assert.match(JSON.stringify(warn), /db password leaked/);
  });

  it('is 503 when a check exceeds the timeout', async () => {
    const { createHealthRoutes } = await import('../../src/modules/health/health.routes.ts');
    const { memoryLogger } = await import('../helpers/app.ts');
    const { logger, events } = memoryLogger();
    const routes = createHealthRoutes({ isShuttingDown: () => false, checks: [never] }, logger, 30);
    const ready = routes[1];
    assert.ok(ready);
    await assert.rejects(
      async () => {
        await ready.handler({} as never, {} as never, () => undefined);
      },
      { code: 'SERVICE_UNAVAILABLE', status: 503 },
    );
    assert.match(JSON.stringify(events), /timed out/);
  });
});
