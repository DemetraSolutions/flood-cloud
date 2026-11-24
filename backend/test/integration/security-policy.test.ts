import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { AppError } from '../../src/shared/http/errors.ts';
import { createSettingsRepository } from '../../src/modules/settings/settings.repository.ts';
import { createSettingsService } from '../../src/modules/settings/settings.service.ts';
import { principalOf } from '../helpers/principal.ts';
import { userName } from '../helpers/backoffice.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

const APP = 'https://backoffice.example.com';
const BROWSER = { origin: APP, 'sec-fetch-site': 'cross-site' };
// `fetch` of Node owns the names `Sec-Fetch-*`: a valid `Origin` alone already looks like a browser's.
const FROM_BROWSER = { origin: APP };
const URL = '/settings/security-policy';

const limiter = memoryRateLimiter();
let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const psa = () => world.office.cluster.psa;
const g0 = () => world.group(0);
const settings = () => ctx.databases.common().collection('settings');
const eventsOf = (actor: ObjectId) => events('request.nonBrowser').filter((entry) => entry.actor.id?.equals(actor));
const events = (action: string) => world.office.activity.entries.filter((entry) => entry.action === action);
const etagOf = async (actor: ObjectId = psa()) => (await call(actor, 'GET', URL)).headers.get('etag') as string;

/** Sets the policy as a PSA calling from a browser. */
async function setPolicy(mode: 'report' | 'block'): Promise<void> {
  const reply = await call(psa(), 'PUT', URL, { nonBrowserRequests: mode }, { ...FROM_BROWSER, 'if-match': await etagOf() });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { REQUEST_ORIGIN_SIGNAL: 'on', CORS_ALLOWED_ORIGINS: APP } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await settings().deleteMany({ key: 'SECURITY_POLICY' });
  // The copy in memory of this instance: a write puts it back, a deleted document is seen when the copy expires.
  world.office.clock.advance(31_000);
  world.office.activity.entries.length = 0;
  // The signal speaks once a day per user and reason: every test starts with a clean day.
  limiter.reset();
});

