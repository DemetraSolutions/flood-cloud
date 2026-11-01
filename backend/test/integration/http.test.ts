import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { sendData, sendPage } from '../../src/shared/http/envelope.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import { SECURITY_HEADERS } from '../../src/shared/http/security-headers.ts';
import { startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';

const auth = { kind: 'anonymous', reason: 'test route' } as const;
const ORIGIN = 'https://backoffice.example.com';

const testRoutes = [
  defineRoute({ method: 'GET', path: '/items', auth, handler: (_req, res) => sendData(res, [1]) }),
  defineRoute({ method: 'GET', path: '/page', auth, handler: (_req, res) => sendPage(res, [1, 2], { limit: 2, next: 'abc' }) }),
  defineRoute({
    method: 'POST',
    path: '/items',
    auth,
    handler: (req, res) => sendData(res, { echo: req.body as unknown }, 201),
  }),
  defineRoute({ method: 'POST', path: '/small', auth, bodyLimit: '10b', handler: (_req, res) => sendData(res, {}, 201) }),
  defineRoute({ method: 'PUT', path: '/items', auth, handler: (_req, res) => sendData(res, {}) }),
  defineRoute({ method: 'DELETE', path: '/items', auth, handler: (_req, res) => void res.status(204).end() }),
  defineRoute({ method: 'GET', path: '/boom', auth, handler: () => { throw new Error('secret internal detail'); } }),
  defineRoute({ method: 'GET', path: '/async-boom', auth, handler: async () => { throw new Error('async secret detail'); } }),
  defineRoute({ method: 'GET', path: '/things/:id', auth, handler: (req, res) => sendData(res, { id: req.params['id'] }) }),
  defineRoute({
    method: 'GET',
    path: '/bad-header',
    auth,
    handler: () => {
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': '1\n2' } });
    },
  }),
  defineRoute({ method: 'GET', path: '/slow', auth, handler: async (_req, res) => { await new Promise((r) => setTimeout(r, 300)); sendData(res, {}); } }),
  defineRoute({ method: 'GET', path: '/app-error', auth, handler: () => { throw new AppError('CONFLICT', { message: 'Duplicate' }); } }),
  defineRoute({
    method: 'GET',
    path: '/big',
    auth,
    handler: (_req, res) => sendData(res, 'x'.repeat(3000)),
  }),
  defineRoute({
    method: 'GET',
    path: '/late-failure',
    auth,
    handler: async (_req, res) => {
      res.write('partial');
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('after headers');
    },
  }),
];

describe('HTTP pipeline', () => {
  let t: TestServer;
  before(async () => {
    t = await startApp(
      { routes: { v1: testRoutes, public: testRoutes } },
      { CORS_ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: '1' },
    );
  });
  after(() => t.close());

  const json = { 'Content-Type': 'application/json' };

  function assertSecurityHeaders(res: Response): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers.get(name), value, name);
    }
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('etag'), null);
  }

  it('answers successes with the envelope, security headers and a request id', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
    assert.deepEqual(await res.json(), { data: [1] });
    assertSecurityHeaders(res);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  it('answers lists with the page envelope', async () => {
    const res = await fetch(`${t.baseUrl}/public/v1/page`);
    assert.deepEqual(await res.json(), { data: [1, 2], page: { limit: 2, next: 'abc' } });
  });

  it('creates with 201 and parses a JSON body', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: json, body: JSON.stringify({ a: 1 }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { data: { echo: { a: 1 } } });
    const withCharset = await fetch(`${t.baseUrl}/v1/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{"a":2}',
    });
    assert.equal(withCharset.status, 201);
  });

  it('answers 204 without body', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  });

  it('accepts a POST without body', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST' });
    assert.equal(res.status, 201);
  });

  it('accepts a POST that declares neither length nor content type', async () => {
    const port = Number(new URL(t.baseUrl).port);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('POST /v1/items HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString()));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 201 /);
  });

  it('answers 400 for malformed JSON', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: json, body: '{"a":' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: { code: 'MALFORMED_JSON', message: 'Malformed JSON' } });
    assertSecurityHeaders(res);
  });

  it('rejects non-object JSON in strict mode', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: json, body: '"text"' });
    assert.equal(res.status, 400);
  });

  it('answers 413 above the route body limit', async () => {
    const ok = await fetch(`${t.baseUrl}/v1/small`, { method: 'POST', headers: json, body: '{"a":1}' });
    assert.equal(ok.status, 201);
    const res = await fetch(`${t.baseUrl}/v1/small`, { method: 'POST', headers: json, body: JSON.stringify({ a: 'x'.repeat(50) }) });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'PAYLOAD_TOO_LARGE');
    assertSecurityHeaders(res);
  });

  it('applies the default body limit of 100kb', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: json, body: JSON.stringify({ a: 'x'.repeat(110 * 1024) }) });
    assert.equal(res.status, 413);
  });

  it('answers 415 for other content types and charsets', async () => {
    for (const headers of [
      { 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      { 'Content-Type': 'application/json; charset=iso-8859-1' },
      { 'Content-Type': 'application/json; charset="utf-16"' },
    ]) {
      const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers, body: 'a=1' });
      assert.equal(res.status, 415, JSON.stringify(headers));
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'UNSUPPORTED_MEDIA_TYPE');
      assertSecurityHeaders(res);
    }
  });

  it('answers 415 for an unsupported content encoding', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, {
      method: 'POST',
      headers: { ...json, 'Content-Encoding': 'x-unknown' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  });

  it('answers 404 for unknown paths on every surface', async () => {
    for (const path of ['/nope', '/v1/nope', '/public/v1/nope', '/store/v1/products', '/health/nope']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: { code: 'NOT_FOUND', message: 'Not found' } });
      assertSecurityHeaders(res);
    }
  });

  it('answers 405 with Allow for a known path and wrong method', async () => {
    const res = await fetch(`${t.baseUrl}/v1/page`, { method: 'POST', headers: json, body: '{}' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'METHOD_NOT_ALLOWED');
    const multi = await fetch(`${t.baseUrl}/v1/items`, { method: 'PATCH', headers: json, body: '{}' });
    assert.equal(multi.status, 405);
    assert.equal(multi.headers.get('allow'), 'GET, HEAD, POST, PUT, DELETE');
    const health = await fetch(`${t.baseUrl}/health/live`, { method: 'DELETE' });
    assert.equal(health.status, 405);
    assert.equal(health.headers.get('allow'), 'GET, HEAD');
  });

  it('answers HEAD for GET routes', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  it('answers 500 without leaking internals, for sync and async handlers', async () => {
    for (const path of ['/v1/boom', '/v1/async-boom']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
      assert.ok(!text.includes('secret'));
      assert.ok(!text.includes('at '));
      assertSecurityHeaders(res);
    }
    const logged = t.events.filter((event) => event['msg'] === 'unhandled error');
    assert.ok(logged.length >= 2);
    assert.match(String((logged[0]?.['error'] as Record<string, unknown>)['stack']), /secret internal detail/);
    assert.match(String(logged[0]?.['requestId']), /^[0-9a-f-]{36}$/);
  });

  it('renders AppErrors with their message', async () => {
    const res = await fetch(`${t.baseUrl}/v1/app-error`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: { code: 'CONFLICT', message: 'Duplicate' } });
  });

  it('destroys the connection instead of answering twice', async () => {
    await assert.rejects(async () => {
      const res = await fetch(`${t.baseUrl}/v1/late-failure`);
      await res.text();
    });
    assert.ok(t.events.some((event) => event['msg'] === 'error after response started'));
  });

  describe('request id', () => {
    const uuid = /^[0-9a-f-]{36}$/;

    it('always generates the id on the server, even when the client sends a valid one', async () => {
      const res = await fetch(`${t.baseUrl}/v1/items`, { headers: { 'X-Request-Id': 'abc-12345.XYZ:9' } });
      assert.match(res.headers.get('x-request-id') ?? '', uuid);
      assert.notEqual(res.headers.get('x-request-id'), 'abc-12345.XYZ:9');
    });

    it('logs a valid client id as clientRequestId and ignores invalid ones', async () => {
      t.events.length = 0;
      await fetch(`${t.baseUrl}/v1/items`, { headers: { 'X-Request-Id': 'trace-123456' } });
      await fetch(`${t.baseUrl}/v1/items`, { headers: { 'X-Request-Id': 'short' } });
      const entries = t.events.filter((event) => event['msg'] === 'request');
      assert.equal(entries[0]?.['clientRequestId'], 'trace-123456');
      assert.equal('clientRequestId' in (entries[1] ?? {}), false);
    });

    it('is present on errors too', async () => {
      const res = await fetch(`${t.baseUrl}/v1/nope`);
      assert.match(res.headers.get('x-request-id') ?? '', uuid);
    });
  });

  it('answers 500 JSON, not the Express error page, when the error handler fails', async () => {
    const res = await fetch(`${t.baseUrl}/v1/bad-header`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    assert.ok(!text.includes('<'));
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assertSecurityHeaders(res);
    assert.ok(t.events.some((event) => event['msg'] === 'error handler failed'));
  });

  it('rejects compressed request bodies with 415', async () => {
    const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: { ...json, 'Content-Encoding': 'gzip' }, body: '{}' });
    assert.equal(res.status, 415);
  });

  it('answers 400 for an undecodable path parameter', async () => {
    const ok = await fetch(`${t.baseUrl}/v1/things/abc`);
    assert.equal(ok.status, 200);
    const res = await fetch(`${t.baseUrl}/v1/things/%E0%A4%A`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'BAD_REQUEST');
    assert.ok(!t.events.some((event) => event['level'] === 'error' && event['msg'] === 'unhandled error' && /decode/i.test(JSON.stringify(event))));
  });

  it('logs an aborted request once, with aborted: true', async () => {
    t.events.length = 0;
    const controller = new AbortController();
    const pending = fetch(`${t.baseUrl}/v1/slow`, { signal: controller.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 400));
    const entries = t.events.filter((event) => event['msg'] === 'request' && event['path'] === '/v1/slow');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['aborted'], true);
  });

  describe('CORS', () => {
    const exposed = 'X-Request-Id, Location, ETag, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After';

    it('adds headers for an allowed origin', async () => {
      const res = await fetch(`${t.baseUrl}/v1/items`, { headers: { Origin: ORIGIN } });
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(res.headers.get('access-control-expose-headers'), exposed);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
      assert.match(res.headers.get('vary') ?? '', /Origin/);
    });

    it('keeps CORS headers on errors', async () => {
      const res = await fetch(`${t.baseUrl}/v1/nope`, { headers: { Origin: ORIGIN } });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    });

    it('answers the preflight of an allowed origin', async () => {
      const res = await fetch(`${t.baseUrl}/v1/items`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PUT, PATCH, DELETE');
      assert.equal(
        res.headers.get('access-control-allow-headers'),
        'Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, X-Request-Id',
      );
      assert.equal(res.headers.get('access-control-max-age'), '600');
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
      assertSecurityHeaders(res);
    });

    it('lets an OPTIONS without Access-Control-Request-Method proceed', async () => {
      const res = await fetch(`${t.baseUrl}/v1/items`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    });

    it('gives no CORS headers to a disallowed origin but still sets Vary', async () => {
      for (const origin of ['https://evil.example.com', `${ORIGIN}.evil.com`, 'null']) {
        const res = await fetch(`${t.baseUrl}/v1/items`, { headers: { Origin: origin } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.equal(res.headers.get('access-control-expose-headers'), null);
        assert.match(res.headers.get('vary') ?? '', /Origin/);
      }
      const pre = await fetch(`${t.baseUrl}/v1/items`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(pre.status, 405);
      assert.equal(pre.headers.get('access-control-allow-origin'), null);
    });

    it('sets Vary: Origin without Origin header', async () => {
      const res = await fetch(`${t.baseUrl}/v1/items`);
      assert.match(res.headers.get('vary') ?? '', /Origin/);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    it('is absent on /public/v1 and /health', async () => {
      for (const path of ['/public/v1/items', '/health/live']) {
        const res = await fetch(`${t.baseUrl}${path}`, { headers: { Origin: ORIGIN } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.ok(!(res.headers.get('vary') ?? '').includes('Origin'));
      }
    });
  });

  describe('compression', () => {
    function rawGet(path: string): Promise<{ encoding: string | undefined; body: string }> {
      const port = Number(new URL(t.baseUrl).port);
      return new Promise((resolve, reject) => {
        request({ port, path, headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const encoding = res.headers['content-encoding'];
            resolve({ encoding, body: (encoding === 'gzip' ? gunzipSync(raw) : raw).toString() });
          });
        })
          .on('error', reject)
          .end();
      });
    }

    it('compresses large responses and not small ones', async () => {
      const big = await rawGet('/v1/big');
      assert.equal(big.encoding, 'gzip');
      assert.equal((JSON.parse(big.body) as { data: string }).data.length, 3000);
      const small = await rawGet('/v1/items');
      assert.equal(small.encoding, undefined);
    });
  });

  describe('access log', () => {
    it('logs method, path without query, status, duration and ip, never the query or body', async () => {
      t.events.length = 0;
      await fetch(`${t.baseUrl}/v1/items?token=secret-query-value&email=a@b.c`);
      await fetch(`${t.baseUrl}/v1/items`, { method: 'POST', headers: json, body: JSON.stringify({ password: 'body-secret' }) });
      const entries = t.events.filter((event) => event['msg'] === 'request');
      assert.equal(entries.length, 2);
      const [first] = entries;
      assert.equal(first?.['method'], 'GET');
      assert.equal(first?.['path'], '/v1/items');
      assert.equal(first?.['status'], 200);
      assert.equal(typeof first?.['durationMs'], 'number');
      assert.equal(Number.isInteger(first?.['durationMs']), true);
      assert.match(String(first?.['requestId']), /^[0-9a-f-]{36}$/);
      assert.match(String(first?.['ip']), /127\.0\.0\.1/);
      assert.equal(first?.['level'], 'info');
      const text = JSON.stringify(entries);
      assert.ok(!text.includes('secret-query-value'));
      assert.ok(!text.includes('body-secret'));
    });

    it('skips successful health probes but logs failed ones', async () => {
      t.events.length = 0;
      await fetch(`${t.baseUrl}/health/live`);
      await fetch(`${t.baseUrl}/health/live`, { method: 'DELETE' });
      const entries = t.events.filter((event) => event['msg'] === 'request');
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['status'], 405);
    });

    it('uses the forwarded address when trust proxy is configured', async () => {
      t.events.length = 0;
      await fetch(`${t.baseUrl}/v1/items`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
      assert.equal(t.events.find((event) => event['msg'] === 'request')?.['ip'], '203.0.113.9');
    });
  });
});

describe('app construction', () => {
  it('works without injected routes and without a trusted proxy', async () => {
    const t = await startApp();
    try {
      const res = await fetch(`${t.baseUrl}/v1/anything`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
      assert.equal(res.status, 404);
      await fetch(`${t.baseUrl}/v1/anything`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
      assert.match(String(t.events.find((event) => event['msg'] === 'request')?.['ip']), /127\.0\.0\.1/);
    } finally {
      await t.close();
    }
  });

  it('fails at startup when a route declares no auth', () => {
    assert.rejects(
      startApp({
        routes: { v1: [{ method: 'GET', path: '/x', handler: () => undefined } as never] },
      }),
      /missing auth declaration/,
    );
  });

  it('accepts only public routes', async () => {
    const t = await startApp({ routes: { public: testRoutes } });
    try {
      assert.equal((await fetch(`${t.baseUrl}/public/v1/items`)).status, 200);
      assert.equal((await fetch(`${t.baseUrl}/v1/items`)).status, 404);
    } finally {
      await t.close();
    }
  });
});
