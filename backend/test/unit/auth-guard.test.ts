import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestHandler } from 'express';
import { AppError } from '../../src/shared/http/errors.ts';
import { guardAuthentication } from '../../src/shared/security/rate-limit/rate-limit.ts';
import type { RateLimitMount } from '../../src/shared/security/rate-limit/rate-limit.ts';
import { clientIpKey } from '../../src/shared/security/client-ip.ts';
import { normalizeUsername } from '../../src/shared/security/username.ts';
import { memoryRateLimitMount, memoryRateLimiter } from '../helpers/activity.ts';
import type { MemoryRateLimiter } from '../helpers/activity.ts';

function setup(authenticate: RequestHandler, limit = 2, key: string | null = '203.0.113.1') {
  const limiter = memoryRateLimiter();
  const base = memoryRateLimitMount(limiter);
  const mount: RateLimitMount = { ...base, authFailureRule: { bucket: 'auth-fail:ip', limit, key: () => key } };
  const guarded = guardAuthentication(authenticate, mount);
  const run = async (): Promise<{ nexted: unknown[]; thrown: unknown }> => {
    const nexted: unknown[] = [];
    let thrown: unknown;
    try {
      await guarded({} as never, {} as never, ((error?: unknown) => void nexted.push(error)) as never);
    } catch (error) {
      thrown = error;
    }
    return { nexted, thrown };
  };
  return { limiter, run };
}

const consumed = (limiter: MemoryRateLimiter) => limiter.calls.length;

describe('guardAuthentication', () => {
  it('lets a successful authentication through without touching the counter', async () => {
    const calls: number[] = [];
    const { limiter, run } = setup((_req, _res, next) => {
      calls.push(1);
      next();
    });
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual((await run()).nexted, [undefined]);
    }
    assert.equal(consumed(limiter), 0);
    assert.equal(limiter.peeks.length, 5);
    assert.equal(calls.length, 5);
  });

  it('counts a 401 thrown, rejected or passed to next, and rethrows it', async () => {
    const unauthenticated = new AppError('UNAUTHENTICATED');
    for (const authenticate of [
      (() => { throw unauthenticated; }) as RequestHandler,
      (async () => { throw new AppError('TOKEN_EXPIRED'); }) as RequestHandler,
      ((_req, _res, next) => next(unauthenticated)) as RequestHandler,
    ]) {
      const { limiter, run } = setup(authenticate);
      const { thrown, nexted } = await run();
      assert.ok(thrown instanceof AppError && thrown.status === 401);
      assert.deepEqual(nexted, []);
      assert.deepEqual(limiter.calls, [{ bucket: 'auth-fail:ip', key: '203.0.113.1', limit: 2 }]);
    }
  });

  it('does not count other failures, and rethrows them', async () => {
    for (const failure of [new AppError('FORBIDDEN'), new Error('database down'), 'plain']) {
      const { limiter, run } = setup(() => { throw failure; });
      assert.equal((await run()).thrown, failure);
      assert.equal(consumed(limiter), 0);
    }
  });

  it('answers 429 with Retry-After without calling authenticate once the IP reached the limit', async () => {
    let authenticated = 0;
    const { limiter, run } = setup(() => {
      authenticated += 1;
      throw new AppError('UNAUTHENTICATED');
    });
    await run();
    await run();
    assert.equal(authenticated, 2);
    const blocked = await run();
    assert.equal(authenticated, 2);
    assert.ok(blocked.thrown instanceof AppError);
    assert.equal(blocked.thrown.code, 'RATE_LIMITED');
    assert.deepEqual(blocked.thrown.headers, { 'Retry-After': '30' });
    assert.equal(consumed(limiter), 2);
  });

  it('reports the first excess of the window once, like any other rate limit', async () => {
    const exceeded: string[] = [];
    const limiter = memoryRateLimiter();
    const base = memoryRateLimitMount(limiter);
    const mount: RateLimitMount = { ...base, onExceeded: ({ rule }) => void exceeded.push(rule.bucket), authFailureRule: { bucket: 'auth-fail:ip', limit: 1, key: () => 'k' } };
    // peek is bypassed so that the counter keeps growing past the limit, as with concurrent requests.
    const racing: RateLimitMount = { ...mount, limiter: { ...limiter, peek: () => Promise.resolve({ allowed: true, limit: 1, remaining: 1, resetSeconds: 1, firstExcess: false }) } };
    const guarded = guardAuthentication(() => { throw new AppError('UNAUTHENTICATED'); }, racing);
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(Promise.resolve(guarded({} as never, {} as never, (() => undefined) as never)));
    }
    assert.deepEqual(exceeded, ['auth-fail:ip']);
  });

  it('does nothing about failures when the rule does not apply to the request', async () => {
    const { limiter, run } = setup(() => { throw new AppError('UNAUTHENTICATED'); }, 2, null);
    assert.ok((await run()).thrown instanceof AppError);
    assert.equal(limiter.peeks.length + consumed(limiter), 0);
  });
});