describe('GET and PUT /v1/settings/security-policy', () => {
  it('is report while nothing was saved, with an ETag, and a damaged stored value is report too', async () => {
    const reply = await call(psa(), 'GET', URL);
    assert.deepEqual([reply.status, reply.body], [200, { data: { nonBrowserRequests: 'report', sustainedLimits: 'report', sources: { nonBrowserRequests: 'default', sustainedLimits: 'default' }, limits: { perMinute: 100000, perHour: 1000000, perDay: 10000000 } } }]);
    assert.match(reply.headers.get('etag') ?? '', /^"[A-Za-z0-9_-]{43}"$/);
    await settings().insertOne({ key: 'SECURITY_POLICY', value: { nonBrowserRequests: 'maybe', sustainedLimits: 'block' } });
    const damaged = (await call(psa(), 'GET', URL)).body.data;
    assert.deepEqual([damaged.nonBrowserRequests, damaged.sustainedLimits, damaged.sources], ['report', 'report', { nonBrowserRequests: 'default', sustainedLimits: 'default' }]);
  });

  it('is the PSA alone: D, SA, CA, PA and a store key are refused (403), an anonymous caller is 401, on both routes', async () => {
    for (const actor of [world.office.cluster.dealerA, g0().sa, g0().ca, g0().pa]) {
      assert.deepEqual(failure(await call(actor, 'GET', URL)).status, 403);
      assert.deepEqual(failure(await call(actor, 'PUT', URL, { nonBrowserRequests: 'report' }, { 'if-match': `"${'a'.repeat(43)}"` })).status, 403);
    }
    const key = await world.activate(g0().ownPlaceId);
    for (const method of ['GET', 'PUT']) {
      const asStore = await world.asStore(key.key, method, URL, method === 'PUT' ? { nonBrowserRequests: 'report' } : undefined);
      assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);
      assert.equal((await world.office.call(method, URL, undefined)).status, 401);
    }
    assert.equal((await world.office.publicCall('GET', URL, undefined)).status, 404, 'the public surface has no such route');
  });

  it('needs If-Match (422), refuses a stale version (412), validates by allowlist (422) and keeps the document with the author', async () => {
    const tag = await etagOf();
    const put = (body: unknown, headers: Record<string, string> = { 'if-match': tag }) => call(psa(), 'PUT', URL, body, { ...FROM_BROWSER, ...headers });
    assert.deepEqual(failure(await put({ nonBrowserRequests: 'block' }, {})), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    assert.equal(failure(await put({ nonBrowserRequests: 'block' }, { 'if-match': '*' })).status, 422);
    assert.equal(failure(await put({ nonBrowserRequests: 'block' }, { 'if-match': `"${'a'.repeat(43)}"` })).status, 412);
    for (const body of [{}, { nonBrowserRequests: 'maybe' }, { nonBrowserRequests: true }, { sustainedLimits: 'block' }, { sustainedLimits: 'maybe' }, { nonBrowserRequests: 'block', extra: 1 }, { $set: { a: 1 } }]) {
      assert.equal(failure(await put(body)).status, 422, JSON.stringify(body));
    }
    const done = await put({ nonBrowserRequests: 'block' });
    assert.deepEqual([done.status, done.body.data.nonBrowserRequests, done.body.data.sustainedLimits, done.body.data.sources], [200, 'block', 'report', { nonBrowserRequests: 'database', sustainedLimits: 'default' }]);
    assert.notEqual(done.headers.get('etag'), tag);
    const stored = (await settings().findOne({ key: 'SECURITY_POLICY' }))!;
    assert.deepEqual([stored['value'], stored['updatedBy']], [{ nonBrowserRequests: 'block' }, psa()]);
    // The old version is stale now.
    assert.equal(failure(await put({ nonBrowserRequests: 'report' })).status, 412);
    // Two writers at once from the same version: one wins.
    await settings().deleteMany({ key: 'SECURITY_POLICY' });
    world.office.clock.advance(31_000);
    const fresh = await etagOf();
    const racing = await Promise.all([put({ nonBrowserRequests: 'block' }, { 'if-match': fresh }), put({ nonBrowserRequests: 'block' }, { 'if-match': fresh })]);
    assert.deepEqual(racing.map((reply) => reply.status).sort(), [200, 412]);
  });

  it('records settings.securityPolicyUpdated with the before and after, only when the value changes, and no secret', async () => {
    await setPolicy('block');
    const [event] = events('settings.securityPolicyUpdated');
    assert.deepEqual(
      [event!.category, event!.outcome, event!.actor, event!.resource, event!.changes, event!.requestId !== undefined],
      ['security', 'success', { kind: 'user', id: psa(), role: 'PSA' }, { type: 'securityPolicy', id: 'SECURITY_POLICY' }, [{ field: 'nonBrowserRequests', before: 'report', after: 'block' }], true],
    );
    assert.equal((await call(psa(), 'PUT', URL, { nonBrowserRequests: 'block' }, { ...FROM_BROWSER, 'if-match': await etagOf() })).status, 200);
    assert.equal(events('settings.securityPolicyUpdated').length, 1, 'an unchanged policy writes nothing');
    // Saving the other field: its own entry, and the first field is left as it is.
    const second = await call(psa(), 'PUT', URL, { sustainedLimits: 'enforce' }, { ...FROM_BROWSER, 'if-match': await etagOf() });
    assert.deepEqual([second.status, second.body.data.nonBrowserRequests, second.body.data.sustainedLimits, second.body.data.sources], [200, 'block', 'enforce', { nonBrowserRequests: 'database', sustainedLimits: 'database' }]);
    assert.deepEqual(events('settings.securityPolicyUpdated')[1]!.changes, [{ field: 'sustainedLimits', before: 'report', after: 'enforce' }]);
    assert.deepEqual((await settings().findOne({ key: 'SECURITY_POLICY' }))!['value'], { nonBrowserRequests: 'block', sustainedLimits: 'enforce' });
    // Saving the value the default already has pins it to the database (the environment no longer decides it): no change to show, but the source changes.
    const pinned = await call(psa(), 'PUT', URL, { nonBrowserRequests: 'block', sustainedLimits: 'report' }, { ...FROM_BROWSER, 'if-match': await etagOf() });
    assert.equal(pinned.body.data.sustainedLimits, 'report');
  });

  it('turns the block on only from a request that looks like a browser: 409 with a dedicated detail, nothing saved; turning it off needs no browser', async () => {
    const tag = await etagOf();
    const script = await call(psa(), 'PUT', URL, { nonBrowserRequests: 'block' }, { 'if-match': tag });
    assert.deepEqual(failure(script), { status: 409, code: 'CONFLICT', details: [{ field: 'nonBrowserRequests', issue: 'browserRequired' }] });
    assert.equal(await settings().countDocuments({ key: 'SECURITY_POLICY' }), 0);
    assert.equal((await call(psa(), 'PUT', URL, { nonBrowserRequests: 'block' }, { 'if-match': tag, origin: 'https://evil.example' })).status, 409);
    await setPolicy('block');
    const off = await call(psa(), 'PUT', URL, { nonBrowserRequests: 'report' }, { 'if-match': await etagOf() });
    assert.equal(off.status, 200, 'the PSA can turn the block off from anywhere');
  });
});

