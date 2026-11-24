import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { ACTIVITY_ALERT_ACTIONS } from '../../src/shared/activity-log/catalog.ts';
import type { Document } from 'mongodb';
import { ACTIVITY_EVENTS_INDEXES } from '../../src/db/activity-events-schema.ts';
import { activityCountQuery } from '../../src/modules/activity-log/activity-log.repository.ts';
import { ALERTS_COUNT_CAP, MAX_ALERTS_PERIOD_DAYS } from '../../src/modules/activity-log/activity-log.service.ts';
import { addUser } from '../helpers/backoffice.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { LEGACY_MODULE_NAMES, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const DAY = 86_400_000;
const hex = (id: ObjectId) => id.toHexString();
const g = (index: number) => world.group(index);
const events = () => ctx.databases.common().collection('activityEvents');
const iso = (offsetMs: number) => new Date(world.office.clock.now() + offsetMs).toISOString();
const count = (actor: ObjectId, since: string) => world.as.call(actor, 'GET', `/activity-log/alerts/count?since=${encodeURIComponent(since)}`);

/** An alert entry of an actor, `minutes` minutes ago. */
function alert(actor: ObjectId, role: string, groupId: ObjectId | undefined, minutes: number, action = 'rateLimit.sustainedExceeded'): Document {
  return {
    _id: new ObjectId(),
    at: new Date(world.office.clock.now() - minutes * 60_000),
    category: 'security',
    action,
    outcome: 'success',
    actor: { kind: 'user', id: actor, role },
    ...(groupId === undefined ? {} : { groupId }),
    metadata: { bucket: 'api-day:user', window: 'day', limit: 10000, mode: 'report' },
    expiresAt: new Date(Date.now() + 365 * DAY),
  };
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter });
  await events().deleteMany({});
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(() => limiter.reset());

