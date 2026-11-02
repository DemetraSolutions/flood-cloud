import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Collection, Document, Filter, ObjectId } from 'mongodb';
import { createCompanyPlacesRepository } from '../../src/shared/security/scope/company-places.repository.ts';
import { createDealerGroupsRepository } from '../../src/shared/security/scope/dealer-groups.repository.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import type { Scope } from '../../src/shared/security/scope/scope.ts';
import { companiesScopeFilter, placesScopeFilter, usersScopeFilter, withScope } from '../../src/shared/security/scope/scope-filters.ts';
import { seedIsolationCluster } from '../helpers/isolation.ts';
import type { IsolationCluster } from '../helpers/isolation.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { fixtureId, legacyUser } from '../helpers/legacy-fixtures.ts';
import { principalFromLegacyUser } from '../helpers/principal.ts';

let ctx: TestDatabases;
let cluster: IsolationCluster;

before(async () => {
  ctx = await openTestDatabases();
  cluster = await seedIsolationCluster(ctx.databases);
});
after(() => ctx.cleanup());

const hexes = (ids: readonly ObjectId[]): string[] => ids.map((id) => id.toHexString()).sort();

describe('dealer groups repository (real MongoDB)', () => {
  it('lists the groups whose dealerId is the dealer, with only the id', async () => {
    const repository = createDealerGroupsRepository(ctx.databases);
    assert.deepEqual(hexes(await repository.listDealerGroupIds(cluster.dealerA)), hexes(cluster.groups.slice(0, 2).map((g) => g.groupId)));
    assert.deepEqual(hexes(await repository.listDealerGroupIds(cluster.dealerB)), hexes(cluster.groups.slice(2).map((g) => g.groupId)));
    assert.deepEqual(await repository.listDealerGroupIds(cluster.psa), []);
  });

  it('fails closed instead of truncating a dealer above the cap', async () => {
    await assert.rejects(createDealerGroupsRepository(ctx.databases, 1).listDealerGroupIds(cluster.dealerA), /more than 1 groups/);
    assert.equal((await createDealerGroupsRepository(ctx.databases, 2).listDealerGroupIds(cluster.dealerA)).length, 2);
  });
});

