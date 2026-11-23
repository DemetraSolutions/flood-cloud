import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { MAX_LIMIT } from '../../src/shared/http/list.ts';
import { countMirrorByGroups } from '../../src/shared/security/scope/group-mirror.ts';
import { countByGroupPipeline } from '../../src/shared/security/scope/group-counts.ts';
import { createReferenceRepository } from '../../src/modules/reference/reference.repository.ts';
import { createReferenceService } from '../../src/modules/reference/reference.service.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace, legacyUser } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const g3 = fixtureId('group', 3);
const g4 = fixtureId('group', 4);
const empty = fixtureId('group', 9);
const NONE = { active: 0, trashed: 0 };
let ctx: TestDatabases;

before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS);
  const company = fixtureId('company', 1);
  await ctx.databases.common().collection('groups').insertMany([g1, g2, g3, g4, empty].map((id, index) => ({ ...legacyGroup(index + 1), _id: id })));
  await insertCopies(ctx.databases, 'companies', [
    legacyCompany(1, g1),
    legacyCompany(2, g1),
    legacyCompany(3, g1, { trash: true }),
    legacyCompany(4, g2, { trash: 'yes' }),
    legacyCompany(5, g3),
    legacyCompany(6, g1, { groupId: [g1, g2] }),
    legacyCompany(7, g1, { groupId: g1.toHexString() }),
    legacyCompany(8, g1, { groupId: undefined }),
    legacyCompany(9, g1, { groupId: null }),
  ]);
  await insertCopies(ctx.databases, 'places', [
    legacyPlace(1, g1, company),
    legacyPlace(2, g1, company, { trash: true }),
    legacyPlace(3, g1, company, { trash: true }),
    legacyPlace(4, g3, company, { trash: false }),
    legacyPlace(5, g1, company, { groupId: [g1] }),
  ]);
  await ctx.databases.common().collection('users').insertMany([
    legacyUser(1, { groupId: g1 }),
    legacyUser(2, { groupId: g1, status: false }),
    legacyUser(3, { groupId: g1, trash: true }),
    legacyUser(4, { groupId: g2, trash: true }),
    legacyUser(5, { groupId: g3 }),
    legacyUser(6, { groupId: [g1, g2] }),
    legacyUser(7, { groupId: g1.toHexString() }),
    legacyUser(8, { groupId: null }),
  ]);
});
after(() => ctx.cleanup());

const asPlain = (map: Map<string, unknown>) => Object.fromEntries(map);
const hex = (id: ObjectId) => id.toHexString();

describe('countMirrorByGroups', () => {
  it('counts active and trashed copies by group, ignoring groups outside the list and malformed groupId', async () => {
    const companies = await countMirrorByGroups(ctx.databases, 'companies', [g1, g2, empty]);
    assert.deepEqual(asPlain(companies), { [hex(g1)]: { active: 2, trashed: 1 }, [hex(g2)]: { active: 1, trashed: 0 }, [hex(empty)]: NONE });
    assert.ok(!companies.has(hex(g3)));
    const places = await countMirrorByGroups(ctx.databases, 'places', [g1, g3]);
    assert.deepEqual(asPlain(places), { [hex(g1)]: { active: 1, trashed: 2 }, [hex(g3)]: { active: 1, trashed: 0 } });
  });

  it('rejects an empty list, a list with a non-ObjectId, a list that is too long and an unknown collection', async () => {
    await assert.rejects(countMirrorByGroups(ctx.databases, 'companies', []), /group ids/);
    await assert.rejects(countMirrorByGroups(ctx.databases, 'companies', [g1, hex(g2) as unknown as ObjectId]), /group ids/);
    await assert.rejects(countMirrorByGroups(ctx.databases, 'places', { length: 1 } as unknown as ObjectId[]), /group ids/);
    await assert.rejects(countMirrorByGroups(ctx.databases, 'places', Array.from({ length: MAX_LIMIT + 1 }, () => new ObjectId())), /group ids/);
    assert.equal((await countMirrorByGroups(ctx.databases, 'places', Array.from({ length: MAX_LIMIT }, () => new ObjectId()))).size, MAX_LIMIT);
    await assert.rejects(countMirrorByGroups(ctx.databases, 'groups' as 'places', [g1]), /Not a copy collection/);
  });

  it('uses an index with the groupId prefix, never a collection scan', async () => {
    for (const name of ['companies', 'places'] as const) {
      const plan = JSON.stringify(await ctx.databases.common().collection(name).aggregate(countByGroupPipeline([g1, g2])).explain('queryPlanner'));
      assert.ok(plan.includes('IXSCAN') && !plan.includes('COLLSCAN'), name);
      assert.match(plan, /groupId_1_/);
    }
    const users = JSON.stringify(await ctx.databases.common().collection('users').aggregate(countByGroupPipeline([g1, g2])).explain('queryPlanner'));
    assert.ok(users.includes('IXSCAN') && !users.includes('COLLSCAN'));
    assert.ok(users.includes('groupId_1_role_1'));
  });
});

