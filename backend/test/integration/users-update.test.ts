import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { createUsersService } from '../../src/modules/users/users.service.ts';
import { legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { resolveGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { TEST_PASSWORD, TEST_PEPPER, addUser as addBackofficeUser, startBackoffice, userName } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const PASSWORD = `Prov-${randomBytes(8).toString('hex')}-pass`;
const EXTRA = { r: true, w: false };
const FULL = { status: true, groups: { r: true, w: true }, users: { r: true, w: true }, companies: { r: true, w: true }, places: { r: true, w: true }, logs: { r: true, w: true }, products: EXTRA, apps: { cash: { status: true, sub: { discounts: true } } } };
const users = () => ctx.databases.common().collection('users');
const credentials = () => ctx.databases.common().collection('userCredentials');
const sessions = () => ctx.databases.common().collection('sessions');
const g0 = () => office.cluster.groups[0]!;
const g1 = () => office.cluster.groups[1]!;
const hex = (id: ObjectId) => id.toHexString();
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);
const path = (id?: ObjectId, rest = '', group = g0()) => `/groups/${hex(group.groupId)}/users${id === undefined ? '' : `/${hex(id)}`}${rest}`;
const stored = async (id: ObjectId): Promise<Document> => (await users().findOne({ _id: id }))!;
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const notFound = { status: 404, code: 'NOT_FOUND', details: undefined };
const mark = (): number => office.activity.entries.length;
const events = (from: number) => office.activity.entries.slice(from).map((entry) => (entry.metadata === undefined ? entry.action : `${entry.action}:${Object.values(entry.metadata).join('>')}`));

/** A user of the first group with a legacy document, the whole matrix (and a non-core module) unless told otherwise. */
const fresh = async (overrides: Document = {}) => (await addBackofficeUser(ctx, office, { permissions: FULL, ...overrides })).id;
const freshPa = (overrides: Document = {}) => fresh({ role: 'PA', companyId: company(1), placeId: place(1), placesId: [place(1)], ...overrides });
const freshE = (overrides: Document = {}) => fresh({ role: 'E', placeId: place(1), placesId: [place(1)], ...overrides });
const failure = (reply: Awaited<ReturnType<typeof as.call>>) => as.failure(reply);
/** A logged-in session of a freshly made user: the token, to see later that it is gone. */
const loggedIn = async (id: ObjectId): Promise<string> => as.tokenOf(id);
const works = async (token: string): Promise<boolean> => (await send(office, 'GET', '/me', token)).status === 200;

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/users/{userId}', () => {
  it('returns the user with the response mapper, and a 404 that is the same for every user the caller cannot see', async () => {
    const reply = await as.call(g0().sa, 'GET', path(g0().pa));
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.data.id, reply.body.data.username, reply.body.data.role, reply.body.data.placeIds], [hex(g0().pa), 'user-005', 'PA', [hex(place(1))]]);
    assert.ok(!JSON.stringify(reply.body).includes('1234'));
    const hidden: Array<[string, ObjectId, ObjectId]> = [
      ['another group of the same dealer', g0().sa, g1().sa],
      ['another dealer', office.cluster.dealerB, g0().pa],
      ['an SA seen by a CA', g0().ca, g0().sa],
      ['a user outside the companies of the CA', g0().ca, g0().employee],
      ['a PA looking at an employee of another place', g0().pa, g0().employee],
      ['a PSA seen by an SA', g0().sa, office.cluster.psa],
      ['a dealer seen by an SA', g0().sa, office.cluster.dealerA],
      ['nobody', g0().sa, new ObjectId()],
    ];
    for (const [label, actor, target] of hidden) {
      assert.deepEqual(failure(await as.call(actor, 'GET', path(target))), notFound, label);
    }
    // The same user through the path of another group is not found either, for the PSA too.
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'GET', path(g0().pa, '', g1()))), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'GET', path(g1().sa, '', g0()))), notFound);
    assert.equal((await as.call(office.cluster.dealerA, 'GET', path(g1().sa, '', g1()))).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'GET', `${path()}/not-an-id`)), invalid(['userId', 'format']));
    assert.deepEqual(failure(await as.call(g0().sa, 'GET', `${path()}/%7B%22%24ne%22%3Anull%7D`)), invalid(['userId', 'format']));
  });
});

