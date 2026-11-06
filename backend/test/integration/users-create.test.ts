import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { fromLegacy } from '../../src/modules/users/user.mapper.ts';
import type { LegacyUserDocument } from '../../src/modules/users/user.types.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { createUsersService } from '../../src/modules/users/users.service.ts';
import { legacyHashFingerprint, legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { TEST_PEPPER, addUser as addBackofficeUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fixtureId, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const PASSWORD = `Prov-${randomBytes(8).toString('hex')}-pass`;
const FULL = { status: true, groups: { r: true, w: true }, users: { r: true, w: true }, companies: { r: true, w: true }, places: { r: true, w: true }, logs: { r: true, w: true }, apps: { cash: { status: true } } };
const users = () => ctx.databases.common().collection('users');
const credentials = () => ctx.databases.common().collection('userCredentials');
const g0 = () => office.cluster.groups[0]!;
const g1 = () => office.cluster.groups[1]!;
const hex = (id: ObjectId) => id.toHexString();
const path = (group = g0(), rest = '') => `/groups/${hex(group.groupId)}/users${rest}`;
const company = (n: number) => fixtureId('company', n);
const place = (n: number) => fixtureId('place', n);
const idOf = (reply: { body: { data: { id: string } } }) => ObjectId.createFromHexString(reply.body.data.id);
const stored = async (id: ObjectId): Promise<Document> => (await users().findOne({ _id: id }))!;
let sequence = 0;
const name = (): string => `created-${String(sequence++)}`;
/** An actor of the first group with the whole legacy matrix, unless told otherwise. */
const actor = async (overrides: Document = {}) => (await addBackofficeUser(ctx, office, { permissions: FULL, ...overrides })).id;
const body = (overrides: Document = {}): Document => ({ username: name(), password: PASSWORD, role: 'E', placeIds: [hex(place(1))], ...overrides });
const failure = (reply: Awaited<ReturnType<typeof as.call>>) => as.failure(reply);
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('POST /v1/groups/{groupId}/users: a new user', () => {
  const cases: Array<[string, Document, Document]> = [
    ['SA', { role: 'SA' }, { companyIds: [], placeIds: [] }],
    ['CA', { role: 'CA', companyIds: [hex(company(1))] }, { companyIds: [hex(company(1))], placeIds: [] }],
    ['PA', { role: 'PA', placeIds: [hex(place(1))] }, { companyIds: [], placeIds: [hex(place(1))] }],
    ['E', { role: 'E', companyIds: [hex(company(2))], placeIds: [hex(place(2))] }, { companyIds: [hex(company(2))], placeIds: [hex(place(2))] }],
  ];
  for (const [label, request, scope] of cases) {
    it(`creates a ${label} as a legacy document that reads back clean, with scrypt credentials and a provisional password`, async () => {
      const username = name();
      await as.tokenOf(g0().sa);
      const mark = office.activity.entries.length;
      const reply = await as.call(g0().sa, 'POST', path(), body({ ...request, placeIds: undefined, ...(request['placeIds'] === undefined ? {} : { placeIds: request['placeIds'] }), username, firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@Example.test', phone: '+39 06 1234' }));
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const data = reply.body.data;
      assert.equal(reply.headers.get('location'), `/v1/groups/${hex(g0().groupId)}/users/${String(data.id)}`);
      assert.deepEqual(
        { username: data.username, role: data.role, groupId: data.groupId, dealerId: data.dealerId, status: data.status, trashed: data.trashed, language: data.language, firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone, hiddenInStats: data.hiddenInStats, ...scope },
        { username, role: label, groupId: hex(g0().groupId), dealerId: hex(office.cluster.dealerA), status: 'active', trashed: false, language: 'it', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: '+39 06 1234', hiddenInStats: false, companyIds: data.companyIds, placeIds: data.placeIds },
      );
      assert.deepEqual([data.companyIds, data.placeIds], [scope['companyIds'], scope['placeIds']]);
      assert.equal(data.permissions.canManagePermissions, false);
      assert.equal(data.permissions.status, false);

      // The stored document, as the legacy would read it.
      const id = idOf(reply);
      const document = await stored(id);
      assert.deepEqual(fromLegacy(document as LegacyUserDocument).anomalies, []);
      assert.deepEqual(Object.keys(document).sort(), [
        '_id', 'companyId', 'dealerId', 'email', 'groupId', 'insertDate', 'name', 'password', 'permissions', 'placeId', 'placesId', 'role', 'settings', 'status', 'surname', 'telephone', 'tokens', 'trash', 'updateDate', 'userName',
      ]);
      assert.equal(document['status'], true);
      assert.equal(document['trash'], false);
      assert.deepEqual(document['tokens'], []);
      assert.deepEqual(document['settings'], { language: 'it', hiddenInStats: false });
      assert.ok((document['groupId'] as ObjectId).equals(g0().groupId));
      assert.ok((document['dealerId'] as ObjectId).equals(office.cluster.dealerA));
      assert.ok(document['insertDate'] instanceof Date && document['updateDate'] instanceof Date);
      assert.equal(document['userName'], username);
      assert.equal(document['password'], legacyPasswordHash(PASSWORD, new Secret(TEST_PEPPER)));
      const expectedCompany = (scope['companyIds'] as string[])[0];
      assert.equal(document['companyId'] === null ? undefined : hex(document['companyId'] as ObjectId), expectedCompany);
      assert.deepEqual((document['placesId'] as ObjectId[]).map(hex), scope['placeIds']);
      assert.deepEqual(Object.keys(document['permissions'] as Document).sort(), ['companies', 'groups', 'logs', 'places', 'status', 'users']);
      assert.ok(!('apps' in (document['permissions'] as Document)) && !('pin' in document) && !('avatar' in document));

      const creds = (await credentials().findOne({ _id: id }))!;
      assert.match(creds['passwordHash'] as string, /^scrypt\$/);
      assert.equal(creds['legacyHashFingerprint'], legacyHashFingerprint(document['password'] as string));
      assert.equal(creds['mustChangePassword'], true, 'every role, the employee too');
      assert.deepEqual([creds['failedLogins'], creds['passwordChangedAt'] instanceof Date], [0, true]);

      // The activity log has the creation with before/after and never the password.
      const events = office.activity.entries.slice(mark);
      assert.deepEqual(events.map((entry) => [entry.action, entry.category, entry.resource?.id, entry.groupId?.toHexString(), entry.actor.id?.toHexString()]), [
        ['user.created', 'data', hex(id), hex(g0().groupId), hex(g0().sa)],
      ]);
      const passwordChange = events[0]!.changes!.find((change) => change.field === 'password');
      assert.deepEqual(passwordChange, { field: 'password', redacted: true });
      assert.ok(!JSON.stringify(events).includes(PASSWORD));
      assert.ok(events[0]!.changes!.some((change) => change.field === 'username' && change.after === username));
    });
  }

  it('lets the new user sign in with the provisional password, and tells him to change it; an employee cannot sign in at all', async () => {
    const username = name();
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ role: 'PA', username }))).status, 201);
    const login = await office.login(username, PASSWORD);
    assert.equal(login.status, 200);
    assert.equal(((await login.json()) as { data: { passwordChangeRequired: boolean } }).data.passwordChangeRequired, true);
    const employee = name();
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ role: 'E', username: employee }))).status, 201);
    assert.equal((await office.login(employee, PASSWORD)).status, 401);
  });

  it('creates a disabled user that cannot sign in, and applies the language', async () => {
    const username = name();
    const reply = await as.call(g0().sa, 'POST', path(), body({ role: 'PA', username, status: 'disabled', language: 'it' }));
    assert.equal(reply.body.data.status, 'disabled');
    assert.equal((await stored(idOf(reply)))['status'], false);
    assert.equal((await office.login(username, PASSWORD)).status, 401);
  });

  it('removes duplicates from the scope lists and keeps the order of the first appearance', async () => {
    const reply = await as.call(g0().sa, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(2)), hex(place(1)), hex(place(2))] }));
    assert.deepEqual(reply.body.data.placeIds, [hex(place(2)), hex(place(1))]);
  });

  it('gives a user created by a platform user the dealer of the group', async () => {
    const reply = await as.call(office.cluster.psa, 'POST', path(g1()), body({ role: 'SA', placeIds: undefined }));
    assert.equal(reply.status, 201);
    assert.equal(reply.body.data.dealerId, hex(office.cluster.dealerA));
    const orphan = await ctx.databases.common().collection('groups').updateOne({ _id: g1().groupId }, { $unset: { dealerId: '' } });
    assert.equal(orphan.modifiedCount, 1);
    try {
      const without = await as.call(office.cluster.psa, 'POST', path(g1()), body({ role: 'SA', placeIds: undefined }));
      assert.equal(without.status, 201);
      assert.equal(without.body.data.dealerId, null);
      assert.equal((await stored(idOf(without)))['dealerId'], null);
    } finally {
      await ctx.databases.common().collection('groups').updateOne({ _id: g1().groupId }, { $set: { dealerId: office.cluster.dealerA } });
    }
  });
});

