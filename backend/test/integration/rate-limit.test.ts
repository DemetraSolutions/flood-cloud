import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { createRateLimiter, RATE_LIMIT_WINDOW_SECONDS } from '../../src/shared/security/rate-limit/rate-limiter.ts';
import type { Databases } from '../../src/db/databases.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { quietLogger } from '../helpers/indexes.ts';
import { COLLECTIONS } from '../../src/db/collections.ts';

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
});
after(async () => {
  await ctx.cleanup();
});

const counters = () => ctx.databases.common().collection<{ _id: string; count: number; expiresAt: Date }>('rateLimits');

// Anchored at the start of the current minute: counters have a TTL and must never be born expired.
const BASE = Math.floor(Date.now() / 60_000) * 60_000;

describe('rate limiter (real MongoDB)', () => {
  it('counts a daily quota in a window of 24 hours: a request an hour later is in the same window, and the reset tells the seconds to the end of the day', async () => {
    const DAY = 86_400;
    const midnight = Math.floor(Date.now() / (DAY * 1000)) * DAY * 1000;
    let now = midnight + 3_600_000;
    const limiter = createRateLimiter(ctx.databases, () => now);
    const first = await limiter.consume('media-upload-day:user', 'u1', 2, DAY);
    assert.deepEqual([first.allowed, first.resetSeconds], [true, DAY - 3600]);
    now += 3_600_000;
    assert.equal((await limiter.consume('media-upload-day:user', 'u1', 2, DAY)).allowed, true);
    const third = await limiter.consume('media-upload-day:user', 'u1', 2, DAY);
    assert.deepEqual([third.allowed, third.firstExcess, third.resetSeconds], [false, true, DAY - 7200]);
    assert.equal((await limiter.peek('media-upload-day:user', 'u1', 2, DAY)).allowed, false);
    assert.equal((await limiter.consume('media-upload-day:user', 'u1', 2)).allowed, true, 'the same key in the one-minute window is another counter');
    const stored = await counters().findOne({ _id: `media-upload-day:user:${createHash('sha256').update('u1').digest('hex')}:${String(midnight / 1000)}` });
    assert.equal(stored?.count, 3);
    assert.ok(stored!.expiresAt.getTime() > midnight + DAY * 1000);
  });

  it('counts per window, reports remaining and reset, and flags only the first excess', async () => {
    const start = BASE + 10_000;
    const limiter = createRateLimiter(ctx.databases, () => start);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await limiter.consume('login:ip', '203.0.113.7', 2));
    }
    assert.deepEqual(
      results.map(({ allowed, remaining, firstExcess }) => ({ allowed, remaining, firstExcess })),
      [
        { allowed: true, remaining: 1, firstExcess: false },
        { allowed: true, remaining: 0, firstExcess: false },
        { allowed: false, remaining: 0, firstExcess: true },
        { allowed: false, remaining: 0, firstExcess: false },
      ],
    );
    assert.equal(results[0]?.limit, 2);
    assert.equal(results[0]?.resetSeconds, 50);
  });

  it('starts a fresh count in the next window', async () => {
    let now = BASE + 59_500;
    const limiter = createRateLimiter(ctx.databases, () => now);
    assert.equal((await limiter.consume('refresh:ip', 'a', 1)).allowed, true);
    const blocked = await limiter.consume('refresh:ip', 'a', 1);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.resetSeconds, 1);
    now += 1000;
    assert.deepEqual(await limiter.consume('refresh:ip', 'a', 1), { allowed: true, limit: 1, remaining: 0, resetSeconds: RATE_LIMIT_WINDOW_SECONDS, firstExcess: false });
  });

  it('keeps keys and buckets independent', async () => {
    const limiter = createRateLimiter(ctx.databases, () => BASE);
    assert.equal((await limiter.consume('b1', 'k1', 1)).allowed, true);
    assert.equal((await limiter.consume('b1', 'k1', 1)).allowed, false);
    assert.equal((await limiter.consume('b1', 'k2', 1)).allowed, true);
    assert.equal((await limiter.consume('b2', 'k1', 1)).allowed, true);
  });

  it('never stores the key in clear and expires the counter after the window', async () => {
    const now = BASE + 30_000;
    await createRateLimiter(ctx.databases, () => now).consume('login:username', 'Mario.Rossi@example.com', 5);
    const hash = createHash('sha256').update('Mario.Rossi@example.com').digest('hex');
    const windowStart = BASE / 1000;
    const stored = await counters().findOne({ _id: `login:username:${hash}:${windowStart}` });
    assert.equal(stored?.count, 1);
    assert.equal(stored?.expiresAt.getTime(), (windowStart + 120) * 1000);
    for (const document of await counters().find().toArray()) {
      assert.ok(!document._id.includes('Mario') && !document._id.includes('203.0.113.7'));
    }
  });

  it('has the TTL index on expiresAt', async () => {
    const index = (await counters().indexes()).find((candidate) => candidate.name === 'expiresAt_1');
    assert.equal(index?.expireAfterSeconds, 0);
  });

  it('does not let concurrent requests exceed the limit', async () => {
    const limiter = createRateLimiter(ctx.databases, () => BASE);
    const results = await Promise.all(Array.from({ length: 40 }, () => limiter.consume('race', 'same', 10)));
    assert.equal(results.filter((result) => result.allowed).length, 10);
    assert.equal(results.filter((result) => result.firstExcess).length, 1);
    assert.equal((await counters().findOne({ _id: { $regex: '^race:' } }))?.count, 40);
  });

  it('rejects when the database fails (callers fail closed)', async () => {
    const broken = { common: () => ({ collection: () => ({ findOneAndUpdate: () => Promise.reject(new Error('down')) }) }) } as unknown as Databases;
    await assert.rejects(createRateLimiter(broken).consume('b', 'k', 1), /down/);
  });
});

