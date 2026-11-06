import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { createReferenceRepository } from '../../src/modules/reference/reference.repository.ts';
import { createReferenceService } from '../../src/modules/reference/reference.service.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const group = (index: number) => office.cluster.groups[index]!;
const hex = (id: ObjectId) => id.toHexString();
const gpath = (index: number, resource: 'companies' | 'places', query = '') => `/groups/${hex(group(index).groupId)}/${resource}${query}`;

/** Extra groups of the platform: suspended, trashed, without a name, with a non-string name, with a regex-like name. */
const extraGroups = () => {
  const dealer = office.cluster.dealerA;
  return [
    legacyGroup(100, { dealerId: dealer, name: 'Suspended group', status: false }),
    legacyGroup(101, { dealerId: dealer, name: 'Trashed group', trash: true }),
    legacyGroup(102, { dealerId: dealer, name: 7 }),
    legacyGroup(103, { dealerId: dealer, name: 'Reg.Ex (a+', status: 'yes' }),
  ];
};

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
  const groups = ctx.databases.common().collection('groups');
  const documents = extraGroups();
  delete documents[2]!['name'];
  documents.push(legacyGroup(104, { dealerId: office.cluster.dealerA, name: 7 }));
  await groups.insertMany(documents);
  // Extra companies and places of group 0: a trashed company, a nameless one, a place of a trashed company and one without company.
  const g = group(0).groupId;
  const db = ctx.databases.group(g, TEST_CLUSTER);
  await db.collection('companies').insertMany([
    legacyCompany(50, g, { name: 'Trashed company', trash: true }),
    legacyCompany(51, g, { name: 'Reg.Ex (b+' }),
    legacyCompany(52, g, { name: 12 }),
  ]);
  await db.collection('places').insertMany([
    legacyPlace(50, g, fixtureId('company', 50), { name: 'Trashed place', trash: true }),
    legacyPlace(51, g, fixtureId('company', 1), { name: 'Second place of company 1' }),
    legacyPlace(52, g, fixtureId('company', 1), { name: 'Orphan place', companyId: undefined }),
  ]);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

const names = (reply: { body: { data: Array<{ name: string }> } }) => reply.body.data.map((item) => item.name);

