import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { ActivityEntry } from '../../src/shared/activity-log/activity-log.ts';
import { createAuthenticateApiKey, LAST_USED_RESOLUTION_MS, PUBLIC_GROUP_BUCKET, PUBLIC_GROUP_QUOTA_BUCKET, PUBLIC_KEY_BUCKET, PUBLIC_QUOTA_BUCKET, QUOTA_WINDOW_SECONDS } from '../../src/modules/api-keys/authenticate-api-key.ts';
import type { UsageEvent } from '../../src/modules/api-keys/usage-meter.ts';
import type { ApiKey, PublicGroupState } from '../../src/modules/api-keys/api-keys.types.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { RateLimitDecision } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import type { ApiKeyPrincipal } from '../../src/shared/security/scope/principal.ts';
import { memoryLogger } from '../helpers/app.ts';

const SECRET = `fc_pk_${'k'.repeat(43)}`; // gitleaks:allow (fake test value)
const HASH = createHash('sha256').update(SECRET).digest('hex');
const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const KEY_ID = new ObjectId('0a0000000000000000000001');
const GROUP_ID = new ObjectId('020000000000000000000001');
const COMPANY = new ObjectId('030000000000000000000001');

const storedKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: KEY_ID,
  groupId: GROUP_ID,
  name: 'Webshop',
  prefix: SECRET.slice(0, 12),
  hash: HASH,
  permissions: ['places:read'],
  restrictions: { companyIds: [COMPANY], placeIds: null },
  rateLimitPerMinute: 60,
  dailyQuota: 1000,
  expiresAt: null,
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  createdAt: new Date(NOW - 86_400_000),
  createdBy: { userId: new ObjectId('010000000000000000000002'), role: 'PSA' },
  lastUsedAt: null,
  ...overrides,
});

const GROUP_STATE: PublicGroupState = { name: 'Group One', usable: true, groupRateLimitPerMinute: 120, groupDailyQuota: 20_000 };
const decision = (overrides: Partial<RateLimitDecision> = {}): RateLimitDecision => ({ allowed: true, limit: 60, remaining: 59, resetSeconds: 30, firstExcess: false, ...overrides });

/** The authentication over fakes, with what it did. */
function harness(options: { key?: ApiKey | null; group?: PublicGroupState | null; decisions?: RateLimitDecision[]; exhausted?: boolean; touch?: () => Promise<void> } = {}) {
  const touches: Array<{ keyId: ObjectId; at: Date; olderThan: Date }> = [];
  const consumed: Array<{ bucket: string; key: string; limit: number; window: number | undefined }> = [];
  const entries: ActivityEntry[] = [];
  const events: UsageEvent[] = [];
  const logs = memoryLogger();
  const decisions = [...(options.decisions ?? [])];
  const exhaustedQuota = options.exhausted === true;
  const handler = createAuthenticateApiKey({
    repository: {
      findByHash: () => Promise.resolve(options.key === undefined ? storedKey() : options.key),
      groupState: () => Promise.resolve(options.group === undefined ? GROUP_STATE : options.group),
      touch: (keyId, at, olderThan) => {
        touches.push({ keyId, at, olderThan });
        return options.touch === undefined ? Promise.resolve() : options.touch();
      },
    },
    rateLimiter: {
      peek: (bucket) => Promise.resolve(decision({ allowed: !(exhaustedQuota && bucket === PUBLIC_QUOTA_BUCKET) })),
      consume: (bucket, key, limit, window) => {
        consumed.push({ bucket, key, limit, window });
        return Promise.resolve(decisions.shift() ?? decision());
      },
    },
    activityLog: { record: (entry) => (entries.push(entry), Promise.resolve()) },
    logger: logs.logger,
    meter: { record: (event: UsageEvent) => void events.push(event) },
    now: () => NOW,
  });
  const run = async (headers: Record<string, string | undefined> = { 'x-api-key': SECRET }, request: { method?: string; ip?: string | undefined } = {}) => {
    const finish: Array<[string, () => void]> = [];
    const set: Array<Record<string, string>> = [];
    const res = {
      statusCode: 200,
      locals: { requestId: 'req-1', routePattern: '/public/v1/places' } as Record<string, unknown>,
      set: (values: Record<string, string>) => void set.push(values),
      writableFinished: true,
      once: (event: string, listener: () => void) => void finish.push([event, listener]),
    };
    const req = { get: (name: string) => headers[name.toLowerCase()], method: request.method ?? 'GET', ip: 'ip' in request ? request.ip : '203.0.113.7', headers: {} };
    let passed = false;
    let error: unknown;
    try {
      await handler(req as never, res as never, () => void (passed = true));
    } catch (thrown) {
      error = thrown;
    }
    return { passed, error, res, set, finish: (only?: string) => finish.filter(([event]) => only === undefined || event === only).forEach(([, listener]) => listener()) };
  };
  return { run, touches, consumed, entries, events, logs };
}

