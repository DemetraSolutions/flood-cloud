import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { COOLDOWN_ONLY, createLimiters, ensureLimiterIndexes, FencedError } from '../../src/limits/limiters.ts';
import type { LimitRule } from '../../src/limits/limiters.ts';
import { createWorld, T0 } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

const HOUR = 3_600_000;
const RULE: LimitRule = { minIntervalMs: 65_000, jitterMs: 3_000, maxPerHour: 3, maxPerYear: null };

describe('persistent limiters (real MongoDB)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  const make = async (epoch = 1, random = () => 0.5) => {
    const limiters = createLimiters({ collection: world.limits, random, loadLimit: 100 });
    await limiters.attach(epoch);
    return limiters;
  };

  it('is free when nothing was used, and a use sets the minimum interval plus the jitter', async () => {
    const limiters = await make();
    assert.deepEqual(limiters.gate('account:h:upload', RULE, T0), { at: T0, reason: 'free' });
    await limiters.consume('account:h:upload', RULE, T0);
    assert.deepEqual(limiters.gate('account:h:upload', RULE, T0), { at: T0 + 65_000 + 1_500, reason: 'interval' });
    assert.deepEqual(limiters.gate('account:h:upload', RULE, T0 + 66_500), { at: T0 + 66_500, reason: 'free' });
    assert.deepEqual(limiters.gate('account:other:upload', RULE, T0), { at: T0, reason: 'free' }, 'keys are independent');
  });

  it('draws the jitter from the whole range', async () => {
    const rule: LimitRule = { minIntervalMs: 1000, jitterMs: 500, maxPerHour: null, maxPerYear: null };
    const low = await make(1, () => 0);
    await low.consume('a', rule, T0);
    assert.equal(low.gate('a', rule, T0).at, T0 + 1000);
    const high = await make(2, () => 0.999999);
    await high.consume('b', rule, T0);
    assert.equal(high.gate('b', rule, T0).at, T0 + 1500);
  });

  it('holds the sliding hourly cap until the oldest use leaves the hour', async () => {
    const limiters = await make();
    const rule: LimitRule = { minIntervalMs: 0, jitterMs: 0, maxPerHour: 3, maxPerYear: null };
    for (const offset of [0, 10 * 60_000, 20 * 60_000]) {
      await limiters.consume('k', rule, T0 + offset);
    }
    assert.deepEqual(limiters.gate('k', rule, T0 + 30 * 60_000), { at: T0 + HOUR, reason: 'hour' });
    assert.deepEqual(limiters.gate('k', rule, T0 + HOUR), { at: T0 + HOUR, reason: 'free' }, 'the first use is out of the hour');
    await limiters.consume('k', rule, T0 + HOUR);
    assert.deepEqual(limiters.gate('k', rule, T0 + HOUR + 1), { at: T0 + HOUR + 10 * 60_000, reason: 'hour' });
  });

  it('does not track the hour for a rule without an hourly cap', async () => {
    const limiters = await make();
    const rule: LimitRule = { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null };
    await limiters.consume('k', rule, T0);
    assert.deepEqual((await world.limits.findOne({ _id: 'k' }))?.recent, []);
  });

  it('counts the calendar year in Rome, stops at the cap until 1 January and starts over', async () => {
    const limiters = await make();
    const rule: LimitRule = { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: 2 };
    await limiters.consume('k', rule, T0);
    assert.equal(limiters.gate('k', rule, T0 + 1).reason, 'free');
    await limiters.consume('k', rule, T0 + 1000);
    const newYear = Date.UTC(2026, 11, 31, 23, 0, 0);
    assert.deepEqual(limiters.gate('k', rule, T0 + 2000), { at: newYear, reason: 'year' });
    assert.deepEqual(limiters.gate('k', rule, newYear), { at: newYear, reason: 'free' });
    await limiters.consume('k', rule, newYear);
    assert.deepEqual((await world.limits.findOne({ _id: 'k' }))?.yearCount, 1);
    assert.deepEqual((await world.limits.findOne({ _id: 'k' }))?.year, 2027);
  });

  it('keeps hour, year and backoff across a restart (a new instance loads the state)', async () => {
    const first = await make(1);
    const rule: LimitRule = { minIntervalMs: 65_000, jitterMs: 0, maxPerHour: 1, maxPerYear: 5 };
    await first.consume('account:h:upload', rule, T0);
    await first.backoff('account:h:upload', [600_000, 1_500_000], 0, T0);
    await first.coolDown('seller:h:IT1', T0 + 3_720_000);

    const second = await make(2);
    assert.deepEqual(second.gate('account:h:upload', rule, T0 + 70_000), { at: T0 + HOUR, reason: 'hour' });
    assert.deepEqual(second.gate('account:h:upload', COOLDOWN_ONLY, T0 + 5_000), { at: T0 + 600_000, reason: 'cooldown' });
    assert.deepEqual(second.blocked('seller:h:', T0), ['IT1']);
    const doc = await world.limits.findOne({ _id: 'account:h:upload' });
    assert.equal(doc?.yearCount, 1);
    assert.equal(doc?.step, 1);
    assert.equal(doc?.expireAt, undefined, 'a document with a yearly count never expires');
    assert.equal(await second.backoff('account:h:upload', [600_000, 1_500_000], 0, T0 + 1000), 1_500_000, 'the second retry uses the second step');
  });

  it('loads the state only when the epoch changes', async () => {
    const limiters = await make(1);
    await world.limits.insertOne({ _id: 'late', epoch: 0, nextAt: new Date(0), until: new Date(T0 + 1000), step: 0, recent: [], year: 0, yearCount: 0 });
    await limiters.attach(1);
    assert.equal(limiters.gate('late', COOLDOWN_ONLY, T0).reason, 'free');
    await limiters.attach(2);
    assert.equal(limiters.gate('late', COOLDOWN_ONLY, T0).reason, 'cooldown');
  });

  it('refuses to load more documents than the limit instead of working on a partial state', async () => {
    await world.limits.insertMany(Array.from({ length: 4 }, (_, i) => ({ _id: `k${i}`, epoch: 0, nextAt: new Date(0), until: new Date(0), step: 0, recent: [], year: 0, yearCount: 0 })));
    const limiters = createLimiters({ collection: world.limits, random: () => 0, loadLimit: 3 });
    await assert.rejects(limiters.attach(1), /too many limiter documents/);
  });

  it('cools down a key until a time, never shortening a longer cooldown', async () => {
    const limiters = await make();
    await limiters.coolDown('seller:h:A', T0 + 10_000);
    await limiters.coolDown('seller:h:A', T0 + 5_000);
    assert.deepEqual(limiters.gate('seller:h:A', COOLDOWN_ONLY, T0), { at: T0 + 10_000, reason: 'cooldown' });
    assert.deepEqual(limiters.blocked('seller:h:', T0 + 9_999), ['A']);
    assert.deepEqual(limiters.blocked('seller:h:', T0 + 10_000), [], 'a reached cooldown no longer blocks');
    assert.deepEqual(limiters.blocked('seller:x:', T0), [], 'other prefixes are not listed');
  });

  it('steps the backoff, repeats the last step, honours "at least", and resets after a success', async () => {
    const limiters = await make();
    const steps = [600_000, 1_500_000, 3_720_000];
    assert.equal(await limiters.backoff('k', steps, 0, T0), 600_000);
    assert.deepEqual(limiters.gate('k', COOLDOWN_ONLY, T0), { at: T0 + 600_000, reason: 'cooldown' });
    assert.equal(await limiters.backoff('k', steps, 0, T0 + 600_000), 1_500_000);
    assert.equal(await limiters.backoff('k', steps, 0, T0 + 2_100_000), 3_720_000);
    assert.equal(await limiters.backoff('k', steps, 0, T0 + 6_000_000), 3_720_000, 'the last step repeats');
    assert.equal(await limiters.backoff('k', steps, 9_000_000, T0 + 10_000_000), 9_000_000, 'the provider asked for more');
    await limiters.resetBackoff('k');
    assert.equal(await limiters.backoff('k', steps, 0, T0 + 30_000_000), 600_000, 'back to the first step');
  });

  it('a reset of a key that is not in backoff writes nothing', async () => {
    const limiters = await make();
    await limiters.resetBackoff('never-used');
    assert.equal(await world.limits.countDocuments({ _id: 'never-used' }), 0);
  });

  it('expires documents with a TTL index and keeps the state of live ones in memory only until they are of no use', async () => {
    const limiters = await make();
    await ensureLimiterIndexes(world.limits);
    await ensureLimiterIndexes(world.limits);
    const indexes = await world.limits.indexes();
    assert.deepEqual(indexes.filter((index) => index.name === 'expireAt_1').map((index) => index.expireAfterSeconds), [0]);

    await limiters.consume('ip:fake:upload', { minIntervalMs: 3_000, jitterMs: 0, maxPerHour: 2, maxPerYear: null }, T0);
    const doc = await world.limits.findOne({ _id: 'ip:fake:upload' });
    assert.equal(doc?.expireAt?.getTime(), T0 + HOUR + 86_400_000, 'a day after the last use leaves the hour');
    await limiters.coolDown('seller:h:late', T0 + 3 * 86_400_000);
    assert.equal((await world.limits.findOne({ _id: 'seller:h:late' }))?.expireAt?.getTime(), T0 + 4 * 86_400_000);

    await limiters.consume('year', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: 10 }, T0);
    limiters.sweep(T0 + 2 * 86_400_000);
    assert.deepEqual(limiters.blocked('seller:h:', T0 + 2 * 86_400_000), ['late'], 'a live cooldown survives the sweep');
    limiters.sweep(T0 + 10 * 86_400_000);
    assert.deepEqual(limiters.blocked('seller:h:', T0 + 2 * 86_400_000), [], 'an expired entry is dropped from memory');
    assert.equal(limiters.gate('year', { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: 1 }, T0 + 10 * 86_400_000).reason, 'year', 'a yearly count is never swept');
  });

  describe('fencing by the lease epoch', () => {
    it('refuses the writes of an instance that lost the lease, and lets the new holder write', async () => {
      const old = await make(1);
      await old.consume('account:h:upload', RULE, T0);
      const holder = await make(2);
      await holder.consume('account:h:upload', RULE, T0 + 1000);

      await assert.rejects(old.consume('account:h:upload', RULE, T0 + 2000), FencedError);
      await assert.rejects(old.coolDown('account:h:upload', T0 + 9_999_999), FencedError);
      await assert.rejects(old.backoff('account:h:upload', [1000], 0, T0), /write fenced: limiter account:h/);
      const doc = await world.limits.findOne({ _id: 'account:h:upload' });
      assert.equal(doc?.epoch, 2);
      assert.equal(doc?.until.getTime(), 0, 'the old holder changed nothing');
      assert.equal(doc?.nextAt.getTime(), T0 + 1000 + 65_000 + 1_500);
    });

    it('lets the same epoch and a newer one overwrite an older document', async () => {
      const first = await make(1);
      await first.consume('k', RULE, T0);
      await first.consume('k', RULE, T0 + 1);
      const second = await make(5);
      await second.consume('k', RULE, T0 + 2);
      assert.equal((await world.limits.findOne({ _id: 'k' }))?.epoch, 5);
    });

    it('rethrows a database error that is not a fence', async () => {
      const limiters = createLimiters({
        collection: { replaceOne: async () => { throw new Error('boom'); } } as never,
        random: () => 0,
        loadLimit: 10,
      });
      await assert.rejects(limiters.consume('k', RULE, T0), /boom/);
    });
  });
});