describe('GET /v1/groups', () => {
  it('lists every active group to the PSA, with the contract fields only', async () => {
    const reply = await as.call(office.cluster.psa, 'GET', '/groups?limit=200');
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.page, { limit: 200, next: null });
    const byId = new Map(reply.body.data.map((item: { id: string }) => [item.id, item]));
    for (const g of office.cluster.groups) {
      assert.deepEqual(Object.keys(byId.get(hex(g.groupId)) as object).sort(), ['id', 'name', 'status', 'trashed']);
    }
    assert.ok(!byId.has(hex(fixtureId('group', 101))), 'trashed groups are hidden by default');
    assert.equal((byId.get(hex(fixtureId('group', 100))) as { status: string }).status, 'suspended');
    assert.equal((byId.get(hex(fixtureId('group', 103))) as { status: string }).status, 'suspended');
    assert.equal((byId.get(hex(fixtureId('group', 102))) as { name: string }).name, '');
    assert.equal((byId.get(hex(fixtureId('group', 104))) as { name: string }).name, '');
    const text = JSON.stringify(reply.body);
    for (const secret of ['apiKey', 'plain-key', 'fixture-secret', 'integration-key', 'databaseHost', 'smtp']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('filters the PSA list by status and trash', async () => {
    const suspended = await as.call(office.cluster.psa, 'GET', '/groups?status=suspended');
    assert.deepEqual(names(suspended).sort(), ['Reg.Ex (a+', 'Suspended group']);
    const active = await as.call(office.cluster.psa, 'GET', '/groups?status=active&limit=200');
    assert.ok(active.body.data.every((item: { status: string; trashed: boolean }) => item.status === 'active' && !item.trashed));
    const trashed = await as.call(office.cluster.psa, 'GET', '/groups?trashed=true');
    assert.deepEqual(trashed.body.data.map((item: { name: string; trashed: boolean }) => [item.name, item.trashed]), [['Trashed group', true]]);
    const explicit = await as.call(office.cluster.psa, 'GET', '/groups?trashed=false&limit=200');
    assert.ok(explicit.body.data.every((item: { trashed: boolean }) => !item.trashed));
  });

  it('searches the name literally, case-insensitively', async () => {
    assert.deepEqual(names(await as.call(office.cluster.psa, 'GET', '/groups?q=reg.ex%20(a%2B')), ['Reg.Ex (a+']);
    assert.deepEqual(names(await as.call(office.cluster.psa, 'GET', '/groups?q=SUSPENDED')), ['Suspended group']);
    assert.deepEqual((await as.call(office.cluster.psa, 'GET', '/groups?q=.*')).body.data, []);
  });

  it('pages by name in both directions with a stable cursor', async () => {
    for (const sort of ['name', '-name']) {
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const reply = await as.call(office.cluster.psa, 'GET', `/groups?sort=${sort}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        assert.equal(reply.status, 200);
        walked.push(...reply.body.data.map((item: { id: string }) => item.id));
        cursor = reply.body.page.next;
        if (cursor === null) {
          break;
        }
      }
      const all = await as.call(office.cluster.psa, 'GET', `/groups?sort=${sort}&limit=200`);
      assert.deepEqual(walked, all.body.data.map((item: { id: string }) => item.id));
      assert.equal(new Set(walked).size, walked.length);
      assert.ok(walked.length >= 7);
    }
    const ascending = names(await as.call(office.cluster.psa, 'GET', '/groups?limit=200'));
    assert.equal(ascending[0], '');
  });

  it('shows a dealer only his own active groups and refuses the platform filters', async () => {
    const reply = await as.call(office.cluster.dealerA, 'GET', '/groups?limit=200');
    assert.deepEqual(reply.body.data.map((item: { id: string }) => item.id).sort(), [hex(group(0).groupId), hex(group(1).groupId), hex(fixtureId('group', 102)), hex(fixtureId('group', 104))].sort());
    assert.deepEqual(names(await as.call(office.cluster.dealerB, 'GET', '/groups')).sort(), ['group-003', 'group-004']);
    assert.equal((await as.call(office.cluster.dealerA, 'GET', '/groups?trashed=false')).status, 200);
    for (const query of ['status=active', 'status=suspended', 'trashed=true']) {
      assert.deepEqual(as.failure(await as.call(office.cluster.dealerA, 'GET', `/groups?${query}`)), { status: 403, code: 'FORBIDDEN', details: undefined }, query);
    }
  });

  it('shows an SA only his own group and refuses the platform filters', async () => {
    const reply = await as.call(group(0).sa, 'GET', '/groups');
    assert.deepEqual(reply.body.data.map((item: { id: string }) => item.id), [hex(group(0).groupId)]);
    assert.equal(as.failure(await as.call(group(0).sa, 'GET', '/groups?status=active')).status, 403);
    assert.equal(as.failure(await as.call(group(0).sa, 'GET', '/groups?trashed=true')).status, 403);
  });

  it('shows nothing to an SA whose group is suspended, even when the service is reached with a stale scope', async () => {
    const groups = ctx.databases.common().collection('groups');
    await groups.updateOne({ _id: group(1).groupId }, { $set: { status: false } });
    try {
      const service = createReferenceService(createReferenceRepository(ctx.databases));
      const principal = { scope: { kind: 'group', groupId: group(1).groupId } } as unknown as AuthPrincipal;
      assert.deepEqual((await service.listGroups(principal, {})).items, []);
      const platform = { scope: { kind: 'platform' } } as unknown as AuthPrincipal;
      assert.ok((await service.listGroups(platform, { limit: 200 })).items.some((item) => item.id === hex(group(1).groupId)));
    } finally {
      await groups.updateOne({ _id: group(1).groupId }, { $set: { status: true } });
    }
  });

  it('refuses a CA and a PA (no groups:read) and an anonymous caller', async () => {
    for (const actor of [group(0).ca, group(0).pa]) {
      assert.deepEqual(as.failure(await as.call(actor, 'GET', '/groups')), { status: 403, code: 'FORBIDDEN', details: undefined });
    }
    assert.equal((await office.call('GET', '/groups', undefined)).status, 401);
  });

  it('rejects unknown parameters, other sorts and malformed values', async () => {
    for (const query of ['sort=status', 'status=maybe', 'trashed=1', 'limit=0', 'limit=201', 'foo=bar', 'cursor=!!']) {
      assert.equal((await as.call(office.cluster.psa, 'GET', `/groups?${query}`)).status, 422, query);
    }
  });
});

describe('GET /v1/groups/{groupId}/companies', () => {
  it('lists the untrashed companies of the group with the contract fields only', async () => {
    const reply = await as.call(group(0).sa, 'GET', gpath(0, 'companies'));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Reg.Ex (b+', 'company-001', 'company-002']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['id', 'name', 'trashed']);
    const text = JSON.stringify(reply.body);
    for (const secret of ['fattura_elettronica', 'fixture-secret', 'fixture-user', 'Via Fixture', 'banks']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('filters trash, searches the name and pages by name', async () => {
    const trashed = await as.call(office.cluster.psa, 'GET', gpath(0, 'companies', '?trashed=true'));
    assert.deepEqual(trashed.body.data.map((item: { name: string; trashed: boolean }) => [item.name, item.trashed]), [['Trashed company', true]]);
    assert.deepEqual(names(await as.call(group(0).sa, 'GET', gpath(0, 'companies', '?q=reg.ex%20(b%2B'))), ['Reg.Ex (b+']);
    const first = await as.call(group(0).sa, 'GET', gpath(0, 'companies', '?limit=3&sort=-name'));
    assert.deepEqual(names(first), ['company-002', 'company-001', 'Reg.Ex (b+']);
    const second = await as.call(group(0).sa, 'GET', gpath(0, 'companies', `?limit=3&sort=-name&cursor=${first.body.page.next}`));
    assert.deepEqual([names(second), second.body.page.next], [[''], null]);
  });

  it('applies the perimeter: a CA sees his companies only, a PA has no companies:read', async () => {
    assert.deepEqual(names(await as.call(group(0).ca, 'GET', gpath(0, 'companies'))), ['company-001']);
    assert.deepEqual(as.failure(await as.call(group(0).pa, 'GET', gpath(0, 'companies'))), { status: 403, code: 'FORBIDDEN', details: undefined });
  });

  it('keeps every group to its callers', async () => {
    assert.equal((await as.call(office.cluster.psa, 'GET', gpath(2, 'companies'))).status, 200);
    assert.equal((await as.call(office.cluster.dealerA, 'GET', gpath(1, 'companies'))).status, 200);
    for (const [actor, index] of [
      [office.cluster.dealerA, 2],
      [office.cluster.dealerB, 0],
      [group(0).sa, 1],
      [group(0).sa, 2],
      [group(0).ca, 1],
    ] as const) {
      assert.deepEqual(as.failure(await as.call(actor, 'GET', gpath(index, 'companies'))), { status: 404, code: 'NOT_FOUND', details: undefined });
    }
    assert.equal((await as.call(office.cluster.psa, 'GET', '/groups/not-a-group/companies')).status, 404);
    assert.equal((await as.call(office.cluster.psa, 'GET', gpath(0, 'companies', '?foo=1'))).status, 422);
  });

  it('shows the companies of group B only in group B', async () => {
    assert.deepEqual(names(await as.call(group(2).sa, 'GET', gpath(2, 'companies'))), ['company-005', 'company-006']);
  });
});

describe('GET /v1/groups/{groupId}/places', () => {
  it('lists the untrashed places with their company and the contract fields only', async () => {
    const reply = await as.call(group(0).sa, 'GET', gpath(0, 'places'));
    assert.equal(reply.status, 200);
    assert.deepEqual(
      reply.body.data.map((item: { name: string; companyId: string | null }) => [item.name, item.companyId]),
      [
        ['Orphan place', null],
        ['Second place of company 1', hex(fixtureId('company', 1))],
        ['place-001', hex(fixtureId('company', 1))],
        ['place-002', hex(fixtureId('company', 2))],
      ],
    );
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['companyId', 'id', 'name', 'trashed']);
    const text = JSON.stringify(reply.body);
    for (const secret of ['integration', 'fixture-integration-secret', '10.0.0.1', 'apiKey', 'storages', 'devices']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('filters by company and trash', async () => {
    const one = await as.call(group(0).sa, 'GET', gpath(0, 'places', `?companyId=${hex(fixtureId('company', 2))}`));
    assert.deepEqual(names(one), ['place-002']);
    const trashed = await as.call(group(0).sa, 'GET', gpath(0, 'places', '?trashed=true'));
    assert.deepEqual(trashed.body.data.map((item: { name: string; trashed: boolean }) => [item.name, item.trashed]), [['Trashed place', true]]);
    assert.equal((await as.call(group(0).sa, 'GET', gpath(0, 'places', '?companyId=nope'))).status, 422);
  });

  it('applies the perimeter: a company outside it gives an empty page, not an error', async () => {
    assert.deepEqual(names(await as.call(group(0).ca, 'GET', gpath(0, 'places'))), ['Second place of company 1', 'place-001']);
    const outside = await as.call(group(0).ca, 'GET', gpath(0, 'places', `?companyId=${hex(fixtureId('company', 2))}`));
    assert.deepEqual([outside.status, outside.body.data], [200, []]);
    assert.deepEqual(names(await as.call(group(0).pa, 'GET', gpath(0, 'places'))), ['place-001']);
    const paOther = await as.call(group(0).pa, 'GET', gpath(0, 'places', `?companyId=${hex(fixtureId('company', 2))}`));
    assert.deepEqual(paOther.body.data, []);
    assert.deepEqual(names(await as.call(group(0).pa, 'GET', gpath(0, 'places', `?companyId=${hex(fixtureId('company', 1))}`))), ['place-001']);
  });

  it('keeps every group to its callers and searches and pages', async () => {
    for (const [actor, index] of [
      [office.cluster.dealerA, 2],
      [group(0).sa, 1],
      [group(0).pa, 1],
    ] as const) {
      assert.deepEqual(as.failure(await as.call(actor, 'GET', gpath(index, 'places'))), { status: 404, code: 'NOT_FOUND', details: undefined });
    }
    assert.deepEqual(names(await as.call(office.cluster.dealerA, 'GET', gpath(1, 'places'))), ['place-003', 'place-004']);
    assert.deepEqual(names(await as.call(group(0).sa, 'GET', gpath(0, 'places', '?q=ORPHAN'))), ['Orphan place']);
    const page = await as.call(group(0).sa, 'GET', gpath(0, 'places', '?limit=1'));
    assert.deepEqual([names(page), typeof page.body.page.next], [['Orphan place'], 'string']);
    assert.equal((await office.call('GET', gpath(0, 'places'), undefined)).status, 401);
  });
});
