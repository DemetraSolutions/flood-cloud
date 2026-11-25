import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DOJO_KEY, integrationsEnv, startFakes, startIntegrationsWorld, stopFakes } from '../helpers/integrations-world.ts';
import type { Fakes, IntegrationsWorld } from '../helpers/integrations-world.ts';
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
const terminals = (actor = sa(), id = place, world = on) => world.world.as.call(actor, 'GET', world.path(id, '/integrations/dojo/terminals'));
const dojo = { status: true, apiKey: DOJO_KEY };

before(async () => {
  fakes = await startFakes();
  ctx = await openTestDatabases();
  bareCtx = await openTestDatabases();
  on = await startIntegrationsWorld(ctx, { env: integrationsEnv(fakes), integrationsHttp: { dojo: { timeoutMs: 300, sleep: async () => undefined } } });
  off = await startIntegrationsWorld(bareCtx);
  place = await on.seed(800, { dojo });
});
after(async () => {
  await on.world.office.close();
  await off.world.office.close();
  await ctx.cleanup();
  await bareCtx.cleanup();
  await stopFakes(fakes);
});
beforeEach(() => {
  fakes.dojo.reset();
  fakes.satispay.reset();
  on.limiter.reset();
  on.world.office.activity.entries.length = 0;
  on.world.office.logEvents.length = 0;
});

