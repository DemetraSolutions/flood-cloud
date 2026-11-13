import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { toLegacyUpdate } from '../../src/modules/users/user.mapper.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import type { UsersRepository } from '../../src/modules/users/users.repository.ts';
import { fixtureId, legacyPasswordHash, legacyUser, seedLegacyCluster } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: UsersRepository;
const users = (): ReturnType<ReturnType<Databases['common']>['collection']> => ctx.databases.common().collection('users');
const id = (n: number): ObjectId => fixtureId('user', n);

before(async () => {
  ctx = await openTestDatabases();
  await seedLegacyCluster(ctx.databases, { anomalies: true, productionShape: true });
  repository = createUsersRepository(ctx.databases);
});
after(() => ctx.cleanup());

describe('findById', () => {
  it('reads a user in the domain model', async () => {
    const found = await repository.findById(id(5));
    assert.ok(found !== null);
    assert.equal(found.user.id, id(5).toHexString());
    assert.equal(found.user.username, 'user-005');
    assert.equal(found.user.role, 'PA');
    assert.equal(found.user.status, 'active');
    assert.equal(found.user.trashed, false);
    assert.deepEqual(found.user.permissions.modules['groups'], { r: false, w: false });
    assert.equal(found.user.permissions.status, true);
    assert.deepEqual(found.anomalies, []);
  });

  it('answers null for a user that does not exist', async () => {
    assert.equal(await repository.findById(new ObjectId()), null);
  });

  it('reads every user of an irregular production-shaped cluster without failing', async () => {
    const all = await users().find({}, { projection: { _id: 1 }, limit: 1000 }).toArray();
    assert.ok(all.length > 25);
    const kinds = new Set<string>();
    for (const { _id } of all) {
      const found = await repository.findById(_id);
      assert.ok(found !== null);
      for (const anomaly of found.anomalies) {
        kinds.add(anomaly.kind);
      }
      assert.ok(['active', 'disabled'].includes(found.user.status));
    }
    // role "weird", encrypted data, string references, missing scope, non-boolean flags: all seen and reported.
    for (const kind of ['invalidRole', 'encryptedPersonalData', 'invalidReference', 'missingScope']) {
      assert.ok(kinds.has(kind), kind);
    }
  });

  it('reads the anomalies of the irregular documents', async () => {
    const encrypted = (await repository.findById(id(11)))!;
    assert.deepEqual(encrypted.anomalies.map((a) => a.kind).sort(), ['encryptedPersonalData', 'encryptedPersonalData', 'encryptedPersonalData']);
    assert.equal(encrypted.user.email, null);
    const weird = (await repository.findById(id(14)))!;
    assert.equal(weird.user.role, 'invalid');
    const noRole = (await repository.findById(id(16)))!;
    assert.equal(noRole.user.role, 'E');
    const duplicates = (await repository.findById(id(15)))!;
    assert.equal(duplicates.user.trashed, true);
  });

  it('never loads secrets or legacy-only fields from the database', async () => {
    let captured: Document | undefined;
    const spy = {
      common: () => ({
        collection: () => ({
          findOne: (_filter: Document, options: { projection: Document }) => {
            captured = options.projection;
            return Promise.resolve(null);
          },
        }),
      }),
    } as unknown as Databases;
    await createUsersRepository(spy).findById(id(1));
    assert.ok(captured !== undefined);
    // The detail loads the picture; the PIN, the password and the tokens are never loaded, and the PIN is only tested for presence.
    for (const field of ['password', 'pin', 'tokens', 'permissions', 'settings']) {
      assert.equal(field in captured, false, field);
    }
    assert.equal(captured['avatar'], 1);
    assert.equal(JSON.stringify(captured['__pinSet']).includes('$pin'), true);
    assert.equal(captured['permissions.apps'], 1);
    assert.equal(captured['permissions.users.r'], 1);
    assert.equal(captured['permissions.status'], 1);
    assert.equal(captured['userName'], 1);
  });
});