describe('PATCH /v1/groups/{groupId}/users/{userId}', () => {
  it('changes the personal fields, keeps everything else of the legacy document and ends no session', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const before = await stored(id);
    const from = mark();
    const reply = await as.call(g0().sa, 'PATCH', path(id), { firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@Example.test', phone: '+39 06 99', language: 'it' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.firstName, reply.body.data.lastName, reply.body.data.email, reply.body.data.phone], ['Ada', 'Lovelace', 'ada@example.test', '+39 06 99']);
    const after = await stored(id);
    assert.deepEqual([after['name'], after['surname'], after['email'], after['telephone']], ['Ada', 'Lovelace', 'ada@example.test', '+39 06 99']);
    assert.ok((after['updateDate'] as Date).getTime() >= (before['updateDate'] as Date).getTime());
    for (const field of ['password', 'pin', 'tokens', 'role', 'status', 'trash', 'groupId', 'dealerId', 'companyId', 'placeId', 'placesId', 'userName', 'insertDate']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.deepEqual(after['permissions'], before['permissions'], 'the matrix, the non-core module and the cash permissions are untouched');
    assert.ok(await works(token), 'the session of the user goes on');
    assert.deepEqual(events(from), ['user.updated']);
    const changes = office.activity.entries.at(-1)!.changes!.map((change) => change.field).sort();
    assert.deepEqual(changes, ['email', 'firstName', 'lastName', 'phone']);
  });

  it('clears the personal fields with null and removes them from the document', async () => {
    const id = await freshPa({ name: 'Old', surname: 'Name', email: 'old@example.test', telephone: '+390000' });
    const reply = await as.call(g0().sa, 'PATCH', path(id), { firstName: null, lastName: null, email: null, phone: null });
    assert.deepEqual([reply.body.data.firstName, reply.body.data.lastName, reply.body.data.email, reply.body.data.phone], [null, null, null, null]);
    const after = await stored(id);
    for (const field of ['name', 'surname', 'email', 'telephone']) {
      assert.ok(!(field in after), field);
    }
  });

  it('does nothing, and writes no event, when nothing changes; an empty patch is refused', async () => {
    const id = await freshPa({ name: 'Same' });
    const before = await stored(id);
    const from = mark();
    const reply = await as.call(g0().sa, 'PATCH', path(id), { firstName: 'Same', status: 'active', role: 'PA', placeIds: [hex(place(1))], permissions: { modules: { users: { r: true } } } });
    assert.equal(reply.status, 200);
    assert.deepEqual(await stored(id), before);
    assert.deepEqual(events(from), []);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), {})), invalid(['(body)', 'required']));
  });

  it('refuses fields it does not own, in particular the password, the group and the trash', async () => {
    const id = await freshPa();
    for (const field of ['password', 'groupId', 'dealerId', 'trashed', 'trash', 'tokens', 'pin', 'apps', '_id', 'createdAt', 'hiddenInStats']) {
      assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { [field]: field === 'tokens' ? [] : 'x' })), invalid([field, 'unknown']), field);
    }
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { '$set': { role: 'PSA' } })), invalid(['(key)', 'forbiddenKey']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { role: 'PSA' })), invalid(['role', 'enum']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { permissions: { apps: {} } })), invalid(['permissions.apps', 'unknown']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { email: 'nope' })), invalid(['email', 'format']));
    assert.equal((await stored(id))['role'], 'PA');
  });

  it('changes the username with the uniqueness check of D-15 and lets the user keep his own', async () => {
    const id = await freshPa();
    const own = (await stored(id))['userName'] as string;
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { username: own })).status, 200);
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { username: own.toUpperCase() })).status, 200);
    assert.equal((await stored(id))['userName'], own.toUpperCase());
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { username: 'USER-003' })), { status: 409, code: 'CONFLICT', details: [{ field: 'username', issue: 'taken' }] });
    const renamed = await as.call(g0().sa, 'PATCH', path(id), { username: 'renamed.user' });
    assert.equal(renamed.body.data.username, 'renamed.user');
    assert.equal((await stored(id))['userName'], 'renamed.user');
    assert.equal((await office.login('renamed.user', TEST_PASSWORD)).status, 200);
  });

  it('changes the language of a user stored with another one', async () => {
    const id = await freshPa({ settings: { language: 'en', hiddenInStats: true } });
    const reply = await as.call(g0().sa, 'PATCH', path(id), { language: 'it' });
    assert.deepEqual([reply.status, reply.body.data.language, reply.body.data.hiddenInStats], [200, 'it', true]);
    assert.deepEqual((await stored(id))['settings'], { language: 'it', hiddenInStats: true });
  });

  it('changes only the right to manage permissions, touching nothing else of the matrix', async () => {
    const id = await freshPa();
    const from = mark();
    const reply = await as.call(g0().sa, 'PATCH', path(id), { permissions: { canManagePermissions: false } });
    assert.equal(reply.body.data.permissions.canManagePermissions, false);
    const permissions = (await stored(id))['permissions'] as Document;
    assert.deepEqual([permissions['status'], permissions['users'], permissions['products']], [false, { r: true, w: true }, EXTRA]);
    assert.deepEqual(events(from), ['user.updated', 'user.permissionsChanged']);
  });

  it('ends the sessions and the legacy tokens when the status changes, in both directions', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const from = mark();
    const off = await as.call(g0().sa, 'PATCH', path(id), { status: 'disabled' });
    assert.equal(off.body.data.status, 'disabled');
    assert.deepEqual(events(from), ['user.updated', 'user.statusChanged:active>disabled', 'session.revoked:statusChanged']);
    assert.equal(office.activity.entries.at(-1)!.actor.id!.toHexString(), hex(g0().sa));
    assert.equal(await works(token), false);
    assert.deepEqual((await stored(id))['tokens'], []);
    assert.equal((await office.login(userName(id))).status, 401);
    const session = await sessions().findOne({ userId: id });
    assert.equal(session!['revokeReason'], 'statusChanged');
    const on = await as.call(g0().sa, 'PATCH', path(id), { status: 'active' });
    assert.equal(on.body.data.status, 'active');
    assert.equal((await office.login(userName(id))).status, 200);
  });

  it('changes the role, ends the sessions and records the security events', async () => {
    const id = await freshE();
    const from = mark();
    const reply = await as.call(g0().sa, 'PATCH', path(id), { role: 'PA' });
    assert.deepEqual([reply.status, reply.body.data.role], [200, 'PA']);
    assert.deepEqual(events(from), ['user.updated', 'user.roleChanged:E>PA']);
    assert.equal((await stored(id))['role'], 'PA');
    // PA to SA needs the scope cleared in the same request (D-08 on the final state).
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { role: 'SA' })), invalid(['placeIds', 'incorrect']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { role: 'CA' })), invalid(['companyIds', 'required']));
    // A CA may keep places that belong to his companies.
    assert.equal((await as.call(g0().sa, 'PATCH', path(id), { role: 'CA', companyIds: [hex(company(1))] })).status, 200);
  });

  it('moves a user to another role and scope in one request, keeping the legacy fields aligned (D-08)', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const from = mark();
    const toCa = await as.call(g0().sa, 'PATCH', path(id), { role: 'CA', companyIds: [hex(company(2)), hex(company(1))], placeIds: [] });
    assert.equal(toCa.status, 200, JSON.stringify(toCa.body));
    let document = await stored(id);
    assert.deepEqual([document['role'], hex(document['companyId'] as ObjectId), document['placeId'], document['placesId']], ['CA', hex(company(2)), null, []]);
    assert.deepEqual(events(from), ['user.updated', 'user.roleChanged:PA>CA', 'user.scopeChanged', 'session.revoked:roleChanged']);
    assert.equal(await works(token), false);
    const toSa = await as.call(g0().sa, 'PATCH', path(id), { role: 'SA', companyIds: [], placeIds: [] });
    assert.equal(toSa.status, 200);
    document = await stored(id);
    assert.deepEqual([document['role'], document['companyId'], document['placeId'], document['placesId']], ['SA', null, null, []]);
    const toE = await as.call(g0().sa, 'PATCH', path(id), { role: 'E', placeIds: [hex(place(2)), hex(place(1))] });
    assert.equal(toE.status, 200);
    document = await stored(id);
    assert.deepEqual([hex(document['placeId'] as ObjectId), (document['placesId'] as ObjectId[]).map(hex)], [hex(place(2)), [hex(place(2)), hex(place(1))]]);
  });

  it('changes the scope, checks the new references only, and leaves an old leftover scope alone', async () => {
    const id = await freshPa({ companyId: null });
    const token = await loggedIn(id);
    const from = mark();
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { placeIds: [hex(place(1)), hex(new ObjectId())] })), invalid(['placeIds.1', 'incorrect']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { placeIds: [hex(place(3))] })), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(id), { placeIds: [] })), invalid(['placeIds', 'required']));
    const reply = await as.call(g0().sa, 'PATCH', path(id), { placeIds: [hex(place(1)), hex(place(2))] });
    assert.equal(reply.status, 200);
    assert.deepEqual(events(from), ['user.updated', 'user.scopeChanged', 'session.revoked:scopeChanged']);
    assert.equal(await works(token), false);
    // A place the user already has is not checked again: it may have been trashed since.
    const database = ctx.databases.group(g0().groupId);
    await database.collection('places').updateOne({ _id: place(1) }, { $set: { trash: true } });
    try {
      assert.equal((await as.call(g0().sa, 'PATCH', path(id), { firstName: 'Still fine' })).status, 200);
      assert.equal((await as.call(g0().sa, 'PATCH', path(id), { placeIds: [hex(place(1)), hex(place(2))], firstName: 'Same scope' })).status, 200);
    } finally {
      await database.collection('places').updateOne({ _id: place(1) }, { $set: { trash: false } });
    }
    // An SA with a company left over from the old days can still be renamed: the scope is checked only when the change touches it.
    const dirty = await fresh({ role: 'SA', companyId: company(1), placeId: place(1), placesId: [place(1)] });
    assert.equal((await as.call(g0().sa, 'PATCH', path(dirty), { firstName: 'Dirty' })).status, 200);
    assert.ok((await stored(dirty))['companyId'] instanceof ObjectId);
    assert.equal((await as.call(g0().sa, 'PATCH', path(dirty), { role: 'SA', companyIds: [hex(company(1))], placeIds: [hex(place(1))] })).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(dirty), { placeIds: [hex(place(2))] })), invalid(['companyIds', 'incorrect'], ['placeIds', 'incorrect']));
  });

  it('changes the permissions with targeted writes, keeps the non-core modules and the cash permissions, and ends the sessions', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const from = mark();
    const reply = await as.call(g0().sa, 'PATCH', path(id), { permissions: { canManagePermissions: false, modules: { users: { w: false }, logs: { r: false, w: false } } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.permissions.modules.users, { r: true, w: false });
    assert.deepEqual(reply.body.data.permissions.modules.logs, { r: false, w: false });
    assert.equal(reply.body.data.permissions.canManagePermissions, false);
    const permissions = (await stored(id))['permissions'] as Document;
    assert.deepEqual([permissions['status'], permissions['users'], permissions['logs'], permissions['places'], permissions['products']], [false, { r: true, w: false }, { r: false, w: false }, { r: true, w: true }, EXTRA]);
    assert.deepEqual(permissions['apps'], { cash: { status: true, sub: { discounts: true } } });
    assert.deepEqual(events(from), ['user.updated', 'user.permissionsChanged', 'session.revoked:permissionsChanged']);
    assert.equal(await works(token), false);
  });

  it('refuses to change himself, whatever the field', async () => {
    const id = await fresh();
    for (const patch of [{ firstName: 'Me' }, { role: 'CA', companyIds: [hex(company(1))] }, { status: 'disabled' }, { permissions: { canManagePermissions: false } }]) {
      assert.deepEqual(failure(await as.call(id, 'PATCH', path(id), patch)), denied, JSON.stringify(patch));
    }
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'PATCH', `/users/${hex(office.cluster.psa)}`, { firstName: 'Me' })), denied);
  });

  it('applies the rank and the perimeter: no promotion, no peer outside the companies, no move out', async () => {
    const ca = g0().ca;
    const pa = await freshPa();
    // A CA reaches the PA of his company and may make him a CA of his company; not an SA.
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(pa), { role: 'SA', placeIds: [] })), denied);
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(pa), { placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(pa), { role: 'CA', companyIds: [hex(company(2))], placeIds: [] })), invalid(['companyIds.0', 'incorrect']));
    assert.equal((await as.call(ca, 'PATCH', path(pa), { role: 'CA', companyIds: [hex(company(1))], placeIds: [] })).status, 200);
    // An SA is not even visible to a CA.
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(g0().sa), { firstName: 'x' })), notFound);
    // A PA with places in and out of the companies is visible but not manageable.
    const mixed = await freshPa({ placeId: place(1), placesId: [place(1), place(2)] });
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(mixed), { firstName: 'x' })), denied);
    // A PA manages the employees of his places, and the peers, not the CA.
    const employee = await freshE();
    const pa5 = g0().pa;
    assert.equal((await as.call(pa5, 'PATCH', path(employee), { firstName: 'Worker' })).status, 200);
    assert.deepEqual(failure(await as.call(pa5, 'PATCH', path(employee), { placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    // A company of another group, or any company for a PA, is refused in a patch as well.
    assert.deepEqual(failure(await as.call(pa5, 'PATCH', path(employee), { companyIds: [hex(company(3))] })), invalid(['companyIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(pa5, 'PATCH', path(employee), { companyIds: [hex(company(1))] })), invalid(['companyIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'PATCH', path(employee), { companyIds: [hex(company(2))] })), invalid(['companyIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(pa5, 'PATCH', path(employee), { role: 'CA', companyIds: [hex(company(1))], placeIds: [] })), denied);
    assert.equal((await as.call(pa5, 'PATCH', path(employee), { role: 'PA' })).status, 200);
    assert.deepEqual(failure(await as.call(pa5, 'PATCH', path(ca), { firstName: 'x' })), notFound);
  });

  it('refuses to grant permissions the caller does not hold or may not hand out', async () => {
    const target = await freshPa();
    const holder = await fresh({ permissions: { ...FULL, logs: { r: false, w: false } } });
    await users().updateOne({ _id: target }, { $set: { 'permissions.logs': { r: false, w: false }, 'permissions.users': { r: true, w: false }, 'permissions.status': false } });
    assert.deepEqual(failure(await as.call(holder, 'PATCH', path(target), { permissions: { modules: { logs: { r: true } } } })), denied);
    assert.equal((await as.call(holder, 'PATCH', path(target), { permissions: { modules: { places: { w: false } } } })).status, 200);
    const plain = await fresh({ permissions: { ...FULL, status: false } });
    assert.deepEqual(failure(await as.call(plain, 'PATCH', path(target), { permissions: { modules: { users: { w: true } } } })), denied);
    assert.deepEqual(failure(await as.call(plain, 'PATCH', path(target), { permissions: { canManagePermissions: true } })), denied);
    assert.equal((await as.call(plain, 'PATCH', path(target), { firstName: 'Allowed' })).status, 200);
    const reader = await fresh({ permissions: { ...FULL, users: { r: true, w: false } } });
    assert.deepEqual(failure(await as.call(reader, 'PATCH', path(target), { firstName: 'x' })), denied);
  });

  it('isolates the groups and the dealers', async () => {
    const mine = await freshPa();
    const other = await fresh({ role: 'SA', groupId: g1().groupId, dealerId: g1().dealerId });
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(other), { firstName: 'x' })), notFound);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(other, '', g1()), { firstName: 'x' })), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'PATCH', path(mine), { firstName: 'x' })), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'PATCH', path(mine, '', g1()), { firstName: 'x' })), notFound);
    assert.equal((await as.call(office.cluster.dealerA, 'PATCH', path(mine), { firstName: 'Dealer' })).status, 200);
    assert.equal((await as.call(office.cluster.psa, 'PATCH', path(other, '', g1()), { firstName: 'Psa' })).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'PATCH', path(new ObjectId()), { firstName: 'x' })), notFound);
  });

  it('keeps a suspended or trashed group to the PSA, for every write', async () => {
    const target = await freshPa();
    const groups = ctx.databases.common().collection('groups');
    await groups.updateOne({ _id: g0().groupId }, { $set: { status: false } });
    try {
      for (const [method, rest, body] of [['PATCH', '', { firstName: 'x' }], ['PUT', '/password', { password: PASSWORD }], ['POST', '/trash', undefined], ['POST', '/restore', undefined], ['DELETE', '', undefined]] as const) {
        assert.deepEqual(failure(await as.call(office.cluster.dealerA, method, path(target, rest), body)), notFound, `${method} ${rest}`);
      }
      assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'POST', path(), { username: 'nobody.here', password: PASSWORD, role: 'SA' })), notFound);
      assert.equal((await as.call(office.cluster.psa, 'PATCH', path(target), { firstName: 'Psa only' })).status, 200);
    } finally {
      await groups.updateOne({ _id: g0().groupId }, { $set: { status: true } });
    }
  });

  it('answers 404 when the user disappears under the request', async () => {
    const id = await freshPa({ name: 'Untouched' });
    const name = 'Untouched';
    const usersRepository = createUsersRepository(ctx.databases);
    const build = (overrides: Partial<typeof usersRepository>) =>
      createUsersService({
        config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
        users: { ...usersRepository, ...overrides },
        credentials: createCredentialsRepository(ctx.databases),
        sessions: createSessionsRepository(ctx.databases),
        directory: createGroupDirectoryRepository(ctx.databases),
        activityLog: memoryActivityLog(),
        transaction: (work) => ctx.databases.transaction(work),
        now: () => Date.now(),
      });
    const client = { requestId: 'req-12345678', ip: null, userAgent: null };
    const psa = principalOf('PSA');
    const area = { kind: 'group', access: resolveGroupAccess(psa, hex(g0().groupId))! } as const;
    await assert.rejects(build({ updateOwned: () => Promise.resolve(false) }).update(psa, area, id, { firstName: 'x' }, client), { code: 'NOT_FOUND' });
    assert.equal((await stored(id))['name'], name, 'the refused update wrote nothing');
    await assert.rejects(build({ findById: () => Promise.resolve(null) }).update(psa, area, id, { firstName: 'y' }, client), { code: 'NOT_FOUND' });
  });
});

