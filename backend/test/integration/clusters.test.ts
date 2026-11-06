import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { MongoClient } from 'mongodb';
import { loadDatabaseConfig } from '../../src/config.ts';
import { closeClusters, connectClusters, createClusterClients } from '../../src/db/clusters.ts';
import type { ClusterRegistry, ConnectFailure } from '../../src/db/clusters.ts';
import { createDatabases, UnknownClusterError } from '../../src/db/databases.ts';
import { createPingCheck } from '../../src/db/ping.ts';
import { createCompanyPlacesRepository } from '../../src/shared/security/scope/company-places.repository.ts';
import { createGroupsRepository } from '../../src/shared/security/scope/groups.repository.ts';
import { freePort, startApp } from '../helpers/app.ts';
import type { TestServer } from '../helpers/app.ts';
import { TEST_USER_HEADER, isolationProbeRoute, seedIsolationCluster, testAuthenticator } from '../helpers/isolation.ts';
import type { IsolationCluster } from '../helpers/isolation.ts';
import { fixtureId, seedLegacyCluster } from '../helpers/legacy-fixtures.ts';
import { openTestClusters, testMongoUri } from '../helpers/mongo.ts';
import type { TestClusters } from '../helpers/mongo.ts';
import { profileLegacy } from '../../src/tools/profile-legacy/profile.ts';

const clientOf = (ctx: TestClusters, key: `${string}:${'main' | 'analytics'}`): string[] => ctx.opened.get(key) as string[];
const reset = (ctx: TestClusters): void => {
  for (const names of ctx.opened.values()) {
    names.length = 0;
  }
};

