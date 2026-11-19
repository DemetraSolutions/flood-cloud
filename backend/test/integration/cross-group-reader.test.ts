import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { listParamsOf } from '../../src/shared/http/list.ts';
import { assertCrossGroupAccess, readCrossGroupPage, resolveCrossGroups } from '../../src/shared/security/scope/cross-group.ts';
import { MAX_LIST_GROUPS, readMirrorList } from '../../src/shared/security/scope/group-mirror.ts';
import { COMPANIES_LIST } from '../../src/modules/companies/companies.list.ts';
import { COMPANY_SUMMARY_PROJECTION } from '../../src/modules/companies/company.mapper.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const g3 = fixtureId('group', 3);
const dealer = fixtureId('user', 50);
const psa = principalOf('PSA');
const dealerPrincipal = principalOf('D', { dealerGroupIds: [g1, g2] });
const lonelyDealer = principalOf('D', { dealerGroupIds: [] });
let ctx: TestDatabases;
let databases: Databases;

const NAME_PROJECTION = { _id: 1, name: 1, groupId: 1 } as const;
const names = (documents: Array<{ name?: unknown }>): unknown[] => documents.map((document) => document.name);
const cap = { $limit: 10 };
const pipeline = () => [{ $match: {} }, { $sort: { name: 1 } }, cap, { $project: NAME_PROJECTION }];

before(async () => {
  ctx = await openTestDatabases();
  databases = ctx.databases;
  await databases.common().collection('groups').insertMany([legacyGroup(1, { name: 'One', dealerId: dealer }), legacyGroup(2, { name: 'Two', dealerId: dealer }), legacyGroup(3, { name: 7, dealerId: fixtureId('user', 51) })]);
  await insertCopies(databases, 'companies', [
    legacyCompany(1, g1, { name: 'a' }),
    legacyCompany(2, g2, { name: 'b' }),
    legacyCompany(3, g3, { name: 'c' }),
    legacyCompany(4, g1, { name: 'array', groupId: [g1, g3] }),
    legacyCompany(5, g1, { name: 'text', groupId: g1.toHexString() }),
    legacyCompany(6, g1, { name: 'none', groupId: undefined }),
  ]);
  await insertCopies(databases, 'places', [legacyPlace(1, g1, fixtureId('company', 1), { name: 'p' })]);
});
after(() => ctx.cleanup());