describe('platform users on /v1/users/{userId}', () => {
  const psa = () => office.cluster.psa;
  const platformUser = async (role: 'D' | 'PSA' = 'D') => {
    const reply = await as.call(psa(), 'POST', '/users', { username: `platform-${hex(new ObjectId())}`, password: PASSWORD, role });
    assert.equal(reply.status, 201);
    return ObjectId.createFromHexString(reply.body.data.id);
  };

  it('is for the PSA only, and only for platform users', async () => {
    const dealer = await platformUser();
    assert.equal((await as.call(psa(), 'GET', `/users/${hex(dealer)}`)).status, 200);
    assert.deepEqual(failure(await as.call(psa(), 'GET', `/users/${hex(g0().sa)}`)), notFound);
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'GET', `/users/${hex(dealer)}`)), denied);
    assert.deepEqual(failure(await as.call(g0().sa, 'GET', `/users/${hex(dealer)}`)), denied);
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'PATCH', `/users/${hex(dealer)}`, { firstName: 'x' })), denied);
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/users/${hex(dealer)}`, { companyIds: [] })), invalid(['companyIds', 'unknown']));
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/users/${hex(dealer)}`, { role: 'SA' })), invalid(['role', 'enum']));
    const renamed = await as.call(psa(), 'PATCH', `/users/${hex(dealer)}`, { firstName: 'Dea', role: 'PSA' });
    assert.deepEqual([renamed.status, renamed.body.data.role, renamed.body.data.firstName], [200, 'PSA', 'Dea']);
  });

  it('resets the password, trashes, restores and deletes a platform user, never the caller himself', async () => {
    const dealer = await platformUser();
    assert.equal((await as.call(psa(), 'PUT', `/users/${hex(dealer)}/password`, { password: PASSWORD })).status, 204);
    assert.equal((await as.call(psa(), 'POST', `/users/${hex(dealer)}/trash`)).body.data.trashed, true);
    assert.equal((await as.call(psa(), 'POST', `/users/${hex(dealer)}/restore`)).body.data.trashed, false);
    assert.deepEqual(failure(await as.call(psa(), 'DELETE', `/users/${hex(dealer)}`)), { status: 409, code: 'CONFLICT', details: undefined });
    await as.call(psa(), 'POST', `/users/${hex(dealer)}/trash`);
    assert.equal((await as.call(psa(), 'DELETE', `/users/${hex(dealer)}`)).status, 204);
    assert.deepEqual(failure(await as.call(psa(), 'GET', `/users/${hex(dealer)}`)), notFound);
    for (const [method, rest] of [['PUT', '/password'], ['POST', '/trash'], ['POST', '/restore'], ['DELETE', '']] as const) {
      assert.deepEqual(failure(await as.call(psa(), method, `/users/${hex(psa())}${rest}`, method === 'PUT' ? { password: PASSWORD } : undefined)), denied, `${method} ${rest}`);
    }
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'DELETE', `/users/${hex(dealer)}`)), denied);
  });
});