describe('clusters (real MongoDB, two clusters on one server)', () => {
  let ctx: TestClusters;
  before(async () => {
    ctx = await openTestClusters();
  });
  after(async () => {
    await ctx.cleanup();
  });

  it('creates a main and an analytics client per cluster, with the right read preferences', () => {
    const { clusters } = ctx.registry;
    assert.deepEqual([...clusters.keys()], ['cluster0', 'cluster1']);
    const all = [...clusters.values()].flatMap((entry) => [entry.main, entry.analytics]);
    assert.equal(new Set(all).size, 4);
    const mode = (client: MongoClient): string => client.options.readPreference.mode;
    assert.deepEqual(
      [mode(clusters.get('cluster0')!.main), mode(clusters.get('cluster0')!.analytics), mode(clusters.get('cluster1')!.main), mode(clusters.get('cluster1')!.analytics)],
      ['primary', 'secondaryPreferred', 'primary', 'secondary'],
    );
    assert.equal(ctx.registry.commonCluster, 'cluster0');
    assert.equal(ctx.registry.defaultGroupCluster, 'cluster0');
  });

  it('opens the common database on the common cluster only', async () => {
    reset(ctx);
    assert.equal(ctx.databases.common().databaseName, `${ctx.prefix}development_common`);
    assert.deepEqual(clientOf(ctx, 'cluster0:main'), [`${ctx.prefix}development_common`]);
    assert.deepEqual(clientOf(ctx, 'cluster1:main'), []);
    ctx.databases.analyticsCommon();
    assert.deepEqual(clientOf(ctx, 'cluster0:analytics'), [`${ctx.prefix}development_common`]);
  });

  it('opens the database of a group with the client of the cluster asked for', () => {
    const groupId = new ObjectId();
    const name = `${ctx.prefix}development_${groupId.toHexString()}`;
    reset(ctx);
    assert.equal(ctx.databases.group(groupId, 'cluster1').databaseName, name);
    assert.deepEqual(clientOf(ctx, 'cluster1:main'), [name]);
    assert.deepEqual(clientOf(ctx, 'cluster0:main'), []);
    ctx.databases.group(groupId, 'cluster0');
    assert.deepEqual(clientOf(ctx, 'cluster0:main'), [name]);
    ctx.databases.analyticsGroup(groupId, 'cluster1');
    assert.deepEqual(clientOf(ctx, 'cluster1:analytics'), [name]);
    assert.deepEqual(clientOf(ctx, 'cluster0:analytics'), []);
  });

  it('resolves the cluster of a group: declared, default when absent, never a silent fallback', () => {
    const _id = new ObjectId();
    assert.equal(ctx.databases.resolveGroupCluster({ _id }), 'cluster0');
    assert.equal(ctx.databases.resolveGroupCluster({ _id, dataCluster: 'cluster1' }), 'cluster1');
    for (const dataCluster of ['cluster9', '', 'CLUSTER1', null, 5, { $ne: 1 }]) {
      assert.throws(() => ctx.databases.resolveGroupCluster({ _id, dataCluster }), (error: unknown) => error instanceof UnknownClusterError && error.groupId === _id.toHexString(), String(dataCluster));
    }
  });

  it('refuses a cluster that is not configured, everywhere, with a sanitized error', async () => {
    const groupId = new ObjectId();
    assert.throws(() => ctx.databases.group(groupId, 'cluster9'), UnknownClusterError);
    assert.throws(() => ctx.databases.analyticsGroup(groupId, 'cluster9'), UnknownClusterError);
    await assert.rejects(ctx.databases.listGroupIds('cluster9'), UnknownClusterError);
    await assert.rejects(ctx.databases.countOtherDatabases('cluster9'), UnknownClusterError);
    await assert.rejects(ctx.databases.serverVersion('cluster9'), UnknownClusterError);
    const error = new UnknownClusterError(`evil\n${'x'.repeat(100)}`, groupId);
    assert.equal(error.clusterId.length, 64);
    assert.ok(!error.clusterId.includes('\n'));
    assert.equal(error.groupId, groupId.toHexString());
    assert.equal(new UnknownClusterError(7).clusterId, '[invalid]');
    assert.equal(new UnknownClusterError('c').groupId, null);
    assert.equal(error.message, 'Cluster is not configured');
  });

  it('exposes analytics as read-only handles that read through the analytics client', async () => {
    const groupId = new ObjectId();
    await ctx.databases.group(groupId, 'cluster1').collection('items').insertMany([{ n: 1 }, { n: 2 }, { n: 2 }]);
    const items = ctx.databases.analyticsGroup(groupId, 'cluster1').collection('items');
    assert.deepEqual(
      Object.keys(items).sort(),
      ['aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount', 'find', 'findOne'],
    );
    for (const write of ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'bulkWrite', 'drop', 'createIndex']) {
      assert.equal(write in items, false, write);
    }
    assert.equal(await items.countDocuments({ n: 2 }), 2);
    assert.equal(await items.countDocuments({}, { limit: 1 }), 1);
    assert.equal((await items.findOne({ n: 1 }))?.['n'], 1);
    assert.equal((await items.findOne({ n: 1 }, { projection: { _id: 0 } }))?.['_id'], undefined);
    assert.equal((await items.find({}).toArray()).length, 3);
    assert.equal((await items.find({}, { limit: 2 }).toArray()).length, 2);
    assert.equal((await items.aggregate([{ $group: { _id: '$n' } }]).toArray()).length, 2);
    assert.equal((await items.aggregate([{ $match: {} }], { maxTimeMS: 5000 }).toArray()).length, 3);
    assert.deepEqual((await items.distinct('n', {})).sort(), [1, 2]);
    assert.ok((await items.estimatedDocumentCount()) >= 0);
    const common = ctx.databases.analyticsCommon().collection('anything');
    assert.equal(await common.countDocuments({}), 0);
  });

  it('wraps cursors so that they expose reads only, never the client', async () => {
    const groupId = new ObjectId();
    await ctx.databases.group(groupId, 'cluster1').collection('items').insertMany([{ n: 3 }, { n: 1 }, { n: 2 }, { n: 4 }]);
    const items = ctx.databases.analyticsGroup(groupId, 'cluster1').collection('items');
    const cursor = items.find({});
    assert.deepEqual(
      Object.keys(cursor).sort(),
      ['close', 'hasNext', 'limit', 'maxTimeMS', 'next', 'project', 'skip', 'sort', 'toArray'],
    );
    for (const leak of ['client', 'db', 'namespace', 'readPreference', 'session']) {
      assert.equal(leak in cursor, false, leak);
    }
    assert.equal(await cursor.hasNext(), true);
    assert.equal((await cursor.next())?.['n'], 3);
    await cursor.close();
    const chained = await items.find({}).sort({ n: 1 }).skip(1).limit(2).project({ _id: 0, n: 1 }).maxTimeMS(5000).toArray();
    assert.deepEqual(chained, [{ n: 2 }, { n: 3 }]);
    const seen: unknown[] = [];
    for await (const document of items.find({}).sort({ n: 1 })) {
      seen.push(document['n']);
    }
    assert.deepEqual(seen, [1, 2, 3, 4]);
    const aggregated = items.aggregate([{ $sort: { n: 1 } }]);
    assert.equal('client' in aggregated, false);
    assert.equal((await aggregated.limit(1).toArray())[0]?.['n'], 1);
    assert.equal(await items.find({ n: 99 }).next(), null);
  });

  it('refuses $out and $merge before calling the driver, toward the same or another database', async () => {
    const source = new ObjectId();
    const target = new ObjectId();
    await ctx.databases.group(source, 'cluster1').collection('items').insertOne({ n: 1 });
    const items = ctx.databases.analyticsGroup(source, 'cluster1').collection('items');
    const targetName = ctx.databases.group(target, 'cluster1').databaseName;
    const stages = [
      { $out: { db: targetName, coll: 'stolen' } },
      { $out: 'copy' },
      { $merge: { into: { db: targetName, coll: 'stolen' } } },
      { $merge: { into: 'copy' } },
    ];
    for (const stage of stages) {
      assert.throws(() => items.aggregate([{ $match: {} }, stage]), /cannot contain \$out or \$merge/, JSON.stringify(Object.keys(stage)));
      assert.throws(() => items.aggregate([stage]), /cannot contain/);
    }
    const created = await ctx.databases.group(target, 'cluster1').listCollections({}, { nameOnly: true }).toArray();
    assert.deepEqual(created, []);
    const copies = await ctx.databases.group(source, 'cluster1').listCollections({ name: 'copy' }, { nameOnly: true }).toArray();
    assert.deepEqual(copies, []);
  });

  it('runs transactions on the common cluster only', async () => {
    reset(ctx);
    const result = await ctx.databases.transaction(async (session) => {
      await ctx.databases.common().collection('tx_probe').insertOne({ ok: 1 }, { session });
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(await ctx.databases.common().collection('tx_probe').countDocuments(), 1);
  });

  it('lists and counts databases per cluster', async () => {
    const groupId = new ObjectId();
    await ctx.databases.group(groupId, 'cluster0').collection('items').insertOne({ n: 1 });
    // The two clusters point at the same server here, so both see the database.
    for (const clusterId of ctx.databases.clusterIds) {
      assert.ok((await ctx.databases.listGroupIds(clusterId)).some((id) => id.equals(groupId)));
      assert.ok((await ctx.databases.countOtherDatabases(clusterId)).other >= 0);
      assert.match(await ctx.databases.serverVersion(clusterId), /^\d+\.\d+\.\d+/);
    }
    assert.deepEqual(ctx.databases.clusterIds, ['cluster0', 'cluster1']);
    assert.equal(ctx.databases.commonCluster, 'cluster0');
  });

  it('puts the common database on another cluster when configured so', async () => {
    const other = await openTestClusters({ MONGODB_COMMON_CLUSTER: 'cluster1', MONGODB_DEFAULT_GROUP_CLUSTER: 'cluster0' });
    try {
      reset(other);
      other.databases.common();
      assert.deepEqual(clientOf(other, 'cluster0:main'), []);
      assert.equal(clientOf(other, 'cluster1:main').length, 1);
      assert.equal(other.databases.resolveGroupCluster({ _id: new ObjectId() }), 'cluster0');
      await other.databases.transaction(async () => undefined);
      assert.equal(await other.databases.common().command({ ping: 1 }).then((r) => r['ok']), 1);
    } finally {
      await other.cleanup();
    }
  });
});

describe('connecting and closing clusters', () => {
  const config = (extra: Record<string, string>) =>
    loadDatabaseConfig({
      APP_ENV: 'development',
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000',
      MONGODB_CLUSTERS: 'cluster0,cluster1',
      MONGODB_URI_CLUSTER0: testMongoUri(),
      ...extra,
    });

  it('keeps the common cluster mandatory and the others optional, reporting only id, role and error name', async () => {
    const dead = `mongodb://127.0.0.1:${await freePort()}/?directConnection=true`;
    const registry = createClusterClients(config({ MONGODB_URI_CLUSTER1: dead, MONGODB_ANALYTICS_URI_CLUSTER0: dead }));
    const failures: ConnectFailure[] = [];
    try {
      const { background } = await connectClusters(registry, (failure) => failures.push(failure));
      await background;
      assert.deepEqual(
        failures.map((failure) => `${failure.clusterId}:${failure.role}:${failure.errorName}`).sort(),
        ['cluster0:analytics:MongoServerSelectionError', 'cluster1:analytics:MongoServerSelectionError', 'cluster1:main:MongoServerSelectionError'],
      );
      assert.ok(!JSON.stringify(failures).includes('127.0.0.1'));
      const databases = createDatabases(registry, { prefix: 'flood_cloud_test_ffffff_', appEnv: 'development' });
      await createPingCheck(databases)();
    } finally {
      assert.equal(await closeClusters(registry, () => undefined), true);
    }
  });

  it('fails when the common cluster is unreachable', async () => {
    const dead = `mongodb://127.0.0.1:${await freePort()}/?directConnection=true`;
    const registry = createClusterClients(config({ MONGODB_URI_CLUSTER0: dead, MONGODB_URI_CLUSTER1: testMongoUri() }));
    try {
      await assert.rejects(connectClusters(registry, () => assert.fail('no background failure expected before the common cluster')), /./);
    } finally {
      await closeClusters(registry, () => undefined);
    }
  });

  it('reports the name of a non-Error rejection and closes every client even when one fails', async () => {
    const calls: string[] = [];
    const fake = (name: string, behavior: { connect?: unknown; close?: unknown } = {}): MongoClient =>
      ({
        connect: async () => {
          calls.push(`connect:${name}`);
          if ('connect' in behavior) throw behavior.connect;
        },
        close: async () => {
          calls.push(`close:${name}`);
          if ('close' in behavior) throw behavior.close;
        },
      }) as unknown as MongoClient;
    const shared = fake('shared');
    const registry: ClusterRegistry = {
      clusters: new Map([
        ['cluster0', { main: shared, analytics: shared }],
        ['cluster1', { main: fake('c1main', { connect: 'plain string', close: new Error('close failed') }), analytics: fake('c1an', { close: new Error('close failed too') }) }],
      ]),
      commonCluster: 'cluster0',
      defaultGroupCluster: 'cluster0',
    };
    const failures: ConnectFailure[] = [];
    const { background } = await connectClusters(registry, (failure) => failures.push(failure));
    await background;
    assert.deepEqual(calls.filter((call) => call.startsWith('connect:')).sort(), ['connect:c1an', 'connect:c1main', 'connect:shared']);
    assert.deepEqual(failures, [{ clusterId: 'cluster1', role: 'main', errorName: 'string' }]);
    const closeErrors: string[] = [];
    assert.equal(await closeClusters(registry, (clusterId, error) => closeErrors.push(`${clusterId}:${(error as Error).message}`)), false);
    assert.deepEqual(calls.filter((call) => call.startsWith('close:')).sort(), ['close:c1an', 'close:c1main', 'close:shared']);
    assert.deepEqual(closeErrors, ['cluster1:close failed', 'cluster1:close failed too']);
  });
});

describe('routing of group requests (real MongoDB, two clusters)', () => {
  let ctx: TestClusters;
  let cluster: IsolationCluster;
  let app: TestServer;
  let hex: string[];

  before(async () => {
    ctx = await openTestClusters();
    cluster = await seedIsolationCluster(ctx.databases);
    hex = cluster.groups.map((group) => group.groupId.toHexString());
    const groups = ctx.databases.common().collection('groups');
    await groups.updateOne({ _id: cluster.groups[0]!.groupId }, { $set: { dataCluster: 'cluster1' } });
    await groups.updateOne({ _id: cluster.groups[2]!.groupId }, { $set: { dataCluster: 'cluster9' } });
    await groups.updateOne({ _id: cluster.groups[3]!.groupId }, { $set: { dataCluster: 7 } });
    app = await startApp({
      routes: { v1: [isolationProbeRoute(ctx.databases)] },
      groupAccess: { groups: createGroupsRepository(ctx.databases) },
      authenticate: { v1: testAuthenticator(ctx.databases) },
    });
  });
  after(async () => {
    await app.close();
    await ctx.cleanup();
  });

  const get = async (groupIndex: number, placeIndex: 'ownPlaceId' | 'otherPlaceId' = 'ownPlaceId'): Promise<{ status: number; code: string | undefined }> => {
    const group = cluster.groups[groupIndex]!;
    const response = await fetch(`${app.baseUrl}/v1/groups/${hex[groupIndex]}/places/${group[placeIndex].toHexString()}`, {
      headers: { [TEST_USER_HEADER]: cluster.psa.toHexString() },
    });
    const body = (await response.json()) as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  };

  it('opens the database of a group declaring dataCluster on that cluster', async () => {
    reset(ctx);
    assert.deepEqual(await get(0), { status: 200, code: undefined });
    const name = `${ctx.prefix}development_${hex[0]}`;
    assert.ok(clientOf(ctx, 'cluster1:main').includes(name));
    assert.ok(!clientOf(ctx, 'cluster0:main').includes(name));
  });

  it('opens the database of a group without dataCluster on the default cluster', async () => {
    reset(ctx);
    assert.deepEqual(await get(1), { status: 200, code: undefined });
    const name = `${ctx.prefix}development_${hex[1]}`;
    assert.ok(clientOf(ctx, 'cluster0:main').includes(name));
    assert.ok(!clientOf(ctx, 'cluster1:main').includes(name));
  });

  it('answers 503 and logs group and cluster when the declared cluster is not configured or not valid', async () => {
    assert.deepEqual(await get(2), { status: 503, code: 'SERVICE_UNAVAILABLE' });
    assert.deepEqual(await get(3), { status: 503, code: 'SERVICE_UNAVAILABLE' });
    const logged = app.events.filter((event) => event['msg'] === 'data cluster not available');
    assert.deepEqual(
      logged.map((event) => [event['level'], event['groupId'], event['clusterId']]),
      [
        ['error', hex[2], 'cluster9'],
        ['error', hex[3], '[invalid]'],
      ],
    );
  });

  it('answers 404 to non-PSA, not 503, for a suspended group whose dataCluster is broken (the cluster is resolved last)', async () => {
    const group = cluster.groups[2]!;
    const groups = ctx.databases.common().collection('groups');
    await groups.updateOne({ _id: group.groupId }, { $set: { status: false } });
    try {
      const as = async (actor: ObjectId): Promise<number> =>
        (await fetch(`${app.baseUrl}/v1/groups/${hex[2]}/places/${group.ownPlaceId.toHexString()}`, { headers: { [TEST_USER_HEADER]: actor.toHexString() } })).status;
      assert.equal(await as(group.sa), 404);
      assert.equal(await as(cluster.dealerB), 404);
      assert.equal(await as(cluster.psa), 503);
    } finally {
      await groups.updateOne({ _id: group.groupId }, { $set: { status: true } });
    }
  });

  it('keeps the isolation: another group is still 404 and does not touch any cluster', async () => {
    reset(ctx);
    const response = await fetch(`${app.baseUrl}/v1/groups/${hex[1]}/places/${cluster.groups[0]!.ownPlaceId.toHexString()}`, {
      headers: { [TEST_USER_HEADER]: cluster.groups[0]!.sa.toHexString() },
    });
    assert.equal(response.status, 404);
    assert.ok(!clientOf(ctx, 'cluster1:main').some((name) => name.endsWith(hex[1]!)));
  });

  it('finds the places of the companies of a CA on the cluster of the group', async () => {
    const repository = createCompanyPlacesRepository(ctx.databases);
    const [first, second, broken] = cluster.groups as [IsolationCluster['groups'][number], IsolationCluster['groups'][number], IsolationCluster['groups'][number]];
    reset(ctx);
    const ids = await repository.listCompanyPlaceIds(first.groupId, [fixtureId('company', 1)]);
    assert.ok(ids.length > 0);
    assert.ok(clientOf(ctx, 'cluster1:main').includes(`${ctx.prefix}development_${hex[0]}`));
    reset(ctx);
    await repository.listCompanyPlaceIds(second.groupId, [fixtureId('company', 1)]);
    assert.ok(clientOf(ctx, 'cluster0:main').includes(`${ctx.prefix}development_${hex[1]}`));
    await assert.rejects(repository.listCompanyPlaceIds(broken.groupId, [fixtureId('company', 1)]), UnknownClusterError);
    assert.deepEqual(await repository.listCompanyPlaceIds(new ObjectId(), [fixtureId('company', 1)]), []);
  });
});

describe('profiling over several clusters (real MongoDB)', () => {
  let ctx: TestClusters;
  before(async () => {
    ctx = await openTestClusters();
  });
  after(async () => {
    await ctx.cleanup();
  });

  it('profiles every cluster and flags groups and databases that are not where the group declares', async () => {
    const seeded = await seedLegacyCluster(ctx.databases);
    const groups = ctx.databases.common().collection('groups');
    await groups.updateOne({ _id: seeded.groupIds[0]! }, { $set: { dataCluster: 'cluster1' } });
    await groups.updateOne({ _id: seeded.groupIds[1]! }, { $set: { dataCluster: 'nope' } });
    const versionCalls: string[] = [];
    const counting = { ...ctx.databases, serverVersion: (clusterId: string) => (versionCalls.push(clusterId), ctx.databases.serverVersion(clusterId)) };
    const report = await profileLegacy(counting, { appEnv: 'development' });
    assert.deepEqual(versionCalls, ['cluster0', 'cluster1'], 'one server version query per cluster');
    assert.equal(report.databases.groupDatabases, 4);
    assert.deepEqual(
      report.databases.clusters.map(({ clusterId, groupDatabases }) => [clusterId, groupDatabases]),
      [
        ['cluster0', 2],
        ['cluster1', 2],
      ],
    );
    // Both clusters see the same server here: group 0 declares cluster1, so its database on cluster0 is unexpected;
    // group 1 declares an unusable cluster and is counted apart.
    assert.deepEqual(report.databases.clusterPlacement, { groupsWithInvalidCluster: 1, groupsWithoutDatabaseOnExpectedCluster: 0, databasesOnUnexpectedCluster: 1 });
    assert.ok(!JSON.stringify(report.databases).includes(ctx.prefix));
  });

  it('reports a group with a usable cluster that has no database there', async () => {
    const groupId = fixtureId('group', 9999);
    await ctx.databases.common().collection('groups').insertOne({ _id: groupId, status: true, trash: false, dataCluster: 'cluster1' });
    const report = await profileLegacy(ctx.databases, { appEnv: 'development' });
    assert.equal(report.databases.clusterPlacement.groupsWithoutDatabaseOnExpectedCluster, 1);
  });
});
