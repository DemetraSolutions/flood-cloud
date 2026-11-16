import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ObjectId } from 'mongodb';
import { defineRoute, mountRoutes } from '../../src/shared/http/routes.ts';
import { rateLimit } from '../../src/shared/security/rate-limit/rate-limit.ts';
import type { RateLimitRule } from '../../src/shared/security/rate-limit/rate-limit.ts';
import type { RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { memoryRateLimitMount, memoryRateLimiter } from '../helpers/activity.ts';
import { testConfig } from '../helpers/app.ts';

const rules = createRateLimitRules(testConfig());

describe('createRateLimitRules', () => {
  it('builds the fifteen rules from the thresholds', () => {
    assert.deepEqual(
      Object.values(rules).map(({ bucket, limit }) => [bucket, limit]),
      [['login:username', 5], ['login:ip', 15], ['auth-fail:ip', 300], ['refresh:ip', 30], ['usernameCheck:user', 15], ['user-credentials:user', 20], ['password-change:user', 5], ['client-errors:user', 30], ['media-upload:user', 30], ['media-upload-day:user', 300], ['media-upload-day:group', 2000], ['api:user', 300], ['api:store', 600], ['storeActivation:ip', 10], ['storeKeyAdmin:user', 20]],
    );
    const custom = createRateLimitRules(testConfig({ RATE_LIMIT_LOGIN_PER_USERNAME: '7', RATE_LIMIT_API_PER_USER: '9', RATE_LIMIT_MEDIA_UPLOAD_PER_USER: '4', RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY: '8', RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY: '9' }));
    assert.deepEqual([custom.loginPerUsername.limit, custom.apiPerUser.limit, custom.mediaUploadPerUser.limit], [7, 9, 4]);
    assert.deepEqual([custom.mediaUploadPerUserDaily.limit, custom.mediaUploadPerGroupDaily.limit, custom.mediaUploadPerUserDaily.windowSeconds, custom.mediaUploadPerGroupDaily.windowSeconds], [8, 9, 86400, 86400]);
    assert.equal(rules.mediaUploadPerGroupDaily.needsGroup, true);
    const res = (groupAccess?: { groupId: { toHexString(): string } }) => ({ locals: { groupAccess } }) as never;
    assert.equal(rules.mediaUploadPerGroupDaily.key({} as never, res({ groupId: { toHexString: () => 'abc' } })), 'abc');
    assert.equal(rules.mediaUploadPerGroupDaily.key({} as never, res()), null);
    assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules.apiPerUser));
    const tuned = createRateLimitRules(testConfig({ RATE_LIMIT_API_PER_STORE: '11', RATE_LIMIT_STORE_ACTIVATION_PER_IP: '3', RATE_LIMIT_STORE_KEY_ADMIN_PER_USER: '4' }));
    assert.deepEqual([tuned.apiPerStore.limit, tuned.storeActivationPerIp.limit, tuned.storeKeyAdminPerUser.limit], [11, 3, 4]);
  });

  it('counts a store per its key and never per a user: the rule of a store has no subject outside a store principal', () => {
    const store = { locals: { store: { keyId: new ObjectId('0123456789abcdef01234567') } } } as never;
    const user = { locals: { auth: { userId: new ObjectId('0123456789abcdef01234567') } } } as never;
    assert.equal(rules.apiPerStore.key({} as never, store), '0123456789abcdef01234567');
    assert.equal(rules.apiPerStore.key({} as never, user), null, 'a user is not counted by the rule of the stores');
    assert.equal(rules.apiPerUser.key({} as never, store), null, 'a store is not counted by the per-user rule: the route builder must mount its own');
    assert.equal(rules.storeActivationPerIp.key({ ip: '203.0.113.9' } as never, { locals: {} } as never), '203.0.113.9');
    assert.equal(rules.storeKeyAdminPerUser.key({} as never, user), '0123456789abcdef01234567');
  });

  it('keys by normalized username, IP and user id', () => {
    const res = { locals: { auth: { userId: new ObjectId('0123456789abcdef01234567') } } } as never;
    const empty = { locals: {} } as never;
    const body = (username: unknown, hasBody = true) => ({ body: hasBody ? { username } : undefined }) as never;
    assert.equal(rules.loginPerUsername.key(body('  MaRio '), empty), 'mario');
    for (const bad of [undefined, 5, '', '   ', null]) {
      assert.equal(rules.loginPerUsername.key(body(bad), empty), null);
    }
    assert.equal(rules.loginPerUsername.key(body('x', false), empty), null);
    assert.equal(rules.loginPerUsername.needsBody, true);
    assert.equal(rules.loginPerIp.key({ ip: '203.0.113.9' } as never, empty), '203.0.113.9');
    assert.equal(rules.refreshPerIp.key({ ip: undefined } as never, empty), 'unknown');
    assert.equal(rules.loginPerIp.key({ ip: '::ffff:203.0.113.9' } as never, empty), '203.0.113.9');
    assert.equal(rules.unauthenticatedPerIp.key({ ip: '2001:db8::5' } as never, empty), rules.unauthenticatedPerIp.key({ ip: '2001:db8::6' } as never, empty));
    assert.equal(rules.loginPerUsername.key(body('ＭＡＲＩＯ'), empty), 'mario');
    assert.equal(rules.apiPerUser.key({} as never, res), '0123456789abcdef01234567');
    assert.equal(rules.usernameCheckPerUser.key({} as never, empty), null);
    assert.equal(rules.passwordChangePerUser.key({} as never, res), '0123456789abcdef01234567');
    assert.equal(rules.passwordChangePerUser.key({} as never, empty), null);
  });
});