describe('GET /v1/activity-log/alerts/count', () => {
  it('counts the alerts inside the perimeter of the caller, as the monitor shows them, and only the alert actions', async () => {
    const psa = world.office.cluster.psa;
    const dealerA = world.office.cluster.dealerA;
    await events().insertMany([
      alert(g(0).sa, 'SA', g(0).groupId, 5),
      alert(g(0).sa, 'SA', g(0).groupId, 10),
      alert(g(0).ca, 'CA', g(0).groupId, 20),
      alert(g(1).sa, 'SA', g(1).groupId, 30),
      alert(g(2).sa, 'SA', g(2).groupId, 40),
      alert(dealerA, 'D', undefined, 50),
      alert(g(0).sa, 'SA', g(0).groupId, 60, 'rateLimit.exceeded'),
      alert(g(0).sa, 'SA', g(0).groupId, 61, 'auth.loginFailed'),
      alert(g(0).sa, 'SA', g(0).groupId, 60 * 24 * 3, 'rateLimit.sustainedExceeded'),
    ]);
    const since = iso(-2 * DAY);
    const read = async (actor: ObjectId) => {
      const reply = await count(actor, since);
      assert.equal(reply.status, 200);
      return reply.body;
    };
    // The PSA reads everything; the dealer his two groups plus nothing for his own entry without a group; the SA of a group his group;
    // a company or place administrator only his own actions, which never include an alert.
    assert.deepEqual(await read(psa), { data: { count: 6, capped: false } });
    assert.deepEqual(await read(dealerA), { data: { count: 4, capped: false } });
    assert.deepEqual(await read(world.office.cluster.dealerB), { data: { count: 1, capped: false } });
    assert.deepEqual(await read(g(0).sa), { data: { count: 3, capped: false } });
    assert.deepEqual(await read(g(0).ca), { data: { count: 0, capped: false } }, 'a company administrator never reads an alert, not even his own');
    assert.deepEqual(await read(g(0).pa), { data: { count: 0, capped: false } });
    // `since` is inclusive of newer entries only.
    assert.deepEqual((await count(psa, iso(-15 * 60_000))).body, { data: { count: 2, capped: false } });
    assert.deepEqual((await count(psa, iso(1000))).body, { data: { count: 0, capped: false } });
    // The same numbers as the list the monitor shows with the same filters.
    // The list: PSA, dealer and group administrator see the alerts; a company or place administrator sees none, with or without the filter.
    const alertsOf = async (actor: ObjectId, query: string) => (await world.as.call(actor, 'GET', `/activity-log?limit=200${query}`)).body.data.filter((entry: { action: string }) => entry.action === 'rateLimit.sustainedExceeded').length;
    const all = `&from=${encodeURIComponent(since)}`;
    assert.deepEqual([await alertsOf(psa, all), await alertsOf(dealerA, all), await alertsOf(g(0).sa, all)], [6, 4, 3]);
    assert.deepEqual([await alertsOf(g(0).ca, all), await alertsOf(g(0).pa, all), await alertsOf(g(0).ca, `${all}&action=rateLimit.sustainedExceeded&actorId=${hex(g(0).ca)}`)], [0, 0, 0]);
    assert.ok((await world.as.call(g(0).ca, 'GET', `/activity-log?limit=200${all}`)).body.data.every((entry: { actor: { id: string } }) => entry.actor.id === hex(g(0).ca)), 'his own other actions are still his');
    const list = await world.as.call(dealerA, 'GET', `/activity-log?action=rateLimit.sustainedExceeded&from=${encodeURIComponent(since)}&limit=200`);
    assert.equal(list.body.data.length, 4);
  });

  it('stops at the cap: the count is the cap and capped is true', async () => {
    await events().deleteMany({});
    await events().insertMany(Array.from({ length: ALERTS_COUNT_CAP + 5 }, (_, index) => alert(g(0).sa, 'SA', g(0).groupId, 1 + index / 100)));
    assert.deepEqual((await count(world.office.cluster.psa, iso(-DAY))).body, { data: { count: ALERTS_COUNT_CAP, capped: true } });
    await events().deleteMany({ action: 'rateLimit.sustainedExceeded', 'actor.role': 'SA' });
    await events().insertMany(Array.from({ length: ALERTS_COUNT_CAP }, () => alert(g(0).sa, 'SA', g(0).groupId, 1)));
    assert.deepEqual((await count(world.office.cluster.psa, iso(-DAY))).body, { data: { count: ALERTS_COUNT_CAP, capped: false } });
  });

  it('requires since, a valid date and at most 30 days back (422), and has no other parameter', async () => {
    const psa = world.office.cluster.psa;
    const none = await world.as.call(psa, 'GET', '/activity-log/alerts/count');
    assert.deepEqual([none.status, none.body.error.code, none.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'since', issue: 'required' }]]);
    const bad = await world.as.call(psa, 'GET', '/activity-log/alerts/count?since=yesterday');
    assert.deepEqual([bad.status, bad.body.error.details], [422, [{ field: 'since', issue: 'format' }]]);
    const old = await count(psa, iso(-(MAX_ALERTS_PERIOD_DAYS * DAY + 60_000)));
    assert.deepEqual([old.status, old.body.error.code, old.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'since', issue: 'minimum' }]]);
    assert.equal((await count(psa, iso(-(MAX_ALERTS_PERIOD_DAYS * DAY - 60_000)))).status, 200);
    const extra = await world.as.call(psa, 'GET', `/activity-log/alerts/count?since=${encodeURIComponent(iso(-DAY))}&action=auth.loginFailed`);
    assert.equal(extra.status, 422);
  });

  it('refuses a caller without the permission (403), a store key (403) and an anonymous caller (401)', async () => {
    const modules = Object.fromEntries(LEGACY_MODULE_NAMES.map((name) => [name, { r: name !== 'logs', w: false }]));
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules }) });
    const path = `/activity-log/alerts/count?since=${encodeURIComponent(iso(-DAY))}`;
    assert.equal((await world.as.call(blind.id, 'GET', path)).status, 403);
    assert.equal((await world.office.call('GET', path, undefined)).status, 401);
    const key = await world.activate(g(0).ownPlaceId);
    const asStore = await world.asStore(key.key, 'GET', path);
    assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN']);
  });

  it('is served by the index on the action and the date', async () => {
    assert.ok(ACTIVITY_EVENTS_INDEXES.some((index) => index.name === 'action_1_at_-1' && JSON.stringify(index.key) === '{"action":1,"at":-1}'));
    const names = (await events().indexes()).map((index) => index.name);
    assert.ok(names.includes('action_1_at_-1'));
    const plan = (await events().find({ action: { $in: ['rateLimit.sustainedExceeded'] }, at: { $gte: new Date(0) } }).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } };
    assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /action_1_at_-1/);
  });

  it('reads through the index on the action and the date, with the perimeter of a platform administrator, a dealer, and a group administrator', async () => {
    const groupId = g(0).groupId;
    const principals = [
      { userId: new ObjectId(), scope: { kind: 'platform' } },
      { userId: new ObjectId(), scope: { kind: 'dealer', groupIds: new Set([hex(groupId), hex(g(1).groupId)]) } },
      { userId: new ObjectId(), scope: { kind: 'group', groupId } },
    ] as never[];
    for (const principal of principals) {
      const { match, options } = activityCountQuery(principal, { action: { $in: [...ACTIVITY_ALERT_ACTIONS] }, at: { $gte: new Date(0) } }, ALERTS_COUNT_CAP);
      assert.deepEqual(options, { limit: ALERTS_COUNT_CAP + 1, maxTimeMS: 5000, hint: 'action_1_at_-1' });
      const plan = (await events().find(match, { hint: options.hint }).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } };
      const text = JSON.stringify(plan.queryPlanner.winningPlan);
      assert.match(text, /"indexName":"action_1_at_-1"/, JSON.stringify((principal as { scope: unknown }).scope));
      assert.match(text, /IXSCAN/);
    }
    // A company or place administrator: the alert actions and the exclusion of the alerts contradict each other, nothing is read.
    const company = { userId: new ObjectId(), scope: { kind: 'companies', companyIds: new Set() } } as never;
    const { match } = activityCountQuery(company, { action: { $in: [...ACTIVITY_ALERT_ACTIONS] } }, ALERTS_COUNT_CAP);
    assert.match(JSON.stringify(((await events().find(match).explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan), /predicateEvalsToFalse/);
  });
});