describe('the block (policy block)', () => {
  const tokensOf = async (actor: ObjectId) => world.office.tokens(userName(actor), FROM_BROWSER);

  it('refuses a user route of a request that does not look like a browser with 403 BROWSER_REQUIRED, before the controller and the body, and lets a browser through', async () => {
    const tokens = await tokensOf(g0().sa);
    await setPolicy('block');
    const blocked = await world.office.call('GET', '/me', tokens.accessToken);
    assert.deepEqual([blocked.status, await blocked.json()], [403, { error: { code: 'BROWSER_REQUIRED', message: 'A browser is required' } }]);
    const bodyless = await world.office.call('POST', `/groups/${g0().groupId.toHexString()}/places`, tokens.accessToken, { not: 'valid' });
    assert.equal(bodyless.status, 403, 'refused before the body is validated');
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken, undefined, FROM_BROWSER)).status, 200);
    const [event] = eventsOf(g0().sa);
    assert.deepEqual([event!.outcome, event!.actor.id, event!.metadata], ['denied', g0().sa, { reason: 'noOrigin', source: 'api', outcome: 'blocked', userAgent: event!.metadata!['userAgent'] }]);
    assert.equal(eventsOf(g0().sa).length, 1, 'once a day per user and reason');
  });

  it('never blocks a PSA (only reports) and never the routes that revoke or change one\'s credentials', async () => {
    const psaTokens = await tokensOf(psa());
    const sa = await tokensOf(g0().sa);
    await setPolicy('block');
    assert.equal((await world.office.call('GET', '/me', psaTokens.accessToken)).status, 200);
    assert.equal(events('request.nonBrowser').filter((entry) => entry.actor.id?.equals(psa())).every((entry) => entry.metadata?.['outcome'] === 'reported'), true);
    assert.equal((await world.office.call('GET', '/me', sa.accessToken)).status, 403);
    // These pass the guard (their own answers: not found, invalid body) instead of 403 BROWSER_REQUIRED.
    assert.equal((await world.office.call('DELETE', `/me/sessions/${new ObjectId().toHexString()}`, sa.accessToken)).status, 404);
    assert.equal((await world.office.call('PUT', '/me/password', sa.accessToken, {})).status, 422);
    assert.equal((await world.office.call('PUT', '/me/pin', sa.accessToken, {})).status, 422);
    assert.equal((await world.office.call('POST', '/auth/logout', sa.accessToken)).status, 204);
    const again = await tokensOf(g0().sa);
    assert.equal((await world.office.call('POST', '/auth/logout-all', again.accessToken)).status, 204);
  });

  it('refuses a login with the right credentials from a non-browser request without creating a session or recording a login, and answers a failed login as ever', async () => {
    await setPolicy('block');
    const sessions = ctx.databases.common().collection('sessions');
    const before = await sessions.countDocuments({ userId: g0().sa });
    const blocked = await world.office.login(userName(g0().sa));
    assert.deepEqual([blocked.status, (await blocked.json()).error], [403, { code: 'BROWSER_REQUIRED', message: 'A browser is required' }]);
    assert.equal(await sessions.countDocuments({ userId: g0().sa }), before, 'no session');
    assert.equal(world.office.activity.entries.filter((entry) => entry.action === 'auth.loginSucceeded').length, 0);
    const [event] = eventsOf(g0().sa);
    assert.deepEqual([event!.outcome, event!.metadata?.['source'], event!.metadata?.['outcome']], ['denied', 'login', 'blocked']);
    // A wrong password is a 401 as it always was (the policy is not an oracle on the passwords), from a browser or not.
    const wrong = await world.office.login(userName(g0().sa), 'not-the-password');
    const wrongFromBrowser = await world.office.login(userName(g0().sa), 'not-the-password', FROM_BROWSER);
    assert.deepEqual([wrong.status, wrongFromBrowser.status, await wrong.json()], [401, 401, (await wrongFromBrowser.json())]);
    // Every refused login is an event of its own (403 BROWSER_REQUIRED at the login means the credentials are valid): three in a day, three events, though request.nonBrowser speaks once.
    await world.office.login(userName(g0().sa));
    await world.office.login(userName(g0().sa));
    const refusals = world.office.activity.entries.filter((entry) => entry.action === 'auth.loginFailed' && entry.metadata?.['reason'] === 'browserRequired');
    assert.deepEqual([refusals.length, refusals[0]!.outcome, refusals[0]!.actor, refusals[0]!.groupId], [3, 'denied', { kind: 'user', id: g0().sa, role: 'SA' }, g0().groupId]);
    assert.equal(eventsOf(g0().sa).length, 1);
    // The same user from a browser logs in; a PSA from a script too (reported).
    assert.equal((await world.office.login(userName(g0().sa), undefined, FROM_BROWSER)).status, 200);
    assert.equal((await world.office.login(userName(psa()))).status, 200);
  });

  it('refuses a refresh from a non-browser request without rotating the token: the browser that holds it can still use it', async () => {
    const tokens = await tokensOf(g0().ca);
    await setPolicy('block');
    const blocked = await world.office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken });
    assert.deepEqual([blocked.status, (await blocked.json()).error.code], [403, 'BROWSER_REQUIRED']);
    const rotatedBefore = await ctx.databases.common().collection('sessions').findOne({ userId: g0().ca });
    assert.equal(rotatedBefore?.['rotatedAt'] ?? null, null);
    const refreshed = await world.office.call('POST', '/auth/refresh', undefined, { refreshToken: tokens.refreshToken }, FROM_BROWSER);
    assert.equal(refreshed.status, 200, 'the same refresh token from the browser still works: nothing was consumed, no reuse was detected');
    assert.equal(world.office.activity.entries.filter((entry) => entry.action === 'auth.refreshReuseDetected').length, 0);
    const next = ((await refreshed.json()) as { data: { accessToken: string } }).data;
    assert.equal((await world.office.call('GET', '/me', next.accessToken, undefined, FROM_BROWSER)).status, 200);
    assert.deepEqual(eventsOf(g0().ca).map((e) => [e.metadata?.['source'], e.metadata?.['outcome']]), [['refresh', 'blocked']]);
    assert.deepEqual(world.office.activity.entries.filter((entry) => entry.action === 'auth.refreshFailed').map((entry) => [entry.outcome, entry.metadata, entry.actor.id]), [['denied', { reason: 'browserRequired' }, g0().ca]]);
  });

  it('blocks a dealer too: only the PSA is never blocked', async () => {
    const dealer = world.office.cluster.dealerA;
    const tokens = await tokensOf(dealer);
    await setPolicy('block');
    const blocked = await world.office.call('GET', '/me', tokens.accessToken);
    assert.deepEqual([blocked.status, (await blocked.json()).error.code], [403, 'BROWSER_REQUIRED']);
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken, undefined, FROM_BROWSER)).status, 200);
  });

  it('never looks at the exchange of an activation code nor at a request with a store key, and an invalid refresh token is a 401 as ever', async () => {
    await setPolicy('block');
    const code = await world.codeFor(world.group(1).ownPlaceId, 1);
    const done = await world.exchange(code);
    assert.equal(done.status, 201);
    assert.equal((await world.asStore(done.body.data.key, 'GET', '/store-context')).status, 200);
    assert.equal((await world.office.call('POST', '/auth/refresh', undefined, { refreshToken: `fc_rt_${'a'.repeat(43)}` })).status, 401);
    assert.deepEqual(events('request.nonBrowser').filter((entry) => entry.actor.kind !== 'user' || !entry.actor.id?.equals(psa())), []);
  });

  it('follows the policy of this instance at once after a write, and the copy of the database after the expiry of the memory', async () => {
    const tokens = await tokensOf(g0().pa);
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken)).status, 200, 'report by default');
    await setPolicy('block');
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken)).status, 403, 'the instance that served the write follows it at once');
    // Another instance would write the database: this one keeps its copy for 30 seconds.
    await settings().updateOne({ key: 'SECURITY_POLICY' }, { $set: { value: { nonBrowserRequests: 'report' } } });
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken)).status, 403);
    world.office.clock.advance(31_000);
    assert.equal((await world.office.call('GET', '/me', tokens.accessToken)).status, 200);
  });
});

