import { connect } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { profileOf, searchOf, startFakeCerved, subject } from '../helpers/fake-cerved.ts';
import type { FakeCerved } from '../helpers/fake-cerved.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { actors } from '../helpers/users.ts';

const VAT = '12345678903';
const OTHER_VAT = '01234567897';
// A throw-away value, only ever sent to the fake server on the loopback.
const KEY = 'test-key-0123456789abcdef'; // gitleaks:allow (fake test value)

let ctx: TestDatabases;
let keyless: TestDatabases;
let world: StoreWorld;
let bare: Backoffice;
let fake: FakeCerved;
const limiter = memoryRateLimiter();
const office = (): Backoffice => world.office;
const psa = () => world.office.cluster.psa;
const lookup = (actor = psa(), vat: string = VAT) => world.as.call(actor, 'GET', `/vat-lookups/${encodeURIComponent(vat)}`);
const events = () => office().activity.entries.filter((entry) => entry.action === 'vatLookup.performed');
/** Everything the application logged, as one text. */
const logged = (): string => JSON.stringify(office().logEvents);

before(async () => {
  fake = await startFakeCerved();
  ctx = await openTestDatabases();
  keyless = await openTestDatabases();
  const env = { CERVED_API_KEY: KEY, CERVED_BASE_URL: fake.baseUrl, RATE_LIMIT_CERVED_LOOKUP_PER_USER: '6' };
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env, cervedHttp: { timeoutMs: 300 } });
  bare = await startBackoffice(keyless, { env: { CERVED_BASE_URL: fake.baseUrl } });
});
after(async () => {
  await world.office.close();
  await bare.close();
  await ctx.cleanup();
  await keyless.cleanup();
  await fake.close();
});
beforeEach(() => {
  limiter.reset();
  fake.reset();
  office().activity.entries.length = 0;
  office().logEvents.length = 0;
});