const unauthenticated = (error: unknown): boolean => error instanceof AppError && error.code === 'UNAUTHENTICATED' && error.message === 'Authentication required' && error.details === undefined;

describe('the authentication of an API key (units)', () => {
  it('lets a valid key in with a frozen principal that has the key, the group and the limits', async () => {
    const h = harness();
    const done = await h.run();
    assert.equal(done.passed, true);
    const principal = done.res.locals['apiKey'] as ApiKeyPrincipal;
    assert.deepEqual(
      [principal.kind, principal.keyId, principal.groupId, principal.groupName, principal.name, principal.prefix, [...principal.permissions], principal.rateLimitPerMinute, principal.dailyQuota, principal.expiresAt],
      ['apiKey', KEY_ID, GROUP_ID, 'Group One', 'Webshop', SECRET.slice(0, 12), ['places:read'], 60, 1000, null],
    );
    assert.deepEqual([principal.restrictions.companyIds, principal.restrictions.placeIds], [[COMPANY], null]);
    assert.ok(Object.isFrozen(principal) && Object.isFrozen(principal.restrictions) && Object.isFrozen(principal.restrictions.companyIds));
    assert.equal(principal.permissions.has('companies:read' as never), false);
    assert.deepEqual(done.set, [{ 'RateLimit-Limit': '60', 'RateLimit-Remaining': '59', 'RateLimit-Reset': '30' }]);
    assert.deepEqual([principal.groupRateLimitPerMinute, principal.groupDailyQuota], [120, 20_000]);
    assert.deepEqual(h.consumed, [
      { bucket: PUBLIC_KEY_BUCKET, key: KEY_ID.toHexString(), limit: 60, window: undefined },
      { bucket: PUBLIC_GROUP_BUCKET, key: GROUP_ID.toHexString(), limit: 120, window: undefined },
      { bucket: PUBLIC_QUOTA_BUCKET, key: KEY_ID.toHexString(), limit: 1000, window: QUOTA_WINDOW_SECONDS },
      { bucket: PUBLIC_GROUP_QUOTA_BUCKET, key: GROUP_ID.toHexString(), limit: 20_000, window: QUOTA_WINDOW_SECONDS },
    ]);
  });

  it('shows the restrictions of both kinds and the expiry in the principal', async () => {
    const place = new ObjectId('040000000000000000000001');
    const h = harness({ key: storedKey({ restrictions: { companyIds: null, placeIds: [place] }, expiresAt: new Date(NOW + 1) }) });
    const principal = (await h.run()).res.locals['apiKey'] as ApiKeyPrincipal;
    assert.deepEqual([principal.restrictions.companyIds, principal.restrictions.placeIds, principal.expiresAt], [null, [place], new Date(NOW + 1)]);
  });

  it('refuses with the same generic 401 whatever the reason, and counts nothing', async () => {
    const cases: Array<[string, ReturnType<typeof harness>, Record<string, string | undefined>?]> = [
      ['no header', harness(), {}],
      ['bad format', harness(), { 'x-api-key': 'fc_pk_short' }],
      ['another prefix', harness(), { 'x-api-key': SECRET.replace('fc_pk_', 'fc_sk_') }],
      ['unknown', harness({ key: null })],
      ['a stored hash that is not the one asked for', harness({ key: storedKey({ hash: 'f'.repeat(64) }) })],
      ['revoked', harness({ key: storedKey({ status: 'revoked' }) })],
      ['expired at this very instant', harness({ key: storedKey({ expiresAt: new Date(NOW) }) })],
      ['expired', harness({ key: storedKey({ expiresAt: new Date(NOW - 1) }) })],
      ['no group', harness({ group: null })],
      ['group not usable', harness({ group: { ...GROUP_STATE, usable: false } })],
    ];
    for (const [reason, h, headers] of cases) {
      const done = await h.run(headers ?? { 'x-api-key': SECRET });
      assert.equal(unauthenticated(done.error), true, reason);
      assert.equal(done.passed, false, reason);
      assert.deepEqual([h.consumed, h.touches, done.set, done.res.locals['apiKey']], [[], [], [], undefined], reason);
      done.finish();
      assert.deepEqual(h.events, [], reason);
    }
  });

  it('counts the request when it finishes, under the route of the router, a HEAD as the GET it answers', async () => {
    const h = harness();
    const done = await h.run();
    assert.deepEqual(h.events, []);
    done.res.statusCode = 404;
    done.finish();
    const head = await h.run({ 'x-api-key': SECRET }, { method: 'HEAD' });
    head.finish();
    assert.deepEqual(
      h.events.map((event: UsageEvent) => [event.keyId, event.groupId, event.day, event.route, event.status]),
      [[KEY_ID, GROUP_ID, '2026-11-17', 'GET /public/v1/places', 404], [KEY_ID, GROUP_ID, '2026-11-17', 'GET /public/v1/places', 200]],
    );
  });

  it('answers 429 RATE_LIMITED over the per-minute limit, with Retry-After and the headers, and records the first excess only; the request is still counted', async () => {
    const h = harness({ decisions: [decision({ allowed: false, remaining: 0, resetSeconds: 17, firstExcess: true }), decision({ allowed: false, remaining: 0, resetSeconds: 16 })] });
    const first = await h.run();
    assert.ok(first.error instanceof AppError && first.error.code === 'RATE_LIMITED' && first.error.headers['Retry-After'] === '17');
    assert.deepEqual(first.set, [{ 'RateLimit-Limit': '60', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '17' }]);
    first.res.statusCode = 429;
    first.finish();
    const second = await h.run();
    assert.ok(second.error instanceof AppError && second.error.headers['Retry-After'] === '16');
    assert.deepEqual(h.entries.map((entry) => [entry.action, entry.category, entry.outcome, entry.actor, entry.groupId, entry.resource, entry.requestId, entry.ip, entry.metadata]), [
      ['rateLimit.exceeded', 'security', 'denied', { kind: 'apiKey', id: KEY_ID }, GROUP_ID, { type: 'apiKey', id: KEY_ID.toHexString() }, 'req-1', '203.0.113.7', { bucket: PUBLIC_KEY_BUCKET }],
    ]);
    assert.deepEqual(h.consumed.map((call) => call.bucket), [PUBLIC_KEY_BUCKET, PUBLIC_KEY_BUCKET], 'the quota is not touched by a request the minute refused');
    assert.deepEqual(h.touches, []);
    assert.deepEqual(h.events.map((event) => event.status), [429]);
  });

  it('answers 429 QUOTA_EXCEEDED over the daily quota, with Retry-After until the end of the day, records the first excess once and leaves the client address out when there is none', async () => {
    const h = harness({ decisions: [decision(), decision(), decision({ allowed: false, remaining: 0, resetSeconds: 3600, firstExcess: true }), decision(), decision(), decision({ allowed: false, remaining: 0, resetSeconds: 3599 })] });
    const first = await h.run({ 'x-api-key': SECRET }, { ip: undefined });
    assert.ok(first.error instanceof AppError && first.error.code === 'QUOTA_EXCEEDED' && first.error.status === 429 && first.error.message === 'Quota exceeded' && first.error.headers['Retry-After'] === '3600');
    const second = await h.run();
    assert.ok(second.error instanceof AppError && second.error.headers['Retry-After'] === '3599');
    assert.deepEqual(h.entries.map((entry) => [entry.metadata, 'ip' in entry]), [[{ bucket: PUBLIC_QUOTA_BUCKET }, false]]);
    assert.deepEqual(h.touches, []);
  });

  it('shows the headers of the tighter of the two minute limits, the one of the group when it has fewer requests left', async () => {
    const h = harness({ decisions: [decision({ limit: 60, remaining: 50 }), decision({ limit: 120, remaining: 10 })] });
    const done = await h.run();
    assert.deepEqual(done.set, [{ 'RateLimit-Limit': '120', 'RateLimit-Remaining': '10', 'RateLimit-Reset': '30' }]);
  });

  it('answers 429 RATE_LIMITED over the per-minute cap of the group, with its headers, records the first excess with the key as actor, and consumes no daily quota', async () => {
    const h = harness({ decisions: [decision(), decision({ allowed: false, limit: 120, remaining: 0, resetSeconds: 9, firstExcess: true }), decision(), decision({ allowed: false, limit: 120, remaining: 0, resetSeconds: 8 })] });
    const first = await h.run();
    assert.ok(first.error instanceof AppError && first.error.code === 'RATE_LIMITED' && first.error.headers['Retry-After'] === '9');
    assert.deepEqual(first.set, [{ 'RateLimit-Limit': '120', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '9' }]);
    const second = await h.run();
    assert.ok(second.error instanceof AppError && second.error.code === 'RATE_LIMITED');
    assert.deepEqual(h.entries.map((entry) => entry.metadata), [{ bucket: PUBLIC_GROUP_BUCKET }]);
    assert.deepEqual(h.consumed.map((call) => call.bucket), [PUBLIC_KEY_BUCKET, PUBLIC_GROUP_BUCKET, PUBLIC_KEY_BUCKET, PUBLIC_GROUP_BUCKET]);
  });

  it('refuses a key that has used up its daily quota before the counters of the group, and records the first excess once', async () => {
    const h = harness({ exhausted: true, decisions: [decision(), decision({ allowed: false, remaining: 0, resetSeconds: 5000, firstExcess: true }), decision(), decision({ allowed: false, remaining: 0, resetSeconds: 4999 })] });
    const first = await h.run();
    assert.ok(first.error instanceof AppError && first.error.code === 'QUOTA_EXCEEDED' && first.error.headers['Retry-After'] === '5000');
    assert.deepEqual(first.set, []);
    await h.run();
    assert.deepEqual(h.consumed.map((call) => call.bucket), [PUBLIC_KEY_BUCKET, PUBLIC_QUOTA_BUCKET, PUBLIC_KEY_BUCKET, PUBLIC_QUOTA_BUCKET], 'the group is never touched');
    assert.deepEqual(h.entries.map((entry) => entry.metadata), [{ bucket: PUBLIC_QUOTA_BUCKET }]);
  });

  it('answers 429 QUOTA_EXCEEDED over the daily cap of the group, without any RateLimit header, once the quota of the key has passed', async () => {
    const h = harness({ decisions: [decision(), decision(), decision(), decision({ allowed: false, remaining: 0, resetSeconds: 7200, firstExcess: true }), decision(), decision(), decision(), decision({ allowed: false, remaining: 0, resetSeconds: 7199 })] });
    const first = await h.run();
    assert.ok(first.error instanceof AppError && first.error.code === 'QUOTA_EXCEEDED' && first.error.headers['Retry-After'] === '7200');
    assert.deepEqual(first.set, [], 'no per-minute header on a refusal for the daily quota');
    await h.run();
    assert.deepEqual(h.entries.map((entry) => entry.metadata), [{ bucket: PUBLIC_GROUP_QUOTA_BUCKET }]);
    assert.deepEqual(h.consumed.slice(0, 4).map((call) => call.bucket), [PUBLIC_KEY_BUCKET, PUBLIC_GROUP_BUCKET, PUBLIC_QUOTA_BUCKET, PUBLIC_GROUP_QUOTA_BUCKET]);
  });

  it('counts an aborted request once, as aborted, and a finished one once even if the connection closes after', async () => {
    const h = harness();
    const aborted = await h.run();
    (aborted.res as { writableFinished: boolean }).writableFinished = false;
    aborted.res.statusCode = 200;
    aborted.finish('close');
    const finished = await h.run();
    finished.finish();
    assert.deepEqual(h.events.map((event) => [event.aborted, event.status]), [[true, 200], [false, 200]]);
  });

  it('refreshes lastUsedAt when the key was never used or last used a minute ago, and not before', async () => {
    const never = harness();
    await never.run();
    assert.deepEqual(never.touches, [{ keyId: KEY_ID, at: new Date(NOW), olderThan: new Date(NOW - LAST_USED_RESOLUTION_MS) }]);
    const stale = harness({ key: storedKey({ lastUsedAt: new Date(NOW - LAST_USED_RESOLUTION_MS) }) });
    await stale.run();
    assert.equal(stale.touches.length, 1);
    const fresh = harness({ key: storedKey({ lastUsedAt: new Date(NOW - LAST_USED_RESOLUTION_MS + 1) }) });
    await fresh.run();
    assert.deepEqual(fresh.touches, []);
  });

  it('logs by the name of the error a refresh of lastUsedAt that fails, and answers the request all the same', async () => {
    for (const [failure, name] of [[new TypeError('boom'), 'TypeError'], ['text', 'string']] as const) {
      const h = harness({ touch: () => Promise.reject(failure) });
      const done = await h.run();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(done.passed, true);
      assert.deepEqual(h.logs.events.map((entry) => [entry['msg'], entry['errorName']]), [['updating the last use of a public API key failed', name]]);
      assert.ok(!JSON.stringify(h.logs.events).includes('boom'));
    }
  });
});