describe('findByUsernameForLogin', () => {
  it('finds the exact username first, even when other spellings exist, and reads the legacy hash', async () => {
    const found = (await repository.findByUsernameForLogin('user-003'))!;
    assert.equal(found.user.id, id(3).toHexString());
    assert.equal(found.legacyPasswordHash, legacyPasswordHash(3));
    assert.equal((await repository.findByUsernameForLogin('USER-003'))!.user.id, id(15).toHexString());
    assert.equal((await repository.findByUsernameForLogin('User-003'))!.user.id, id(11).toHexString());
  });

  it('finds a unique user ignoring case, spaces and Unicode variants (NFKC)', async () => {
    for (const typed of ['USER-004', 'User-004', '  user-004 ', 'ＵＳＥＲ－００４']) {
      assert.equal((await repository.findByUsernameForLogin(typed))?.user.id, id(4).toHexString(), typed);
    }
  });

  it('finds nobody when the name is ambiguous, because several users differ only by case', async () => {
    assert.equal(await repository.findByUsernameForLogin('uSeR-003'), null);
    assert.equal(await repository.findByUsernameForLogin('Dup-Name'), null);
    assert.equal(await repository.findByUsernameForLogin('DUP-NAME'), null);
    // The exact spelling of one of the pair is unambiguous.
    assert.ok(await repository.findByUsernameForLogin('dup-NAME'));
  });

  it('finds nobody for an unknown or empty name, and never treats the name as a pattern', async () => {
    for (const typed of ['nobody', '', '   ', '.*', 'user-0.*', '^user-004$', '(user-004)', 'user-004|user-005', '[u]ser-004', 'user-00\\d', '\\', '$', '{"$ne":""}']) {
      assert.equal(await repository.findByUsernameForLogin(typed), null, typed);
    }
  });

  it('gives a null hash when the stored password is not a string', async () => {
    const stored = await users().findOne({ _id: id(13) }, { projection: { userName: 1 } });
    const found = (await repository.findByUsernameForLogin(String(stored!['userName'])))!;
    assert.equal(found.user.id, id(13).toHexString());
    assert.equal(found.legacyPasswordHash, null);
  });

  it('does not read the other secrets of the user for the login', async () => {
    const found = (await repository.findByUsernameForLogin('user-005'))!;
    // Quoted: a random hex id can contain the digits, never a whole string value equal to the PIN.
    assert.equal(JSON.stringify(found).includes('"1234"'), false);
    assert.equal(JSON.stringify(found).includes('token-005'), false);
  });
});

describe('isUsernameTaken (D-15)', () => {
  before(async () => {
    // A user created by the old signup flow: only `username`, spelled differently.
    await users().insertOne(legacyUser(900, { userName: 'signup-owner', username: 'Signup-Name' }));
  });

  it('compares the normalized names of every user', async () => {
    for (const typed of ['user-004', 'USER-004', ' User-004 ', 'ＵＳＥＲ－００４']) {
      assert.equal(await repository.isUsernameTaken(typed), true, typed);
    }
    assert.equal(await repository.isUsernameTaken('somebody-else'), false);
    assert.equal(await repository.isUsernameTaken('user-00'), false);
    assert.equal(await repository.isUsernameTaken('.*'), false);
  });

  it('also considers the older username field', async () => {
    assert.equal(await repository.isUsernameTaken('signup-name'), true);
    assert.equal(await repository.isUsernameTaken('SIGNUP-OWNER'), true);
  });

  it('lets a user keep its own name', async () => {
    assert.equal(await repository.isUsernameTaken('user-004', id(4)), false);
    assert.equal(await repository.isUsernameTaken('USER-004', id(4)), false);
    assert.equal(await repository.isUsernameTaken('signup-name', id(900)), false);
    assert.equal(await repository.isUsernameTaken('user-004', id(5)), true);
    // Existing duplicates stay as they are: another spelling of the same name is taken by the others.
    assert.equal(await repository.isUsernameTaken('dup-name', id(2008)), true);
  });
});

