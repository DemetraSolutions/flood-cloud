import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';
import { TEST_USER_HEADER, assertIsolation, isolationCases, isolationGroupAccess, isolationProbeRoute, seedIsolationCluster, testAuthenticator } from '../helpers/isolation.ts';
import type { IsolationCluster, IsolationCase } from '../helpers/isolation.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let cluster: IsolationCluster;
let app: TestServer;
const activity = memoryActivityLog();
let clock = Date.now();

before(async () => {
  ctx = await openTestDatabases();
  cluster = await seedIsolationCluster(ctx.databases);
  app = await startApp({
    routes: { v1: [isolationProbeRoute(ctx.databases)] },
    activityLog: activity,
    now: () => clock,
    groupAccess: isolationGroupAccess(ctx.databases),
    authenticate: { v1: testAuthenticator(ctx.databases) },
  });
});
after(async () => {
  await app.close();
  await ctx.cleanup();
});

const as = async (actor: ObjectId | undefined, groupId: string, placeId: ObjectId): Promise<{ status: number; code: string | undefined; body: { data?: { id: string } } }> => {
  const headers: Record<string, string> = actor === undefined ? {} : { [TEST_USER_HEADER]: actor.toHexString() };
  const response = await fetch(`${app.baseUrl}/v1/groups/${encodeURIComponent(groupId)}/places/${placeId.toHexString()}`, { headers });
  const body = (await response.json()) as { error?: { code: string }; data?: { id: string } };
  return { status: response.status, code: body.error?.code, body };
};

describe('isolation model (real MongoDB)', () => {
  it('passes the standard cases: other group, other dealer, CA outside company, PA outside place, E', async () => {
    await assertIsolation(isolationCases(cluster), async (c: IsolationCase) => as(c.actor, c.groupId, c.placeId));
  });

  it('returns the requested place on success', async () => {
    const [a1] = cluster.groups;
    const response = await as(a1!.sa, a1!.groupId.toHexString(), a1!.otherPlaceId);
    assert.equal(response.body.data?.id, a1!.otherPlaceId.toHexString());
  });

  it('answers 403 to a user whose own matrix removes the permission, inside his perimeter', async () => {
    const [, a2] = cluster.groups;
    const users = ctx.databases.common().collection('users');
    await users.updateOne({ _id: a2!.sa }, { $set: { permissions: { status: true, places: { r: false, w: true } } } });
    const response = await as(a2!.sa, a2!.groupId.toHexString(), a2!.ownPlaceId);
    assert.deepEqual({ status: response.status, code: response.code }, { status: 403, code: 'FORBIDDEN' });
    // Outside the perimeter the group check still comes first.
    const other = await as(a2!.sa, cluster.groups[0]!.groupId.toHexString(), a2!.ownPlaceId);
    assert.equal(other.status, 404);
    await users.updateOne({ _id: a2!.sa }, { $unset: { permissions: '' } });
    assert.equal((await as(a2!.sa, a2!.groupId.toHexString(), a2!.ownPlaceId)).status, 403);
  });

  it('lets only PSA into a suspended or trashed group, and nobody into a missing one', async () => {
    const [, , b1] = cluster.groups;
    const groups = ctx.databases.common().collection('groups');
    const hex = b1!.groupId.toHexString();
    const statuses = [{ status: false }, { trash: true }];
    for (const change of statuses) {
      const before = await groups.findOne({ _id: b1!.groupId });
      await groups.updateOne({ _id: b1!.groupId }, { $set: change });
      try {
        assert.equal((await as(b1!.sa, hex, b1!.ownPlaceId)).status, 404);
        assert.equal((await as(b1!.ca, hex, b1!.ownPlaceId)).status, 404);
        assert.equal((await as(b1!.pa, hex, b1!.ownPlaceId)).status, 404);
        assert.equal((await as(cluster.psa, hex, b1!.ownPlaceId)).status, 200);
      } finally {
        await groups.updateOne({ _id: b1!.groupId }, { $set: { status: before!['status'], trash: before!['trash'] } });
      }
    }
    // A suspended group also leaves the dealer's scope, so his next sign-in no longer reaches it.
    await groups.updateOne({ _id: b1!.groupId }, { $set: { status: false } });
    try {
      assert.equal((await as(cluster.dealerB, hex, b1!.ownPlaceId)).status, 404);
    } finally {
      await groups.updateOne({ _id: b1!.groupId }, { $set: { status: true } });
    }
    assert.equal((await as(cluster.dealerB, hex, b1!.ownPlaceId)).status, 200);
    const missing = fixtureId('group', 424242).toHexString();
    assert.equal((await as(cluster.psa, missing, b1!.ownPlaceId)).status, 404);
  });

  it('answers 401 to an unknown or missing user, before looking at the group', async () => {
    const [a1] = cluster.groups;
    assert.equal((await as(undefined, a1!.groupId.toHexString(), a1!.ownPlaceId)).status, 401);
    assert.equal((await as(a1!.groupId, a1!.groupId.toHexString(), a1!.ownPlaceId)).status, 401);
    const response = await fetch(`${app.baseUrl}/v1/groups/${a1!.groupId.toHexString()}/places/${a1!.ownPlaceId.toHexString()}`, { headers: { [TEST_USER_HEADER]: 'not-hex' } });
    assert.equal(response.status, 401);
  });

  it('answers 404 to a malformed place id', async () => {
    const [a1] = cluster.groups;
    const response = await fetch(`${app.baseUrl}/v1/groups/${a1!.groupId.toHexString()}/places/zzz`, { headers: { [TEST_USER_HEADER]: a1!.sa.toHexString() } });
    assert.equal(response.status, 404);
  });

  it('reports every PSA and D access to a group, and nothing else', async () => {
    activity.entries.length = 0;
    clock += 16 * 60 * 1000; // past the 15 minutes in which a repeated access is recorded once
    const [a1, a2, , b2] = cluster.groups as [IsolationCluster['groups'][number], IsolationCluster['groups'][number], IsolationCluster['groups'][number], IsolationCluster['groups'][number]];
    await as(cluster.psa, b2.groupId.toHexString(), b2.ownPlaceId);
    await as(cluster.dealerA, a2.groupId.toHexString(), a2.ownPlaceId);
    await as(cluster.dealerA, b2.groupId.toHexString(), b2.ownPlaceId); // 404: outside the perimeter, not an access
    await as(a1.sa, a1.groupId.toHexString(), a1.ownPlaceId);
    await as(a1.ca, a1.groupId.toHexString(), a1.ownPlaceId);
    assert.deepEqual(
      activity.entries.map(({ category, action, outcome, actor, groupId }) => ({ category, action, outcome, role: actor.role, userId: actor.id?.toHexString(), groupId: groupId?.toHexString() })),
      [
        { category: 'security', action: 'group.crossAccess', outcome: 'success', role: 'PSA', userId: cluster.psa.toHexString(), groupId: b2.groupId.toHexString() },
        { category: 'security', action: 'group.crossAccess', outcome: 'success', role: 'D', userId: cluster.dealerA.toHexString(), groupId: a2.groupId.toHexString() },
      ],
    );
  });
});
