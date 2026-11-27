import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startHealthServer } from '../../src/health.ts';

async function call(port: number, path: string, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: response.status, body: await response.text(), headers: response.headers };
}

describe('health server', () => {
  it('answers 200 while alive and 503 when stale, with minimal headers', async () => {
    let alive = true;
    const server = await startHealthServer(0, () => alive, '127.0.0.1');
    try {
      const up = await call(server.port, '/health/live');
      assert.equal(up.status, 200);
      assert.deepEqual(JSON.parse(up.body), { status: 'ok' });
      assert.equal(up.headers.get('cache-control'), 'no-store');
      assert.equal(up.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await call(server.port, '/health/live?probe=1')).status, 200);
      alive = false;
      const down = await call(server.port, '/health/live');
      assert.equal(down.status, 503);
      assert.deepEqual(JSON.parse(down.body), { status: 'stale' });
    } finally {
      await server.close();
    }
  });

  it('answers 404 to every other path and method without information', async () => {
    const server = await startHealthServer(0, () => true);
    try {
      for (const [path, method] of [['/', 'GET'], ['/health', 'GET'], ['/health/live/', 'GET'], ['/health/live', 'POST']] as const) {
        const response = await call(server.port, path, method);
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.deepEqual(JSON.parse(response.body), { status: 'not_found' });
      }
    } finally {
      await server.close();
    }
  });

  it('can be closed twice and rejects when the port is taken', async () => {
    const first = await startHealthServer(0, () => true, '127.0.0.1');
    await assert.rejects(startHealthServer(first.port, () => true, '127.0.0.1'), { code: 'EADDRINUSE' });
    await first.close();
    await first.close();
  });
});