describe('readMirrorList: the cross-group reader of the copies', () => {
  it('reads every group, or exactly the listed ones, never a copy whose group is an array, a text or missing', async () => {
    assert.deepEqual(names(await readMirrorList(databases, 'companies', { kind: 'all' }, pipeline())), ['a', 'b', 'c']);
    assert.deepEqual(names(await readMirrorList(databases, 'companies', { kind: 'include', ids: [g1, g3] }, pipeline())), ['a', 'c']);
    assert.deepEqual(names(await readMirrorList(databases, 'companies', { kind: 'include', ids: [g2] }, pipeline())), ['b']);
    assert.deepEqual(names(await readMirrorList(databases, 'places', { kind: 'all' }, pipeline())), ['p']);
  });

  it('cannot be widened by the filter of the pipeline: a groupId or an $or only narrow the groups', async () => {
    const widen = (match: object) => readMirrorList(databases, 'companies', { kind: 'include', ids: [g1] }, [{ $match: match }, { $sort: { name: 1 } }, cap, { $project: NAME_PROJECTION }]);
    assert.deepEqual(names(await widen({ groupId: g2 })), []);
    assert.deepEqual(names(await widen({ $or: [{ groupId: g2 }, { name: 'b' }] })), []);
    assert.deepEqual(names(await widen({ $or: [{ groupId: g2 }, { name: 'a' }] })), ['a']);
    assert.deepEqual(names(await widen({ groupId: { $in: [g1, g2, g3] } })), ['a']);
  });

  it('refuses a collection that is not a copy and groups that are not valid', async () => {
    await assert.rejects(readMirrorList(databases, 'users' as never, { kind: 'all' }, pipeline()), /Not a copy collection/);
    await assert.rejects(readMirrorList(databases, 'companies', { kind: 'include', ids: [] }, pipeline()), /group ids/);
    await assert.rejects(readMirrorList(databases, 'companies', { kind: 'include', ids: [g1.toHexString() as never] }, pipeline()), /group ids/);
    await assert.rejects(readMirrorList(databases, 'companies', { kind: 'include', ids: Array.from({ length: MAX_LIST_GROUPS + 1 }, () => g1) }, pipeline()), /group ids/);
  });

  it('allows `groupId` in the projection and nothing else outside the allowlist, and refuses what the other reads refuse', async () => {
    const read = (...stages: object[]) => readMirrorList(databases, 'companies', { kind: 'all' }, stages);
    assert.deepEqual((await read(cap, { $project: { groupId: 1 } }))[0]!['groupId'], g1);
    for (const field of ['integrations', 'fattura_elettronica', 'banks', 'settings', 'password', 'groupId.x', 'devices']) {
      await assert.rejects(read(cap, { $project: { [field]: 1 } }), /allowlist/, field);
    }
    await assert.rejects(read(cap, { $project: { groupId: 0 } }), /allowlist/);
    await assert.rejects(read({ $lookup: { from: 'users', as: 'u', pipeline: [] } }, cap, { $project: { name: 1 } }), /stage not allowed/);
    await assert.rejects(read({ $out: 'x' }, cap, { $project: { name: 1 } }), /stage not allowed/);
    await assert.rejects(read({ $match: { fattura_elettronica: { $exists: true } } }, cap, { $project: { name: 1 } }), /not readable/);
    await assert.rejects(read({ $match: { $where: 'true' } }, cap, { $project: { name: 1 } }), /not readable/);
    await assert.rejects(read({ $match: {} }, { $project: { name: 1 } }), /\$limit/);
    await assert.rejects(read({ $match: {} }, cap), /final allowlist projection/);
    await assert.rejects(readMirrorList(databases, 'companies', { kind: 'all' }, []), /needs a pipeline/);
  });

  it('answers 503 when the read exceeds its time limit, and lets any other failure through', async () => {
    const failing = (error: Error): Databases => ({ common: () => ({ collection: () => ({ aggregate: () => ({ toArray: () => Promise.reject(error) }) }) }) }) as unknown as Databases;
    const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
    await assert.rejects(readMirrorList(failing(expired), 'places', { kind: 'all' }, pipeline()), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE' && error.status === 503);
    await assert.rejects(readMirrorList(failing(new Error('network')), 'companies', { kind: 'all' }, pipeline()), /network/);
    await assert.rejects(readCrossGroupPage(failing(expired), psa, { name: 'companies', config: COMPANIES_LIST, projection: COMPANY_SUMMARY_PROJECTION }, {}, {}, listParamsOf({}, COMPANIES_LIST)), (error: unknown) => error instanceof AppError && error.status === 503);
  });
});

describe('the groups of a cross-group list', () => {
  it('lets the platform and the dealers through, and refuses every other scope and the dealerId of a dealer', () => {
    assert.doesNotThrow(() => assertCrossGroupAccess(psa, { dealerId: dealer }));
    assert.doesNotThrow(() => assertCrossGroupAccess(dealerPrincipal, { groupId: g1 }));
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      assert.throws(() => assertCrossGroupAccess(principalOf(role, { groupId: g1, companyIds: [fixtureId('company', 1)], placeIds: [fixtureId('place', 1)] }), {}), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN', role);
    }
    assert.throws(() => assertCrossGroupAccess(dealerPrincipal, { dealerId: dealer }), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
  });

  it('computes them from the scope: every group for the platform, the groups of the scope for a dealer, narrowed by the filters', async () => {
    assert.deepEqual(await resolveCrossGroups(databases, psa, {}), { kind: 'all' });
    assert.deepEqual(await resolveCrossGroups(databases, psa, { groupId: g3 }), { kind: 'include', ids: [g3] });
    assert.deepEqual(await resolveCrossGroups(databases, psa, { dealerId: dealer }), { kind: 'include', ids: [g1, g2] });
    assert.deepEqual(await resolveCrossGroups(databases, psa, { dealerId: dealer, groupId: g2 }), { kind: 'include', ids: [g2] });
    assert.equal(await resolveCrossGroups(databases, psa, { dealerId: dealer, groupId: g3 }), null);
    assert.equal(await resolveCrossGroups(databases, psa, { dealerId: fixtureId('user', 99) }), null);
    assert.deepEqual(await resolveCrossGroups(databases, dealerPrincipal, {}), { kind: 'include', ids: [g1, g2] });
    assert.deepEqual(await resolveCrossGroups(databases, dealerPrincipal, { groupId: g2 }), { kind: 'include', ids: [g2] });
    assert.equal(await resolveCrossGroups(databases, dealerPrincipal, { groupId: g3 }), null);
    assert.equal(await resolveCrossGroups(databases, lonelyDealer, {}), null);
    await assert.rejects(resolveCrossGroups(databases, principalOf('SA', { groupId: g1 }), {}), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
  });

  it('fails closed on a dealer with more groups than the cap, rather than truncating', async () => {
    const many = { common: () => ({ collection: () => ({ find: () => ({ toArray: async () => Array.from({ length: MAX_LIST_GROUPS + 1 }, () => ({ _id: new ObjectId() })) }) }) }) } as unknown as Databases;
    await assert.rejects(resolveCrossGroups(many, psa, { dealerId: dealer }), /Too many groups/);
  });

  it('reads a page with the names of the groups of the page only, and an empty page without reading when there is no group', async () => {
    const resource = { name: 'companies', config: COMPANIES_LIST, projection: COMPANY_SUMMARY_PROJECTION } as const;
    const page = await readCrossGroupPage(databases, psa, resource, {}, {}, listParamsOf({ limit: 2 }, COMPANIES_LIST));
    assert.deepEqual(names(page.items), ['a', 'b']);
    assert.deepEqual([...page.groupNames], [[g1.toHexString(), 'One'], [g2.toHexString(), 'Two']]);
    assert.equal(page.page.next !== null, true);
    const last = await readCrossGroupPage(databases, psa, resource, {}, {}, listParamsOf({ limit: 5, cursor: page.page.next! }, COMPANIES_LIST));
    assert.deepEqual(names(last.items), ['c']);
    // A group whose name is not a text has an empty one.
    assert.deepEqual([...last.groupNames], [[g3.toHexString(), '']]);
    const none = await readCrossGroupPage(databases, lonelyDealer, resource, {}, {}, listParamsOf({}, COMPANIES_LIST));
    assert.deepEqual([none.items, none.page, none.groupNames.size], [[], { limit: 50, next: null }, 0]);
    const empty = await readCrossGroupPage(databases, psa, resource, {}, { name: 'nothing' }, listParamsOf({}, COMPANIES_LIST));
    assert.deepEqual([empty.items, empty.groupNames.size], [[], 0]);
  });
});