describe('the settings service of the security policy on its own', () => {
  it('works without a copy in memory to refresh, refuses the block when the request was not evaluated (the signal is off: it cannot be verified) and answers 412 when somebody wins the race', async () => {
    const repository = createSettingsRepository(ctx.databases);
    const options = { versionKey: Buffer.alloc(32, 5), sustainedDefault: 'report' as const, limits: { perMinute: 1, perHour: 2, perDay: 3 }, now: () => 0 };
    const service = createSettingsService({ repository, activityLog: memoryActivityLog(), ...options });
    const admin = principalOf('PSA');
    const client = { requestId: 'req', ip: null, userAgent: null } as never;
    const first = await service.getSecurityPolicy();
    assert.deepEqual([first.policy.nonBrowserRequests, first.limits], ['report', { perMinute: 1, perHour: 2, perDay: 3 }]);
    await assert.rejects(service.replaceSecurityPolicy(admin, first.version, { nonBrowserRequests: 'block' }, client, undefined), (error: unknown) => error instanceof AppError && error.status === 409);
    const done = await service.replaceSecurityPolicy(admin, first.version, { nonBrowserRequests: 'block' }, client, null);
    assert.equal(done.policy.nonBrowserRequests, 'block');
    const racing = createSettingsService({ repository: { ...repository, replaceSecurityPolicy: async () => false }, activityLog: memoryActivityLog(), ...options });
    await assert.rejects(racing.replaceSecurityPolicy(admin, done.version, { sustainedLimits: 'enforce' }, client, null), (error: unknown) => error instanceof AppError && error.status === 412);
  });
});