describe('GET /v1/groups/{groupId}/places/{placeId}/integrations/dojo/terminals', () => {
  it('lists the terminals with the key the place stores, asking the provider with the identifiers of the platform, and answers only id, tid and status', async () => {
    for (const actor of [sa(), psa(), on.world.office.cluster.dealerA, on.world.group(0).ca]) {
      const reply = await terminals(actor);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, { data: [{ id: 'trm_1', tid: 'T-100', status: 'Active' }, { id: 'trm_2', tid: 'T-200', status: 'Inactive' }] });
    }
    const request = fakes.dojo.requests[0]!;
    assert.deepEqual([request.method, request.path, request.headers['authorization'], request.headers['reseller-id'], request.headers['software-house-id'], request.headers['version']], ['GET', '/terminals', `Basic ${DOJO_KEY}`, 'Fake Reseller', 'Fake Software House', '2024-02-05']);
    assert.equal(fakes.dojo.requests.length, 4);
  });

  it('never takes a credential from the request', async () => {
    const reply = await on.world.as.call(sa(), 'GET', `${on.path(place, '/integrations/dojo/terminals')}?apiKey=evil&reseller-id=evil`);
    assert.equal(reply.status, 200);
    assert.equal(fakes.dojo.requests.at(-1)!.headers['authorization'], `Basic ${DOJO_KEY}`);
    assert.ok(!fakes.dojo.requests.at(-1)!.url.includes('evil'));
  });

  it('records the call with its outcome, the count and the duration, and never a key', async () => {
    await terminals();
    const [entry, ...rest] = on.entries();
    assert.equal(rest.length, 0);
    assert.deepEqual([entry!['category'], entry!['action'], entry!['outcome'], entry!['resource'], entry!['groupId']], ['data', 'integrations.dojoTerminalsListed', 'success', { type: 'place', id: place.toHexString() }, on.world.group(0).groupId]);
    assert.deepEqual({ ...entry!['metadata'], durationMs: typeof entry!['metadata'].durationMs }, { outcome: 'ok', providerStatus: null, durationMs: 'number', count: 2 });
    assert.ok(!JSON.stringify(on.world.office.activity.entries).includes(DOJO_KEY));
    assert.ok(!on.logged().includes(DOJO_KEY));
  });

  it('says a switch that is off or a key that is missing with the field, without calling the provider', async () => {
    const switchedOff = await on.seed(801, { dojo: { status: false, apiKey: DOJO_KEY } });
    const keyless = await on.seed(802, { dojo: { status: true, apiKey: null } });
    const failures = [await terminals(sa(), switchedOff), await terminals(sa(), keyless)].map((reply) => [reply.status, reply.body.error.code, reply.body.error.details]);
    assert.deepEqual(failures, [
      [422, 'VALIDATION_ERROR', [{ field: 'integrations.dojo.status', issue: 'incorrect' }]],
      [422, 'VALIDATION_ERROR', [{ field: 'integrations.dojo.apiKey', issue: 'required' }]],
    ]);
    assert.equal(fakes.dojo.requests.length, 0);
    assert.deepEqual(on.entries().map((entry) => [entry['outcome'], entry['metadata'].outcome]), [['denied', 'disabled'], ['denied', 'notConfigured']]);
  });

  it('does not send a key that cannot travel in a header: a 422 on the key, no call', async () => {
    const odd = await on.seed(803, { dojo: { status: true, apiKey: 'has a space' } });
    const reply = await terminals(sa(), odd);
    assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'integrations.dojo.apiKey', issue: 'incorrect' }]]);
    assert.equal(fakes.dojo.requests.length, 0);
    assert.equal(on.entries()[0]!['metadata'].outcome, 'rejected');
  });

  it('turns a key the provider refuses (401 or 403) into a 422 on the key, without anything the provider said', async () => {
    for (const status of [401, 403]) {
      fakes.dojo.respond = () => ({ status, json: { message: 'provider says: bad key fake-secret-detail' } });
      const reply = await terminals();
      assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'integrations.dojo.apiKey', issue: 'incorrect' }]]);
      assert.ok(!JSON.stringify(reply.body).includes('fake-secret-detail'));
    }
    assert.deepEqual(on.entries().map((entry) => [entry['metadata'].outcome, entry['metadata'].providerStatus]), [['rejected', 401], ['rejected', 403]]);
  });

  it('answers 502 PROVIDER_ERROR, with no detail and no Retry-After, to a provider that fails, rate limits, answers something else, or is too big', async () => {
    const cases: Array<[string, () => import('../helpers/fake-provider.ts').FakeReply, string, number | null, number]> = [
      ['a 500, not repeated', () => ({ status: 500, json: { error: 'internal detail' } }), 'providerError', 500, 1],
      ['a 502, tried twice', () => ({ status: 502 }), 'providerError', 502, 2],
      ['a 503, tried twice', () => ({ status: 503 }), 'providerError', 503, 2],
      ['a 429, not repeated', () => ({ status: 429, headers: { 'Retry-After': '17' }, json: {} }), 'providerError', 429, 1],
      ['a 404', () => ({ status: 404 }), 'providerError', 404, 1],
      ['text that is not JSON', () => ({ raw: 'not json' }), 'providerError', null, 1],
      ['JSON of another type', () => ({ raw: '"a text"' }), 'providerError', null, 1],
      ['a body that is not declared as JSON', () => ({ raw: '{}', noContentType: true }), 'providerError', null, 1],
      ['a connection that closes', () => ({ drop: true }), 'providerError', null, 2],
      ['an answer that never comes', () => ({ hang: true }), 'timeout', null, 2],
      ['a redirect, which is refused', () => ({ redirectTo: `${fakes.satispay.baseUrl}/elsewhere` }), 'providerError', null, 2],
      ['a body over the limit', () => ({ streamMegabytes: 2 }), 'providerError', null, 1],
    ];
    for (const [name, reply, outcome, status, attempts] of cases) {
      fakes.dojo.reset();
      on.world.office.activity.entries.length = 0;
      fakes.dojo.respond = reply;
      const answer = await terminals();
      assert.equal(answer.status, 502, name);
      assert.deepEqual(answer.body, { error: { code: 'PROVIDER_ERROR', message: 'The provider could not complete the request' } }, name);
      assert.equal(answer.headers.get('retry-after'), null, name);
      assert.equal(fakes.dojo.requests.length, attempts, name);
      assert.deepEqual([on.entries()[0]!['metadata'].outcome, on.entries()[0]!['metadata'].providerStatus], [outcome, status], name);
    }
    assert.equal(fakes.satispay.requests.length, 0, 'a redirect is never followed');
  });

  it('refuses an answer whose terminals are not texts of a sane size, or are too many', async () => {
    const good = { id: 'trm_1', properties: { tid: 'T-1' }, status: 'Active' };
    const bad: unknown[] = [
      { items: [{ ...good, id: 5 }] },
      { items: [{ ...good, id: '' }] },
      { items: [{ ...good, id: 'x'.repeat(101) }] },
      { items: [{ ...good, properties: {} }] },
      { items: [{ ...good, properties: null }] },
      { items: [{ ...good, status: undefined }] },
      { items: [null] },
      { items: 'a text' },
      { items: Array.from({ length: 501 }, () => good) },
      null,
      {},
    ];
    for (const json of bad) {
      fakes.dojo.respond = () => ({ json });
      assert.equal((await terminals()).status, 502, JSON.stringify(json)?.slice(0, 60));
    }
  });

  it('accepts a list with no terminals, and the list under `terminals` or as the whole answer', async () => {
    const good = { id: 'trm_1', properties: { tid: 'T-1' }, status: 'Active' };
    for (const json of [{ items: [] }, { terminals: [good] }, [good]]) {
      fakes.dojo.respond = () => ({ json });
      const reply = await terminals();
      assert.equal(reply.status, 200);
      assert.equal(reply.body.data.length, Array.isArray(json) ? 1 : (json.items ?? json.terminals).length);
    }
  });

  it('answers 503 without calling anybody when the platform has no Dojo configuration, and records it', async () => {
    const own = await off.seed(804, { dojo });
    const reply = await off.world.as.call(off.world.group(0).sa, 'GET', off.path(own, '/integrations/dojo/terminals'));
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(fakes.dojo.requests.length, 0);
    assert.equal(off.entries()[0]!['metadata'].outcome, 'notConfigured');
  });

  it('hides a place of another group, a trashed one and an unknown one as one 404, and refuses a malformed id', async () => {
    const trashed = await on.seed(805, { dojo }, { trash: true });
    const elsewhere = await on.world.seedPlace(1, 806, 1);
    const unknown = on.world.group(0).ownPlaceId;
    const replies = [
      await terminals(sa(), trashed),
      await terminals(on.world.group(1).sa, place),
      await terminals(sa(), elsewhere),
      await on.world.as.call(sa(), 'GET', on.path(place, '/integrations/dojo/terminals').replace(place.toHexString(), 'f'.repeat(24))),
    ];
    assert.deepEqual(replies.map((reply) => [reply.status, reply.body.error.code]), Array(4).fill([404, 'NOT_FOUND']));
    assert.equal(unknown.toHexString().length, 24);
    const malformed = await on.world.as.call(sa(), 'GET', on.path(place, '/integrations/dojo/terminals').replace(place.toHexString(), '..%2F..'));
    assert.equal(malformed.status, 422);
    assert.equal(fakes.dojo.requests.length, 0);
  });

  it('limits a user to 30 lists an hour, with the headers of the limit', async () => {
    for (let call = 0; call < 30; call += 1) {
      assert.equal((await terminals()).status, 200);
    }
    const refused = await terminals();
    assert.deepEqual([refused.status, refused.body.error.code], [429, 'RATE_LIMITED']);
    assert.notEqual(refused.headers.get('retry-after'), null);
    assert.equal(fakes.dojo.requests.length, 30);
    // Another user has his own counter.
    assert.equal((await terminals(psa())).status, 200);
  });
});
