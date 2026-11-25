import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FakeReply, FakeRequest } from '../helpers/fake-provider.ts';
import { TSH_ID, TSH_NONCE, TSH_SECRET, TSH_TOKEN, integrationsEnv, startFakes, startIntegrationsWorld, stopFakes } from '../helpers/integrations-world.ts';
import type { Fakes, IntegrationsWorld } from '../helpers/integrations-world.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let halfCtx: TestDatabases;
let bareCtx: TestDatabases;
let fakes: Fakes;
let on: IntegrationsWorld;
let withoutTest: IntegrationsWorld;
let off: IntegrationsWorld;
const sa = () => on.world.group(0).sa;
const psa = () => on.world.office.cluster.psa;
const COMPLETE = { status: true, id: TSH_ID, secret: TSH_SECRET, propertyId: 'prop_1-A', testMode: false, tshCategories: [{ id: 'old', name: 'Old' }], categoriesMap: { cat: 'old' } };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const BAR = { id: 'c1', name: 'Bar' };
const KITCHEN = { id: 'c2', name: 'Cucina' };

async function sync(id: Awaited<ReturnType<IntegrationsWorld['seed']>>, extra: Record<string, string | null> = {}, actor = sa(), world = on) {
  const headers: Record<string, string> = { ...(await world.ifMatch(id)) };
  for (const [name, value] of Object.entries(extra)) {
    if (value === null) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return world.world.as.call(actor, 'POST', world.path(id, '/integrations/tsh/charge-categories/sync'), undefined, headers);
}
const everything = (world: IntegrationsWorld) => JSON.stringify([world.world.office.activity.entries, world.world.office.logEvents]);
const answerApi = (reply: FakeReply) => {
  fakes.tshApi.respond = () => reply;
};
const answerAuth = (decide: (request: FakeRequest) => FakeReply) => {
  fakes.tshAuth.respond = decide;
};

before(async () => {
  fakes = await startFakes();
  ctx = await openTestDatabases();
  halfCtx = await openTestDatabases();
  bareCtx = await openTestDatabases();
  const http = { tsh: { timeoutMs: 300, sleep: async () => undefined } };
  on = await startIntegrationsWorld(ctx, { env: integrationsEnv(fakes), integrationsHttp: http });
  const { TSH_TEST_AUTH_BASE_URL: _a, TSH_TEST_API_BASE_URL: _b, ...production } = integrationsEnv(fakes);
  withoutTest = await startIntegrationsWorld(halfCtx, { env: production, integrationsHttp: http });
  off = await startIntegrationsWorld(bareCtx);
});
after(async () => {
  for (const world of [on, withoutTest, off]) {
    await world.world.office.close();
  }
  await ctx.cleanup();
  await halfCtx.cleanup();
  await bareCtx.cleanup();
  await stopFakes(fakes);
});
beforeEach(() => {
  for (const fake of [fakes.tshAuth, fakes.tshApi, fakes.tshTestAuth, fakes.tshTestApi]) {
    fake.reset();
  }
  on.limiter.reset();
  for (const world of [on, withoutTest, off]) {
    world.world.office.activity.entries.length = 0;
    world.world.office.logEvents.length = 0;
  }
});

describe('POST /v1/groups/{groupId}/places/{placeId}/integrations/tsh/charge-categories/sync', () => {
  it('asks for a nonce, derives the digest of the credentials, exchanges it for a token, reads the categories with it, stores the copy and answers the list with the new version', async () => {
    const id = await on.seed(830, { tsh: COMPLETE });
    const reply = await sync(id);
    assert.deepEqual([reply.status, reply.body], [200, { data: [BAR, KITCHEN] }]);
    assert.equal(reply.headers.get('etag'), (await on.ifMatch(id))['if-match']);
    const [nonce, token] = fakes.tshAuth.requests;
    assert.deepEqual([nonce!.method, nonce!.path, JSON.parse(nonce!.body)], ['POST', '/api/v3/nonces', { id: TSH_ID }]);
    assert.deepEqual([token!.method, token!.path, JSON.parse(token!.body)], ['POST', '/api/v3/tokens', { id: TSH_ID, digest: sha(`${sha(TSH_ID.toLowerCase() + TSH_SECRET).toLowerCase()}${TSH_NONCE}`) }]);
    const read = fakes.tshApi.requests[0]!;
    assert.deepEqual([read.method, read.path, read.headers['authorization']], ['GET', '/api/pms/prop_1-A/charge-categories', `Bearer ${TSH_TOKEN}`]);
    assert.ok(typeof read.headers['x-correlation-id'] === 'string' && read.headers['x-app-name'] === 'TS320');
    // The copy is stored, the map and the credentials are untouched.
    const tsh = (await on.integrationsOf(id))['tsh']!;
    assert.deepEqual([tsh['tshCategories'], tsh['categoriesMap'], tsh['secret']], [[BAR, KITCHEN], { cat: 'old' }, TSH_SECRET]);
    assert.equal(fakes.tshTestAuth.requests.length + fakes.tshTestApi.requests.length, 0);
  });

  it('keeps no secret, nonce, digest or token anywhere but the calls, and records the call with the count and the mode', async () => {
    const id = await on.seed(831, { tsh: COMPLETE });
    const reply = await sync(id);
    const digest = JSON.parse(fakes.tshAuth.requests[1]!.body).digest as string;
    for (const secret of [TSH_SECRET, TSH_NONCE, TSH_TOKEN, digest]) {
      assert.ok(!everything(on).includes(secret), secret);
      assert.ok(!JSON.stringify(reply.body).includes(secret), secret);
    }
    const [entry, ...rest] = on.entries();
    assert.equal(rest.length, 0);
    assert.deepEqual([entry!['category'], entry!['action'], entry!['outcome']], ['data', 'integrations.tshCategoriesSynced', 'success']);
    assert.deepEqual({ ...entry!['metadata'], durationMs: typeof entry!['metadata'].durationMs }, { outcome: 'ok', providerStatus: null, durationMs: 'number', count: 2, testMode: false });
  });

  it('asks for a new nonce and a new token on every call, and never keeps them', async () => {
    const id = await on.seed(832, { tsh: COMPLETE });
    assert.equal((await sync(id)).status, 200);
    assert.equal((await sync(id)).status, 200);
    assert.deepEqual([fakes.tshAuth.requests.length, fakes.tshApi.requests.length], [4, 2]);
    assert.notEqual(fakes.tshAuth.requests[0]!.headers['x-correlation-id'], fakes.tshAuth.requests[2]!.headers['x-correlation-id']);
  });

  it('uses the hosts of the test environment, and only them, for a place in test mode', async () => {
    const id = await on.seed(833, { tsh: { ...COMPLETE, testMode: true } });
    assert.equal((await sync(id, {}, psa())).status, 200);
    assert.deepEqual([fakes.tshTestAuth.requests.length, fakes.tshTestApi.requests.length, fakes.tshAuth.requests.length, fakes.tshApi.requests.length], [2, 1, 0, 0]);
    assert.equal(on.entries()[0]!['metadata'].testMode, true);
  });

  it('answers 503 for a place in test mode when the platform has no test hosts, without calling anybody, and works for the other places', async () => {
    const test = await withoutTest.seed(834, { tsh: { ...COMPLETE, testMode: true } });
    const reply = await sync(test, {}, withoutTest.world.group(0).sa, withoutTest);
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(fakes.tshAuth.requests.length, 0);
    assert.deepEqual([withoutTest.entries()[0]!['metadata'].outcome, withoutTest.entries()[0]!['metadata'].testMode], ['notConfigured', true]);
    const production = await withoutTest.seed(835, { tsh: COMPLETE });
    assert.equal((await sync(production, {}, withoutTest.world.group(0).sa, withoutTest)).status, 200);
  });

  it('answers 503 without calling anybody when the platform has no TS Hospitality configuration', async () => {
    const id = await off.seed(836, { tsh: COMPLETE });
    const reply = await sync(id, {}, off.world.group(0).sa, off);
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(fakes.tshAuth.requests.length, 0);
    assert.equal(off.entries()[0]!['metadata'].outcome, 'notConfigured');
  });

  it('says a switch that is off and a credential that is missing, in the order id, secret, property, without calling the provider', async () => {
    const cases: Array<[Record<string, unknown>, string, string, string]> = [
      [{ ...COMPLETE, status: false }, 'integrations.tsh.status', 'incorrect', 'disabled'],
      [{ ...COMPLETE, id: null }, 'integrations.tsh.id', 'required', 'notConfigured'],
      [{ ...COMPLETE, secret: '' }, 'integrations.tsh.secret', 'required', 'notConfigured'],
      [{ ...COMPLETE, propertyId: null }, 'integrations.tsh.propertyId', 'required', 'notConfigured'],
    ];
    for (const [tsh, field, issue, outcome] of cases) {
      on.world.office.activity.entries.length = 0;
      const reply = await sync(await on.seed(837, { tsh }));
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field, issue }]], field);
      assert.equal(on.entries()[0]!['metadata'].outcome, outcome);
    }
    assert.equal(fakes.tshAuth.requests.length, 0);
  });

  it('never lets a property identifier that is not in the allowed form reach the path of a call', async () => {
    for (const propertyId of ['../etc', 'a/b', 'a?b=1', 'a#b', 'a b', 'a%2Fb', 'x'.repeat(65)]) {
      const reply = await sync(await on.seed(838, { tsh: { ...COMPLETE, propertyId } }));
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'integrations.tsh.propertyId', issue: 'pattern' }]], propertyId);
    }
    assert.equal(fakes.tshAuth.requests.length + fakes.tshApi.requests.length, 0);
  });

  it('refuses a call without If-Match, or with one that is not a strong tag, and a stale one (412) without storing anything', async () => {
    const id = await on.seed(839, { tsh: COMPLETE });
    const missing = await sync(id, { 'if-match': null });
    assert.deepEqual([missing.status, missing.body.error.details], [422, [{ field: 'If-Match', issue: 'required' }]]);
    const weak = await sync(id, { 'if-match': '*' });
    assert.deepEqual([weak.status, weak.body.error.details], [422, [{ field: 'If-Match', issue: 'format' }]]);
    const stale = await sync(id, { 'if-match': `"${'A'.repeat(43)}"` });
    assert.deepEqual([stale.status, stale.body.error.code], [412, 'PRECONDITION_FAILED']);
    assert.deepEqual((await on.integrationsOf(id))['tsh']!['tshCategories'], COMPLETE.tshCategories);
    assert.equal(on.entries().at(-1)!['metadata'].outcome, 'rejected');
  });

  it('turns credentials the provider refuses (401 or 403, at the nonce or at the token) into a 422 on the secret, with nothing of what it said', async () => {
    for (const [stage, path] of [['nonce', '/api/v3/nonces'], ['token', '/api/v3/tokens']] as const) {
      for (const status of [401, 403]) {
        fakes.tshAuth.reset();
        answerAuth((request) => (request.path === path ? { status, json: { message: 'provider detail' } } : { json: { nonce: TSH_NONCE } }));
        const reply = await sync(await on.seed(840, { tsh: COMPLETE }));
        assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'integrations.tsh.secret', issue: 'incorrect' }]], `${stage} ${String(status)}`);
        assert.ok(!JSON.stringify(reply.body).includes('provider detail'));
      }
    }
    assert.equal(fakes.tshApi.requests.length, 0);
  });

  it('answers 502 PROVIDER_ERROR, with no detail and no Retry-After, to a provider that fails at any step, and repeats only the read', async () => {
    const auth = (path: string, reply: FakeReply) => () => answerAuth((request) => (request.path === path ? reply : { json: { nonce: TSH_NONCE } }));
    const cases: Array<[string, () => void, number]> = [
      ['a 500 at the nonce', auth('/api/v3/nonces', { status: 500 }), 1],
      ['a 429 at the nonce', auth('/api/v3/nonces', { status: 429, headers: { 'Retry-After': '9' } }), 1],
      ['a 503 at the token', auth('/api/v3/tokens', { status: 503 }), 2],
      ['a timeout at the nonce', () => answerAuth(() => ({ hang: true })), 1],
      ['a connection that closes at the token', auth('/api/v3/tokens', { drop: true }), 2],
      ['a nonce that is missing', () => answerAuth(() => ({ json: {} })), 1],
      ['a nonce that is not a text', () => answerAuth(() => ({ json: { nonce: 5 } })), 1],
      ['a nonce with a space', () => answerAuth(() => ({ json: { nonce: 'two words' } })), 1],
      ['a nonce that is too long', () => answerAuth(() => ({ json: { nonce: 'n'.repeat(257) } })), 1],
      ['a nonce answer that is null', () => answerAuth(() => ({ raw: 'null' })), 1],
      ['a token that is missing', auth('/api/v3/tokens', { json: {} }), 2],
      ['a token that is too short', auth('/api/v3/tokens', { json: { accessToken: 'short' } }), 2],
      ['a token with a line break', auth('/api/v3/tokens', { json: { accessToken: `${TSH_TOKEN}\r\nX-Evil: 1` } }), 2],
      ['a token with a space', auth('/api/v3/tokens', { json: { accessToken: `${TSH_TOKEN} more` } }), 2],
      ['a token that is too long', auth('/api/v3/tokens', { json: { accessToken: 't'.repeat(4097) } }), 2],
      ['a token answer that is null', auth('/api/v3/tokens', { raw: 'null' }), 2],
    ];
    for (const [name, arrange, authCalls] of cases) {
      fakes.tshAuth.reset();
      fakes.tshApi.reset();
      arrange();
      const id = await on.seed(841, { tsh: COMPLETE });
      on.limiter.reset();
      const reply = await sync(id);
      assert.deepEqual([reply.status, reply.body], [502, { error: { code: 'PROVIDER_ERROR', message: 'The provider could not complete the request' } }], name);
      assert.equal(reply.headers.get('retry-after'), null, name);
      assert.equal(fakes.tshAuth.requests.length, authCalls, name);
      assert.equal(fakes.tshApi.requests.length, 0, name);
      assert.deepEqual((await on.integrationsOf(id))['tsh']!['tshCategories'], COMPLETE.tshCategories, name);
    }
  });

  it('answers 502 to a read that fails, rate limits, redirects, answers something else or is too big, repeating it once only on 502, 503 and 504, and stores nothing', async () => {
    const cases: Array<[string, FakeReply, number, string]> = [
      ['a 500', { status: 500 }, 1, 'providerError'],
      ['a 502', { status: 502 }, 2, 'providerError'],
      ['a 504', { status: 504 }, 2, 'providerError'],
      ['a 429', { status: 429, headers: { 'Retry-After': '30' } }, 1, 'providerError'],
      ['a 404', { status: 404 }, 1, 'providerError'],
      ['a timeout', { hang: true }, 2, 'timeout'],
      ['a redirect', { redirectTo: `${fakes.satispay.baseUrl}/elsewhere` }, 2, 'providerError'],
      ['a body over the limit', { streamMegabytes: 2 }, 1, 'providerError'],
      ['text that is not JSON', { raw: '<html>' }, 1, 'providerError'],
    ];
    for (const [name, reply, attempts, outcome] of cases) {
      fakes.tshApi.reset();
      on.world.office.activity.entries.length = 0;
      answerApi(reply);
      on.limiter.reset();
      const id = await on.seed(842, { tsh: COMPLETE });
      const answer = await sync(id);
      assert.deepEqual([answer.status, answer.body.error.code, answer.headers.get('retry-after')], [502, 'PROVIDER_ERROR', null], name);
      assert.equal(fakes.tshApi.requests.length, attempts, name);
      assert.equal(on.entries()[0]!['metadata'].outcome, outcome, name);
      assert.deepEqual((await on.integrationsOf(id))['tsh']!['tshCategories'], COMPLETE.tshCategories, name);
    }
    assert.equal(fakes.satispay.requests.length, 0);
  });

  it('refuses a list whose categories are out of shape (a missing id or name, another type, too long, too many) as a 502, and stores nothing', async () => {
    const bad: unknown[] = [
      [{ name: 'No id' }],
      [{ id: 'c1' }],
      [{ id: '', name: 'Empty id' }],
      [{ id: 'c'.repeat(65), name: 'Long id' }],
      [{ id: 'c1', name: 'n'.repeat(201) }],
      [{ id: 'c1', name: '   ' }],
      [{ id: 1.5, name: 'Fractional id' }],
      [{ id: ['c1'], name: 'List id' }],
      [null],
      ['text'],
      Array.from({ length: 501 }, (_, index) => ({ id: `c${String(index)}`, name: 'N' })),
      { chargeCategories: 'a text' },
      { somethingElse: [BAR] },
      'a text',
      null,
    ];
    for (const json of bad) {
      answerApi({ json });
      on.limiter.reset();
      const id = await on.seed(843, { tsh: COMPLETE });
      assert.equal((await sync(id)).status, 502, JSON.stringify(json)?.slice(0, 50));
      assert.deepEqual((await on.integrationsOf(id))['tsh']!['tshCategories'], COMPLETE.tshCategories);
    }
  });

  it('reads the list from the whole answer or from `chargeCategories`, `categories` or `items`, takes a numeric id as a text, and an empty list as a list', async () => {
    const forms: Array<[unknown, unknown]> = [
      [[BAR], [BAR]],
      [{ chargeCategories: [KITCHEN] }, [KITCHEN]],
      [{ categories: [BAR, KITCHEN] }, [BAR, KITCHEN]],
      [{ items: [BAR] }, [BAR]],
      [[{ id: 7, description: ' Bar 7 ' }], [{ id: '7', name: 'Bar 7' }]],
      [[], []],
    ];
    for (const [json, expected] of forms) {
      answerApi({ json });
      on.limiter.reset();
      const id = await on.seed(844, { tsh: COMPLETE });
      const reply = await sync(id);
      assert.deepEqual([reply.status, reply.body.data], [200, expected], JSON.stringify(json));
      assert.deepEqual((await on.integrationsOf(id))['tsh']!['tshCategories'], expected);
    }
  });

  it('hides a place of another group, a trashed one and an unknown one as a 404, and a place administrator reaches his own place only', async () => {
    const trashed = await on.seed(845, { tsh: COMPLETE }, { trash: true });
    const elsewhere = await on.world.seedPlace(1, 846, 1);
    const replies = [await sync(trashed), await sync(await on.seed(847, { tsh: COMPLETE }), {}, on.world.group(1).sa), await sync(elsewhere, { 'if-match': `"${'A'.repeat(43)}"` }), await sync(await on.seed(848, { tsh: COMPLETE }), {}, on.world.group(0).pa)];
    assert.deepEqual(replies.map((reply) => [reply.status, reply.body.error.code]), Array(4).fill([404, 'NOT_FOUND']));
    assert.equal(fakes.tshAuth.requests.length, 0);
  });

  it('limits a user to 20 synchronizations an hour', async () => {
    const id = await on.seed(849, { tsh: COMPLETE });
    for (let call = 0; call < 20; call += 1) {
      assert.equal((await sync(id)).status, 200);
    }
    const refused = await sync(id);
    assert.deepEqual([refused.status, refused.body.error.code], [429, 'RATE_LIMITED']);
    assert.equal(fakes.tshApi.requests.length, 20);
    assert.equal((await sync(id, {}, psa())).status, 200);
  });
});
