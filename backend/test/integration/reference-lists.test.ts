import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createReferenceRepository } from '../../src/modules/reference/reference.repository.ts';
import { createReferenceService } from '../../src/modules/reference/reference.service.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
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
  // Extra companies and places of group 0 (in the copies of the common database): a trashed company, a nameless one, a place of a trashed company and one without company.
  const g = group(0).groupId;
  await insertCopies(ctx.databases, 'companies', [
    legacyCompany(50, g, { name: 'Trashed company', trash: true }),
    legacyCompany(51, g, { name: 'Reg.Ex (b+' }),
    legacyCompany(52, g, { name: 12 }),
  ]);
  await insertCopies(ctx.databases, 'places', [
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
      assert.deepEqual(Object.keys(byId.get(hex(g.groupId)) as object).sort(), ['counts', 'dealerId', 'demo', 'id', 'name', 'status', 'trashed']);
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

  it('carries the counts of the common database on every group, a dealer seeing only those of his own groups', async () => {
    const countOf = async (id: ObjectId, name: 'companies' | 'places' | 'users') =>
      ({
        active: await ctx.databases.common().collection(name).countDocuments({ groupId: id, trash: { $ne: true } }),
        trashed: await ctx.databases.common().collection(name).countDocuments({ groupId: id, trash: true }),
      });
    const psa = await as.call(office.cluster.psa, 'GET', '/groups?limit=200');
    const dealer = await as.call(office.cluster.dealerA, 'GET', '/groups?limit=200');
    assert.ok(dealer.body.data.length < psa.body.data.length);
    for (const item of psa.body.data as Array<{ id: string; counts: Record<string, unknown> }>) {
      const id = new ObjectId(item.id);
      assert.deepEqual(item.counts, { companies: await countOf(id, 'companies'), places: await countOf(id, 'places'), users: await countOf(id, 'users') }, item.id);
    }
    assert.deepEqual((await as.call(group(0).sa, 'GET', `/groups/${hex(group(0).groupId)}`)).body.data.counts, undefined);
    const empty = psa.body.data.find((item: { id: string }) => item.id === hex(fixtureId('group', 102)));
    assert.deepEqual(empty.counts, { companies: { active: 0, trashed: 0 }, places: { active: 0, trashed: 0 }, users: { active: 0, trashed: 0 } });
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

describe('GET /v1/groups/{groupId}/companies (the compact fields the reference store reads)', () => {
  it('lists the untrashed companies of the group with the contract fields only', async () => {
    const reply = await as.call(group(0).sa, 'GET', gpath(0, 'companies'));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Reg.Ex (b+', 'company-001', 'company-002']);
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['city', 'country', 'id', 'name', 'province', 'status', 'trashed', 'vatNumber']);
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
    assert.deepEqual(Object.keys(reply.body.data[0]).sort(), ['city', 'companyId', 'country', 'expirationDate', 'id', 'name', 'plan', 'province', 'status', 'trashed']);
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

describe('the ids parameter of the companies and places lists', () => {
  const c = (n: number) => hex(fixtureId('company', n));
  const pl = (n: number) => hex(fixtureId('place', n));

  it('resolves the given companies, ignoring case and repeats, inside the perimeter', async () => {
    const sa = await as.call(group(0).sa, 'GET', gpath(0, 'companies', `?ids=${c(2)},${c(1).toUpperCase()},${c(1)}`));
    assert.deepEqual(names(sa), ['company-001', 'company-002']);
    // A CA holds only company 1: company 2 and a company of another group are not returned.
    const ca = await as.call(group(0).ca, 'GET', gpath(0, 'companies', `?ids=${c(1)},${c(2)},${c(5)}`));
    assert.deepEqual(names(ca), ['company-001']);
    assert.deepEqual((await as.call(group(0).sa, 'GET', gpath(0, 'companies', `?ids=${c(5)}`))).body.data, []);
  });

  it('resolves the given places, ignoring case and repeats, inside the perimeter', async () => {
    const sa = await as.call(group(0).sa, 'GET', gpath(0, 'places', `?ids=${pl(2)},${pl(1).toUpperCase()},${pl(1)}`));
    assert.deepEqual(names(sa), ['place-001', 'place-002']);
    const ca = await as.call(group(0).ca, 'GET', gpath(0, 'places', `?ids=${pl(1)},${pl(2)}`));
    assert.deepEqual(names(ca), ['place-001']);
    const pa = await as.call(group(0).pa, 'GET', gpath(0, 'places', `?ids=${pl(1)},${pl(2)},${pl(3)}`));
    assert.deepEqual(names(pa), ['place-001']);
    assert.deepEqual((await as.call(group(0).sa, 'GET', gpath(0, 'places', `?ids=${pl(3)}`))).body.data, []);
    assert.deepEqual(names(await as.call(group(0).sa, 'GET', gpath(0, 'places', `?ids=${pl(1)},${pl(2)}&companyId=${c(2)}`))), ['place-002']);
  });

  it('rejects a malformed or oversized list with 422 and accepts exactly 100', async () => {
    for (const resource of ['companies', 'places'] as const) {
      for (const ids of ['not-an-id', `${c(1)},`, Array(101).fill(c(1)).join(',')]) {
        assert.equal(as.failure(await as.call(group(0).sa, 'GET', gpath(0, resource, `?ids=${ids}`))).status, 422, ids);
      }
      assert.equal((await as.call(group(0).sa, 'GET', gpath(0, resource, `?ids=${Array(100).fill(c(1)).join(',')}`))).status, 200);
    }
  });
});

describe('the lists read the copies of their own group only', () => {
  const strayCompany = fixtureId('company', 70);
  const foreignCompany = fixtureId('company', 71);
  const stringGroupCompany = fixtureId('company', 72);
  const strayPlace = fixtureId('place', 70);
  const foreignPlace = fixtureId('place', 71);

  before(async () => {
    const g0 = group(0).groupId;
    const g1 = group(1).groupId;
    await insertCopies(ctx.databases, 'companies', [
      legacyCompany(70, g0, { name: 'Stray company', groupId: undefined }),
      legacyCompany(71, g1, { name: 'company-001' }),
      legacyCompany(72, g0, { name: 'String group company', groupId: g0.toHexString() }),
    ]);
    await insertCopies(ctx.databases, 'places', [
      legacyPlace(70, g0, fixtureId('company', 1), { name: 'Stray place', groupId: undefined }),
      legacyPlace(71, g1, fixtureId('company', 1), { name: 'place-001' }),
    ]);
  });

  it('ignores a copy without groupId, with the groupId of another group or with a groupId of another type', async () => {
    const companies = await as.call(group(0).sa, 'GET', gpath(0, 'companies', '?limit=200'));
    assert.deepEqual(names(companies), ['', 'Reg.Ex (b+', 'company-001', 'company-002']);
    const places = await as.call(group(0).sa, 'GET', gpath(0, 'places', '?limit=200'));
    assert.deepEqual(names(places), ['Orphan place', 'Second place of company 1', 'place-001', 'place-002']);
    // The same name in two groups is two different copies: each group sees its own.
    assert.deepEqual(names(await as.call(group(1).sa, 'GET', gpath(1, 'companies', '?q=company-001'))), ['company-001']);
    assert.deepEqual(names(await as.call(group(0).sa, 'GET', gpath(0, 'companies', '?q=company-001'))), ['company-001']);
    assert.deepEqual(
      (await as.call(group(0).sa, 'GET', gpath(0, 'companies', '?q=company-001'))).body.data.map((item: { id: string }) => item.id),
      [hex(fixtureId('company', 1))],
    );
  });

  it('does not resolve through ids a copy of another group, nor one without a group', async () => {
    const ids = (...list: ObjectId[]) => list.map(hex).join(',');
    assert.deepEqual((await as.call(group(0).sa, 'GET', gpath(0, 'companies', `?ids=${ids(strayCompany, foreignCompany, stringGroupCompany)}`))).body.data, []);
    assert.deepEqual((await as.call(group(0).sa, 'GET', gpath(0, 'places', `?ids=${ids(strayPlace, foreignPlace)}`))).body.data, []);
    assert.deepEqual(names(await as.call(group(1).sa, 'GET', gpath(1, 'companies', `?ids=${ids(foreignCompany, strayCompany)}`))), ['company-001']);
    assert.deepEqual(names(await as.call(group(1).sa, 'GET', gpath(1, 'places', `?ids=${ids(foreignPlace, strayPlace)}`))), ['place-001']);
  });

  it('never returns the integrations or any other field outside the contract', async () => {
    const text = JSON.stringify([
      (await as.call(office.cluster.psa, 'GET', gpath(1, 'places', '?limit=200'))).body,
      (await as.call(office.cluster.psa, 'GET', gpath(1, 'companies', '?limit=200'))).body,
    ]);
    for (const secret of ['integrations', 'dojo', 'fixture-integration-secret', 'fattura_elettronica', 'fixture-secret', 'groupId']) {
      assert.ok(!text.includes(secret), secret);
    }
  });
});
