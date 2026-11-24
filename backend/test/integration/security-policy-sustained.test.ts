import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { userName } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { createRateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';

const URL = '/settings/security-policy';
const HOUR = 3_600_000;
// Tomorrow (UTC), so no counter is born already expired for the TTL index, whatever the time the suite runs at.
const BASE = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 + 5000;
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/**
 * A backoffice whose limits are 3 an hour and 50 a day, with the mode of the environment given. Each request of a user moves the clock of the counters a minute on (the minute limit equals the hourly
 * one: it must never be the one that answers), so only the hourly limit can refuse. The signal of the non-browser requests is off: this is about the limits.
 */
async function start(mode: string | undefined) {
  const ctx: TestDatabases = await openTestDatabases();
  const clock = { now: BASE };
  const world: StoreWorld = await startStoreWorld(ctx, {
    rateLimiter: createRateLimiter(ctx.databases, () => clock.now),
    env: { REQUEST_ORIGIN_SIGNAL: 'off', RATE_LIMIT_API_PER_USER: '3', RATE_LIMIT_API_PER_USER_HOUR: '3', RATE_LIMIT_API_PER_USER_DAY: '50', ...(mode === undefined ? {} : { RATE_LIMIT_API_SUSTAINED_MODE: mode }) },
  });
  cleanups.push(async () => {
    await world.office.close();
    await ctx.cleanup();
  });
  const hit = (token: string, path = '/me', method = 'GET') => {
    clock.now += 61_000;
    return world.office.call(method, path, token);
  };
  const policy = async (body: unknown) => {
    const tag = (await world.as.call(world.office.cluster.psa, 'GET', URL)).headers.get('etag') as string;
    return world.as.call(world.office.cluster.psa, 'PUT', URL, body, { 'if-match': tag });
  };
  /** Four requests of a user in one hour: the statuses. */
  const four = async (actor: ObjectId) => {
    const token = (await world.office.tokens(userName(actor))).accessToken;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await hit(token)).status);
    }
    return { token, statuses };
  };
  return { ctx, world, clock, hit, policy, four, settings: () => ctx.databases.common().collection('settings') };
}

describe('the hourly and daily limits as a setting', () => {
  it('without a saved value follow RATE_LIMIT_API_SUSTAINED_MODE (report when the variable is not there), and say so with the thresholds', async () => {
    const reporting = await start(undefined);
    const got = (await reporting.world.as.call(reporting.world.office.cluster.psa, 'GET', URL)).body.data;
    assert.deepEqual([got.sustainedLimits, got.sources.sustainedLimits, got.limits], ['report', 'default', { perMinute: 3, perHour: 3, perDay: 50 }]);
    assert.deepEqual((await reporting.four(reporting.world.group(0).sa)).statuses, [200, 200, 200, 200], 'report: nothing is refused');
    const enforcing = await start('enforce');
    const env = (await enforcing.world.as.call(enforcing.world.office.cluster.psa, 'GET', URL)).body.data;
    assert.deepEqual([env.sustainedLimits, env.sources.sustainedLimits], ['enforce', 'default']);
    assert.deepEqual((await enforcing.four(enforcing.world.group(0).sa)).statuses, [200, 200, 200, 429], 'enforce from the environment: the fourth request of the hour is refused');
  });

  it('what the PSA saved prevails over the variable, in both directions, at once on the instance that served the write', async () => {
    const enforcing = await start('enforce');
    const saved = await enforcing.policy({ sustainedLimits: 'report' });
    assert.deepEqual([saved.status, saved.body.data.sustainedLimits, saved.body.data.sources.sustainedLimits], [200, 'report', 'database']);
    assert.deepEqual((await enforcing.four(enforcing.world.group(0).sa)).statuses, [200, 200, 200, 200]);
    const reporting = await start('report');
    assert.equal((await reporting.policy({ sustainedLimits: 'enforce' })).status, 200);
    assert.deepEqual((await reporting.four(reporting.world.group(0).ca)).statuses, [200, 200, 200, 429], 'the write counts for the next request, no waiting');
    // The other field was never saved: it stays at its default.
    const got = (await reporting.world.as.call(reporting.world.office.cluster.psa, 'GET', URL)).body.data;
    assert.deepEqual(got.sources, { nonBrowserRequests: 'default', sustainedLimits: 'database' });
  });

  it('is seen by another instance when its copy expires (30 seconds), not before', async () => {
    const w = await start(undefined);
    const sa = (await w.world.office.tokens(userName(w.world.group(0).sa))).accessToken;
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await w.hit(sa)).status, 200);
    }
    // Another instance saved `enforce`: this one still has `report` in memory.
    await w.settings().insertOne({ key: 'SECURITY_POLICY', value: { sustainedLimits: 'enforce' } });
    assert.equal((await w.hit(sa)).status, 200);
    w.world.office.clock.advance(31_000);
    assert.equal((await w.hit(sa)).status, 429);
    // And back, the other way, the same.
    await w.settings().updateOne({ key: 'SECURITY_POLICY' }, { $set: { value: { sustainedLimits: 'report' } } });
    assert.equal((await w.hit(sa)).status, 429);
    w.world.office.clock.advance(31_000);
    assert.equal((await w.hit(sa)).status, 200);
  });

  it('is the default again when the stored field is damaged, and never refuses for it', async () => {
    const w = await start('report');
    await w.settings().insertOne({ key: 'SECURITY_POLICY', value: { sustainedLimits: 'block', nonBrowserRequests: 7 } });
    assert.deepEqual((await w.four(w.world.group(0).pa)).statuses, [200, 200, 200, 200]);
  });

  it('never refuses a PSA or a D, nor the routes that revoke or change one\'s credentials, even in enforce', async () => {
    const w = await start('enforce');
    for (const actor of [w.world.office.cluster.psa, w.world.office.cluster.dealerA]) {
      assert.deepEqual((await w.four(actor)).statuses, [200, 200, 200, 200], userName(actor));
    }
    const sa = (await w.world.office.tokens(userName(w.world.group(1).sa))).accessToken;
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await w.hit(sa)).status, 200);
    }
    assert.equal((await w.hit(sa)).status, 429);
    assert.equal((await w.hit(sa, '/me/pin', 'PUT')).status, 422, 'the guard let it through (its own answer is the validation)');
    assert.equal((await w.hit(sa, '/auth/logout', 'POST')).status, 204);
  });
});