describe('PUT /v1/groups/{groupId}/users/{userId}/password', () => {
  it('sets a provisional password, ends the sessions and the legacy tokens, and records it without the password', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const username = userName(id);
    const from = mark();
    const reply = await as.call(g0().sa, 'PUT', path(id, '/password'), { password: PASSWORD });
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    const document = await stored(id);
    assert.equal(document['password'], legacyPasswordHash(PASSWORD, new Secret(TEST_PEPPER)));
    assert.deepEqual(document['tokens'], []);
    const creds = (await credentials().findOne({ _id: id }))!;
    assert.deepEqual([creds['mustChangePassword'], creds['passwordChangedAt'] instanceof Date], [true, true]);
    assert.equal(await works(token), false);
    assert.equal((await office.login(username, TEST_PASSWORD)).status, 401, 'the old password is gone');
    const login = await office.login(username, PASSWORD);
    assert.equal(((await login.json()) as { data: { passwordChangeRequired: boolean } }).data.passwordChangeRequired, true);
    assert.deepEqual(events(from).slice(0, 2), ['user.updated', 'session.revoked:passwordReset']);
    const entry = office.activity.entries[from]!;
    assert.deepEqual(entry.changes!.map((change) => [change.field, change.redacted]), [['password', true]]);
    assert.ok(!JSON.stringify(office.activity.entries.slice(from)).includes(PASSWORD));
  });

  it('also clears the failed logins and the lock of the account', async () => {
    const id = await freshPa();
    await credentials().insertOne({ _id: id, failedLogins: 7, lockedUntil: new Date(Date.now() + 600_000), createdAt: new Date(), updatedAt: new Date() });
    assert.equal((await office.login(userName(id))).status, 401, 'locked');
    assert.equal((await as.call(g0().sa, 'PUT', path(id, '/password'), { password: PASSWORD })).status, 204);
    const creds = (await credentials().findOne({ _id: id }))!;
    assert.deepEqual([creds['failedLogins'], creds['lockedUntil']], [0, null]);
    assert.equal((await office.login(userName(id), PASSWORD)).status, 200);
  });

  it('asks an employee too to change it, and logs no revocation when he had no session', async () => {
    const id = await freshE();
    const from = mark();
    assert.equal((await as.call(g0().sa, 'PUT', path(id, '/password'), { password: PASSWORD })).status, 204);
    assert.equal((await credentials().findOne({ _id: id }))!['mustChangePassword'], true);
    assert.deepEqual(events(from), ['user.updated']);
    assert.equal('ip' in office.activity.entries[from]!, true);
  });

  it('applies the policy, accepts only the password and refuses himself and what he cannot reach', async () => {
    const id = await freshPa();
    const reset = async (body: unknown, actor: ObjectId = g0().sa, target: ObjectId = id) => failure(await as.call(actor, 'PUT', path(target, '/password'), body));
    assert.deepEqual(await reset({ password: 'short' }), invalid(['password', 'tooShort']));
    const named = await freshPa({ userName: 'a-long-enough-username' });
    assert.deepEqual(await reset({ password: 'A-Long-Enough-Username' }, g0().sa, named), invalid(['password', 'sameAsUsername']));
    assert.deepEqual(await reset({}), invalid(['password', 'required']));
    assert.deepEqual(await reset({ password: PASSWORD, extra: 1 }), invalid(['extra', 'unknown']));
    assert.deepEqual(await reset({ currentPassword: 'x', password: PASSWORD }), invalid(['currentPassword', 'unknown']));
    assert.deepEqual(await reset({ password: PASSWORD }, id, id), denied);
    assert.deepEqual(await reset({ password: PASSWORD }, g0().ca, g0().sa), notFound);
    assert.deepEqual(await reset({ password: PASSWORD }, office.cluster.dealerB), notFound);
    assert.deepEqual(await reset({ password: PASSWORD }, g0().sa, new ObjectId()), notFound);
    const mixed = await freshPa({ placeId: place(1), placesId: [place(1), place(2)] });
    assert.deepEqual(await reset({ password: PASSWORD }, g0().ca, mixed), denied);
    assert.equal((await as.call(g0().ca, 'PUT', path(id, '/password'), { password: PASSWORD })).status, 204);
  });
});

