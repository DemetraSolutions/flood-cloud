import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const sub = (id: ObjectId, rest = ''): string => world.path(0, `/${hex(id)}${rest}`);
const etagOf = (reply: Awaited<ReturnType<typeof call>>): string => reply.headers.get('etag')!;
const conflict = (...details: Array<[string, string]>) => ({ status: 409, code: 'CONFLICT', details: details.length === 0 ? undefined : details.map(([field, issue]) => ({ field, issue })) });
let sequence = 400;
const fresh = async (overrides: Document = {}): Promise<{ id: ObjectId; etag: string }> => {
  const n = sequence++;
  const id = await world.seed(0, n, { code: `STATE-${String(n)}`, ...overrides });
  return { id, etag: etagOf(await call(psa(), 'GET', sub(id))) };
};

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('POST …/trash and …/restore', () => {
  it('moves a company to the trash and back, answering with the company and the new ETag, and keeps its places', async () => {
    const { id, etag } = await fresh();
    const place = fixtureId('place', 450);
    const document = legacyPlace(450, world.group(0).groupId, id);
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').insertOne(document);
    await insertCopies(ctx.databases, 'places', [document]);
    const before = (await world.stored(0, id))!;
    const mark = world.office.activity.entries.length;
    const trashed = await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etag });
    assert.equal(trashed.status, 200);
    assert.equal(trashed.body.data.trashed, true);
    assert.notEqual(etagOf(trashed), etag);
    const after = (await world.stored(0, id))!;
    assert.equal(after['trash'], true);
    assert.ok(sameDocument({ ...before, trash: true, updateDate: after['updateDate'] }, after));
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOf(id))!));
    // The place keeps its reference to the trashed company.
    assert.deepEqual((await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').findOne({ _id: place }))!['companyId'], id);
    assert.deepEqual((await call(sa(), 'GET', sub(id))).body.data.trashed, true);
    // It is in the list of the trash and out of the default one.
    assert.deepEqual((await call(sa(), 'GET', world.path(0, '?trashed=true&limit=200'))).body.data.map((item: { id: string }) => item.id).includes(hex(id)), true);
    assert.ok(!(await call(sa(), 'GET', world.path(0, '?limit=200'))).body.data.some((item: { id: string }) => item.id === hex(id)));
    // Trashing twice is a conflict; the stale version is a 412.
    assert.deepEqual(failure(await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etagOf(trashed) })), conflict());
    assert.equal((await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etag })).status, 412);
    const restored = await call(sa(), 'POST', sub(id, '/restore'), undefined, { 'if-match': etagOf(trashed) });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.trashed, false);
    assert.deepEqual(failure(await call(sa(), 'POST', sub(id, '/restore'), undefined, { 'if-match': etagOf(restored) })), conflict());
    assert.ok(sameDocument(expectedCopy((await world.stored(0, id))!, world.group(0).groupId), (await world.copyOf(id))!));
    const events = world.office.activity.entries.slice(mark).filter((entry) => entry.action.startsWith('company.'));
    assert.deepEqual(events.map((entry) => [entry.action, entry.resource!.id, entry.groupId, entry.changes!.map((change) => [change.field, change.before, change.after])]), [
      ['company.trashed', hex(id), world.group(0).groupId, [['trashed', false, true]]],
      ['company.restored', hex(id), world.group(0).groupId, [['trashed', true, false]]],
    ]);
  });

  it('is allowed to the PSA, the dealer and the SA only, and hidden outside the perimeter', async () => {
    const { id, etag } = await fresh();
    assert.deepEqual(failure(await call(ca(), 'POST', sub(fixtureId('company', 1), '/trash'), undefined, { 'if-match': etag })), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.deepEqual(failure(await call(world.group(0).pa, 'POST', sub(id, '/trash'), undefined, { 'if-match': etag })), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(world.group(1).sa, 'POST', sub(id, '/trash'), undefined, { 'if-match': etag })).status, 404);
    assert.equal((await call(world.office.cluster.dealerB, 'POST', sub(id, '/restore'), undefined, { 'if-match': etag })).status, 404);
    assert.equal((await call(psa(), 'POST', sub(new ObjectId(), '/trash'), undefined, { 'if-match': etag })).status, 404);
    assert.equal((await call(world.office.cluster.dealerA, 'POST', sub(id, '/trash'), undefined, { 'if-match': etag })).status, 200);
    assert.equal(((await world.stored(0, id))!['trash']), true);
    assert.equal((await call(world.office.cluster.dealerA, 'POST', sub(id, '/trash'), undefined, { 'if-match': etag })).status, 412);
    assert.equal((await call(psa(), 'POST', world.path(0, '/not-an-id/trash'), undefined, { 'if-match': etag })).status, 422);
  });
});

describe('DELETE /v1/groups/{groupId}/companies/{companyId}', () => {
  it('deletes a company in the trash for good, with its copy, answering 204', async () => {
    const { id, etag } = await fresh();
    const mark = world.office.activity.entries.length;
    // Only from the trash.
    assert.deepEqual(failure(await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etag })), conflict());
    const trashed = await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etag });
    assert.equal((await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etag })).status, 412);
    const deleted = await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etagOf(trashed) });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, undefined);
    assert.equal(await world.stored(0, id), null);
    assert.equal(await world.copyOf(id), null);
    assert.equal((await call(sa(), 'GET', sub(id))).status, 404);
    assert.equal((await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etagOf(trashed) })).status, 404);
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'company.deleted');
    assert.deepEqual([entry!.resource, entry!.changes], [{ type: 'company', id: hex(id) }, []]);
  });

  it('refuses with 409 while a place of the group, trashed ones included, still refers to the company', async () => {
    const { id, etag } = await fresh();
    const placeDocument = legacyPlace(460, world.group(0).groupId, id, { trash: true });
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').insertOne(placeDocument);
    const trashed = await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etag });
    const before = (await world.stored(0, id))!;
    assert.deepEqual(failure(await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etagOf(trashed) })), conflict(['places', 'referenced']));
    assert.ok(sameDocument(before, (await world.stored(0, id))!));
    assert.ok((await world.copyOf(id)) !== null);
    // Once the place is gone the company can go.
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('places').deleteOne({ _id: placeDocument['_id'] });
    assert.equal((await call(sa(), 'DELETE', sub(id), undefined, { 'if-match': etagOf(trashed) })).status, 204);
  });

  it('is allowed to the PSA, the dealer and the SA only, and hidden outside the perimeter', async () => {
    const { id, etag } = await fresh();
    const trashed = await call(sa(), 'POST', sub(id, '/trash'), undefined, { 'if-match': etag });
    const version = etagOf(trashed);
    assert.deepEqual(failure(await call(ca(), 'DELETE', sub(fixtureId('company', 1)), undefined, { 'if-match': version })), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.deepEqual(failure(await call(world.group(0).pa, 'DELETE', sub(id), undefined, { 'if-match': version })), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(world.group(1).sa, 'DELETE', sub(id), undefined, { 'if-match': version })).status, 404);
    assert.equal((await call(world.office.cluster.dealerB, 'DELETE', sub(id), undefined, { 'if-match': version })).status, 404);
    assert.equal((await call(psa(), 'DELETE', sub(fixtureId('company', 3)), undefined, { 'if-match': version })).status, 404);
    assert.equal((await call(world.office.cluster.dealerA, 'DELETE', sub(id), undefined, { 'if-match': version })).status, 204);
  });
});