describe('scope filters on real documents', () => {
  const g0 = 0;
  const principals = async (): Promise<Record<string, AuthPrincipal>> => {
    const lookups = { ...createDealerGroupsRepository(ctx.databases), ...createCompanyPlacesRepository(ctx.databases) };
    const group = cluster.groups[g0]!;
    const users = ctx.databases.common().collection('users');
    const load = async (id: ObjectId): Promise<AuthPrincipal> => principalFromLegacyUser((await users.findOne({ _id: id }))!, lookups);
    return {
      platform: await load(cluster.psa),
      dealer: await load(cluster.dealerA),
      group: await load(group.sa),
      companies: await load(group.ca),
      places: await load(group.pa),
      none: await load(group.employee),
    };
  };
  const count = (collection: Collection, filter: Filter<Document>): Promise<number> => collection.countDocuments(filter);

  it('computes the places of a CA from the group database', async () => {
    const companies = (await principals())['companies']!;
    assert.equal(companies.scope.kind, 'companies');
    assert.deepEqual((companies.scope as Extract<Scope, { kind: 'companies' }>).placeIds.map((id) => id.toHexString()), [cluster.groups[g0]!.ownPlaceId.toHexString()]);
  });

  it('restricts users to the perimeter and to the roles the principal manages', async () => {
    const users = ctx.databases.common().collection('users');
    const p = await principals();
    const counts: Record<string, number> = {};
    for (const [name, principal] of Object.entries(p)) {
      counts[name] = await count(users, usersScopeFilter(principal));
    }
    assert.deepEqual(counts, { platform: 3 + 4 * cluster.groups.length, dealer: 8, group: 4, companies: 2, places: 1, none: 0 });
    const roles = async (name: string): Promise<string[]> => (await users.find(usersScopeFilter(p[name]!)).toArray()).map((u) => u['role'] as string).sort();
    assert.deepEqual(await roles('group'), ['CA', 'E', 'PA', 'SA']);
    assert.deepEqual(await roles('companies'), ['CA', 'PA']);
    assert.deepEqual(await roles('places'), ['PA']);
  });

  it('reaches a CA through his companies and a PA through the places, never through the legacy companyId of a PA', async () => {
    const users = ctx.databases.common().collection('users');
    const group = cluster.groups[g0]!;
    const c1 = fixtureId('company', 1);
    const c2 = fixtureId('company', 2);
    const inserted = await users.insertMany([
      // PA whose legacy company is the CA's, but whose place is elsewhere: must not appear.
      legacyUser(4001, { role: 'PA', groupId: group.groupId, companyId: c1, placeId: group.otherPlaceId, placesId: [group.otherPlaceId] }),
      // CA of another company with a leftover placeId inside one of the CA's companies: must not appear.
      legacyUser(4002, { role: 'CA', groupId: group.groupId, companyId: c2, placeId: group.ownPlaceId, placesId: [group.ownPlaceId] }),
      // PA with the place in the CA's company but no company at all: must appear.
      legacyUser(4003, { role: 'PA', groupId: group.groupId, companyId: null, placeId: group.ownPlaceId, placesId: [] }),
    ]);
    try {
      const p = await principals();
      const found = (await users.find(usersScopeFilter(p['companies']!)).toArray()).map((user) => user._id.toHexString());
      assert.ok(!found.includes(fixtureId('user', 4001).toHexString()));
      assert.ok(!found.includes(fixtureId('user', 4002).toHexString()));
      assert.ok(found.includes(fixtureId('user', 4003).toHexString()));
      assert.equal(found.length, 3);
    } finally {
      await users.deleteMany({ _id: { $in: Object.values(inserted.insertedIds) } });
    }
  });

  it('does not show PSA and D to a SA, nor other dealers to a dealer', async () => {
    const users = ctx.databases.common().collection('users');
    const p = await principals();
    const hidden = await users.find({ role: { $in: ['PSA', 'D'] } }).toArray();
    assert.equal(hidden.length, 3);
    for (const name of ['dealer', 'group', 'companies', 'places']) {
      const visible = await users.find(usersScopeFilter(p[name]!)).toArray();
      assert.ok(visible.every((user) => user['role'] !== 'PSA' && user['role'] !== 'D'), name);
    }
  });

  it('shows users without a role as E', async () => {
    const users = ctx.databases.common().collection('users');
    const group = cluster.groups[g0]!;
    const { insertedId } = await users.insertOne({ userName: 'no-role', groupId: group.groupId, placeId: group.ownPlaceId, placesId: [group.ownPlaceId] });
    try {
      const p = await principals();
      assert.equal(await count(users, usersScopeFilter(p['group']!)), 5);
      assert.equal(await count(users, usersScopeFilter(p['places']!)), 2);
    } finally {
      await users.deleteOne({ _id: insertedId });
    }
  });

  it('a query filter can only narrow the scope, never widen it (withScope)', async () => {
    const users = ctx.databases.common().collection('users');
    const p = await principals();
    const other = cluster.groups[1]!.groupId;
    assert.equal(await count(users, withScope(usersScopeFilter(p['group']!), { $or: [{ groupId: other }, {}] })), 4);
    assert.equal(await count(users, withScope(usersScopeFilter(p['group']!), { groupId: other })), 0);
    assert.equal(await count(users, withScope(usersScopeFilter(p['group']!), { $or: [{ role: 'PSA' }, { role: 'D' }] })), 0);
    assert.equal(await count(users, withScope(usersScopeFilter(p['places']!), { $or: [{ role: 'SA' }, { role: 'PA' }] })), 1);
    assert.equal(await count(users, withScope(usersScopeFilter(p['none']!), {})), 0);
    // Contrast: a plain spread would let the query override the scope.
    assert.ok((await count(users, { ...usersScopeFilter(p['group']!), groupId: other })) > 0);
  });

  it('restricts companies and places of a group database', async () => {
    const db = ctx.databases.group(cluster.groups[g0]!.groupId);
    const result: Record<string, [number, number]> = {};
    for (const [name, principal] of Object.entries(await principals())) {
      result[name] = [await count(db.collection('companies'), companiesScopeFilter(principal.scope)), await count(db.collection('places'), placesScopeFilter(principal.scope))];
    }
    assert.deepEqual(result, { platform: [2, 2], dealer: [2, 2], group: [2, 2], companies: [1, 1], places: [0, 1], none: [0, 0] });
  });
});