describe('normalizeUsername', () => {
  it('applies NFKC, trims and lower-cases', () => {
    assert.equal(normalizeUsername('  MaRio '), 'mario');
    assert.equal(normalizeUsername('ＭＡＲＩＯ'), 'mario');
    assert.equal(normalizeUsername('Kelvin'), 'kelvin'); // Kelvin sign
    assert.equal(normalizeUsername('é'), 'é'); // composed form
    assert.equal(normalizeUsername('   '), '');
  });
});

describe('clientIpKey', () => {
  it('unwraps IPv4-mapped IPv6 addresses and keeps IPv4 as is', () => {
    assert.equal(clientIpKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientIpKey('::FFFF:203.0.113.7'), '203.0.113.7');
    assert.equal(clientIpKey('203.0.113.7'), '203.0.113.7');
  });

  it('reduces IPv6 to the /64 prefix, expanding :: correctly', () => {
    const prefix = '2001:0db8:0000:0000::/64';
    for (const address of ['2001:db8::1', '2001:db8:0:0:1:2:3:4', '2001:DB8::ffff:ffff:ffff:ffff', '2001:db8:0:0::']) {
      assert.equal(clientIpKey(address), prefix, address);
    }
    assert.equal(clientIpKey('2001:db8:0:1::1'), '2001:0db8:0000:0001::/64');
    assert.equal(clientIpKey('2001:db8:0:1:ffff::'), '2001:0db8:0000:0001::/64');
    assert.equal(clientIpKey('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
    assert.equal(clientIpKey('::1'), '0000:0000:0000:0000::/64');
    assert.equal(clientIpKey('::'), '0000:0000:0000:0000::/64');
    assert.equal(clientIpKey('1::'), '0001:0000:0000:0000::/64');
    assert.equal(clientIpKey('64:ff9b::192.0.2.33'), '0064:ff9b:0000:0000::/64');
    assert.equal(clientIpKey('::ffff:0:1'), '0.0.0.1');
    assert.notEqual(clientIpKey('2001:db8:0:2::1'), prefix);
  });

  it('unwraps IPv4-mapped addresses written in hex groups', () => {
    assert.equal(clientIpKey('::ffff:0102:0304'), '1.2.3.4');
    assert.equal(clientIpKey('0:0:0:0:0:ffff:cb00:7107'), '203.0.113.7');
    assert.equal(clientIpKey('::ffff:ffff:ffff'), '255.255.255.255');
    assert.equal(clientIpKey('::fffe:0102:0304'), '0000:0000:0000:0000::/64');
  });

  it('returns anything that is not an address unchanged', () => {
    assert.equal(clientIpKey('unknown'), 'unknown');
    assert.equal(clientIpKey('::ffff:not-an-ip'), '::ffff:not-an-ip');
  });
});
