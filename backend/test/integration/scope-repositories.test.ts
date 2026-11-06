import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { createCompanyPlacesRepository } from '../../src/shared/security/scope/company-places.repository.ts';
import { createDealerGroupsRepository } from '../../src/shared/security/scope/dealer-groups.repository.ts';
import { accessFor } from '../helpers/group-access.ts';
import { createGroupsRepository } from '../../src/shared/security/scope/groups.repository.ts';
import { fixtureId, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { seedIsolationCluster } from '../helpers/isolation.ts';
import type { IsolationCluster } from '../helpers/isolation.ts';
import { openTestDatabases, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalFromLegacyUser } from '../helpers/principal.ts';

let ctx: TestDatabases;
let cluster: IsolationCluster;
const hexes = (ids: readonly ObjectId[]): string[] => ids.map((id) => id.toHexString()).sort();

const owned = {
  active: fixtureId('group', 70),
  suspended: fixtureId('group', 71),
  trashed: fixtureId('group', 72),
  stringDealer: fixtureId('group', 73),
  nonDealerOwner: fixtureId('group', 74),
  noStatus: fixtureId('group', 75),
  textStatus: fixtureId('group', 76),
};

before(async () => {
  ctx = await openTestDatabases();
  cluster = await seedIsolationCluster(ctx.databases);
  const dealer = cluster.dealerA;
  const sa = cluster.groups[0]!.sa;
  const groups = ctx.databases.common().collection('groups');
  const make = (n: number, overrides: Record<string, unknown>) => ({ ...legacyGroup(n), ...overrides, _id: fixtureId('group', n) });
  await groups.insertMany([
    make(70, { dealerId: dealer }),
    make(71, { dealerId: dealer, status: false }),
    make(72, { dealerId: dealer, trash: true }),
    make(73, { dealerId: dealer.toHexString() }),
    make(74, { dealerId: sa }),
    { ...make(75, { dealerId: dealer }), status: undefined },
    make(76, { dealerId: dealer, status: 'true' }),
  ].map((group) => Object.fromEntries(Object.entries(group).filter(([, value]) => value !== undefined))));
});
after(() => ctx.cleanup());

describe('dealer groups: only available groups owned through an ObjectId dealerId', () => {
  it('excludes suspended, trashed, string-owned and status-less groups', async () => {
    const listed = await createDealerGroupsRepository(ctx.databases).listDealerGroupIds(cluster.dealerA);
    assert.deepEqual(hexes(listed), hexes([...cluster.groups.slice(0, 2).map((g) => g.groupId), owned.active]));
  });

  it('a group owned by a user who is not a dealer gives the dealer view to nobody', async () => {
    const lookups = { ...createDealerGroupsRepository(ctx.databases), ...createCompanyPlacesRepository(ctx.databases) };
    const users = ctx.databases.common().collection('users');
    const saUser = (await users.findOne({ _id: cluster.groups[0]!.sa }))!;
    const principal = await principalFromLegacyUser(saUser, lookups);
    // The SA keeps the scope of his own group, whoever "owns" another group through dealerId.
    assert.equal(principal.scope.kind, 'group');
    assert.equal(await accessFor(principal, owned.nonDealerOwner.toHexString()), null);
    // Another dealer does not get it either.
    const dealerB = await principalFromLegacyUser((await users.findOne({ _id: cluster.dealerB }))!, lookups);
    assert.equal(await accessFor(dealerB, owned.nonDealerOwner.toHexString()), null);
    // And a real dealer does not see the groups of the other dealer's users.
    assert.equal(await accessFor(dealerB, owned.stringDealer.toHexString()), null);
  });

  it('a SA with leftover companyId, placeId and placesId keeps the scope of his group', async () => {
    const lookups = { ...createDealerGroupsRepository(ctx.databases), ...createCompanyPlacesRepository(ctx.databases) };
    const group = cluster.groups[0]!;
    const sa = { _id: group.sa, role: 'SA', groupId: group.groupId, companyId: fixtureId('company', 2), placeId: fixtureId('place', 2), placesId: [fixtureId('place', 2)], permissions: { status: true } };
    const principal = await principalFromLegacyUser(sa, lookups);
    assert.equal(principal.scope.kind, 'group');
    assert.deepEqual(principal.scope, { kind: 'group', groupId: group.groupId });
  });
});

describe('groups repository: availability', () => {
  it('distinguishes available, unavailable and missing groups', async () => {
    const repository = createGroupsRepository(ctx.databases);
    assert.equal(await repository.findAvailability(owned.active), 'available');
    for (const id of [owned.suspended, owned.trashed, owned.noStatus, owned.textStatus]) {
      assert.equal(await repository.findAvailability(id), 'unavailable', id.toHexString());
    }
    assert.equal(await repository.findAvailability(fixtureId('group', 999)), null);
  });
});

describe('company places repository', () => {
  it('lists the places of the companies, trashed ones included, ids only', async () => {
    const group = cluster.groups[0]!;
    const db = ctx.databases.group(group.groupId, TEST_CLUSTER);
    await db.collection('places').insertOne(legacyPlace(3000, group.groupId, fixtureId('company', 1), { trash: true }));
    const repository = createCompanyPlacesRepository(ctx.databases);
    assert.deepEqual(hexes(await repository.listCompanyPlaceIds(group.groupId, [fixtureId('company', 1)])), hexes([group.ownPlaceId, fixtureId('place', 3000)]));
    assert.equal((await repository.listCompanyPlaceIds(group.groupId, [fixtureId('company', 1), fixtureId('company', 2)])).length, 3);
  });

  it('gives nothing for companies without places or that do not exist', async () => {
    const repository = createCompanyPlacesRepository(ctx.databases);
    assert.deepEqual(await repository.listCompanyPlaceIds(cluster.groups[0]!.groupId, [fixtureId('company', 12345)]), []);
  });

  it('does not reach into another group database', async () => {
    const repository = createCompanyPlacesRepository(ctx.databases);
    assert.deepEqual(await repository.listCompanyPlaceIds(cluster.groups[1]!.groupId, [fixtureId('company', 1)]), []);
  });

  it('fails closed above the cap', async () => {
    const group = cluster.groups[0]!;
    await assert.rejects(createCompanyPlacesRepository(ctx.databases, 1).listCompanyPlaceIds(group.groupId, [fixtureId('company', 1)]), /more than 1 places/);
    assert.equal((await createCompanyPlacesRepository(ctx.databases, 2).listCompanyPlaceIds(group.groupId, [fixtureId('company', 1)])).length, 2);
  });
});
