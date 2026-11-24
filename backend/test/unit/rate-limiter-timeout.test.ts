import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError } from 'mongodb';
import type { Document } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { RATE_LIMIT_MAX_TIME_MS, createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';

const expired = () => new MongoServerError({ message: 'operation exceeded time limit', code: 50 });

function databasesWith(collection: Record<string, (...args: never[]) => Promise<unknown>>): Databases {
  return { common: () => ({ collection: () => collection }) } as never;
}

describe('the time limit of the counters', () => {
  it('is two seconds on the write and on the read, for every rule', async () => {
    assert.equal(RATE_LIMIT_MAX_TIME_MS, 2000);
    const seen: Array<Document | undefined> = [];
    const limiter = createRateLimiter(
      databasesWith({
        findOneAndUpdate: ((_filter: Document, _update: Document, options: Document) => (seen.push(options), Promise.resolve({ count: 1 }))) as never,
        findOne: ((_filter: Document, options: Document) => (seen.push(options), Promise.resolve(null))) as never,
      }),
    );
    await limiter.consume('a', 'k', 5);
    await limiter.consume('a', 'k', 5, 3600);
    await limiter.peek('a', 'k', 5);
    assert.deepEqual(seen.map((options) => options?.['maxTimeMS']), [2000, 2000, 2000]);
  });

  it('lets the expiry propagate as any failure of the store: the request fails closed (500 by the central handler)', async () => {
    const limiter = createRateLimiter(databasesWith({ findOneAndUpdate: (() => Promise.reject(expired())) as never, findOne: (() => Promise.reject(expired())) as never }));
    await assert.rejects(limiter.consume('a', 'k', 5), (error) => error instanceof MongoServerError && error.code === 50);
    await assert.rejects(limiter.peek('a', 'k', 5), (error) => error instanceof MongoServerError && error.code === 50);
  });
});