describe('trash, restore and permanent deletion', () => {
  it('trashes a user, ends his sessions, hides him from the list and refuses a second time', async () => {
    const id = await freshPa();
    const token = await loggedIn(id);
    const from = mark();
    const reply = await as.call(g0().sa, 'POST', path(id, '/trash'));
    assert.deepEqual([reply.status, reply.body.data.trashed, reply.body.data.id], [200, true, hex(id)]);
    assert.equal((await stored(id))['trash'], true);
    assert.deepEqual((await stored(id))['tokens'], []);
    assert.deepEqual(events(from), ['user.trashed', 'session.revoked:userTrashed']);
    assert.equal(await works(token), false);
    assert.equal((await office.login(userName(id))).status, 401);
    const listed = await as.call(g0().sa, 'GET', `${path()}?trashed=true&limit=200`);
    assert.ok(listed.body.data.some((user: { id: string }) => user.id === hex(id)));
    const hidden = await as.call(g0().sa, 'GET', `${path()}?limit=200`);
    assert.ok(!hidden.body.data.some((user: { id: string }) => user.id === hex(id)));
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(id, '/trash'))), { status: 409, code: 'CONFLICT', details: undefined });
  });

  it('restores a trashed user, who can sign in again, and refuses to restore one that is not in the trash', async () => {
    const id = await freshPa();
    await as.call(g0().sa, 'POST', path(id, '/trash'));
    const from = mark();
    const reply = await as.call(g0().sa, 'POST', path(id, '/restore'));
    assert.deepEqual([reply.status, reply.body.data.trashed], [200, false]);
    assert.equal((await stored(id))['trash'], false);
    assert.deepEqual(events(from), ['user.restored']);
    assert.equal((await office.login(userName(id))).status, 200);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(id, '/restore'))), { status: 409, code: 'CONFLICT', details: undefined });
  });

  it('deletes for good only from the trash: the user, his credentials and all his sessions, and logs no personal data', async () => {
    const id = await freshPa({ name: 'Secret-Name', email: 'secret@example.test' });
    await loggedIn(id);
    await office.login(userName(id));
    assert.equal(await credentials().countDocuments({ _id: id }), 1);
    assert.ok((await sessions().countDocuments({ userId: id })) >= 2);
    assert.deepEqual(failure(await as.call(g0().sa, 'DELETE', path(id))), { status: 409, code: 'CONFLICT', details: undefined });
    assert.equal(await users().countDocuments({ _id: id }), 1);
    await as.call(g0().sa, 'POST', path(id, '/trash'));
    const from = mark();
    const reply = await as.call(g0().sa, 'DELETE', path(id));
    assert.deepEqual([reply.status, reply.body], [204, undefined]);
    assert.deepEqual([await users().countDocuments({ _id: id }), await credentials().countDocuments({ _id: id }), await sessions().countDocuments({ userId: id })], [0, 0, 0]);
    const [entry, ...rest] = office.activity.entries.slice(from);
    assert.deepEqual(rest, []);
    assert.deepEqual([entry!.action, entry!.category, entry!.resource, entry!.groupId?.toHexString(), entry!.metadata, entry!.changes], ['user.deleted', 'data', { type: 'user', id: hex(id) }, hex(g0().groupId), { role: 'PA' }, []]);
    const text = JSON.stringify(entry);
    for (const personal of ['Secret-Name', 'secret@example.test', userName(id)]) {
      assert.ok(!text.includes(personal), personal);
    }
    assert.deepEqual(failure(await as.call(g0().sa, 'GET', path(id))), notFound);
    assert.deepEqual(failure(await as.call(g0().sa, 'DELETE', path(id))), notFound);
  });

  it('is limited by the permission: a CA or a PA never deletes, a dealer and an SA do inside their perimeter', async () => {
    const victim = await freshPa({ trash: true });
    assert.deepEqual(failure(await as.call(g0().ca, 'DELETE', path(victim))), denied);
    assert.deepEqual(failure(await as.call(g0().pa, 'DELETE', path(victim))), denied);
    const reader = await fresh({ permissions: { ...FULL, users: { r: true, w: false } } });
    assert.deepEqual(failure(await as.call(reader, 'DELETE', path(victim))), denied);
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'DELETE', path(victim))), notFound);
    assert.equal((await as.call(office.cluster.dealerA, 'DELETE', path(victim))).status, 204);
    const another = await freshPa({ trash: true });
    assert.equal((await as.call(g0().sa, 'DELETE', path(another))).status, 204);
  });

  it('applies the anti-escalation rules to the state changes too', async () => {
    const ca = g0().ca;
    const pa = await freshPa();
    assert.equal((await as.call(ca, 'POST', path(pa, '/trash'))).status, 200);
    assert.equal((await as.call(ca, 'POST', path(pa, '/restore'))).status, 200);
    assert.deepEqual(failure(await as.call(ca, 'POST', path(g0().sa, '/trash'))), notFound);
    assert.deepEqual(failure(await as.call(ca, 'POST', path(ca, '/trash'))), denied);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(g0().sa, '/trash'))), denied);
    const mixed = await freshPa({ placeId: place(1), placesId: [place(1), place(2)] });
    assert.deepEqual(failure(await as.call(ca, 'POST', path(mixed, '/trash'))), denied);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(office.cluster.psa, '/trash'))), notFound);
    assert.deepEqual(failure(await as.call(g1().sa, 'POST', path(pa, '/trash'))), notFound);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(new ObjectId(), '/restore'))), notFound);
  });
});