describe('updateOwned and clearLegacyTokens', () => {
  it('applies a mapper update and leaves the legacy-only data of the document untouched', async () => {
    const before = (await users().findOne({ _id: id(6) }))!;
    const update = toLegacyUpdate({ firstName: 'Changed', phone: null, status: 'disabled', trashed: true, permissions: { status: false, modules: { users: { r: false, w: false } } } }, new Date('2026-11-02T10:00:00.000Z'));
    assert.equal(await repository.updateOwned(id(6), update), true);
    const after = (await users().findOne({ _id: id(6) }))!;
    assert.equal(after['name'], 'Changed');
    assert.equal('telephone' in after, false);
    assert.equal(after['status'], false);
    assert.equal(after['trash'], true);
    assert.deepEqual(after['updateDate'], new Date('2026-11-02T10:00:00.000Z'));
    assert.deepEqual((after['permissions'] as Document)['users'], { r: false, w: false });
    assert.equal((after['permissions'] as Document)['status'], false);
    for (const field of ['password', 'pin', 'tokens', 'servicesId', 'shiftTime', 'description', 'userName', 'email', 'insertDate', 'role']) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.deepEqual((after['permissions'] as Document)['apps'], (before['permissions'] as Document)['apps']);
    assert.deepEqual((after['permissions'] as Document)['stats'], (before['permissions'] as Document)['stats']);
    const mapped = (await repository.findById(id(6)))!;
    assert.equal(mapped.user.firstName, 'Changed');
    assert.equal(mapped.user.status, 'disabled');
  });

  it('refuses an update that touches fields the backend does not own, writing nothing', async () => {
    const before = await users().findOne({ _id: id(7) });
    for (const update of [
      { $set: { name: 'ok', 'permissions.apps.cash.sub.productsStatus': false } },
      { $set: { name: 'ok' }, $unset: { 'permissions.apps.cash.options.service': '' as const } },
      { $set: { permissions: {} } },
      { $set: { shiftTime: {} } },
      { $set: { 'permissions.apps': {} } },
      { $set: { 'permissions.logs.w': true } },
    ]) {
      await assert.rejects(repository.updateOwned(id(7), update), /does not own/);
    }
    assert.deepEqual(await users().findOne({ _id: id(7) }), before);
  });

  it('refuses an update with an operator other than $set and $unset, writing nothing', async () => {
    const before = await users().findOne({ _id: id(7) });
    for (const update of [
      { $set: { name: 'ok' }, $rename: { name: 'surname' } },
      { $set: { name: 'ok' }, $inc: { status: 1 } },
      { $set: { name: 'ok' }, $currentDate: { updateDate: true } },
    ]) {
      await assert.rejects(repository.updateOwned(id(7), update as never), /other than \$set and \$unset/);
    }
    assert.deepEqual(await users().findOne({ _id: id(7) }), before);
  });

  it('answers false for a user that does not exist, without creating it', async () => {
    const missing = new ObjectId();
    assert.equal(await repository.updateOwned(missing, toLegacyUpdate({ firstName: 'x' })), false);
    assert.equal(await repository.clearLegacyTokens(missing), false);
    assert.equal(await users().countDocuments({ _id: missing }), 0);
  });

  it('empties the legacy tokens and nothing else (D-11)', async () => {
    const before = (await users().findOne({ _id: id(8) }))!;
    assert.ok((before['tokens'] as unknown[]).length > 0);
    assert.equal(await repository.clearLegacyTokens(id(8)), true);
    const after = (await users().findOne({ _id: id(8) }))!;
    assert.deepEqual(after['tokens'], []);
    assert.deepEqual({ ...after, tokens: before['tokens'] }, before);
    assert.equal(await repository.clearLegacyTokens(id(8)), true);
  });
});

describe('findAuthRecord', () => {
  it('reads what authenticating a request needs and the stored permission matrix untouched', async () => {
    const found = await repository.findAuthRecord(id(5));
    assert.ok(found !== null);
    assert.deepEqual([found.user.id, found.user.role, found.user.status, found.user.trashed], [id(5).toHexString(), 'PA', 'active', false]);
    assert.deepEqual(
      [found.stored.userId, found.stored.role, found.stored.groupId, found.stored.companyIds, found.stored.placeIds],
      [id(5), 'PA', fixtureId('group', 1), [fixtureId('company', 1)], [fixtureId('place', 1)]],
    );
    // The whole matrix is kept, including modules this backend does not map and the cash domain.
    const matrix = found.stored.legacyPermissions as Document;
    assert.deepEqual([matrix['stats'], matrix['status']], [{ r: true, w: false }, true]);
    assert.ok('apps' in matrix);
  });

  it('does not load personal data, the password, the PIN or the sessions', async () => {
    const found = await repository.findAuthRecord(id(5));
    assert.deepEqual([found?.user.firstName, found?.user.lastName, found?.user.email, found?.user.phone], [null, null, null, null]);
    assert.ok(!JSON.stringify(found).includes(legacyPasswordHash(5)));
    assert.ok(!JSON.stringify(found).includes('token-005'));
  });

  it('answers null for a user that does not exist', async () => {
    assert.equal(await repository.findAuthRecord(new ObjectId()), null);
  });

  it('keeps a reference stored as text out of the scope and marks an unknown role', async () => {
    await users().insertOne(legacyUser(9000, { role: 'API', groupId: fixtureId('group', 1).toHexString() }));
    const found = await repository.findAuthRecord(id(9000));
    assert.equal(found?.stored.groupId, null);
    assert.deepEqual([found?.user.role, found?.user.groupId], ['invalid', null]);
  });
});

describe('findLoginRecordById', () => {
  it('reads the user with the legacy hash for the verification', async () => {
    const found = await repository.findLoginRecordById(id(5));
    assert.equal(found?.user.username, 'user-005');
    assert.equal(found?.legacyPasswordHash, legacyPasswordHash(5));
  });

  it('gives a null hash when the stored password is not a string, and null for a missing user', async () => {
    await users().insertOne(legacyUser(9001, { password: 7 }));
    assert.equal((await repository.findLoginRecordById(id(9001)))?.legacyPasswordHash, null);
    assert.equal(await repository.findLoginRecordById(new ObjectId()), null);
  });
});