describe('GET /v1/vat-lookups/{vatNumber}', () => {
  it('answers the data of the company with its PEC, asking the provider for the search and then for the profile with the key in a header', async () => {
    fake.onSearch = () => searchOf(subject(VAT, { id_soggetto: 7 }));
    fake.onProfile = () => profileOf('pec@rossi.example');
    const reply = await lookup();
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { data: { vatNumber: VAT, name: 'ROSSI SRL', fiscalCode: VAT, address: { street: 'VIA ROMA 1', postcode: '20100', city: 'MILANO', province: 'MI', country: 'IT' }, pec: 'pec@rossi.example' } });
    assert.deepEqual(fake.requests.map((request) => [request.path, request.query.get('testoricerca') ?? request.query.get('id_soggetto'), request.headers['apikey']]), [
      ['/cervedApi/v1/entitySearch/live', VAT, KEY],
      ['/cervedApi/v1/entityProfile/live', '7', KEY],
    ]);
  });

  it('is open to a dealer as well, accepts the IT prefix in any case, and answers the number without it', async () => {
    fake.onSearch = (text) => searchOf(subject(text));
    for (const typed of [`IT${VAT}`, `it${VAT}`, ` ${VAT} `]) {
      const reply = await lookup(office().cluster.dealerA, typed);
      assert.equal(reply.status, 200, typed);
      assert.equal(reply.body.data.vatNumber, VAT);
    }
    assert.ok(fake.requests.every((request) => request.query.get('testoricerca') === VAT || request.query.has('id_soggetto')));
  });

  it('answers 200 without the PEC when the profile has none, fails, times out, or has an unknown shape', async () => {
    fake.onSearch = () => searchOf(subject(VAT));
    for (const profile of [{ json: {} }, { status: 500 }, { hang: true as const }, { raw: 'not json' }, { drop: true as const }, { json: { dati_anagrafici: { pec: { email: [] } } } }]) {
      fake.onProfile = () => profile;
      const reply = await lookup();
      assert.deepEqual([reply.status, reply.body.data.pec, reply.body.data.name], [200, null, 'ROSSI SRL'], JSON.stringify(profile));
    }
    assert.equal(events().length, 6);
    assert.ok(events().every((entry) => entry.outcome === 'success' && entry.metadata?.['outcome'] === 'found'));
    const warnings = office().logEvents.filter((event) => event['msg'] === 'cerved profile lookup failed');
    assert.equal(warnings.length, 4, 'the failed profiles are logged');
    assert.ok(warnings.every((event) => event['errorName'] === 'CervedError'));
  });

  it('does not take the first subject: it answers the one whose VAT number is the requested one', async () => {
    fake.onSearch = () => searchOf(subject(OTHER_VAT, { denominazione: 'ALTRA SRL', id_soggetto: 1 }), subject(VAT, { denominazione: 'GIUSTA SRL', id_soggetto: 2 }));
    const reply = await lookup();
    assert.equal(reply.body.data.name, 'GIUSTA SRL');
    assert.equal(fake.requests[1]!.query.get('id_soggetto'), '2');
  });

  it('answers 404 when the provider has no such subject, or only others, and does not ask for a profile', async () => {
    const first = await lookup();
    assert.deepEqual([first.status, first.body.error.code], [404, 'NOT_FOUND']);
    fake.onSearch = () => searchOf(subject(OTHER_VAT));
    assert.equal((await lookup()).status, 404);
    assert.ok(fake.requests.every((request) => request.path === '/cervedApi/v1/entitySearch/live'));
    assert.deepEqual(events().map((entry) => entry.metadata), [{ outcome: 'notFound' }, { outcome: 'notFound' }]);
  });

  it('answers 422 with the field and the issue, and never asks the provider', async () => {
    const failure = async (vat: string) => {
      const reply = await lookup(psa(), vat);
      return [reply.status, reply.body.error.code, reply.body.error.details];
    };
    assert.deepEqual(await failure('1234567'), [422, 'VALIDATION_ERROR', [{ field: 'vatNumber', issue: 'format' }]]);
    assert.deepEqual(await failure('DE123456789'), [422, 'VALIDATION_ERROR', [{ field: 'vatNumber', issue: 'format' }]]);
    assert.deepEqual(await failure('12345678903&apikey=x'), [422, 'VALIDATION_ERROR', [{ field: 'vatNumber', issue: 'format' }]]);
    assert.deepEqual(await failure('%20'), [422, 'VALIDATION_ERROR', [{ field: 'vatNumber', issue: 'format' }]]);
    assert.deepEqual(await failure('12345678900'), [422, 'VALIDATION_ERROR', [{ field: 'vatNumber', issue: 'checksum' }]]);
    assert.equal(fake.requests.length, 0);
    assert.equal(events().length, 0);
  });

  it('is for the PSA and the dealer alone: 401 anonymous, 403 for an SA, a CA and a PA, and 403 for a store key', async () => {
    const group = office().cluster.groups[0]!;
    const anonymous = await office().call('GET', `/vat-lookups/${VAT}`, undefined);
    assert.equal(anonymous.status, 401);
    for (const actor of [group.sa, group.ca, group.pa]) {
      const reply = await lookup(actor);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN']);
    }
    const key = await world.activate(group.ownPlaceId);
    const asStore = await world.asStore(key.key, 'GET', `/vat-lookups/${VAT}`);
    assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);
    assert.equal(fake.requests.length, 0, 'a refused caller costs nothing');
    assert.equal(events().length, 0);
  });

  it('is not on the public surface', async () => {
    const response = await fetch(`${office().app.baseUrl}/public/v1/vat-lookups/${VAT}`, { headers: { 'x-api-key': 'fc_pk_whatever' } });
    assert.ok([401, 404].includes(response.status));
    assert.equal(fake.requests.length, 0);
  });

  it('is limited per user: the seventh lookup in a minute is a 429 with Retry-After, and only for that user', async () => {
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await lookup()).status, 404);
    }
    const limited = await lookup();
    assert.deepEqual([limited.status, limited.body.error.code], [429, 'RATE_LIMITED']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(fake.requests.length, 6, 'the refused one never reached the provider');
    assert.equal((await lookup(office().cluster.dealerA)).status, 404, 'another user has his own count');
  });

  it('counts a malformed request too, since it is the user who spends the lookups', async () => {
    for (let index = 0; index < 6; index += 1) {
      await lookup(psa(), 'x');
    }
    assert.equal((await lookup()).status, 429);
  });
});