describe('POST /v1/groups/{groupId}/users: the request is validated', () => {
  const post = async (request: unknown) => failure(await as.call(g0().sa, 'POST', path(), request));

  it('needs a JSON object body', async () => {
    assert.deepEqual(failure(await send(office, 'POST', path(), await as.tokenOf(g0().sa))), invalid(['(body)', 'required']));
    assert.deepEqual(await post([]), invalid(['(body)', 'type']));
    assert.deepEqual(await post('text'), { status: 400, code: 'MALFORMED_JSON', details: undefined });
    assert.deepEqual(await post({}), invalid(['username', 'required'], ['password', 'required'], ['role', 'required']));
  });

  it('refuses fields it does not own, operators and prototype keys, with the field and never the value', async () => {
    for (const [field, value] of [['groupId', hex(g1().groupId)], ['dealerId', hex(office.cluster.dealerA)], ['pin', '1234'], ['tokens', []], ['apps', {}], ['_id', hex(new ObjectId())], ['trash', true], ['hiddenInStats', true]] as const) {
      const result = await post(body({ [field]: value }));
      assert.deepEqual(result, invalid([field, 'unknown']), field);
    }
    assert.deepEqual(await post(body({ '$set': 1 })), invalid(['(key)', 'forbiddenKey']));
    assert.deepEqual(await post(body({ 'a.b': 1 })), invalid(['(key)', 'forbiddenKey']));
    assert.deepEqual(await post(body({ permissions: { apps: { cash: { status: true } } } })), invalid(['permissions.apps', 'unknown']));
    assert.deepEqual(await post(body({ permissions: { modules: { products: { r: true } } } })), invalid(['permissions.modules.products', 'unknown']));
    assert.deepEqual(await post(body({ permissions: { modules: { users: { x: true } } } })), invalid(['permissions.modules.users.x', 'unknown']));
    assert.deepEqual(await post(body({ permissions: { modules: { users: { r: 'yes' } } } })), invalid(['permissions.modules.users.r', 'type']));
    assert.deepEqual(await post(body({ permissions: { canManagePermissions: 1 } })), invalid(['permissions.canManagePermissions', 'type']));
  });

  it('checks every field', async () => {
    assert.deepEqual(await post(body({ username: 'ab' })), invalid(['username', 'minLength']));
    assert.deepEqual(await post(body({ username: 'a'.repeat(65) })), invalid(['username', 'maxLength']));
    for (const bad of ['has space', 'semi;colon', 'quo"te', 'new\nline', 'sla/sh', '{"$ne":1}']) {
      assert.deepEqual(await post(body({ username: bad })), invalid(['username', 'pattern']), bad);
    }
    assert.deepEqual(await post(body({ username: 7 })), invalid(['username', 'type']));
    assert.deepEqual(await post(body({ role: 'PSA' })), invalid(['role', 'enum']));
    assert.deepEqual(await post(body({ role: 'D' })), invalid(['role', 'enum']));
    assert.deepEqual(await post(body({ role: 'API' })), invalid(['role', 'enum']));
    assert.deepEqual(await post(body({ role: ['E'] })), invalid(['role', 'type']));
    assert.deepEqual(await post(body({ email: 'nope' })), invalid(['email', 'format']));
    assert.deepEqual(await post(body({ phone: 'call me' })), invalid(['phone', 'format']));
    assert.deepEqual(await post(body({ firstName: 'Ada\u0000' })), invalid(['firstName', 'format']));
    assert.deepEqual(await post(body({ lastName: '' })), invalid(['lastName', 'minLength']));
    assert.deepEqual(await post(body({ language: 'fr' })), invalid(['language', 'enum']));
    assert.deepEqual(await post(body({ status: 'banned' })), invalid(['status', 'enum']));
    assert.deepEqual(await post(body({ placeIds: ['zz'] })), invalid(['placeIds.0', 'format']));
    assert.deepEqual(await post(body({ placeIds: 'x' })), invalid(['placeIds', 'type']));
    assert.deepEqual(await post(body({ placeIds: Array.from({ length: 101 }, () => hex(place(1))) })), invalid(['placeIds', 'tooMany']));
    assert.deepEqual(await post(body({ password: 12 })), invalid(['password', 'type']));
    assert.deepEqual(await post(body({ password: '\ud800' })), invalid(['password', 'format']));
  });

  it('requires the scope of the role and refuses one the role cannot have (D-08)', async () => {
    assert.deepEqual(await post(body({ role: 'SA', placeIds: undefined, companyIds: [hex(company(1))] })), invalid(['companyIds', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'SA', placeIds: [hex(place(1))] })), invalid(['placeIds', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'CA', placeIds: undefined })), invalid(['companyIds', 'required']));
    assert.deepEqual(await post(body({ role: 'CA', placeIds: undefined, companyIds: [] })), invalid(['companyIds', 'required']));
    assert.deepEqual(await post(body({ role: 'PA', placeIds: undefined })), invalid(['placeIds', 'required']));
    assert.deepEqual(await post(body({ role: 'PA', placeIds: [] })), invalid(['placeIds', 'required']));
    assert.deepEqual(await post(body({ role: 'E', placeIds: undefined, companyIds: [hex(company(1))] })), invalid(['placeIds', 'required']));
  });

  it('refuses companies and places that do not exist, are in the trash, are of another group or do not fit the companies, all with the same answer', async () => {
    const stray = hex(new ObjectId());
    assert.deepEqual(await post(body({ role: 'CA', placeIds: undefined, companyIds: [stray] })), invalid(['companyIds.0', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1)), hex(company(3))] })), invalid(['companyIds.1', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'PA', placeIds: [stray] })), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'PA', placeIds: [hex(place(1)), hex(place(3))] })), invalid(['placeIds.1', 'incorrect']));
    // A place of company 2 for a user of company 1.
    assert.deepEqual(await post(body({ role: 'PA', companyIds: [hex(company(1))], placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(await post(body({ role: 'CA', companyIds: [hex(company(1))], placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    // In the trash.
    const database = ctx.databases.group(g0().groupId, TEST_CLUSTER);
    await database.collection('companies').updateOne({ _id: company(2) }, { $set: { trash: true } });
    await database.collection('places').updateOne({ _id: place(2) }, { $set: { trash: true } });
    try {
      assert.deepEqual(await post(body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(2))] })), invalid(['companyIds.0', 'incorrect']));
      assert.deepEqual(await post(body({ role: 'PA', placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    } finally {
      await database.collection('companies').updateOne({ _id: company(2) }, { $set: { trash: false } });
      await database.collection('places').updateOne({ _id: place(2) }, { $set: { trash: false } });
    }
    // A place with no company is accepted only when the user has no companies.
    await database.collection('places').updateOne({ _id: place(2) }, { $unset: { companyId: '' } });
    try {
      assert.equal((await as.call(g0().sa, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(2))] }))).status, 201);
      assert.deepEqual(await post(body({ role: 'PA', companyIds: [hex(company(2))], placeIds: [hex(place(2))] })), invalid(['placeIds.0', 'incorrect']));
    } finally {
      await database.collection('places').updateOne({ _id: place(2) }, { $set: { companyId: company(2) } });
    }
  });

  it('applies the password policy (D-19) and says which rule failed', async () => {
    assert.deepEqual(await post(body({ password: 'short' })), invalid(['password', 'tooShort']));
    assert.deepEqual(await post(body({ password: 'x'.repeat(129) })), invalid(['password', 'tooLong']));
    assert.deepEqual(await post(body({ username: 'same-as-user-name', password: 'SAME-as-user-name' })), invalid(['password', 'sameAsUsername']));
    assert.deepEqual(await post(body({ username: 'abc', password: 'abc' })), invalid(['password', 'tooShort'], ['password', 'sameAsUsername']));
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ password: 'x'.repeat(128) }))).status, 201);
  });

  it('refuses a username already used, in any spelling (D-15), without creating anything', async () => {
    const before = await users().countDocuments();
    for (const taken of ['user-003', 'USER-003', 'User-003']) {
      assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(), body({ username: taken }))), { status: 409, code: 'CONFLICT', details: [{ field: 'username', issue: 'taken' }] }, taken);
    }
    // The same name written with look-alike letters is not a username at all.
    for (const lookAlike of ['ｕｓｅｒ-００３', 'ﬁle.name', 'usеr-003', 'úser-003', 'user\u200b-003']) {
      assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(), body({ username: lookAlike }))), invalid(['username', 'pattern']), lookAlike);
    }
    // A weak password is refused before anything is said about the username: no way to probe which names exist.
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(), body({ username: 'user-003', password: 'weak' }))), invalid(['password', 'tooShort']));
    // A user of the old signup flow that has only `username`.
    await users().insertOne(legacyUser(1200, { userName: undefined, username: 'Old-Signup' }));
    assert.equal(failure(await as.call(g0().sa, 'POST', path(), body({ username: 'old-signup' }))).status, 409);
    assert.equal(await users().countDocuments(), before + 1);
    assert.equal(await credentials().countDocuments({ passwordHash: 'x' }), 0);
  });

  it('refuses a body over the limit with 413 and another content type with 415', async () => {
    const token = await as.tokenOf(g0().sa);
    const big = await send(office, 'POST', path(), token, body({ firstName: 'x'.repeat(20_000) }));
    assert.equal(big.status, 413);
    const text = await fetch(`${office.app.baseUrl}/v1${path()}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
  });
});

describe('POST /v1/groups/{groupId}/users: who may create whom', () => {
  it('is refused without the permission, and for a group the caller cannot reach', async () => {
    const reader = await actor({ permissions: { ...FULL, users: { r: true, w: false } } });
    assert.deepEqual(failure(await as.call(reader, 'POST', path(), body())), denied);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', path(g1()), body())).status, 404);
    assert.deepEqual(failure(await as.call(office.cluster.dealerB, 'POST', path(), body())).status, 404);
    assert.equal((await as.call(office.cluster.dealerA, 'POST', path(g1()), body({ role: 'SA', placeIds: undefined }))).status, 201);
    assert.equal((await as.call(office.cluster.dealerA, 'POST', path(office.cluster.groups[2]!), body())).status, 404);
  });

  it('lets a CA create a CA of his company and a PA or E of his places, nothing else', async () => {
    const ca = g0().ca;
    assert.equal((await as.call(ca, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1))] }))).status, 201);
    assert.equal((await as.call(ca, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(1))] }))).status, 201);
    assert.equal((await as.call(ca, 'POST', path(), body({ role: 'E', placeIds: [hex(place(1))] }))).status, 201);
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'SA', placeIds: undefined }))), denied);
    // Outside the perimeter of the caller is the same answer as a company that does not exist, by position.
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(2))] }))), invalid(['companyIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1)), hex(company(2))] }))), invalid(['companyIds.1', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(2))] }))), invalid(['placeIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(1)), hex(place(2))] }))), invalid(['placeIds.1', 'incorrect']));
    // A company of another group, and a company for a PA or E, are refused the same way.
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'PA', companyIds: [hex(company(3))], placeIds: [hex(place(1))] }))), invalid(['companyIds.0', 'incorrect'], ['placeIds.0', 'incorrect']));
    assert.deepEqual(failure(await as.call(ca, 'POST', path(), body({ role: 'E', companyIds: [hex(company(2))], placeIds: [hex(place(1))] }))), invalid(['companyIds.0', 'incorrect'], ['placeIds.0', 'incorrect']));
    assert.equal((await as.call(ca, 'POST', path(), body({ role: 'E', companyIds: [hex(company(1))], placeIds: [hex(place(1))] }))).status, 201);
  });

  it('lets a PA create a PA or E of his places, nothing else', async () => {
    const pa = g0().pa;
    assert.equal((await as.call(pa, 'POST', path(), body({ role: 'PA', placeIds: [hex(place(1))] }))).status, 201);
    assert.equal((await as.call(pa, 'POST', path(), body({ role: 'E', placeIds: [hex(place(1))] }))).status, 201);
    assert.deepEqual(failure(await as.call(pa, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1))] }))), denied);
    assert.deepEqual(failure(await as.call(pa, 'POST', path(), body({ role: 'SA', placeIds: undefined }))), denied);
    assert.deepEqual(failure(await as.call(pa, 'POST', path(), body({ role: 'E', placeIds: [hex(place(2))] }))), invalid(['placeIds.0', 'incorrect']));
    // A PA cannot name a company at all, not even the one of his place.
    assert.deepEqual(failure(await as.call(pa, 'POST', path(), body({ role: 'E', companyIds: [hex(company(1))], placeIds: [hex(place(1))] }))), invalid(['companyIds.0', 'incorrect']));
  });

  it('lets an SA create another SA, and a dealer or the PSA create in the groups they reach', async () => {
    assert.equal((await as.call(g0().sa, 'POST', path(), body({ role: 'SA', placeIds: undefined }))).status, 201);
    assert.equal((await as.call(office.cluster.dealerA, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1))] }))).status, 201);
    assert.equal((await as.call(office.cluster.psa, 'POST', path(office.cluster.groups[3]!), body({ role: 'SA', placeIds: undefined }))).status, 201);
  });

  it('gives the permissions of the role limited to what the creator holds, and refuses to hand out more', async () => {
    const limited = await actor({ permissions: { ...FULL, status: false, logs: { r: false, w: false }, companies: { r: true, w: false } } });
    const created = await as.call(limited, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1))] }));
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.data.permissions, {
      status: false,
      canManagePermissions: false,
      modules: { groups: { r: false, w: false }, users: { r: true, w: true }, companies: { r: true, w: false }, places: { r: true, w: true }, logs: { r: false, w: false } },
    });
    const stored1 = (await stored(idOf(created)))['permissions'] as Document;
    assert.deepEqual([stored1['status'], stored1['logs'], stored1['companies']], [false, { r: false, w: false }, { r: true, w: false }]);
    // Without canManagePermissions he cannot choose a matrix at all, not even the same one.
    assert.deepEqual(failure(await as.call(limited, 'POST', path(), body({ permissions: { modules: { users: { r: true } } } }))), denied);
    assert.deepEqual(failure(await as.call(limited, 'POST', path(), body({ permissions: { canManagePermissions: true } }))), denied);
  });

  it('lets a user who can manage permissions choose them, but only flags he holds', async () => {
    const manager = await actor({ permissions: { ...FULL, logs: { r: false, w: false }, groups: { r: false, w: false } } });
    const chosen = await as.call(manager, 'POST', path(), body({ role: 'CA', placeIds: undefined, companyIds: [hex(company(1))], permissions: { canManagePermissions: true, modules: { companies: { w: false }, places: { r: false, w: false } } } }));
    assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
    assert.deepEqual(chosen.body.data.permissions, {
      status: true,
      canManagePermissions: true,
      modules: { groups: { r: false, w: false }, users: { r: true, w: true }, companies: { r: true, w: false }, places: { r: false, w: false }, logs: { r: false, w: false } },
    });
    assert.deepEqual(failure(await as.call(manager, 'POST', path(), body({ permissions: { modules: { logs: { r: true } } } }))), denied);
    assert.deepEqual(failure(await as.call(manager, 'POST', path(), body({ role: 'SA', placeIds: undefined, permissions: { modules: { groups: { w: true } } } }))), denied);
  });
});

describe('platform users on /v1/users', () => {
  const psa = () => office.cluster.psa;

  it('lets the PSA create a PSA or a dealer, without group and scope, and nobody else', async () => {
    const dealer = await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'D', firstName: 'Dea' });
    assert.equal(dealer.status, 201, JSON.stringify(dealer.body));
    assert.equal(dealer.headers.get('location'), `/v1/users/${String(dealer.body.data.id)}`);
    assert.deepEqual([dealer.body.data.role, dealer.body.data.groupId, dealer.body.data.dealerId, dealer.body.data.companyIds, dealer.body.data.placeIds], ['D', null, null, [], []]);
    const document = await stored(idOf(dealer));
    assert.deepEqual([document['groupId'], document['dealerId'], document['companyId'], document['placeId'], document['placesId']], [null, null, null, null, []]);
    assert.deepEqual(fromLegacy(document as LegacyUserDocument).anomalies, []);
    assert.equal((await credentials().findOne({ _id: idOf(dealer) }))!['mustChangePassword'], true);
    assert.equal((await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'PSA', permissions: { canManagePermissions: true } })).status, 201);
    assert.deepEqual(failure(await as.call(office.cluster.dealerA, 'POST', '/users', { username: name(), password: PASSWORD, role: 'D' })), denied);
    assert.deepEqual(failure(await as.call(g0().sa, 'POST', '/users', { username: name(), password: PASSWORD, role: 'D' })), denied);
    assert.deepEqual(failure(await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'SA' })), invalid(['role', 'enum']));
    assert.deepEqual(failure(await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'D', companyIds: [] })), invalid(['companyIds', 'unknown']));
    assert.deepEqual(failure(await as.call(psa(), 'POST', '/users', { username: 'user-001', password: PASSWORD, role: 'D' })).status, 409);
  });
});

describe('creating a user is all or nothing', () => {
  const build = (overrides: Partial<Parameters<typeof createUsersService>[0]> = {}) => {
    const repositories = { users: createUsersRepository(ctx.databases), credentials: createCredentialsRepository(ctx.databases), sessions: createSessionsRepository(ctx.databases) };
    const activityLog = memoryActivityLog();
    return {
      activityLog,
      service: createUsersService({
        config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
        ...repositories,
        directory: createGroupDirectoryRepository(ctx.databases),
        activityLog,
        transaction: (work) => ctx.databases.transaction(work),
        now: () => Date.now(),
        ...overrides,
      }),
    };
  };
  const client = { requestId: 'req-12345678', ip: null, userAgent: null };

  it('leaves no user behind when the credentials cannot be written', async () => {
    const credentialsRepository = createCredentialsRepository(ctx.databases);
    const { service, activityLog } = build({ credentials: { ...credentialsRepository, upsertPassword: () => Promise.reject(new Error('disk full')) } });
    const username = name();
    await assert.rejects(service.create(principalOf('PSA'), { kind: 'platform' }, { username, password: PASSWORD, role: 'D' }, client), /disk full/);
    assert.equal(await users().countDocuments({ userName: username }), 0);
    assert.deepEqual(activityLog.entries, []);
  });

  it('answers 409 when the unique index of the legacy catches a name created at the same moment', async () => {
    const usersRepository = createUsersRepository(ctx.databases);
    const { service } = build({ users: { ...usersRepository, isUsernameTaken: () => Promise.resolve(false) } });
    await assert.rejects(service.create(principalOf('PSA'), { kind: 'platform' }, { username: 'user-001', password: PASSWORD, role: 'D' }, client), { code: 'CONFLICT', details: [{ field: 'username', issue: 'taken' }] });
    assert.equal(await credentials().countDocuments({ passwordHash: { $exists: false } }), 0);
  });

  it('does not hide an unexpected database error as a conflict', async () => {
    const usersRepository = createUsersRepository(ctx.databases);
    const { service } = build({ users: { ...usersRepository, insert: () => Promise.reject(new Error('socket closed')) } });
    await assert.rejects(service.create(principalOf('PSA'), { kind: 'platform' }, { username: name(), password: PASSWORD, role: 'D' }, client), /socket closed/);
  });

  it('records a creation without an address when the request has none', async () => {
    const { service, activityLog } = build();
    await service.create(principalOf('PSA'), { kind: 'platform' }, { username: name(), password: PASSWORD, role: 'PSA' }, client);
    assert.equal('ip' in activityLog.entries[0]!, false);
  });
});