describe('GET /v1/usernames/{username}/availability', () => {
  it('tells whether a name is free, in any spelling, and refuses what cannot be a username', async () => {
    const free = await as.call(g0().sa, 'GET', '/usernames/someone.new/availability');
    assert.deepEqual([free.status, free.body], [200, { data: { available: true } }]);
    for (const taken of ['user-003', 'USER-003']) {
      assert.deepEqual((await as.call(g0().sa, 'GET', `/usernames/${taken}/availability`)).body, { data: { available: false } }, taken);
    }
    assert.deepEqual((await as.call(g0().sa, 'GET', '/usernames/ada%40example.test/availability')).body, { data: { available: true } });
    for (const bad of ['ab', 'a'.repeat(65), 'has%20space', '%24ne', encodeURIComponent('ｕｓｅｒ-００３'), encodeURIComponent('usеr-003'), encodeURIComponent('ﬁle')]) {
      assert.equal((await as.call(g0().sa, 'GET', `/usernames/${bad}/availability`)).status, 422, bad);
    }
    const reader = await fresh({ permissions: { ...FULL, users: { r: true, w: false } } });
    assert.deepEqual(failure(await as.call(reader, 'GET', '/usernames/someone.new/availability')), denied);
    assert.equal((await send(office, 'GET', '/usernames/someone.new/availability', undefined)).status, 401);
  });
});