describe('rateLimit middleware', () => {
  const makeRule = (key: string | null): RateLimitRule => ({ bucket: 'b', limit: 1, key: () => key });
  const run = async (rule: RateLimitRule, limiter: RateLimiter = memoryRateLimiter(), headers: Record<string, string> = {}) => {
    const set: Record<string, string> = { ...headers };
    const exceeded: string[] = [];
    let nexted = false;
    const res = {
      getHeader: (name: string) => set[name],
      set: (values: Record<string, string>) => void Object.assign(set, values),
    };
    const handler = rateLimit(rule, { limiter, onExceeded: ({ rule: hit }) => void exceeded.push(hit.bucket) });
    let thrown: unknown;
    try {
      await handler({} as never, res as never, () => void (nexted = true));
    } catch (error) {
      thrown = error;
    }
    return { set, exceeded, nexted, thrown };
  };

  it('does nothing when the rule does not apply', async () => {
    const limiter = memoryRateLimiter();
    const result = await run(makeRule(null), limiter);
    assert.equal(result.nexted, true);
    assert.equal(limiter.calls.length, 0);
    assert.deepEqual(result.set, {});
  });

  it('continues under the limit and rejects over it, reporting only the first excess', async () => {
    const limiter = memoryRateLimiter();
    const first = await run(makeRule('k'), limiter);
    assert.deepEqual([first.nexted, first.set['RateLimit-Limit'], first.set['RateLimit-Remaining'], first.set['RateLimit-Reset']], [true, '1', '0', '30']);
    const second = await run(makeRule('k'), limiter);
    assert.equal(second.nexted, false);
    assert.deepEqual(second.exceeded, ['b']);
    assert.deepEqual((second.thrown as { code: string; headers: Record<string, string> }).headers, { 'Retry-After': '30' });
    assert.equal((second.thrown as { code: string }).code, 'RATE_LIMITED');
    assert.deepEqual((await run(makeRule('k'), limiter)).exceeded, []);
  });

  it('keeps the headers of a rule with fewer requests left, and replaces those of a rule with more', async () => {
    const tight = { 'RateLimit-Limit': '5', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '10' };
    assert.deepEqual((await run(makeRule('k'), memoryRateLimiter(), tight)).set, tight);
    const roomy = { 'RateLimit-Limit': '500', 'RateLimit-Remaining': '400', 'RateLimit-Reset': '10' };
    assert.equal((await run(makeRule('k'), memoryRateLimiter(), roomy)).set['RateLimit-Limit'], '1');
  });

  it('propagates a limiter failure', async () => {
    const limiter = { ...memoryRateLimiter(), consume: () => Promise.reject(new Error('down')) };
    assert.equal(((await run(makeRule('k'), limiter)).thrown as Error).message, 'down');
  });
});

describe('mountRoutes with rate limit rules', () => {
  const handler = (): void => undefined;
  const authenticate = (): void => undefined;
  const anonymous = { kind: 'anonymous', reason: 'test' } as const;
  const mountMessage = (routeOverrides: Record<string, unknown>, options: Parameters<typeof mountRoutes>[2]): string => {
    try {
      mountRoutes(express.Router(), [defineRoute({ method: 'GET', path: '/x', auth: anonymous, handler, ...routeOverrides } as never)], options);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail('expected mountRoutes to throw');
  };

  it('requires the rate limit dependencies for user routes and for declared rules', () => {
    const user = { auth: { kind: 'user', permission: 'places:read' } };
    assert.match(mountMessage(user, { authenticate, allowedAuth: ['user'] }), /user route needs the rateLimit dependencies/);
    assert.match(mountMessage({ rateLimit: [rules.loginPerIp] }, {}), /rate limit rules need the rateLimit dependencies/);
    mountRoutes(express.Router(), [defineRoute({ method: 'GET', path: '/x', auth: anonymous, rateLimit: [rules.loginPerIp], handler })], { rateLimit: memoryRateLimitMount() });
  });

  it('rejects malformed rules', () => {
    for (const bad of ['x', [null], [{}], [{ bucket: '', key: () => 'k' }], [{ bucket: 'b' }], [{ bucket: 5, key: () => 'k' }]]) {
      assert.match(mountMessage({ rateLimit: bad }, { rateLimit: memoryRateLimitMount() }), /rateLimit must be a list of rules with a bucket and a key function/);
    }
  });
});