describe('rate limiter with a stubbed collection', () => {
  const stub = (outcomes: Array<unknown>) => {
    let calls = 0;
    const databases = {
      common: () => ({
        collection: () => ({
          findOneAndUpdate: () => {
            const outcome = outcomes[calls++];
            return outcome instanceof Error || (typeof outcome === 'object' && outcome !== null && 'code' in outcome) ? Promise.reject(outcome) : Promise.resolve(outcome);
          },
        }),
      }),
    } as unknown as Databases;
    return { databases, calls: () => calls };
  };

  it('retries once after a duplicate key error from a racing upsert', async () => {
    const { databases, calls } = stub([Object.assign(new Error('dup'), { code: 11000 }), { count: 1 }]);
    assert.equal((await createRateLimiter(databases).consume('b', 'k', 5)).remaining, 4);
    assert.equal(calls(), 2);
  });

  it('gives up after a second duplicate key error and rethrows other errors at once', async () => {
    const dup = Object.assign(new Error('dup'), { code: 11000 });
    const twice = stub([dup, dup]);
    await assert.rejects(createRateLimiter(twice.databases).consume('b', 'k', 5), /dup/);
    assert.equal(twice.calls(), 2);
    const other = stub([Object.assign(new Error('boom'), { code: 5 }), { count: 1 }]);
    await assert.rejects(createRateLimiter(other.databases).consume('b', 'k', 5), /boom/);
    assert.equal(other.calls(), 1);
    // A non-object rejection is not a duplicate key error.
    const databases = { common: () => ({ collection: () => ({ findOneAndUpdate: () => Promise.reject('plain') }) }) } as unknown as Databases;
    await assert.rejects(createRateLimiter(databases).consume('b', 'k', 5), (error) => error === 'plain');
  });

  it('fails when the upsert returns no document', async () => {
    await assert.rejects(createRateLimiter(stub([null]).databases).consume('b', 'k', 5), /returned no document/);
  });
});
