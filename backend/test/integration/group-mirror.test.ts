import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { groupMirror, trustedGroupMirror } from '../../src/shared/security/scope/group-mirror.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { featuresOf } from '../../src/modules/groups/features.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { accessFor } from '../helpers/group-access.ts';
import { fixtureId, legacyCompany, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const sa1 = principalOf('SA', { groupId: g1 });
const psa = principalOf('PSA');
let ctx: TestDatabases;
let databases: Databases;

before(async () => {
  ctx = await openTestDatabases();
  databases = ctx.databases;
  await insertCopies(databases, 'companies', [
    legacyCompany(1, g1, { name: 'beta' }),
    legacyCompany(2, g1, { name: 'alpha', trash: true }),
    legacyCompany(3, g2, { name: 'alpha' }),
    legacyCompany(4, g1, { name: 'no group', groupId: undefined }),
    legacyCompany(5, g1, { name: 'string group', groupId: g1.toHexString() }),
    legacyCompany(6, g1, { name: 'array group', groupId: [g1, g2] }),
  ]);
  await insertCopies(databases, 'places', [legacyPlace(1, g1, fixtureId('company', 1), { name: 'p1' }), legacyPlace(2, g2, fixtureId('company', 3), { name: 'p1' })]);
});
after(() => ctx.cleanup());

const names = (documents: Array<{ name?: unknown }>): unknown[] => documents.map((document) => document.name);

describe('groupMirror: the only reader of the copies of companies and places', () => {
  it('restricts every operation to the group of the verified access', async () => {
    const mirror = groupMirror(sa1, (await accessFor(sa1, g1))!, databases, 'companies');
    assert.deepEqual(names(await mirror.find({}, { projection: { name: 1 }, limit: 10, sort: { name: 1 } })), ['alpha', 'beta']);
    assert.deepEqual(names(await mirror.find({ name: 'alpha' }, { projection: { name: 1 }, limit: 10 })), ['alpha']);
    assert.equal(await mirror.countDocuments({}), 2);
    assert.equal(await mirror.countDocuments({ name: 'alpha' }), 1);
    assert.deepEqual(names(await mirror.aggregate([{ $match: {} }, { $sort: { name: -1 } }, { $limit: 10 }, { $project: { name: 1 } }])), ['beta', 'alpha']);
    const other = groupMirror(psa, (await accessFor(psa, g2))!, databases, 'companies');
    assert.deepEqual(names(await other.find({}, { projection: { name: 1 }, limit: 10 })), ['alpha']);
    const places = groupMirror(sa1, (await accessFor(sa1, g1))!, databases, 'places');
    assert.equal(await places.countDocuments({}), 1);
  });

  it('cannot be widened by the filter: a groupId, an $or or an $expr only narrow the result', async () => {
    const mirror = groupMirror(sa1, (await accessFor(sa1, g1))!, databases, 'companies');
    assert.deepEqual(await mirror.find({ groupId: g2 }, { projection: { name: 1 }, limit: 10 }), []);
    assert.equal(await mirror.countDocuments({ $or: [{ groupId: g2 }, { name: 'alpha' }] }), 1);
    assert.deepEqual(names(await mirror.find({ $or: [{ groupId: g2 }, { name: 'beta' }] }, { projection: { name: 1 }, limit: 10 })), ['beta']);
    assert.deepEqual(
      await mirror.aggregate([{ $match: { $or: [{ groupId: g2 }, { groupId: { $exists: false } }, { groupId: g1.toHexString() }] } }, { $limit: 5 }, { $project: { name: 1 } }]),
      [],
    );
    assert.equal(await mirror.countDocuments({ groupId: { $exists: false } }), 0);
  });

  it('returns only the projected fields, never the integrations or the credentials', async () => {
    const places = groupMirror(sa1, (await accessFor(sa1, g1))!, databases, 'places');
    const [place] = await places.find({}, { projection: { name: 1 }, limit: 1 });
    assert.deepEqual(Object.keys(place!).sort(), ['_id', 'name']);
    const [piped] = await places.aggregate([{ $limit: 5 }, { $project: { name: 1, companyId: 1 } }]);
    assert.deepEqual(Object.keys(piped!).sort(), ['_id', 'companyId', 'name']);
    const companies = groupMirror(sa1, (await accessFor(sa1, g1))!, databases, 'companies');
    assert.ok(!JSON.stringify(await companies.find({}, { projection: { name: 1, trash: 1 }, limit: 5 })).includes('fixture-secret'));
  });

  it('refuses an access it did not issue or that belongs to another principal', async () => {
    const forged: GroupAccess = { groupId: g1, clusterId: 'cluster0', crossGroup: false, features: featuresOf(undefined) };
    assert.throws(() => groupMirror(sa1, forged, databases, 'places'), /verified group access/);
    const access = (await accessFor(psa, g2))!;
    assert.throws(() => groupMirror(sa1, access, databases, 'places'), /verified group access/);
  });

  it('refuses a collection that is not a copy', async () => {
    assert.throws(() => trustedGroupMirror(g1, databases, 'users' as never), /Not a copy collection/);
    assert.throws(() => trustedGroupMirror('abc' as never, databases, 'places'), /group id/);
    assert.throws(() => trustedGroupMirror(undefined as never, databases, 'places'), /group id/);
  });

  it('refuses reads without projection, with exclusion or expression projections, without limit or without a filter object', async () => {
    const mirror = trustedGroupMirror(g1, databases, 'places');
    const find = (options: object, filter: unknown = {}) => mirror.find(filter as never, options as never);
    await assert.rejects(find({ limit: 1 }), /projection/);
    await assert.rejects(find({ projection: {}, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: { integrations: 0 }, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: { _id: 0, name: 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: { name: true }, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: { name: '$integrations' }, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: { $expr: 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(find({ projection: [1] as never, limit: 1 }), /projection/);
    await assert.rejects(find({ projection: { name: 1 } }), /limit/);
    await assert.rejects(find({ projection: { name: 1 }, limit: 0 }), /limit/);
    await assert.rejects(find({ projection: { name: 1 }, limit: 1.5 }), /limit/);
    await assert.rejects(find({ projection: { name: 1 }, limit: 1 }, null), /filter/);
    await assert.rejects(find({ projection: { name: 1 }, limit: 1 }, [{}]), /filter/);
    await assert.rejects(mirror.countDocuments(undefined as never), /filter/);
  });

  it('refuses pipelines with writing or joining stages, without a final allowlist projection, or malformed', async () => {
    const mirror = trustedGroupMirror(g1, databases, 'companies');
    const project = { $project: { name: 1 } };
    const cap = { $limit: 5 };
    for (const stage of [{ $out: 'x' }, { $merge: { into: 'x' } }, { $lookup: { from: 'users', as: 'u', pipeline: [] } }, { $unionWith: 'users' }, { $graphLookup: {} }, { $facet: {} }]) {
      await assert.rejects(mirror.aggregate([{ $match: {} }, stage, cap, project]), /stage not allowed/, Object.keys(stage)[0]);
    }
    await assert.rejects(mirror.aggregate([{ $match: {}, $limit: 1 }, cap, project]), /stage not allowed/);
    await assert.rejects(mirror.aggregate([{}, cap, project]), /stage not allowed/);
    await assert.rejects(mirror.aggregate([null as never, cap, project]), /stage not allowed/);
    await assert.rejects(mirror.aggregate([{ $match: {} }, cap]), /final allowlist projection/);
    await assert.rejects(mirror.aggregate([cap, project, { $match: {} }]), /Only the final|final allowlist/);
    await assert.rejects(mirror.aggregate([cap, { $project: { name: 0 } }]), /allowlist/);
    await assert.rejects(mirror.aggregate([cap, { $project: {} }]), /allowlist/);
    await assert.rejects(mirror.aggregate([]), /needs a pipeline/);
    await assert.rejects(mirror.aggregate('x' as never), /needs a pipeline/);
  });

  it('refuses fields outside the central allowlist: projections, computed references, filters, sorts', async () => {
    const mirror = trustedGroupMirror(g1, databases, 'places');
    const cap = { $limit: 5 };
    await assert.rejects(mirror.find({}, { projection: { integrations: 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(mirror.find({}, { projection: { 'integrations.dojo': 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(mirror.find({}, { projection: { __sortKey: 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(trustedGroupMirror(g1, databases, 'companies').find({}, { projection: { companyId: 1 }, limit: 1 }), /allowlist/);
    await assert.rejects(mirror.aggregate([{ $addFields: { name: '$integrations' } }, cap, { $project: { name: 1 } }]), /__ prefix/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __leak: '$integrations' } }, cap, { $project: { __leak: 1 } }]), /not readable/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __leak: '$integrations.dojo.apiKey' } }, cap, { $project: { __leak: 1 } }]), /not readable/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __leak: { $concat: ['x', { $toString: '$$ROOT' }] } } }, cap, { $project: { __leak: 1 } }]), /not readable/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __leak: { $getField: 'integrations' } } }, cap, { $project: { __leak: 1 } }]), /\$getField/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __k: '$name' } }, { $project: { __k: 1 } }, cap, { $project: { name: 1 } }]), /Only the final/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __k: '$name' } }, cap, { $project: { integrations: 1 } }]), /allowlist/);
    await assert.rejects(mirror.aggregate([{ $sort: { integrations: 1 } }, cap, { $project: { name: 1 } }]), /sort/);
    await assert.rejects(mirror.find({}, { projection: { name: 1 }, limit: 1, sort: { integrations: 1 } }), /sort/);
    await assert.rejects(mirror.find({}, { projection: { name: 1 }, limit: 1, sort: { name: 2 } as never }), /sort/);
    await assert.rejects(mirror.find({ 'integrations.dojo.apiKey': { $regex: '^a' } }, { projection: { name: 1 }, limit: 1 }), /not readable/);
    await assert.rejects(mirror.countDocuments({ $or: [{ name: 'x' }, { integrations: { $exists: true } }] }), /not readable/);
    await assert.rejects(mirror.countDocuments({ $expr: { $eq: ['$integrations.dojo.status', true] } }), /not readable/);
    await assert.rejects(mirror.countDocuments({ $jsonSchema: {} }), /not readable/);
    await assert.rejects(mirror.countDocuments({ $and: 'x' as never }), /list of filters/);
    // The allowed ones work: allowlisted fields, groupId, computed keys, a harmless $expr.
    assert.equal(await mirror.countDocuments({ $expr: { $eq: ['$name', 'p1'] } }), 1);
    assert.equal(await mirror.countDocuments({ $nor: [{ name: 'other' }], 'companyId': { $type: 'objectId' } }), 1);
    assert.deepEqual(names(await mirror.aggregate([{ $addFields: { __k: { $toLower: '$name' } } }, { $match: { __k: 'p1' } }, { $sort: { __k: 1 } }, { $skip: 0 }, cap, { $project: { __k: 1, name: 1 } }])), ['p1']);
  });

  it('refuses operators that run code, anywhere in a filter or a $match', async () => {
    const mirror = trustedGroupMirror(g1, databases, 'places');
    const cap = { $limit: 5 };
    const project = { $project: { name: 1 } };
    const code = { $function: { body: 'function(){return true}', args: [], lang: 'js' } };
    await assert.rejects(mirror.countDocuments({ $where: 'true' } as never), /not readable/);
    await assert.rejects(mirror.countDocuments({ name: { $where: 'true' } } as never), /\$where/);
    await assert.rejects(mirror.countDocuments({ $expr: code }), /\$function/);
    await assert.rejects(mirror.countDocuments({ $or: [{ $and: [{ name: { $in: [{ $accumulator: {} }] } }] }] }), /\$accumulator/);
    await assert.rejects(mirror.aggregate([{ $match: { $expr: code } }, cap, project]), /\$function/);
    await assert.rejects(mirror.aggregate([{ $addFields: { __k: { $accumulator: {} } } }, cap, project]), /\$accumulator/);
    await assert.rejects(mirror.aggregate([{ $match: { name: { $where: 'true' } } }, cap, project]), /\$where/);
  });

  it('needs a limit stage before the final projection, and integers in limit and skip', async () => {
    const mirror = trustedGroupMirror(g1, databases, 'places');
    const project = { $project: { name: 1 } };
    await assert.rejects(mirror.aggregate([{ $match: {} }, project]), /needs a \$limit/);
    await assert.rejects(mirror.aggregate([project]), /needs a \$limit/);
    await assert.rejects(mirror.aggregate([{ $limit: 0 }, project]), /integer/);
    await assert.rejects(mirror.aggregate([{ $limit: '5' as never }, project]), /integer/);
    await assert.rejects(mirror.aggregate([{ $skip: -1 }, { $limit: 1 }, project]), /integer/);
  });

  it('never matches a copy whose groupId is an array that contains the group', async () => {
    const arrayCopy = fixtureId('company', 6);
    const mirror = trustedGroupMirror(g1, databases, 'companies');
    assert.deepEqual(names(await mirror.find({ _id: arrayCopy }, { projection: { name: 1 }, limit: 5 })), []);
    assert.equal(await mirror.countDocuments({ _id: arrayCopy }), 0);
    assert.deepEqual(await mirror.aggregate([{ $match: { _id: arrayCopy } }, { $limit: 5 }, { $project: { name: 1 } }]), []);
    assert.equal(await trustedGroupMirror(g2, databases, 'companies').countDocuments({ _id: arrayCopy }), 0);
  });

  it('works on the trusted group id of a stored document, still restricted to that group', async () => {
    const mirror = trustedGroupMirror(g2, databases, 'places');
    assert.deepEqual(names(await mirror.find({}, { projection: { name: 1 }, limit: 5 })), ['p1']);
    assert.equal(await mirror.countDocuments({}, 1000), 1);
    assert.equal((await trustedGroupMirror(new ObjectId(), databases, 'places').find({}, { projection: { name: 1 }, limit: 5, maxTimeMS: 1000 })).length, 0);
    assert.deepEqual(await mirror.aggregate([{ $limit: 5 }, { $project: { name: 1 } }], 1000).then(names), ['p1']);
  });

  it('resolves company and place ids for user management inside the group only, and nothing for an empty list', async () => {
    const directory = createGroupDirectoryRepository(databases);
    const access = (await accessFor(sa1, g1))!;
    const own = fixtureId('company', 1);
    const foreign = fixtureId('company', 3);
    const noGroup = fixtureId('company', 4);
    const stringGroup = fixtureId('company', 5);
    const trashed = fixtureId('company', 2);
    assert.deepEqual(await directory.findCompanies(sa1, access, [own, foreign, noGroup, stringGroup, trashed, fixtureId('company', 6)]), [own]);
    assert.deepEqual(await directory.findCompanies(sa1, access, []), []);
    assert.deepEqual(await directory.findPlaces(sa1, access, []), []);
    const places = await directory.findPlaces(sa1, access, [fixtureId('place', 1), fixtureId('place', 2)]);
    assert.deepEqual(places.map((place) => [place.id.toHexString(), place.companyId?.toHexString()]), [[fixtureId('place', 1).toHexString(), own.toHexString()]]);
  });
});
