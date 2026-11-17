import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Document } from 'mongodb';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const g = (index = 0) => office.cluster.groups[index]!;
const path = () => `/groups/${g().groupId.toHexString()}`;
const groups = () => ctx.databases.common().collection('groups');
const stored = async (): Promise<Document> => (await groups().findOne({ _id: g().groupId }))!;
const psa = () => office.cluster.psa;
const dealer = () => office.cluster.dealerA;
const DEFAULTS = { enabled: false, defaultRateLimitPerMinute: 60, defaultDailyQuota: 10000, groupRateLimitPerMinute: 120, groupDailyQuota: 20000 };

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await groups().updateMany({}, { $unset: { publicApi: '' } });
  office.activity.entries.length = 0;
});

describe('the public API settings of a group', () => {
  it('are off with the platform defaults when the group has none, and shown to the PSA and the dealer alone', async () => {
    for (const actor of [psa(), dealer()]) {
      assert.deepEqual((await as.call(actor, 'GET', path())).body.data.publicApi, DEFAULTS);
    }
    const sa = await as.call(g().sa, 'GET', path());
    assert.deepEqual([sa.status, 'publicApi' in sa.body.data], [200, false]);
    assert.equal('publicApi' in (await stored()), false);
  });

  it('are changed by the PSA, leaf by leaf, in a field of their own at the top of the document and never in `settings`', async () => {
    const settings = (await stored())['settings'] as Document;
    const first = await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true } });
    assert.deepEqual([first.status, first.body.data.publicApi], [200, { ...DEFAULTS, enabled: true }]);
    assert.deepEqual((await stored())['publicApi'], { enabled: true });
    const second = await as.call(psa(), 'PATCH', path(), { publicApi: { defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000 } });
    assert.deepEqual(second.body.data.publicApi, { ...DEFAULTS, enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000 });
    assert.deepEqual((await stored())['publicApi'], { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000 });
    const caps = await as.call(psa(), 'PATCH', path(), { publicApi: { groupRateLimitPerMinute: 600, groupDailyQuota: 50000 } });
    assert.deepEqual(caps.body.data.publicApi, { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000, groupRateLimitPerMinute: 600, groupDailyQuota: 50000 });
    assert.deepEqual((await stored())['publicApi'], { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000, groupRateLimitPerMinute: 600, groupDailyQuota: 50000 });
    assert.deepEqual((await stored())['settings'], settings);
    assert.deepEqual((await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: false } })).body.data.publicApi, { ...DEFAULTS, enabled: false, defaultRateLimitPerMinute: 120, defaultDailyQuota: 5000, groupRateLimitPerMinute: 600, groupDailyQuota: 50000 });
  });

  it('survive the legacy update of a group, which writes the settings as a whole', async () => {
    await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true, defaultRateLimitPerMinute: 90 } });
    const settings = (await stored())['settings'] as Document;
    await groups().updateOne({ _id: g().groupId }, { $set: { settings: { ...settings, cash: false } } });
    assert.deepEqual((await as.call(psa(), 'GET', path())).body.data.publicApi, { ...DEFAULTS, enabled: true, defaultRateLimitPerMinute: 90 });
  });

  it('are logged in the changes of group.updated, and a request that changes nothing logs nothing', async () => {
    await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true, defaultDailyQuota: 20000 } });
    const events = office.activity.entries.filter((entry) => entry.action === 'group.updated');
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0]!.changes!.map((change) => [change.field, change.before, change.after]),
      [['publicApi.enabled', false, true], ['publicApi.defaultDailyQuota', 10000, 20000]],
    );
    office.activity.entries.length = 0;
    // The platform default is what the group already has: nothing to write.
    assert.equal((await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true, defaultRateLimitPerMinute: 60, defaultDailyQuota: 20000 } })).status, 200);
    assert.equal(office.activity.entries.length, 0);
    assert.deepEqual(await stored().then((document) => document['publicApi']), { enabled: true, defaultDailyQuota: 20000 });
  });

  it('are the PSA\'s alone: a dealer who changes a value is 403 notAllowed per field, one who repeats them is fine, the group administrator may not send them at all', async () => {
    await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true, defaultRateLimitPerMinute: 120 } });
    const refused = await as.call(dealer(), 'PATCH', path(), { name: 'Other name', publicApi: { enabled: false, defaultRateLimitPerMinute: 120, defaultDailyQuota: 9 } });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body.error.details, [{ field: 'publicApi.enabled', issue: 'notAllowed' }, { field: 'publicApi.defaultDailyQuota', issue: 'notAllowed' }]);
    assert.equal((await stored())['name'], 'group-001');
    const same = await as.call(dealer(), 'PATCH', path(), { name: 'Renamed', publicApi: { enabled: true, defaultRateLimitPerMinute: 120, defaultDailyQuota: 10000 } });
    assert.deepEqual([same.status, same.body.data.name, same.body.data.publicApi], [200, 'Renamed', { ...DEFAULTS, enabled: true, defaultRateLimitPerMinute: 120 }]);
    assert.deepEqual((await stored())['publicApi'], { enabled: true, defaultRateLimitPerMinute: 120 });
    // The cap of the whole group is the PSA's too: a dealer cannot raise it, nor lower it.
    for (const change of [{ groupRateLimitPerMinute: 6000 }, { groupDailyQuota: 5 }, { groupRateLimitPerMinute: 1, groupDailyQuota: 1 }]) {
      const capped = await as.call(dealer(), 'PATCH', path(), { publicApi: change });
      assert.deepEqual([capped.status, capped.body.error.details], [403, Object.keys(change).map((name) => ({ field: `publicApi.${name}`, issue: 'notAllowed' }))], JSON.stringify(change));
    }
    assert.deepEqual((await stored())['publicApi'], { enabled: true, defaultRateLimitPerMinute: 120 });
    const sa = await as.call(g().sa, 'PATCH', path(), { publicApi: { enabled: true } });
    assert.deepEqual([sa.status, sa.body.error.details], [403, [{ field: 'publicApi', issue: 'notAllowed' }]]);
    const other = await as.call(office.cluster.dealerB, 'PATCH', path(), { publicApi: { enabled: true } });
    assert.equal(other.status, 404);
  });

  it('have bounds: 1 to 6000 requests a minute, 1 to 10 000 000 a day, and nothing else', async () => {
    const cases: Array<[Document, string, string]> = [
      [{ defaultRateLimitPerMinute: 0 }, 'publicApi.defaultRateLimitPerMinute', 'minimum'],
      [{ defaultRateLimitPerMinute: 6001 }, 'publicApi.defaultRateLimitPerMinute', 'maximum'],
      [{ defaultRateLimitPerMinute: 1.5 }, 'publicApi.defaultRateLimitPerMinute', 'type'],
      [{ defaultDailyQuota: 0 }, 'publicApi.defaultDailyQuota', 'minimum'],
      [{ groupRateLimitPerMinute: 0 }, 'publicApi.groupRateLimitPerMinute', 'minimum'],
      [{ groupRateLimitPerMinute: 6001 }, 'publicApi.groupRateLimitPerMinute', 'maximum'],
      [{ groupDailyQuota: 0 }, 'publicApi.groupDailyQuota', 'minimum'],
      [{ groupDailyQuota: 10_000_001 }, 'publicApi.groupDailyQuota', 'maximum'],
      [{ defaultDailyQuota: 10_000_001 }, 'publicApi.defaultDailyQuota', 'maximum'],
      [{ enabled: 'yes' }, 'publicApi.enabled', 'type'],
      [{ monthlyQuota: 5 }, 'publicApi.monthlyQuota', 'unknown'],
    ];
    for (const [change, field, issue] of cases) {
      const reply = await as.call(psa(), 'PATCH', path(), { publicApi: change });
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field, issue }]], field);
    }
    const edges = await as.call(psa(), 'PATCH', path(), { publicApi: { defaultRateLimitPerMinute: 6000, defaultDailyQuota: 10_000_000 } });
    assert.deepEqual([edges.status, edges.body.data.publicApi.defaultRateLimitPerMinute, edges.body.data.publicApi.defaultDailyQuota], [200, 6000, 10_000_000]);
    const low = await as.call(psa(), 'PATCH', path(), { publicApi: { defaultRateLimitPerMinute: 1, defaultDailyQuota: 1 } });
    assert.deepEqual([low.status, low.body.data.publicApi.defaultRateLimitPerMinute], [200, 1]);
  });

  it('use the platform default for a stored value that is not valid, and refuse to write into a field that is not an object', async () => {
    await groups().updateOne({ _id: g().groupId }, { $set: { publicApi: { enabled: true, defaultRateLimitPerMinute: 0, defaultDailyQuota: 'many' } } });
    assert.deepEqual((await as.call(psa(), 'GET', path())).body.data.publicApi, { ...DEFAULTS, enabled: true });
    await groups().updateOne({ _id: g().groupId }, { $set: { publicApi: 'broken' } });
    assert.deepEqual((await as.call(psa(), 'GET', path())).body.data.publicApi, DEFAULTS);
    const refused = await as.call(psa(), 'PATCH', path(), { publicApi: { enabled: true } });
    assert.deepEqual([refused.status, refused.body.error.code], [409, 'CONFLICT']);
    assert.equal((await stored())['publicApi'], 'broken');
  });

  it('take the platform defaults from the configuration', async () => {
    const other = await openTestDatabases();
    const configured = await startBackoffice(other, { env: { PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE: '30', PUBLIC_API_DEFAULT_DAILY_QUOTA: '777', PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE: '55', PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA: '888' } });
    try {
      const reply = await actors(configured).call(configured.cluster.psa, 'GET', `/groups/${configured.cluster.groups[0]!.groupId.toHexString()}`);
      assert.deepEqual(reply.body.data.publicApi, { enabled: false, defaultRateLimitPerMinute: 30, defaultDailyQuota: 777, groupRateLimitPerMinute: 55, groupDailyQuota: 888 });
    } finally {
      await configured.close();
      await other.cleanup();
    }
  });
});
