import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, ProviderHttpError } from '../../src/integrations/http/index.ts';
import type { HttpClientOptions } from '../../src/integrations/http/index.ts';

const BASE = 'https://api.provider.example';
const URL_OK = `${BASE}/v1/things?q=1`;

const json = (body: unknown, init: ResponseInit = {}): Response => Response.json(body, init);
/** A fetch that answers these responses in order, recording each call. */
function script(...steps: Array<Response | Error>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const send: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps[Math.min(calls.length, steps.length) - 1]!;
    if (step instanceof Error) {
      throw step;
    }
    return step;
  };
  return { fetch: send, calls };
}
const timeoutError = (): Error => new DOMException('timed out', 'TimeoutError');
const sleeps: number[] = [];
const options = (extra: Partial<HttpClientOptions>): HttpClientOptions => ({ provider: 'Acme', baseUrl: BASE, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, ...extra });
/** The failure of a call, as `[reason, status]`, or `undefined` when it did not fail. */
async function failureOf(call: Promise<unknown>): Promise<[string, number | null] | undefined> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof ProviderHttpError);
    return [error.reason, error.status];
  }
  return undefined;
}

describe('the HTTP client of the integrations: a call', () => {
  it('sends a GET with the headers asked, redirects refused and a signal, and parses the JSON', async () => {
    const stub = script(json({ ok: true }));
    const client = createHttpClient(options({ fetch: stub.fetch }));
    assert.deepEqual(await client.getJson({ operation: 'list', url: URL_OK, headers: { apikey: 'k' } }), { ok: true });
    const [call] = stub.calls;
    assert.equal(call!.url, URL_OK);
    assert.deepEqual([call!.init.method, call!.init.redirect, call!.init.headers, call!.init.body === undefined, call!.init.signal instanceof AbortSignal], ['GET', 'error', { accept: 'application/json', apikey: 'k' }, true, true]);
  });

  it('sends a POST with the document as JSON and never retries it', async () => {
    const stub = script(json({}, { status: 503 }), json({ ok: true }));
    const client = createHttpClient(options({ fetch: stub.fetch }));
    assert.deepEqual(await failureOf(client.postJson({ operation: 'activate', url: URL_OK, body: { code: 'x' } })), ['status', 503]);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual([stub.calls[0]!.init.method, stub.calls[0]!.init.body, stub.calls[0]!.init.headers], ['POST', '{"code":"x"}', { accept: 'application/json', 'content-type': 'application/json' }]);
    const ok = createHttpClient(options({ fetch: script(json({ id: 1 })).fetch }));
    assert.deepEqual(await ok.postJson({ operation: 'activate', url: URL_OK, body: {} }), { id: 1 });
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: script(timeoutError()).fetch })).postJson({ operation: 'activate', url: URL_OK, body: {} })), ['timeout', null]);
  });

  it('accepts a JSON media type with parameters or the +json family, and nothing else', async () => {
    for (const type of ['application/json; charset=utf-8', 'APPLICATION/JSON', 'application/problem+json']) {
      const client = createHttpClient(options({ fetch: script(new Response('{"a":1}', { headers: { 'content-type': type } })).fetch }));
      assert.deepEqual(await client.getJson({ operation: 'list', url: URL_OK }), { a: 1 }, type);
    }
    for (const headers of [{}, { 'content-type': 'text/html' }, { 'content-type': 'text/plain; charset=json' }, { 'content-type': 'text/x+json' }, { 'content-type': 'application/xml' }]) {
      const client = createHttpClient(options({ fetch: script(new Response('{"a":1}', { headers })).fetch }));
      assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url: URL_OK })), ['invalidResponse', null], JSON.stringify(headers));
    }
  });

  it('refuses an answer with no content type at all', async () => {
    const client = createHttpClient(options({ fetch: script(new Response(null)).fetch }));
    assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url: URL_OK })), ['invalidResponse', null]);
  });

  it('refuses a body that is missing or is not JSON', async () => {
    for (const response of [new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }), new Response('not json', { headers: { 'content-type': 'application/json' } }), new Response('', { headers: { 'content-type': 'application/json' } })]) {
      assert.deepEqual(await failureOf(createHttpClient(options({ fetch: script(response).fetch })).getJson({ operation: 'list', url: URL_OK })), ['invalidResponse', null]);
    }
  });

  it('refuses a body that is too large, declared or streamed, and one that cannot be cancelled is a network error', async () => {
    const big = (init: ResponseInit): Response => new Response(' '.repeat(2000), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const client = createHttpClient(options({ fetch: script(big({})).fetch, maxBodyBytes: 1000 }));
    assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url: URL_OK })), ['tooLarge', null]);
    const declared = createHttpClient(options({ fetch: script(big({ headers: { 'content-length': '5000' } })).fetch, maxBodyBytes: 1000 }));
    assert.deepEqual(await failureOf(declared.getJson({ operation: 'list', url: URL_OK })), ['tooLarge', null]);
    const small = createHttpClient(options({ fetch: script(json({ a: 1 })).fetch, maxBodyBytes: 1000 }));
    assert.deepEqual(await small.getJson({ operation: 'list', url: URL_OK }), { a: 1 });
    const stubborn = (init: ResponseInit, size = 0): Response =>
      new Response(new ReadableStream({ start: (controller) => size > 0 && controller.enqueue(new Uint8Array(size)), cancel: () => Promise.reject(new Error('cannot cancel')) }), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const get = (response: Response) => createHttpClient(options({ fetch: script(response).fetch, maxBodyBytes: 1000, retries: 0 })).getJson({ operation: 'list', url: URL_OK });
    assert.deepEqual(await failureOf(get(stubborn({ headers: { 'content-length': '5000' } }))), ['network', null]);
    assert.deepEqual(await failureOf(get(stubborn({}, 2000))), ['network', null]);
    assert.deepEqual(await failureOf(get(stubborn({ status: 500 }))), ['status', 500]);
    assert.deepEqual(await failureOf(get(stubborn({ headers: { 'content-type': 'text/html' } }))), ['network', null]);
  });

  it('never reads the body of a failed answer and keeps nothing of it in the error', async () => {
    const client = createHttpClient(options({ fetch: script(new Response('provider secret detail', { status: 400 })).fetch }));
    try {
      await client.getJson({ operation: 'list', url: `${BASE}/v1/things?key=SECRET` });
      assert.fail('did not fail');
    } catch (error) {
      assert.ok(error instanceof ProviderHttpError);
      assert.deepEqual([error.name, error.provider, error.operation, error.reason, error.status, error.message, error.cause], ['ProviderHttpError', 'Acme', 'list', 'status', 400, 'Acme list failed: status (HTTP 400)', undefined]);
      assert.doesNotMatch(JSON.stringify(error) + error.message + String(error.stack), /secret|SECRET|api\.provider/i);
    }
    const timeout = new ProviderHttpError('Acme', 'list', 'timeout');
    assert.equal(timeout.message, 'Acme list failed: timeout');
  });

  it('refuses a URL that is not of the configured origin, or not a URL, before sending anything', async () => {
    const stub = script(json({}));
    const client = createHttpClient(options({ fetch: stub.fetch }));
    for (const url of ['https://evil.example/v1', 'http://api.provider.example/v1', 'https://api.provider.example:8443/v1', 'https://user@evil.example/', 'not a url?key=SECRET', '/relative']) {
      assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url })), ['invalidResponse', null], url);
    }
    assert.equal(stub.calls.length, 0);
  });

  it('refuses an answer that comes from another origin, and accepts one that says nothing or the same', async () => {
    const from = (url: string): Response => Object.defineProperty(json({ a: 1 }), 'url', { value: url });
    for (const url of ['https://evil.example/v1/things', 'not a url']) {
      assert.deepEqual(await failureOf(createHttpClient(options({ fetch: script(from(url)).fetch })).getJson({ operation: 'list', url: URL_OK })), ['invalidResponse', null], url);
    }
    assert.deepEqual(await createHttpClient(options({ fetch: script(from(URL_OK)).fetch })).getJson({ operation: 'list', url: URL_OK }), { a: 1 });
    assert.deepEqual(await createHttpClient(options({ fetch: script(json({ a: 1 })).fetch })).getJson({ operation: 'list', url: URL_OK }), { a: 1 });
    const stubborn = Object.defineProperty(new Response(new ReadableStream({ cancel: () => Promise.reject(new Error('x')) }), { headers: { 'content-type': 'application/json' } }), 'url', { value: 'https://evil.example/' });
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: script(stubborn).fetch, retries: 0 })).getJson({ operation: 'list', url: URL_OK })), ['network', null]);
  });

  it('reports a timeout when the attempt does, and a network error for anything else', async () => {
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: hanging, timeoutMs: 20, retries: 0 })).getJson({ operation: 'list', url: URL_OK })), ['timeout', null]);
    // The body stops in the middle, as a real response stream does when the signal of the request fires.
    const stalled: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode('{"a":'));
            init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: stalled, timeoutMs: 50, retries: 0 })).getJson({ operation: 'list', url: URL_OK })), ['timeout', null]);
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: script(new TypeError('fetch failed')).fetch, retries: 0 })).getJson({ operation: 'list', url: URL_OK })), ['network', null]);
  });
});

