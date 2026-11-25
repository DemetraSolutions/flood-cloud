import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FakeReply } from '../helpers/fake-provider.ts';
import { PUBLIC_KEY_PEM, SATISPAY_KEY_ID, integrationsEnv, startFakes, startIntegrationsWorld, stopFakes } from '../helpers/integrations-world.ts';
import type { Fakes, IntegrationsWorld } from '../helpers/integrations-world.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let bareCtx: TestDatabases;
let fakes: Fakes;
let on: IntegrationsWorld;
let off: IntegrationsWorld;
const psa = () => on.world.office.cluster.psa;
const dealer = () => on.world.office.cluster.dealerA;
const satispay = { status: true, activationCode: 'OLDCODE12345', keyId: null, type: 'checkin' };
const CODE = 'AB12CD34';
const idempotencyKeys = () => ctx.databases.common().collection('idempotencyKeys').find({}).toArray();

/** The activation as an actor: a fresh `Idempotency-Key` and the current `If-Match` unless the test brings its own. */
async function activate(id: Awaited<ReturnType<IntegrationsWorld['seed']>>, body: unknown = { activationCode: CODE }, extra: Record<string, string | null> = {}, actor = psa(), world = on) {
  const headers: Record<string, string> = { 'idempotency-key': randomUUID(), ...(await world.ifMatch(id)) };
  for (const [name, value] of Object.entries(extra)) {
    if (value === null) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return world.world.as.call(actor, 'POST', world.path(id, '/integrations/satispay/activation'), body, headers);
}

before(async () => {
  fakes = await startFakes();
  ctx = await openTestDatabases();
  bareCtx = await openTestDatabases();
  on = await startIntegrationsWorld(ctx, { env: integrationsEnv(fakes), integrationsHttp: { satispay: { timeoutMs: 300 } } });
  off = await startIntegrationsWorld(bareCtx);
});
after(async () => {
  await on.world.office.close();
  await off.world.office.close();
  await ctx.cleanup();
  await bareCtx.cleanup();
  await stopFakes(fakes);
});
beforeEach(() => {
  fakes.satispay.reset();
  on.limiter.reset();
  on.limiter.calls.length = 0;
  on.world.office.activity.entries.length = 0;
  on.world.office.logEvents.length = 0;
});

describe('POST /v1/groups/{groupId}/places/{placeId}/integrations/satispay/activation', () => {
  it('exchanges the code for the key id, stores only the key id, answers that it was set with the new version, and never says the key id', async () => {
    for (const actor of [psa(), dealer()]) {
      const id = await on.seed(810, { satispay });
      const read = (await on.ifMatch(id))['if-match'];
      const reply = await activate(id, { activationCode: ` ${CODE.toLowerCase()} ` }, {}, actor);
      assert.deepEqual([reply.status, reply.body], [200, { data: { keyIdSet: true } }]);
      const call = fakes.satispay.requests.at(-1)!;
      assert.deepEqual([call.method, call.path, JSON.parse(call.body)], ['POST', '/g_business/v1/authentication_keys', { public_key: PUBLIC_KEY_PEM, token: CODE }]);
      // The key id is stored, the code is gone, and the place is at the version the answer gives.
      assert.deepEqual((await on.integrationsOf(id))['satispay'], { status: true, keyId: SATISPAY_KEY_ID, type: 'checkin' });
      assert.equal(reply.headers.get('etag'), (await on.ifMatch(id))['if-match']);
      assert.notEqual(reply.headers.get('etag'), read);
      assert.ok(!JSON.stringify(reply.body).includes(SATISPAY_KEY_ID));
      await ctx.databases.group(on.world.group(0).groupId, 'cluster0').collection('places').deleteOne({ _id: id });
    }
  });

  it('keeps no key id and no code in the idempotency record, the logs or the activity log, and records a security event with the outcome', async () => {
    const id = await on.seed(811, { satispay });
    assert.equal((await activate(id)).status, 200);
    const everything = JSON.stringify([await idempotencyKeys(), on.world.office.activity.entries, on.world.office.logEvents]);
    for (const secret of [SATISPAY_KEY_ID, CODE, 'OLDCODE12345']) {
      assert.ok(!everything.includes(secret), secret);
    }
    const [entry, ...rest] = on.entries();
    assert.equal(rest.length, 0);
    assert.deepEqual([entry!['category'], entry!['action'], entry!['outcome'], entry!['resource']], ['security', 'integrations.satispayActivated', 'success', { type: 'place', id: id.toHexString() }]);
    assert.deepEqual({ ...entry!['metadata'], durationMs: typeof entry!['metadata'].durationMs }, { outcome: 'ok', providerStatus: null, durationMs: 'number' });
  });

  it('answers a replay with the same Idempotency-Key as the first time, without calling the provider again, and refuses the same key with another code', async () => {
    const id = await on.seed(812, { satispay });
    const headers = { 'idempotency-key': randomUUID(), ...(await on.ifMatch(id)) };
    const path = on.path(id, '/integrations/satispay/activation');
    const first = await on.world.as.call(psa(), 'POST', path, { activationCode: CODE }, headers);
    const replay = await on.world.as.call(psa(), 'POST', path, { activationCode: CODE }, headers);
    assert.deepEqual([replay.status, replay.body, replay.headers.get('etag')], [first.status, first.body, first.headers.get('etag')]);
    assert.equal(fakes.satispay.requests.length, 1);
    const other = await on.world.as.call(psa(), 'POST', path, { activationCode: 'OTHER99' }, headers);
    assert.deepEqual([other.status, other.body.error.code, other.body.error.details], [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    assert.equal(fakes.satispay.requests.length, 1);
  });

  it('refuses a call without Idempotency-Key, or with one that is not a UUID, before anything leaves', async () => {
    const id = await on.seed(813, { satispay });
    const noKey = await activate(id, { activationCode: CODE }, { 'idempotency-key': null });
    assert.deepEqual([noKey.status, noKey.body.error.details], [422, [{ field: 'Idempotency-Key', issue: 'required' }]]);
    const badKey = await activate(id, { activationCode: CODE }, { 'idempotency-key': 'not-a-uuid' });
    assert.deepEqual([badKey.status, badKey.body.error.details], [422, [{ field: 'Idempotency-Key', issue: 'format' }]]);
    assert.equal(fakes.satispay.requests.length, 0);
  });

  it('refuses a call without If-Match, with one that is not a strong tag, and with a stale one (412, before the provider), and writes nothing', async () => {
    const id = await on.seed(814, { satispay });
    const missing = await activate(id, { activationCode: CODE }, { 'if-match': null });
    assert.deepEqual([missing.status, missing.body.error.details], [422, [{ field: 'If-Match', issue: 'required' }]]);
    const weak = await activate(id, { activationCode: CODE }, { 'if-match': 'W/"abc"' });
    assert.deepEqual([weak.status, weak.body.error.details], [422, [{ field: 'If-Match', issue: 'format' }]]);
    const stale = await activate(id, { activationCode: CODE }, { 'if-match': `"${'A'.repeat(43)}"` });
    assert.deepEqual([stale.status, stale.body.error.code], [412, 'PRECONDITION_FAILED']);
    assert.equal(fakes.satispay.requests.length, 0);
    assert.equal((await on.integrationsOf(id))['satispay']!['keyId'], null);
  });

  it('lets only a PSA or a dealer activate: a group administrator, a company administrator and a place administrator get 403 without a call', async () => {
    const id = await on.seed(815, { satispay });
    const own = on.world.group(0).ownPlaceId;
    for (const [actor, target] of [[on.world.group(0).sa, id], [on.world.group(0).ca, id], [on.world.group(0).pa, own]] as const) {
      const reply = await activate(target, { activationCode: CODE }, {}, actor);
      assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [403, 'FORBIDDEN', [{ field: 'integrations.satispay.keyId', issue: 'notAllowed' }]]);
    }
    assert.equal(fakes.satispay.requests.length, 0);
    assert.deepEqual(on.entries().map((entry) => [entry['outcome'], entry['metadata'].outcome]), Array(3).fill(['denied', 'rejected']));
  });

  it('says a switch that is off, without calling the provider', async () => {
    const id = await on.seed(816, { satispay: { ...satispay, status: false } });
    const reply = await activate(id);
    assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'integrations.satispay.status', issue: 'incorrect' }]]);
    assert.equal(fakes.satispay.requests.length, 0);
    assert.equal(on.entries()[0]!['metadata'].outcome, 'disabled');
  });

  it('accepts a body of the activation code alone, 1 to 32 letters and digits', async () => {
    const id = await on.seed(817, { satispay });
    const bad: unknown[] = [{}, { activationCode: '' }, { activationCode: 'A'.repeat(33) }, { activationCode: 'AB-12' }, { activationCode: 'AB 12' }, { activationCode: 12 }, { activationCode: null }, { activationCode: CODE, keyId: 'x' }, { activationCode: CODE, public_key: 'x' }, []];
    for (const body of bad) {
      on.limiter.reset();
      const reply = await activate(id, body);
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.ok(!JSON.stringify(reply.body).includes(CODE));
    }
    assert.equal(fakes.satispay.requests.length, 0);
    on.limiter.reset();
    assert.equal((await activate(id, { activationCode: 'A'.repeat(32) })).status, 200);
    assert.equal(JSON.parse(fakes.satispay.requests[0]!.body).token, 'A'.repeat(32));
  });

  it('turns a code the provider refuses (403 already paired, 404 unknown) into a 422 on the code, and the other failures into 502, and never repeats the call', async () => {
    const cases: Array<[string, FakeReply, number, unknown]> = [
      ['403', { status: 403, json: { message: 'provider detail' } }, 422, [{ field: 'activationCode', issue: 'incorrect' }]],
      ['404', { status: 404 }, 422, [{ field: 'activationCode', issue: 'incorrect' }]],
      ['401 (the platform key, not the code)', { status: 401 }, 502, undefined],
      ['400', { status: 400 }, 502, undefined],
      ['429', { status: 429, headers: { 'Retry-After': '9' } }, 502, undefined],
      ['500', { status: 500 }, 502, undefined],
      ['503', { status: 503 }, 502, undefined],
      ['not JSON', { raw: 'nope' }, 502, undefined],
      ['no key id', { json: {} }, 502, undefined],
      ['an empty key id', { json: { key_id: '' } }, 502, undefined],
      ['a key id that is not a text', { json: { key_id: 5 } }, 502, undefined],
      ['a key id that is too long', { json: { key_id: 'k'.repeat(201) } }, 502, undefined],
      ['null', { raw: 'null' }, 502, undefined],
      ['a connection that closes', { drop: true }, 502, undefined],
      ['a timeout', { hang: true }, 502, undefined],
    ];
    for (const [name, reply, status, details] of cases) {
      const id = await on.seed(820, { satispay });
      on.limiter.reset();
      fakes.satispay.reset();
      fakes.satispay.respond = () => reply;
      on.world.office.activity.entries.length = 0;
      const answer = await activate(id);
      assert.equal(answer.status, status, name);
      assert.deepEqual(answer.body.error.details, details, name);
      assert.equal(answer.headers.get('retry-after'), null, name);
      assert.ok(!JSON.stringify(answer.body).includes('provider detail'), name);
      assert.equal(fakes.satispay.requests.length, 1, `${name}: a POST is never repeated`);
      assert.equal((await on.integrationsOf(id))['satispay']!['keyId'], null, name);
      assert.equal((await on.integrationsOf(id))['satispay']!['activationCode'], 'OLDCODE12345', name);
      await ctx.databases.group(on.world.group(0).groupId, 'cluster0').collection('places').deleteOne({ _id: id });
    }
  });

  it('records a security event, with the code consumed, when the key id cannot be stored, and answers 502 when it is not in the form of the field', async () => {
    const id = await on.seed(821, { satispay });
    fakes.satispay.respond = () => ({ json: { key_id: 'has a space' } });
    const reply = await activate(id);
    assert.deepEqual([reply.status, reply.body.error.code], [502, 'PROVIDER_ERROR']);
    assert.deepEqual((await on.integrationsOf(id))['satispay'], satispay);
    const [entry] = on.entries();
    assert.deepEqual([entry!['category'], entry!['outcome'], entry!['metadata'].outcome], ['security', 'failure', 'saveFailed']);
    assert.ok(!JSON.stringify([on.world.office.activity.entries, on.world.office.logEvents]).includes('has a space'));
  });

  it('releases the Idempotency-Key of a failure, so the same request can be sent again', async () => {
    const id = await on.seed(822, { satispay });
    const headers = { 'idempotency-key': randomUUID(), ...(await on.ifMatch(id)) };
    const path = on.path(id, '/integrations/satispay/activation');
    fakes.satispay.respond = () => ({ status: 500 });
    assert.equal((await on.world.as.call(psa(), 'POST', path, { activationCode: CODE }, headers)).status, 502);
    fakes.satispay.respond = () => ({ json: { key_id: SATISPAY_KEY_ID } });
    assert.equal((await on.world.as.call(psa(), 'POST', path, { activationCode: CODE }, headers)).status, 200);
  });

  it('stores the key id and answers with no ETag when the place changed while the provider was asked', async () => {
    const id = await on.seed(823, { satispay });
    const read = await on.ifMatch(id);
    fakes.satispay.respond = async () => {
      assert.equal((await on.world.as.call(psa(), 'PATCH', on.path(id), { name: 'Renamed meanwhile' }, read)).status, 200);
      return { json: { key_id: SATISPAY_KEY_ID } };
    };
    const reply = await on.world.as.call(psa(), 'POST', on.path(id, '/integrations/satispay/activation'), { activationCode: CODE }, { 'idempotency-key': randomUUID(), ...read });
    assert.deepEqual([reply.status, reply.body, reply.headers.get('etag')], [200, { data: { keyIdSet: true } }, null]);
    assert.equal((await on.integrationsOf(id))['satispay']!['keyId'], SATISPAY_KEY_ID);
  });

  it('answers 503 without calling anybody when the platform has no Satispay configuration', async () => {
    const id = await off.seed(824, { satispay });
    const reply = await activate(id, { activationCode: CODE }, {}, off.world.office.cluster.psa, off);
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(fakes.satispay.requests.length, 0);
    assert.equal(off.entries()[0]!['metadata'].outcome, 'notConfigured');
  });

  it('limits a user to 5 activations an hour and a place to 10 a day, counting only the PSA and the dealers who can activate', async () => {
    const id = await on.seed(825, { satispay });
    const statuses = async (actor: typeof psa extends () => infer T ? T : never, times: number) => {
      const found: number[] = [];
      for (let call = 0; call < times; call += 1) {
        found.push((await activate(id, { activationCode: CODE }, {}, actor)).status);
      }
      return found;
    };
    // A group administrator is refused (403) before the provider and does not use up the cap of the place, as many times as its own hourly cap lets it try.
    assert.deepEqual(await statuses(on.world.group(0).sa, 5), Array(5).fill(403));
    assert.ok(!on.limiter.calls.some((call) => call.bucket === 'integrations-satispay-day:place'));
    assert.deepEqual(await statuses(psa(), 5), Array(5).fill(200));
    const sixth = await activate(id, { activationCode: CODE }, {}, psa());
    assert.deepEqual([sixth.status, sixth.body.error.code], [429, 'RATE_LIMITED']);
    assert.notEqual(sixth.headers.get('retry-after'), null);
    // The dealer can still activate after the attempts of the administrator: the place has had 10 activations of the day and not one more.
    assert.deepEqual(await statuses(dealer(), 5), Array(5).fill(200));
    assert.equal(on.limiter.calls.filter((call) => call.bucket === 'integrations-satispay-day:place').length, 10);
    assert.equal(fakes.satispay.requests.length, 10);
  });

  it('counts against the place of the day only an id that is one, and refuses any other before the provider', async () => {
    const path = (rest: string) => on.world.placePath(0, `/${rest}/integrations/satispay/activation`);
    const headers = { 'idempotency-key': randomUUID(), 'if-match': `"${'A'.repeat(43)}"` };
    const malformed = await on.world.as.call(psa(), 'POST', path('not-an-id'), { activationCode: CODE }, headers);
    assert.equal(malformed.status, 422);
    assert.ok(!on.limiter.calls.some((call) => call.bucket === 'integrations-satispay-day:place'));
    assert.equal(fakes.satispay.requests.length, 0);
    const known = await on.seed(826, { satispay });
    assert.equal((await activate(known)).status, 200);
    assert.deepEqual(on.limiter.calls.filter((call) => call.bucket === 'integrations-satispay-day:place').map((call) => [call.key.endsWith(known.toHexString()), call.limit]), [[true, 10]]);
  });
});