describe('reference repository and service: counts of a page of groups', () => {
  it('counts companies, places and users, trashed apart, with zeros for an empty group', async () => {
    const repository = createReferenceRepository(ctx.databases);
    const counts = await repository.countGroupsContents([g1, g2, g3, g4, empty]);
    assert.deepEqual(counts.get(hex(g1)), { companies: { active: 2, trashed: 1 }, places: { active: 1, trashed: 2 }, users: { active: 2, trashed: 1 } });
    assert.deepEqual(counts.get(hex(g2)), { companies: { active: 1, trashed: 0 }, places: NONE, users: { active: 0, trashed: 1 } });
    assert.deepEqual(counts.get(hex(g3)), { companies: { active: 1, trashed: 0 }, places: { active: 1, trashed: 0 }, users: { active: 1, trashed: 0 } });
    assert.deepEqual(counts.get(hex(empty)), { companies: NONE, places: NONE, users: NONE });
    await assert.rejects(repository.countGroupsContents([]), /group ids/);
  });

  it('never counts groups outside the page', async () => {
    const counts = await createReferenceRepository(ctx.databases).countGroupsContents([g3]);
    assert.deepEqual([...counts.keys()], [hex(g3)]);
    assert.deepEqual(counts.get(hex(g3))!.users, { active: 1, trashed: 0 });
  });

  it('runs exactly three count aggregations per page, whatever its length', async () => {
    const repository = createReferenceRepository(ctx.databases);
    const spy = mock.method(Collection.prototype, 'aggregate');
    try {
      for (const ids of [[g1], [g1, g2, g3, g4, empty]]) {
        spy.mock.resetCalls();
        await repository.countGroupsContents(ids);
        assert.equal(spy.mock.callCount(), 3);
      }
      spy.mock.resetCalls();
      const service = createReferenceService(repository);
      const platform = { scope: { kind: 'platform' } } as unknown as AuthPrincipal;
      const page = await service.listGroups(platform, { limit: 200 });
      assert.equal(page.items.length, 5);
      assert.equal(spy.mock.callCount(), 4, 'the page itself plus three counts');
      assert.deepEqual(page.items.find((item) => item.id === hex(g1))!.counts.users, { active: 2, trashed: 1 });
    } finally {
      spy.mock.restore();
    }
  });

  it('runs no count for an empty page', async () => {
    const service = createReferenceService(createReferenceRepository(ctx.databases));
    const none = { scope: { kind: 'group', groupId: new ObjectId() } } as unknown as AuthPrincipal;
    const spy = mock.method(Collection.prototype, 'aggregate');
    try {
      assert.deepEqual((await service.listGroups(none, {})).items, []);
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
  });

  it('shows a group administrator the counts of his own group only', async () => {
    const service = createReferenceService(createReferenceRepository(ctx.databases));
    const sa = { scope: { kind: 'group', groupId: g2 } } as unknown as AuthPrincipal;
    const { items } = await service.listGroups(sa, {});
    assert.deepEqual(items.map((item) => item.id), [hex(g2)]);
    assert.deepEqual(items[0]!.counts, { companies: { active: 1, trashed: 0 }, places: NONE, users: { active: 0, trashed: 1 } });
  });
});