describe('GET /v1/vat-lookups/{vatNumber}: the provider is not available', () => {
  const refused = async () => {
    limiter.reset();
    const reply = await lookup();
    return [reply.status, reply.body.error.code, reply.body.error.message, reply.body.error.details];
  };

  it('answers 503 without asking anything when there is no key, and logs it as unavailable', async () => {
    const tokens = await bare.tokens(`user-${String(parseInt(bare.cluster.psa.toHexString().slice(2), 16)).padStart(3, '0')}`);
    const reply = await bare.call('GET', `/vat-lookups/${VAT}`, tokens.accessToken);
    assert.deepEqual([reply.status, ((await reply.json()) as { error: { code: string } }).error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(fake.requests.length, 0);
    const entry = bare.activity.entries.find((candidate) => candidate.action === 'vatLookup.performed')!;
    assert.deepEqual([entry.outcome, entry.metadata, entry.resource], ['failure', { outcome: 'unavailable' }, { type: 'vatLookup', id: VAT }]);
  });

  it('still answers 422 before it says there is no key', async () => {
    const tokens = await bare.tokens(`user-${String(parseInt(bare.cluster.psa.toHexString().slice(2), 16)).padStart(3, '0')}`);
    assert.equal((await bare.call('GET', '/vat-lookups/123', tokens.accessToken)).status, 422);
  });

  it('answers 503 with nothing of the provider when the search is refused, however it is refused', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502]) {
      fake.onSearch = () => ({ status, raw: 'provider internal detail with the key' });
      assert.deepEqual(await refused(), [503, 'SERVICE_UNAVAILABLE', 'Service unavailable', undefined], String(status));
    }
    assert.doesNotMatch(logged(), /provider internal detail/);
  });

  it('answers 503 on a timeout, a dropped connection, an answer that is not JSON and an answer that is too large', async () => {
    for (const reply of [{ hang: true as const }, { drop: true as const }, { raw: '<html>maintenance</html>' }, { json: { companies: 'x' } }, { streamMegabytes: 3 }, { stallBody: true as const }]) {
      fake.onSearch = () => reply;
      assert.deepEqual(await refused(), [503, 'SERVICE_UNAVAILABLE', 'Service unavailable', undefined], JSON.stringify(reply));
    }
    assert.equal(fake.requests.length, 6, 'no retry');
    assert.deepEqual(new Set(events().map((entry) => entry.metadata?.['outcome'])), new Set(['unavailable']));
    assert.equal(events().length, 6);
  });
});

/** Sends a raw HTTP request line (the target as given) and waits for the whole answer. */
function rawRequest(baseUrl: string, target: string): Promise<string> {
  const { port, hostname } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let text = '';
    socket.on('data', (chunk: Buffer) => void (text += chunk.toString()));
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}