describe('the limits of the second instance: legacy coexistence off, low rate limits', () => {
  let ctx2: TestDatabases;
  let office2: Backoffice;
  let as2: ReturnType<typeof actors>;

  before(async () => {
    ctx2 = await openTestDatabases();
    office2 = await startBackoffice(ctx2, { env: { LEGACY_PASSWORD_COEXISTENCE: 'false', RATE_LIMIT_USERNAME_CHECK_PER_USER: '2', RATE_LIMIT_USER_CREDENTIALS_PER_USER: '4' } });
    as2 = actors(office2);
  });
  after(async () => {
    await office2.close();
    await ctx2.cleanup();
  });

  it('creates and resets a password without writing a legacy hash', async () => {
    const group = office2.cluster.groups[0]!;
    const created = await as2.call(group.sa, 'POST', `/groups/${hex(group.groupId)}/users`, { username: 'no-legacy-hash', password: PASSWORD, role: 'PA', placeIds: [hex(place(1))] });
    assert.equal(created.status, 201);
    const id = ObjectId.createFromHexString(created.body.data.id);
    const users2 = ctx2.databases.common().collection('users');
    assert.ok(!('password' in (await users2.findOne({ _id: id }))!));
    assert.equal((await credentials2().findOne({ _id: id }))!['legacyHashFingerprint'], null);
    const target = group.pa;
    assert.equal((await users2.findOne({ _id: target }))!['password'] !== undefined, true);
    assert.equal((await as2.call(group.sa, 'PUT', `/groups/${hex(group.groupId)}/users/${hex(target)}/password`, { password: PASSWORD })).status, 204);
    assert.ok(!('password' in (await users2.findOne({ _id: target }))!), 'the old legacy hash is removed, it would accept the old password');
    assert.equal((await office2.login('user-005', PASSWORD)).status, 200);
  });

  const credentials2 = () => ctx2.databases.common().collection('userCredentials');

  it('limits the password resets and the availability checks per user, with Retry-After', async () => {
    const group = office2.cluster.groups[0]!;
    const target = `/groups/${hex(group.groupId)}/users/${hex(group.employee)}/password`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await as2.call(group.sa, 'PUT', target, { password: PASSWORD })).status);
    }
    assert.deepEqual(statuses, [204, 204, 429]);
    // The creations share the bucket: the same user cannot start a scrypt run by another door either.
    const creation = await as2.call(group.sa, 'POST', `/groups/${hex(group.groupId)}/users`, { username: 'over.the.limit', password: PASSWORD, role: 'SA' });
    assert.deepEqual([creation.status, creation.body.error.code], [429, 'RATE_LIMITED']);
    assert.equal((await as2.call(office2.cluster.psa, 'POST', '/users', { username: 'psa.is.another.user', password: PASSWORD, role: 'D' })).status, 201);
    const checks: number[] = [];
    let retryAfter: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await as2.call(group.ca, 'GET', '/usernames/free.name/availability');
      checks.push(reply.status);
      retryAfter = reply.headers.get('retry-after');
    }
    assert.deepEqual(checks, [200, 200, 429]);
    assert.ok(Number(retryAfter) > 0);
  });
});

