import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FakeReply } from '../helpers/fake-provider.ts';
import { GOOGLE_KEY, integrationsEnv, startFakes, startIntegrationsWorld, stopFakes } from '../helpers/integrations-world.ts';
import type { Fakes, IntegrationsWorld } from '../helpers/integrations-world.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let bareCtx: TestDatabases;
let fakes: Fakes;
let on: IntegrationsWorld;
let off: IntegrationsWorld;
let place: Awaited<ReturnType<IntegrationsWorld['seed']>>;
const sa = () => on.world.group(0).sa;
const psa = () => on.world.office.cluster.psa;
const dealer = () => on.world.office.cluster.dealerA;
const ADDRESS = { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' };
const geocode = (body: unknown = ADDRESS, actor = sa(), id = place, world = on) => world.world.as.call(actor, 'POST', world.path(id, '/geocoding'), body);
const everything = () => JSON.stringify([on.world.office.activity.entries, on.world.office.logEvents]);
const ok = (lat: unknown, lng: unknown): FakeReply => ({ json: { status: 'OK', results: [{ geometry: { location: { lat, lng } } }] } });

before(async () => {
  fakes = await startFakes();
  ctx = await openTestDatabases();
  bareCtx = await openTestDatabases();
  on = await startIntegrationsWorld(ctx, { env: { ...integrationsEnv(fakes), GEOCODING_DAILY_LIMIT: '25' }, integrationsHttp: { geocoding: { timeoutMs: 300, sleep: async () => undefined } } });
  off = await startIntegrationsWorld(bareCtx);
  place = await on.seed(850, { googleMaps: { status: true } });
});
after(async () => {
  await on.world.office.close();
  await off.world.office.close();
  await ctx.cleanup();
  await bareCtx.cleanup();
  await stopFakes(fakes);
});
beforeEach(() => {
  fakes.geocoding.reset();
  fakes.satispay.reset();
  on.limiter.reset();
  on.limiter.calls.length = 0;
  on.world.office.activity.entries.length = 0;
  on.world.office.logEvents.length = 0;
});

describe('POST /v1/groups/{groupId}/places/{placeId}/geocoding', () => {
  it('answers the coordinates of the first result and nothing else, with the key in the query of the call to the provider and the country restricted, and saves nothing', async () => {
    const before = (await on.ifMatch(place))['if-match'];
    const reply = await geocode({ ...ADDRESS, country: 'it' });
    assert.deepEqual([reply.status, reply.body], [200, { data: { lat: 45.4642, lng: 9.19 } }]);
    const call = fakes.geocoding.requests[0]!;
    assert.deepEqual([call.method, call.path, call.query.get('address'), call.query.get('components'), call.query.get('key')], ['GET', '/maps/api/geocode/json', 'Via Roma 1, 20100 Milano MI', 'country:IT', GOOGLE_KEY]);
    assert.equal((await on.ifMatch(place))['if-match'], before);
  });

  it('never puts the key of Google in a log, an entry of the activity log or an answer, not even when the call fails', async () => {
    const failures: FakeReply[] = [{ status: 500 }, { status: 403 }, { hang: true }, { drop: true }, { raw: 'nope' }, { redirectTo: `${fakes.satispay.baseUrl}/x?key=${GOOGLE_KEY}` }, { json: { status: 'REQUEST_DENIED', error_message: `The key ${GOOGLE_KEY} is wrong` } }, { json: { status: 'ZERO_RESULTS' } }, ok(45, 9)];
    for (const failure of failures) {
      fakes.geocoding.respond = () => failure;
      on.limiter.reset();
      const reply = await geocode();
      assert.ok(!JSON.stringify(reply.body).includes(GOOGLE_KEY));
      assert.ok(!JSON.stringify([...reply.headers]).includes(GOOGLE_KEY));
    }
    assert.ok(!everything().includes(GOOGLE_KEY));
    assert.ok(!everything().includes('key='));
    // The log of the requests names the route of this server, never the call it made.
    assert.ok(on.world.office.logEvents.length > 0);
  });

  it('records the call with the outcome, and never the address or the coordinates', async () => {
    await geocode();
    const [entry, ...rest] = on.entries();
    assert.equal(rest.length, 0);
    assert.deepEqual([entry!['category'], entry!['action'], entry!['outcome']], ['data', 'integrations.geocoded', 'success']);
    assert.deepEqual({ ...entry!['metadata'], durationMs: typeof entry!['metadata'].durationMs }, { outcome: 'ok', providerStatus: null, durationMs: 'number' });
    for (const secret of ['Via Roma', '20100', 'Milano', '45.46', '9.19']) {
      assert.ok(!everything().includes(secret), secret);
    }
  });

  it('is for who can change the place: a PSA, a dealer, a group administrator and a company administrator', async () => {
    for (const actor of [psa(), dealer(), sa(), on.world.group(0).ca]) {
      assert.equal((await geocode(ADDRESS, actor)).status, 200);
    }
  });

  it('asks for every field of the address, with its limit, and names the ones that are missing', async () => {
    const reply = await geocode({});
    assert.deepEqual(reply.body.error.details, ['street', 'postcode', 'city', 'province', 'country'].map((field) => ({ field, issue: 'required' })));
    assert.equal(reply.status, 422);
    const bad: Array<Record<string, unknown>> = [
      { ...ADDRESS, street: '' },
      { ...ADDRESS, street: 'x'.repeat(151) },
      { ...ADDRESS, postcode: 'x'.repeat(21) },
      { ...ADDRESS, city: 'x'.repeat(101) },
      { ...ADDRESS, province: 'x'.repeat(11) },
      { ...ADDRESS, province: '  ' },
      { ...ADDRESS, country: 'ITA' },
      { ...ADDRESS, country: '1T' },
      { ...ADDRESS, city: 5 },
      { ...ADDRESS, lat: 1 },
      { ...ADDRESS, key: GOOGLE_KEY },
    ];
    for (const body of bad) {
      assert.equal((await geocode(body)).status, 422, JSON.stringify(body));
    }
    assert.equal(fakes.geocoding.requests.length, 0);
  });

  it('answers 422 on the street when the provider knows no such address', async () => {
    fakes.geocoding.respond = () => ({ json: { status: 'ZERO_RESULTS', results: [] } });
    const reply = await geocode();
    assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'street', issue: 'incorrect' }]]);
    assert.equal(on.entries()[0]!['metadata'].outcome, 'rejected');
  });

  it('answers 502 PROVIDER_ERROR to a provider that refuses the key or the quota, fails, answers an HTTP error, or answers a point that is not one', async () => {
    const cases: Array<[string, FakeReply, number, string]> = [
      ['REQUEST_DENIED', { json: { status: 'REQUEST_DENIED', error_message: 'detail' } }, 1, 'providerError'],
      ['OVER_QUERY_LIMIT', { json: { status: 'OVER_QUERY_LIMIT' } }, 1, 'providerError'],
      ['OVER_DAILY_LIMIT', { json: { status: 'OVER_DAILY_LIMIT' } }, 1, 'providerError'],
      ['INVALID_REQUEST', { json: { status: 'INVALID_REQUEST' } }, 1, 'providerError'],
      ['UNKNOWN_ERROR', { json: { status: 'UNKNOWN_ERROR' } }, 1, 'providerError'],
      ['an answer with no status', { json: {} }, 1, 'providerError'],
      ['OK with no results', { json: { status: 'OK', results: [] } }, 1, 'providerError'],
      ['OK with results that are not a list', { json: { status: 'OK', results: 'x' } }, 1, 'providerError'],
      ['OK with a result that is not an object', { json: { status: 'OK', results: [null] } }, 1, 'providerError'],
      ['OK with no geometry', { json: { status: 'OK', results: [{}] } }, 1, 'providerError'],
      ['a latitude that is a text', ok('45', 9), 1, 'providerError'],
      ['a latitude beyond 90', ok(90.5, 9), 1, 'providerError'],
      ['a longitude beyond 180', ok(45, -180.5), 1, 'providerError'],
      ['a longitude that is missing', ok(45, undefined), 1, 'providerError'],
      ['an answer that is null', { raw: 'null' }, 1, 'providerError'],
      ['a 401, which is the platform\'s key, not the user\'s', { status: 401 }, 1, 'providerError'],
      ['a 403', { status: 403 }, 1, 'providerError'],
      ['a 429', { status: 429, headers: { 'Retry-After': '9' } }, 1, 'providerError'],
      ['a 500', { status: 500 }, 1, 'providerError'],
      ['a 503, repeated once', { status: 503 }, 2, 'providerError'],
      ['a timeout, repeated once', { hang: true }, 2, 'timeout'],
      ['a redirect', { redirectTo: `${fakes.satispay.baseUrl}/elsewhere` }, 2, 'providerError'],
      ['a body over the limit', { streamMegabytes: 2 }, 1, 'providerError'],
    ];
    for (const [name, reply, attempts, outcome] of cases) {
      fakes.geocoding.reset();
      on.limiter.reset();
      on.world.office.activity.entries.length = 0;
      fakes.geocoding.respond = () => reply;
      const answer = await geocode();
      assert.deepEqual([answer.status, answer.body, answer.headers.get('retry-after')], [502, { error: { code: 'PROVIDER_ERROR', message: 'The provider could not complete the request' } }, null], name);
      assert.equal(fakes.geocoding.requests.length, attempts, name);
      assert.equal(on.entries()[0]!['metadata'].outcome, outcome, name);
    }
    assert.equal(fakes.satispay.requests.length, 0);
  });

  it('says a switch that is off, without calling the provider and without counting the call against the cap of the platform', async () => {
    const switchedOff = await on.seed(851, { googleMaps: { status: false } });
    const reply = await geocode(ADDRESS, sa(), switchedOff);
    assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'integrations.googleMaps.status', issue: 'incorrect' }]]);
    assert.equal(fakes.geocoding.requests.length, 0);
    assert.ok(!on.limiter.calls.some((call) => call.bucket === 'geocoding:global'));
    assert.equal(on.entries()[0]!['metadata'].outcome, 'disabled');
  });

  it('answers 503 without calling anybody when the platform has no key', async () => {
    const own = await off.seed(852, { googleMaps: { status: true } });
    const reply = await geocode(ADDRESS, off.world.group(0).sa, own, off);
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(off.entries()[0]!['metadata'].outcome, 'notConfigured');
  });

  it('hides a place of another group, a trashed one and an unknown one as a 404', async () => {
    const trashed = await on.seed(853, { googleMaps: { status: true } }, { trash: true });
    const replies = [await geocode(ADDRESS, sa(), trashed), await geocode(ADDRESS, on.world.group(1).sa), await geocode(ADDRESS, sa(), fixtureId('place', 999)), await geocode(ADDRESS, on.world.group(0).pa, await on.seed(854, { googleMaps: { status: true } }))];
    assert.deepEqual(replies.map((reply) => [reply.status, reply.body.error.code]), [[404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'NOT_FOUND']]);
    assert.equal(fakes.geocoding.requests.length, 0);
  });

  it('limits a user to 20 a minute and 200 a day, and the whole platform to its daily cap, counted on the calls that are really made', async () => {
    for (let call = 0; call < 20; call += 1) {
      assert.equal((await geocode()).status, 200);
    }
    const sixth = await geocode();
    assert.deepEqual([sixth.status, sixth.body.error.code], [429, 'RATE_LIMITED']);
    assert.ok(on.limiter.calls.some((call) => call.bucket === 'integrations-geocoding-day:user' && call.limit === 200));
    assert.ok(on.limiter.calls.some((call) => call.bucket === 'integrations-geocoding:user' && call.limit === 20));
    // The platform's cap is 25 in this world: five more calls by another user, then nobody.
    for (let call = 0; call < 5; call += 1) {
      assert.equal((await geocode(ADDRESS, dealer())).status, 200);
    }
    const capped = await geocode(ADDRESS, psa());
    assert.deepEqual([capped.status, capped.body.error.code], [429, 'RATE_LIMITED']);
    assert.notEqual(capped.headers.get('retry-after'), null);
    assert.equal(fakes.geocoding.requests.length, 25);
    assert.deepEqual(on.limiter.calls.filter((call) => call.bucket === 'geocoding:global').map((call) => call.limit), Array(26).fill(25));
  });
});