describe('the exits and the guard of the block', () => {
  /** Another backoffice, on its own databases, with the given environment. */
  async function another(env: Record<string, string>) {
    const other = await openTestDatabases();
    const w = await startStoreWorld(other, { env: { CORS_ALLOWED_ORIGINS: APP, ...env } });
    return { w, close: async () => { await w.office.close(); await other.cleanup(); }, ctx: other };
  }

  it('does not accept the block while the signal is off (it could not be verified), whatever the request looks like', async () => {
    const { w, close } = await another({ REQUEST_ORIGIN_SIGNAL: 'off' });
    try {
      const tag = (await w.as.call(w.office.cluster.psa, 'GET', URL)).headers.get('etag') as string;
      const reply = await w.as.call(w.office.cluster.psa, 'PUT', URL, { nonBrowserRequests: 'block' }, { ...FROM_BROWSER, 'if-match': tag });
      assert.deepEqual(w.as.failure(reply), { status: 409, code: 'CONFLICT', details: [{ field: 'nonBrowserRequests', issue: 'browserRequired' }] });
      const report = await w.as.call(w.office.cluster.psa, 'PUT', URL, { nonBrowserRequests: 'report', sustainedLimits: 'enforce' }, { 'if-match': tag });
      assert.equal(report.status, 200, 'what needs no browser is still accepted');
    } finally {
      await close();
    }
  });

  it('SECURITY_POLICY_FORCE_REPORT forces both settings to report, says so in the GET (source forced), keeps accepting a write without effect and blocks nobody', async () => {
    const { w, close, ctx: db } = await another({ REQUEST_ORIGIN_SIGNAL: 'on', SECURITY_POLICY_FORCE_REPORT: 'on' });
    try {
      await db.databases.common().collection('settings').insertOne({ key: 'SECURITY_POLICY', value: { nonBrowserRequests: 'block', sustainedLimits: 'enforce' } });
      const got = (await w.as.call(w.office.cluster.psa, 'GET', URL)).body.data;
      assert.deepEqual([got.nonBrowserRequests, got.sustainedLimits, got.sources], ['report', 'report', { nonBrowserRequests: 'forced', sustainedLimits: 'forced' }]);
      const tokens = await w.office.tokens(userName(w.group(0).sa));
      assert.equal((await w.office.call('GET', '/me', tokens.accessToken)).status, 200, 'the block saved in the database is not applied');
      assert.equal((await w.office.login(userName(w.group(0).sa))).status, 200);
      const tag = (await w.as.call(w.office.cluster.psa, 'GET', URL)).headers.get('etag') as string;
      const saved = await w.as.call(w.office.cluster.psa, 'PUT', URL, { sustainedLimits: 'report' }, { ...FROM_BROWSER, 'if-match': tag });
      assert.deepEqual([saved.status, saved.body.data.sustainedLimits, saved.body.data.sources.sustainedLimits], [200, 'report', 'forced']);
      assert.deepEqual((await db.databases.common().collection('settings').findOne({ key: 'SECURITY_POLICY' }))!['value'], { nonBrowserRequests: 'block', sustainedLimits: 'report' }, 'the write is saved, for when the exit is closed');
    } finally {
      await close();
    }
  });
});