describe('nobody takes down an account stronger than his own', () => {
  const RESTRICTED = { ...FULL, status: false, logs: { r: false, w: false }, companies: { r: true, w: false } };
  const attempts = (target: ObjectId): Array<[string, string, unknown?]> => [
    ['PUT', path(target, '/password'), { password: PASSWORD }],
    ['PATCH', path(target), { status: 'disabled' }],
    ['POST', path(target, '/trash')],
  ];

  it('refuses a restricted SA the reset, the disabling, the trash and the deletion of a full SA, and leaves the account intact', async () => {
    const restricted = await fresh({ permissions: RESTRICTED });
    const strong = await fresh();
    const token = await loggedIn(strong);
    for (const [method, url, body] of attempts(strong)) {
      assert.deepEqual(failure(await as.call(restricted, method, url, body)), denied, `${method} ${url}`);
    }
    await users().updateOne({ _id: strong }, { $set: { trash: true } });
    assert.deepEqual(failure(await as.call(restricted, 'DELETE', path(strong))), denied);
    assert.equal(await users().countDocuments({ _id: strong }), 1);
    assert.equal(await credentials().countDocuments({ _id: strong, mustChangePassword: true }), 0);
    await users().updateOne({ _id: strong }, { $set: { trash: false } });
    assert.ok(await works(token), 'his session was not touched');
    // He cannot change the account in any way: not the role, the permissions, the username, nor a telephone number.
    for (const patch of [
      { role: 'E', placeIds: [hex(place(1))] },
      { permissions: { modules: { users: { r: false, w: false }, places: { r: false, w: false }, companies: { r: false, w: false }, groups: { r: false, w: false }, logs: { r: false, w: false } } } },
      { username: 'taken.over' },
      { phone: '+39 06 000' },
      { firstName: 'Still not allowed' },
    ]) {
      assert.deepEqual(failure(await as.call(restricted, 'PATCH', path(strong), patch)), denied, JSON.stringify(patch));
    }
    assert.equal((await stored(strong))['userName'] === 'taken.over', false);
    // A full superior can.
    assert.equal((await as.call(g0().sa, 'PATCH', path(strong), { phone: '+39 06 111' })).status, 200);
  });

  it('refuses a PSA without the right to manage permissions the lock-out of one who has it', async () => {
    const weakPsa = await fresh({ role: 'PSA', groupId: null, dealerId: null, permissions: { ...FULL, status: false } });
    const strongPsa = await fresh({ role: 'PSA', groupId: null, dealerId: null });
    for (const [method, url, body] of [
      ['PUT', `/users/${hex(strongPsa)}/password`, { password: PASSWORD }],
      ['PATCH', `/users/${hex(strongPsa)}`, { status: 'disabled' }],
      ['POST', `/users/${hex(strongPsa)}/trash`, undefined],
    ] as const) {
      assert.deepEqual(failure(await as.call(weakPsa, method, url, body)), denied, `${method} ${url}`);
    }
    // The other way round it is allowed: the weak one holds less than the strong one.
    assert.equal((await as.call(strongPsa, 'POST', `/users/${hex(weakPsa)}/trash`)).status, 200);
  });

  it('refuses a restricted CA the lock-out of a full CA of the same company', async () => {
    const restricted = await fresh({ role: 'CA', companyId: company(1), permissions: RESTRICTED });
    const strong = await fresh({ role: 'CA', companyId: company(1) });
    for (const [method, url, body] of attempts(strong)) {
      assert.deepEqual(failure(await as.call(restricted, method, url, body)), denied, `${method} ${url}`);
    }
  });

  it('allows a full superior the lock-out of an inferior, and the disabling of one that is already disabled', async () => {
    const pa = await freshPa();
    assert.equal((await as.call(g0().sa, 'PATCH', path(pa), { status: 'disabled' })).status, 200);
    assert.equal((await as.call(g0().sa, 'PUT', path(pa, '/password'), { password: PASSWORD })).status, 204);
    assert.equal((await as.call(g0().sa, 'POST', path(pa, '/trash'))).status, 200);
    assert.equal((await as.call(g0().sa, 'DELETE', path(pa))).status, 204);
  });
});

describe('permanent deletion: dealers with groups, and the race with a restore', () => {
  it('refuses to delete a dealer who is still the dealer of a group, trashed or not, and deletes one who is not', async () => {
    const reply = await as.call(office.cluster.psa, 'POST', '/users', { username: 'dealer.with.groups', password: PASSWORD, role: 'D' });
    const dealer = ObjectId.createFromHexString(reply.body.data.id);
    const groupId = fixtureId('group', 77);
    await ctx.databases.common().collection('groups').insertOne({ _id: groupId, name: 'dealer-group', dealerId: dealer, status: true, trash: true });
    await as.call(office.cluster.psa, 'POST', `/users/${hex(dealer)}/trash`);
    assert.deepEqual(failure(await as.call(office.cluster.psa, 'DELETE', `/users/${hex(dealer)}`)), { status: 409, code: 'CONFLICT', details: undefined });
    assert.equal(await users().countDocuments({ _id: dealer }), 1);
    await ctx.databases.common().collection('groups').deleteOne({ _id: groupId });
    assert.equal((await as.call(office.cluster.psa, 'DELETE', `/users/${hex(dealer)}`)).status, 204);
  });

  it('does not delete a user restored between the check and the delete, and leaves his credentials', async () => {
    const id = await freshPa({ trash: true });
    await credentials().insertOne({ _id: id, failedLogins: 0, createdAt: new Date(), updatedAt: new Date() });
    const usersRepository = createUsersRepository(ctx.databases);
    const service = createUsersService({
      config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
      users: { ...usersRepository, deleteTrashed: () => Promise.resolve(false) },
      credentials: createCredentialsRepository(ctx.databases),
      sessions: createSessionsRepository(ctx.databases),
      directory: createGroupDirectoryRepository(ctx.databases),
      activityLog: memoryActivityLog(),
      transaction: (work) => ctx.databases.transaction(work),
      now: () => Date.now(),
    });
    const psa = principalOf('PSA');
    const area = { kind: 'group', access: resolveGroupAccess(psa, hex(g0().groupId))! } as const;
    await assert.rejects(service.remove(psa, area, id, { requestId: 'req-12345678', ip: null, userAgent: null }), { code: 'CONFLICT' });
    assert.equal(await credentials().countDocuments({ _id: id }), 1);
  });

  it('writes no credentials when the user vanished before the reset', async () => {
    const id = await freshPa();
    const usersRepository = createUsersRepository(ctx.databases);
    const service = createUsersService({
      config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
      users: { ...usersRepository, updateOwned: () => Promise.resolve(false) },
      credentials: createCredentialsRepository(ctx.databases),
      sessions: createSessionsRepository(ctx.databases),
      directory: createGroupDirectoryRepository(ctx.databases),
      activityLog: memoryActivityLog(),
      transaction: (work) => ctx.databases.transaction(work),
      now: () => Date.now(),
    });
    const psa = principalOf('PSA');
    const area = { kind: 'group', access: resolveGroupAccess(psa, hex(g0().groupId))! } as const;
    await assert.rejects(service.resetPassword(psa, area, id, { password: PASSWORD }, { requestId: 'req-12345678', ip: null, userAgent: null }), { code: 'NOT_FOUND' });
    assert.equal(await credentials().countDocuments({ _id: id }), 0);
  });
});