describe('what is logged', () => {
  it('masks the VAT number whatever the form of the request-target: absolute form, dot segments, an unparseable one', async () => {
    const base = office().app.baseUrl;
    for (const target of [`http://example.test/v1/vat-lookups/${VAT}`, `/v1/./vat-lookups/${VAT}`, `/v1/x/../vat-lookups/${VAT}?q=1`, `/V1/VAT-Lookups/${VAT}`]) {
      assert.match(await rawRequest(base, target), /^HTTP\/1\.1 /, target);
    }
    assert.match(await rawRequest(base, '//'), /^HTTP\/1\.1 /);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(logged(), new RegExp(VAT));
    const paths = office().logEvents.filter((event) => event['msg'] === 'request').map((event) => event['path']);
    assert.deepEqual(paths.slice(0, 4).map((path) => String(path).toLowerCase()), Array(4).fill('/v1/vat-lookups/:vatnumber'));
    assert.equal(paths[4], '/:unparseable');
  });

  it('keeps the key and the VAT number out of the application logs, whatever the outcome, and the path of the request is the route', async () => {
    fake.onSearch = () => searchOf(subject(VAT));
    fake.onProfile = () => ({ status: 500 });
    await lookup();
    fake.onSearch = () => ({ status: 500 });
    await lookup();
    fake.onSearch = () => searchOf();
    await lookup();
    await lookup(psa(), '12345678900');
    await lookup(office().cluster.groups[0]!.sa);
    await world.office.call('GET', `/vat-lookups/${VAT}`, undefined);
    assert.doesNotMatch(logged(), new RegExp(`${VAT}|${KEY}|ROSSI|pec@`));
    const requests = office().logEvents.filter((event) => event['msg'] === 'request');
    assert.ok(requests.length >= 6);
    assert.ok(requests.filter((event) => String(event['path']).startsWith('/v1/vat-lookups/')).every((event) => event['path'] === '/v1/vat-lookups/:vatNumber'));
    assert.equal(requests.filter((event) => event['path'] === '/v1/vat-lookups/:vatNumber').length, 6);
  });

  it('records every lookup in the activity log with the VAT number as the resource, the outcome, and the actor, but not the data of the company', async () => {
    fake.onSearch = () => searchOf(subject(VAT));
    await lookup();
    fake.onSearch = () => searchOf();
    await lookup(office().cluster.dealerA);
    fake.onSearch = () => ({ status: 500 });
    await lookup();
    assert.deepEqual(
      events().map((entry) => [entry.category, entry.outcome, entry.actor.kind, entry.resource, entry.metadata]),
      [
        ['data', 'success', 'user', { type: 'vatLookup', id: VAT }, { outcome: 'found' }],
        ['data', 'success', 'user', { type: 'vatLookup', id: VAT }, { outcome: 'notFound' }],
        ['data', 'failure', 'user', { type: 'vatLookup', id: VAT }, { outcome: 'unavailable' }],
      ],
    );
    assert.deepEqual(events().map((entry) => (entry.actor as { id: unknown }).id), [psa(), office().cluster.dealerA, psa()]);
    assert.doesNotMatch(JSON.stringify(office().activity.entries), /ROSSI|VIA ROMA|pec@|test-key/);
  });
});

describe('the daily cap', () => {
  it('limits a user to RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY lookups a day, whatever the minute rule allows, before the provider is asked', async () => {
    const own = await openTestDatabases();
    const daily = memoryRateLimiter();
    const capped = await startBackoffice(own, { rateLimiter: daily, env: { CERVED_API_KEY: KEY, CERVED_BASE_URL: fake.baseUrl, RATE_LIMIT_CERVED_LOOKUP_PER_USER: '100', RATE_LIMIT_CERVED_LOOKUP_PER_USER_DAILY: '3' } });
    try {
      fake.reset();
      const token = (await capped.tokens(`user-${String(parseInt(capped.cluster.psa.toHexString().slice(2), 16)).padStart(3, '0')}`)).accessToken;
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await capped.call('GET', `/vat-lookups/${VAT}`, token)).status, 404);
      }
      const limited = await capped.call('GET', `/vat-lookups/${VAT}`, token);
      assert.deepEqual([limited.status, ((await limited.json()) as { error: { code: string } }).error.code], [429, 'RATE_LIMITED']);
      assert.equal(fake.requests.length, 3, 'the refused one never reached the provider');
      assert.ok(daily.calls.some((call) => call.bucket === 'cerved-lookup-day:user' && call.limit === 3));
    } finally {
      await capped.close();
      await own.cleanup();
    }
  });
});