describe('the HTTP client of the integrations: the retry', () => {
  it('retries a GET once, after a pause with jitter, on a network error, a timeout and a 502, 503 or 504', async () => {
    for (const first of [new TypeError('fetch failed'), timeoutError(), json({}, { status: 502 }), json({}, { status: 503 }), json({}, { status: 504 })]) {
      sleeps.length = 0;
      const stub = script(first, json({ ok: true }));
      assert.deepEqual(await createHttpClient(options({ fetch: stub.fetch })).getJson({ operation: 'list', url: URL_OK }), { ok: true });
      assert.equal(stub.calls.length, 2);
      assert.deepEqual(sleeps, [300]);
    }
  });

  it('retries only once, and not at all when asked not to', async () => {
    const stub = script(json({}, { status: 503 }), json({}, { status: 504 }), json({ ok: true }));
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: stub.fetch })).getJson({ operation: 'list', url: URL_OK })), ['status', 504]);
    assert.equal(stub.calls.length, 2);
    const none = script(json({}, { status: 503 }), json({ ok: true }));
    assert.deepEqual(await failureOf(createHttpClient(options({ fetch: none.fetch, retries: 0 })).getJson({ operation: 'list', url: URL_OK })), ['status', 503]);
    assert.equal(none.calls.length, 1);
  });

  it('does not retry what a second try cannot fix: other statuses, an answer out of shape, a body too large, an origin', async () => {
    for (const first of [json({}, { status: 400 }), json({}, { status: 404 }), json({}, { status: 429 }), json({}, { status: 500 }), new Response('x', { headers: { 'content-type': 'text/html' } }), new Response(' '.repeat(2000), { headers: { 'content-type': 'application/json' } })]) {
      const stub = script(first, json({ ok: true }));
      assert.ok(await failureOf(createHttpClient(options({ fetch: stub.fetch, maxBodyBytes: 1000 })).getJson({ operation: 'list', url: URL_OK })));
      assert.equal(stub.calls.length, 1);
    }
  });

  it('does not retry when the total deadline would be passed', async () => {
    const stub = script(new TypeError('fetch failed'), json({ ok: true }));
    const times = [0, 19_700];
    const client = createHttpClient(options({ fetch: stub.fetch, now: () => times.shift() ?? 20_000 }));
    assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url: URL_OK })), ['network', null]);
    assert.equal(stub.calls.length, 1);
  });

  it('gives every attempt the total deadline as well as its own timeout', async () => {
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    const client = createHttpClient(options({ fetch: hanging, timeoutMs: 10_000, totalTimeoutMs: 30, retries: 0 }));
    assert.deepEqual(await failureOf(client.getJson({ operation: 'list', url: URL_OK })), ['timeout', null]);
  });
});

describe('the HTTP client of the integrations: defaults', () => {
  it('uses the global fetch, the real clock, a real pause and Math.random against a real server, retrying a 503 once', async () => {
    let requests = 0;
    const server: Server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = requests === 1 ? 503 : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const client = createHttpClient({ provider: 'Acme', baseUrl: base });
      assert.deepEqual(await client.getJson({ operation: 'list', url: `${base}/things` }), { ok: true });
      assert.equal(requests, 2);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
