import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ArubaHttpError, exchange } from '../../src/providers/aruba/http.ts';
import type { HttpRequest } from '../../src/providers/aruba/http.ts';
import { cleanText, isRecord, parseJson } from '../../src/providers/aruba/text.ts';
import { ARUBA_LIMITS, arubaHosts, ARUBA_TRANSMITTER, PROVIDER_ID_PATTERN } from '../../src/providers/aruba/settings.ts';
import { freePort } from '../helpers/env.ts';
import { startFakeAruba } from '../helpers/fake-aruba.ts';
import type { FakeAruba } from '../helpers/fake-aruba.ts';

describe('Aruba: one HTTP exchange', () => {
  let fake: FakeAruba;
  before(async () => {
    fake = await startFakeAruba();
  });
  after(async () => {
    await fake.close();
  });

  const request = (values: Partial<HttpRequest> = {}): HttpRequest => ({ method: 'GET', url: `${fake.origin}/x`, headers: {}, timeoutMs: 2000, maxBytes: 1000, ...values });
  const signal = new AbortController().signal;
  const failure = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof ArubaHttpError);
      assert.equal(error.name, 'ArubaHttpError');
      assert.equal(error.message, 'the request to Aruba failed', 'the message never carries a URL, a header or a body');
      return error.code;
    }
    return 'no failure';
  };

  it('returns the status and the text, whatever the status, and sends the method, the headers and the body', async () => {
    fake.route('POST /x', { status: 201, json: { ok: true } });
    const response = await exchange({ fetch, signal }, request({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: '{"a":1}' }));
    assert.deepEqual(response, { status: 201, text: '{"ok":true}' });
    const sent = fake.hits('POST /x')[0];
    assert.equal(sent?.body, '{"a":1}');
    assert.equal(sent?.headers['authorization'], 'Bearer t');
    fake.route('GET /x', { status: 503, text: 'busy' });
    assert.deepEqual(await exchange({ fetch, signal }, request()), { status: 503, text: 'busy' });
  });

  it('reads an empty body (no stream) as empty text', async () => {
    const fetchEmpty = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    assert.deepEqual(await exchange({ fetch: fetchEmpty, signal }, request()), { status: 204, text: '' });
  });

  it('accepts a body of exactly the cap and refuses one byte more', async () => {
    fake.route('GET /x', { text: 'a'.repeat(1000) });
    assert.equal((await exchange({ fetch, signal }, request())).text.length, 1000);
    fake.route('GET /x', { text: 'a'.repeat(1001) });
    assert.equal(await failure(exchange({ fetch, signal }, request())), 'tooLarge');
  });

  it('times out on an answer that never comes', async () => {
    fake.route('GET /x', { hang: true });
    assert.equal(await failure(exchange({ fetch, signal }, request({ timeoutMs: 60 }))), 'timeout');
  });

  it('reports the signal of the caller as aborted, before and during the request', async () => {
    fake.route('GET /x', { hang: true });
    assert.equal(await failure(exchange({ fetch, signal: AbortSignal.abort() }, request())), 'aborted');
    const controller = new AbortController();
    const pending = failure(exchange({ fetch, signal: controller.signal }, request()));
    setTimeout(() => controller.abort(), 30);
    assert.equal(await pending, 'aborted');
  });

  it('tells a connection that never opened (the request did not leave) from one that broke after sending', async () => {
    const port = await freePort();
    assert.equal(await failure(exchange({ fetch, signal }, request({ url: `http://127.0.0.1:${port}/x` }))), 'connect');
    fake.route('GET /x', { destroy: true });
    assert.equal(await failure(exchange({ fetch, signal }, request())), 'network');
  });

  it('does not follow a redirect, and copes with an error that has no cause', async () => {
    const redirect = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    assert.equal(await failure(exchange({ fetch: redirect, signal }, request())), 'network');
    const seen: Array<RequestInit | undefined> = [];
    const spy = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response('x');
    }) as unknown as typeof fetch;
    await exchange({ fetch: spy, signal }, request());
    assert.equal(seen[0]?.redirect, 'error');
  });
});

describe('Aruba: reading what it says', () => {
  it('parses JSON without keeping the parser message', () => {
    assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseJson('{"a":'), { ok: false });
    assert.deepEqual(parseJson(''), { ok: false });
  });

  it('tells a plain object from the rest', () => {
    assert.equal(isRecord({}), true);
    for (const value of [null, [], 'x', 1, undefined]) {
      assert.equal(isRecord(value), false);
    }
  });

  it('cleans text: strings and numbers only, control characters out, trimmed, capped', () => {
    assert.equal(cleanText('  a\u0000\u0007b\u007fc\u009fd  ', 50), 'a b c d');
    assert.equal(cleanText(42, 50), '42');
    assert.equal(cleanText('abcdef', 3), 'abc');
    for (const value of [undefined, null, {}, [], true]) {
      assert.equal(cleanText(value, 10), '');
    }
  });
});

describe('Aruba: fixed settings', () => {
  it('uses the demo hosts for the demo and the production hosts for production', () => {
    assert.deepEqual(arubaHosts('demo'), { auth: 'https://demoauth.fatturazioneelettronica.aruba.it', ws: 'https://demows.fatturazioneelettronica.aruba.it' });
    assert.deepEqual(arubaHosts('production'), { auth: 'https://auth.fatturazioneelettronica.aruba.it', ws: 'https://ws.fatturazioneelettronica.aruba.it' });
  });

  it('has the legacy numbers as data: per-IP spacing, account pacing by hourly cap and the backoff steps', () => {
    const { ip, account } = ARUBA_LIMITS;
    assert.deepEqual([ip.auth.minIntervalMs, ip.auth.jitterMs, ip.upload.minIntervalMs, ip.upload.jitterMs, ip.status.minIntervalMs, ip.status.jitterMs], [65_000, 3_000, 3_000, 500, 6_000, 1_500]);
    assert.equal(account.minIntervalMs(55), 65_000);
    assert.equal(account.minIntervalMs(60), 60_000);
    assert.equal(account.minIntervalMs(10), 360_000);
    assert.equal(account.minIntervalMs(5000), 3_000, 'never faster than the per-IP spacing');
    assert.equal(account.jitterMs, 3_000);
    assert.deepEqual(account.backoffStepsMs, [600_000, 1_500_000, 3_720_000]);
    assert.deepEqual(ARUBA_TRANSMITTER, { IdPaese: 'IT', IdCodice: '01879020517' });
  });

  it('accepts only the file names Aruba gives', () => {
    for (const good of ['IT01234567890_abcde.xml', 'IT01234567890_abcde.xml.p7m', 'a-b_c.1']) {
      assert.match(good, PROVIDER_ID_PATTERN);
    }
    for (const bad of ['', 'a'.repeat(101), 'a b', 'a/b', '../x', 'a?b=c', 'a%20b', 'è', 'a\n']) {
      assert.doesNotMatch(bad, PROVIDER_ID_PATTERN, bad);
    }
  });
});
