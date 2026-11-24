import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Request, Response } from 'express';
import { cleanUserAgent, createNonBrowserGuard, createNonBrowserSignal, MAX_USER_AGENT_LENGTH, NON_BROWSER_SOURCES, nonBrowserReason, NON_BROWSER_REASONS } from '../../src/shared/security/non-browser-signal.ts';
import { ACTIVITY_ALERT_ACTIONS } from '../../src/shared/activity-log/catalog.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { securityPolicyOf } from '../../src/shared/security/security-policy.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { NonBrowserGuard, NonBrowserSubject } from '../../src/shared/security/non-browser-signal.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';

const APP = 'https://backoffice.example.com';
const allowed = new Set([APP]);
const none = new Set<string>();
const request = (method: string, headers: Record<string, string> = {}) => ({ method, get: (name: string) => headers[name.toLowerCase()], ip: '203.0.113.9' }) as unknown as Request;

describe('the rule of the signal (nonBrowserReason)', () => {
  const cases: Array<[string, string, Record<string, string>, ReadonlySet<string>, string | null]> = [
    // A browser of the backoffice: cross-origin calls always carry the Origin.
    ['SPA, GET, Origin allowed, fetch metadata cross-site', 'GET', { origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, allowed, null],
    ['SPA, POST, Origin allowed, same-site', 'POST', { origin: APP, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' }, allowed, null],
    ['an old browser: valid Origin, no fetch metadata at all', 'GET', { origin: APP }, allowed, null],
    ['only Sec-Fetch-Mode, valid', 'GET', { origin: APP, 'sec-fetch-mode': 'cors' }, allowed, null],
    // Another program: no Origin.
    ['no headers at all, GET, an origin is allowed', 'GET', {}, allowed, 'noOrigin'],
    ['no headers at all, POST', 'POST', {}, allowed, 'noOrigin'],
    ['no headers at all, POST, no origin allowed', 'POST', {}, none, 'noOrigin'],
    ['fetch metadata cross-site without Origin', 'GET', { 'sec-fetch-site': 'cross-site' }, allowed, 'noOrigin'],
    ['same-origin POST without Origin (a browser sends it)', 'POST', { 'sec-fetch-site': 'same-origin' }, none, 'noOrigin'],
    ['an invalid Sec-Fetch-Site without Origin', 'GET', { 'sec-fetch-site': 'sideways' }, allowed, 'inconsistentFetchMetadata'],
    ['a navigation (none) without Origin on GET', 'GET', { 'sec-fetch-site': 'none' }, allowed, 'noOrigin'],
    // Same-origin deployment: the browser sends no Origin on GET and HEAD.
    ['same-origin GET without Origin', 'GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' }, allowed, null],
    ['same-origin HEAD without Origin', 'HEAD', { 'sec-fetch-site': 'same-origin' }, none, null],
    ['same-origin GET, download as a blob, same-origin mode', 'GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' }, none, null],
    ['same-origin POST, Origin of the API itself, not in the list', 'POST', { origin: 'https://api.example.com', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'same-origin' }, none, null],
    ['no Origin and no fetch metadata on GET when no origin is allowed (same-origin deployment, old browser)', 'GET', {}, none, null],
    // A foreign origin.
    ['Origin of another site', 'GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, allowed, 'foreignOrigin'],
    ['Origin null', 'POST', { origin: 'null' }, allowed, 'foreignOrigin'],
    ['Origin that differs by one character (exact comparison)', 'GET', { origin: `${APP}/` }, allowed, 'foreignOrigin'],
    ['Origin present, nothing allowed, not said to be same-origin', 'GET', { origin: 'https://api.example.com' }, none, 'foreignOrigin'],
    // Inconsistent fetch metadata.
    ['valid Origin, Sec-Fetch-Site none (a navigation)', 'GET', { origin: APP, 'sec-fetch-site': 'none' }, allowed, 'inconsistentFetchMetadata'],
    ['valid Origin, invalid Sec-Fetch-Site', 'GET', { origin: APP, 'sec-fetch-site': 'sideways' }, allowed, 'inconsistentFetchMetadata'],
    ['valid Origin, mode navigate', 'GET', { origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }, allowed, 'inconsistentFetchMetadata'],
    ['valid Origin, mode no-cors', 'GET', { origin: APP, 'sec-fetch-mode': 'no-cors' }, allowed, 'inconsistentFetchMetadata'],
    ['same-origin GET with mode navigate', 'GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }, allowed, 'inconsistentFetchMetadata'],
  ];
  for (const [name, method, headers, origins, expected] of cases) {
    it(name, () => assert.equal(nonBrowserReason(request(method, headers), origins), expected));
  }

  it('has a closed set of reasons', () => {
    assert.deepEqual([...NON_BROWSER_REASONS], ['noOrigin', 'foreignOrigin', 'inconsistentFetchMetadata']);
    assert.ok(ACTIVITY_ALERT_ACTIONS.includes('request.nonBrowser'));
  });
});

describe('cleanUserAgent', () => {
  it('keeps printable ASCII, drops the rest, trims and cuts at 120 characters; nothing left is null', () => {
    assert.equal(cleanUserAgent('curl/8.4.0'), 'curl/8.4.0');
    assert.equal(cleanUserAgent('  python-requests/2.31 \u0000\r\n‮é x '), 'python-requests/2.31  x');
    assert.equal(cleanUserAgent('a'.repeat(300))?.length, MAX_USER_AGENT_LENGTH);
    assert.equal(cleanUserAgent(`${'a'.repeat(119)} bbb`), 'a'.repeat(119));
    assert.deepEqual([cleanUserAgent(undefined), cleanUserAgent(''), cleanUserAgent('\u0001ÿ  '), cleanUserAgent('   ')], [null, null, null, null]);
  });
});

describe('the guard', () => {
  const userId = new ObjectId();
  const groupId = new ObjectId();
  const subjectOf = (role: 'SA' | 'PSA' = 'SA') => ({ userId, actor: { kind: 'user' as const, id: userId, role }, groupId });
  const make = (mode: 'report' | 'block' = 'report', limiter: Pick<RateLimiter, 'consume'> = memoryRateLimiter(), origins: readonly string[] = [APP]) => {
    const activityLog = memoryActivityLog();
    const logs = memoryLogger();
    const policy = { get: () => Promise.resolve(securityPolicyOf({ nonBrowserRequests: mode }, 'report')) };
    const guard = createNonBrowserGuard({ activityLog, rateLimiter: limiter, logger: logs.logger, allowedOrigins: origins, policy });
    return { activityLog, logs, limiter, guard };
  };
  const run = async (guard: NonBrowserGuard, headers: Record<string, string>, subject: NonBrowserSubject = subjectOf(), source: 'login' | 'refresh' | 'api' = 'api', options?: { neverBlock?: boolean }, method = 'GET') => {
    const res = { locals: { requestId: 'req-1' } } as unknown as Response;
    try {
      await guard(request(method, headers), res, subject, source, options);
      return { blocked: false, res };
    } catch (error) {
      assert.ok(error instanceof AppError && error.code === 'BROWSER_REQUIRED' && error.status === 403 && error.details === undefined);
      return { blocked: true, res };
    }
  };

  it('does nothing and writes nothing for the request of a browser, and says so in the locals', async () => {
    const { guard, activityLog, limiter } = make('block');
    const { res, blocked } = await run(guard, { origin: APP, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
    assert.deepEqual([blocked, res.locals.nonBrowserReason, activityLog.entries.length, (limiter as ReturnType<typeof memoryRateLimiter>).calls.length], [false, null, 0, 0]);
  });

  it('reports under the policy report: one event a day per user and reason, with the source, the outcome reported and the cleaned User-Agent', async () => {
    assert.deepEqual([...NON_BROWSER_SOURCES], ['login', 'refresh', 'api']);
    const { guard, activityLog, limiter } = make();
    for (let i = 0; i < 3; i += 1) {
      const { blocked, res } = await run(guard, { 'user-agent': 'my-script/1.0 \u0007\u00e9' });
      assert.deepEqual([blocked, res.locals.nonBrowserReason], [false, 'noOrigin']);
    }
    assert.equal(activityLog.entries.length, 1);
    const [entry] = activityLog.entries;
    assert.deepEqual(
      [entry!.category, entry!.action, entry!.outcome, entry!.actor, entry!.groupId, entry!.requestId, entry!.ip, entry!.metadata],
      ['security', 'request.nonBrowser', 'success', { kind: 'user', id: userId, role: 'SA' }, groupId, 'req-1', '203.0.113.9', { reason: 'noOrigin', source: 'api', outcome: 'reported', userAgent: 'my-script/1.0' }],
    );
    await run(guard, { origin: 'https://evil.example' }, subjectOf(), 'refresh');
    await run(guard, {}, { userId: new ObjectId(), actor: { kind: 'user' } }, 'login');
    assert.deepEqual(activityLog.entries.map((e) => [e.metadata?.['reason'], e.metadata?.['source']]), [['noOrigin', 'api'], ['foreignOrigin', 'refresh'], ['noOrigin', 'login']]);
    assert.equal('groupId' in activityLog.entries[2]!, false);
    assert.deepEqual((limiter as ReturnType<typeof memoryRateLimiter>).calls[0], { bucket: 'non-browser:user', key: `${userId.toHexString()}:noOrigin`, limit: 1 });
    const noAddress = { method: 'POST', get: () => undefined } as unknown as Request;
    await guard(noAddress, { locals: {} } as unknown as Response, { userId: new ObjectId(), actor: { kind: 'user' } }, 'api');
    assert.equal('ip' in activityLog.entries[3]!, false, 'no address, none recorded');
  });

  it('blocks under the policy block with 403 BROWSER_REQUIRED and no detail, recording request.nonBrowser once a day and, for a login or a refresh, EVERY refusal as a security event outside that ceiling', async () => {
    const { guard, activityLog } = make('block');
    const results = [await run(guard, {}, subjectOf(), 'login'), await run(guard, {}, subjectOf(), 'login'), await run(guard, {}, subjectOf(), 'login'), await run(guard, {}, subjectOf(), 'refresh'), await run(guard, {}, subjectOf(), 'api')];
    assert.ok(results.every((result) => result.blocked));
    const byAction = (action: string) => activityLog.entries.filter((entry) => entry.action === action);
    assert.equal(byAction('auth.loginFailed').length, 3, 'three blocked logins in a day: three events');
    assert.equal(byAction('auth.refreshFailed').length, 1);
    assert.equal(byAction('request.nonBrowser').length, 1, 'the signal itself speaks once a day per user and reason');
    const [refused] = byAction('auth.loginFailed');
    assert.deepEqual([refused!.category, refused!.outcome, refused!.actor, refused!.groupId, refused!.metadata, refused!.requestId, refused!.ip], ['security', 'denied', { kind: 'user', id: userId, role: 'SA' }, groupId, { reason: 'browserRequired' }, 'req-1', '203.0.113.9']);
    assert.deepEqual([byAction('request.nonBrowser')[0]!.outcome, byAction('request.nonBrowser')[0]!.metadata?.['outcome'], byAction('request.nonBrowser')[0]!.metadata?.['source']], ['denied', 'blocked', 'login']);
    assert.equal('groupId' in byAction('auth.refreshFailed')[0]!, true);
    const noGroup = await run(guard, {}, { userId: new ObjectId(), actor: { kind: 'user' } }, 'refresh');
    assert.equal(noGroup.blocked, true);
    assert.equal('groupId' in byAction('auth.refreshFailed')[1]!, false);
    const noAddress = { method: 'POST', get: () => undefined } as unknown as Request;
    await assert.rejects(guard(noAddress, { locals: {} } as unknown as Response, { userId: new ObjectId(), actor: { kind: 'user' } }, 'login'), { code: 'BROWSER_REQUIRED' });
    assert.equal('ip' in byAction('auth.loginFailed')[3]!, false);
  });

  it('writes at most 10 events of refused refreshes an hour per user, the refusal stays, and writes anyway when that counter fails; the login has no such ceiling', async () => {
    const { guard, activityLog } = make('block');
    const refused = [];
    for (let i = 0; i < 13; i += 1) {
      refused.push((await run(guard, {}, subjectOf(), 'refresh')).blocked);
    }
    assert.ok(refused.every(Boolean), 'every refresh is refused');
    assert.equal(activityLog.entries.filter((entry) => entry.action === 'auth.refreshFailed').length, 10);
    const other = await run(guard, {}, { userId: new ObjectId(), actor: { kind: 'user' } }, 'refresh');
    assert.equal(other.blocked, true);
    assert.equal(activityLog.entries.filter((entry) => entry.action === 'auth.refreshFailed').length, 11, 'another user has his own count');
    for (let i = 0; i < 13; i += 1) {
      await run(guard, {}, subjectOf(), 'login');
    }
    assert.equal(activityLog.entries.filter((entry) => entry.action === 'auth.loginFailed').length, 13, 'every refused login is an event');
    const failing = make('block', { consume: (bucket: string) => (bucket === 'non-browser-refresh:user' ? Promise.reject(new Error('down')) : Promise.resolve({ allowed: true, limit: 1, remaining: 0, resetSeconds: 1, firstExcess: false })) });
    assert.equal((await run(failing.guard, {}, subjectOf(), 'refresh')).blocked, true);
    assert.equal(failing.activityLog.entries.filter((entry) => entry.action === 'auth.refreshFailed').length, 1);
    assert.equal(failing.logs.events.length, 1);
    const odd = make('block', { consume: (bucket: string) => (bucket === 'non-browser-refresh:user' ? Promise.reject('plain') : Promise.resolve({ allowed: true, limit: 1, remaining: 0, resetSeconds: 1, firstExcess: false })) });
    await run(odd.guard, {}, subjectOf(), 'refresh');
    assert.equal(odd.logs.events[0]?.['errorName'], 'unknown');
  });

  it('blocks a dealer too: only the PSA is never blocked', async () => {
    const { guard } = make('block');
    const dealer = { userId, actor: { kind: 'user' as const, id: userId, role: 'D' as const }, groupId };
    assert.equal((await run(guard, {}, dealer)).blocked, true);
  });

  it('never blocks a PSA or a never-block route, which are only reported', async () => {
    const { guard, activityLog } = make('block');
    assert.equal((await run(guard, {}, subjectOf('PSA'))).blocked, false);
    assert.equal((await run(guard, { origin: 'https://evil.example' }, subjectOf(), 'api', { neverBlock: true })).blocked, false);
    assert.deepEqual(activityLog.entries.map((e) => [e.outcome, e.metadata?.['outcome']]), [['success', 'reported'], ['success', 'reported']]);
  });

  it('still blocks when the counter fails (the event is lost, logged) and never refuses for a fault of the counter under report', async () => {
    const failing = make('block', { consume: () => Promise.reject(new Error('mongo down')) });
    assert.equal((await run(failing.guard, {})).blocked, true);
    assert.equal(failing.activityLog.entries.length, 0);
    assert.deepEqual(failing.logs.events.map((e) => [e['level'], e['msg'], e['errorName']]), [['error', 'non-browser signal failed', 'Error']]);
    const reporting = make('report', { consume: () => Promise.reject('plain string') });
    assert.equal((await run(reporting.guard, {})).blocked, false);
    assert.equal(reporting.logs.events[0]?.['errorName'], 'unknown');
  });
});

describe('the middleware', () => {
  it('runs the guard for the authenticated user only, with the exemption of the route', async () => {
    const calls: Array<[unknown, string, unknown]> = [];
    const factory = createNonBrowserSignal(async (_req, _res, subject, source, options) => void calls.push([subject.userId, source, options]));
    const userId = new ObjectId();
    const groupId = new ObjectId();
    let passed = 0;
    await factory(true)(request('GET'), { locals: { auth: { userId, role: 'SA', groupId } } } as unknown as Response, () => void (passed += 1));
    await factory(false)(request('GET'), { locals: { auth: { userId, role: 'SA', groupId: null } } } as unknown as Response, () => void (passed += 1));
    await factory(false)(request('GET'), { locals: { store: { keyId: userId } } } as unknown as Response, () => void (passed += 1));
    await factory(false)(request('GET'), { locals: {} } as unknown as Response, () => void (passed += 1));
    assert.equal(passed, 4);
    assert.deepEqual(calls, [[userId, 'api', { neverBlock: true }], [userId, 'api', { neverBlock: false }]]);
  });
});