describe('the writes of user management, with and without a transaction', () => {
  const credentials = () => ctx.databases.common().collection('userCredentials');

  it('inserts a document of owned fields, and refuses one with a field the backend does not own', async () => {
    const document = { _id: new ObjectId(), userName: 'inserted.once', role: 'SA', status: true, trash: false, tokens: [], insertDate: new Date(), updateDate: new Date(), settings: { language: 'it', hiddenInStats: false } };
    const mapped = await repository.insert(document);
    assert.deepEqual([mapped.user.username, mapped.user.role, mapped.anomalies.filter((anomaly) => anomaly.kind !== 'invalidPermission').map((anomaly) => anomaly.kind)], ['inserted.once', 'SA', []]);
    assert.equal(await users().countDocuments({ _id: document._id }), 1);
    await assert.rejects(repository.insert({ _id: new ObjectId(), userName: 'x', tokenss: [] }), /does not own: tokenss/);
    await assert.rejects(repository.insert({ _id: new ObjectId(), userName: 'x', permissions: { apps: { cash: { sub: { productsStatus: true } } } } }), /does not own: permissions.apps.cash.sub.productsStatus/);
    await assert.rejects(repository.insert({ _id: new ObjectId(), userName: 'x', settings: { integrations: {} } }), /does not own: settings.integrations/);
    assert.equal(await users().countDocuments({ userName: 'x' }), 0);
    await assert.rejects(repository.insert({ ...document }), { code: 11000 });
  });

  it('rolls back every write of a transaction that fails and commits the ones that succeed', async () => {
    const first = { _id: new ObjectId(), userName: 'in.transaction', role: 'SA', status: true };
    await assert.rejects(
      ctx.databases.transaction(async (session) => {
        await repository.insert(first, session);
        await credentials().insertOne({ _id: first._id, failedLogins: 0, createdAt: new Date(), updatedAt: new Date() }, { session });
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.deepEqual([await users().countDocuments({ _id: first._id }), await credentials().countDocuments({ _id: first._id })], [0, 0]);
    const result = await ctx.databases.transaction(async (session) => {
      await repository.insert(first, session);
      assert.equal(await repository.updateOwned(first._id, toLegacyUpdate({ status: 'disabled' }), session), true);
      assert.equal(await repository.clearLegacyTokens(first._id, session), true);
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal((await users().findOne({ _id: first._id }))!['status'], false);
  });

  it('deletes a user only from the trash, with or without a session, and says whether it did', async () => {
    const one = { _id: new ObjectId(), userName: 'to.delete.1', role: 'SA', status: true, trash: true };
    const two = { _id: new ObjectId(), userName: 'to.delete.2', role: 'SA', status: true, trash: true };
    const live = { _id: new ObjectId(), userName: 'to.delete.3', role: 'SA', status: true, trash: false };
    await repository.insert(live);
    assert.equal(await repository.deleteTrashed(live._id), false);
    assert.equal(await users().countDocuments({ _id: live._id }), 1);
    await repository.insert(one);
    await repository.insert(two);
    assert.equal(await repository.deleteTrashed(one._id), true);
    assert.equal(await repository.deleteTrashed(one._id), false);
    assert.equal(await ctx.databases.transaction((session) => repository.deleteTrashed(two._id, session)), true);
    assert.equal(await users().countDocuments({ _id: { $in: [one._id, two._id] } }), 0);
  });

  it('finds one user to manage with the whole stored matrix, and nothing outside the filter', async () => {
    const found = await repository.findManaged({ _id: id(5) });
    assert.ok(found !== null);
    assert.deepEqual([found.user.username, found.stored.role, found.stored.userId.toHexString()], ['user-005', 'PA', id(5).toHexString()]);
    assert.ok((found.stored.legacyPermissions as Document)['apps'] !== undefined, 'the non-core modules and the cash permissions are read, to be kept');
    const text = JSON.stringify(found);
    assert.ok(!text.includes('1234') && !text.includes('token-005'));
    assert.equal(await repository.findManaged({ _id: id(5), role: 'SA' }), null);
  });

  it('lists a page in the order asked, with the scope filter combined and the cursor applied', async () => {
    const params = { limit: 3, sort: 'username', q: null, cursor: null };
    const page = await repository.list({ role: { $in: ['SA'] } }, {}, params);
    assert.equal(page.users.length, 3);
    assert.notEqual(page.page.next, null);
    assert.ok(page.users.every((mapped) => mapped.user.role === 'SA'));
    assert.deepEqual(page.users.map((mapped) => mapped.user.username), [...page.users.map((mapped) => mapped.user.username)].sort());
  });
});
