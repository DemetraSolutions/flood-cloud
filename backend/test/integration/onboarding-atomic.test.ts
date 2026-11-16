import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { createCompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import { createDealersRepository } from '../../src/modules/dealers/dealers.repository.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createOnboardingRepository } from '../../src/modules/groups/onboarding.repository.ts';
import { createOnboardingService } from '../../src/modules/groups/onboarding.service.ts';
import type { OnboardingService } from '../../src/modules/groups/onboarding.service.ts';
import { createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createUsersService } from '../../src/modules/users/users.service.ts';
import { createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { groupCreationWriter } from '../../src/shared/legacy-write/companies-places.writer.ts';
import { accessFor } from '../helpers/group-access.ts';
import { issueGroupCreationAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { TEST_PEPPER } from '../helpers/backoffice.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { fixtureId, legacyCountry, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { onboardingBody } from '../helpers/onboarding.ts';
import { principalOf } from '../helpers/principal.ts';
import { groupReaders } from '../helpers/user-deps.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;

before(async () => {
  ctx = await openTestDatabases();
  await ctx.databases.common().collection('countries').insertOne(legacyCountry(1, { code: 'IT', name: 'Italia', areas: [{ code: 'MI', name: 'Milano' }] }));
  await ctx.databases.common().collection('users').insertOne(legacyUser(500, { role: 'D' }));
});
after(async () => {
  await ctx.cleanup();
});

const CLIENT = { requestId: 'req-12345678', ip: null, userAgent: null };
const injected = new Error('injected failure');

/** The steps of the creation, in order, where a failure can be injected after the step has written. */
type Step = 'group' | 'user' | 'company' | 'place' | 'departments';

/** The service over the real databases, with a failure injected right after a step has written, and the id of the group it tried to create. */
function serviceFailingAt(step: Step | null, extra: { readonly placeOutcome?: 'notFound' } = {}): { service: OnboardingService; access: () => GroupAccess; log: ReturnType<typeof memoryActivityLog> } {
  const databases = ctx.databases;
  const repository = createOnboardingRepository(databases);
  const activityLog = memoryActivityLog();
  const usersService = createUsersService({
    config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
    users: createUsersRepository(databases),
    credentials: createCredentialsRepository(databases),
    sessions: createSessionsRepository(databases),
    directory: createGroupDirectoryRepository(databases),
    ...groupReaders(databases),
    dealers: createDealersRepository(databases),
    activityLog,
    transaction: (work) => databases.transaction(work),
    now: () => Date.now(),
  });
  const after = async <T>(name: Step, work: Promise<T>): Promise<T> => {
    const done = await work;
    if (step === name) {
      throw injected;
    }
    return done;
  };
  let issued: GroupAccess | undefined;
  const service = createOnboardingService({
    repository: {
      insertGroup: (document, session) => after('group', repository.insertGroup(document, session)),
      insertDepartments: (principal, access, documents, session) => after('departments', repository.insertDepartments(principal, access, documents, session)),
    },
    users: { prepareGroupAdmin: async (principal, input) => {
      const prepared = await usersService.prepareGroupAdmin(principal, input);
      return { ...prepared, run: (session: ClientSession) => after('user', prepared.run(session)) };
    } },
    directory: createCompaniesRepository(databases, createCatalogsRepository(databases)),
    newAccess: (principal) => (issued = issueGroupCreationAccess(principal, databases)),
    writerFor: (principal, access) => {
      const writer = groupCreationWriter(principal, access, databases, { versionKey: TEST_VERSION_KEY });
      return {
        insertCompany: (fields) => {
          const run = writer.insertCompany(fields);
          return (session) => after('company', run(session));
        },
        insertPlace: (fields) => {
          const run = writer.insertPlace(fields);
          return async (session) => {
            const outcome = await after('place', run(session));
            return extra.placeOutcome === undefined ? outcome : { outcome: extra.placeOutcome };
          };
        },
      };
    },
    activityLog,
    transaction: (work) => databases.transaction(work),
    filesHost: '',
    now: () => Date.now(),
  });
  return { service, access: () => issued!, log: activityLog };
}

/** Everything a creation can leave behind for a group id and a user name: it must all be empty. */
async function leftovers(groupId: ObjectId, username: string): Promise<Record<string, number | string[]>> {
  const common = ctx.databases.common();
  const user = await common.collection('users').findOne({ userName: username }, { projection: { _id: 1 } });
  return {
    groups: await common.collection('groups').countDocuments({ _id: groupId }),
    users: await common.collection('users').countDocuments({ userName: username }),
    credentials: user === null ? 0 : await common.collection('userCredentials').countDocuments({ _id: user._id }),
    companies: await common.collection('companies').countDocuments({ groupId }),
    places: await common.collection('places').countDocuments({ groupId }),
    databases: (await ctx.databases.listGroupIds('cluster0')).filter((id) => id.equals(groupId)).map((id) => id.toHexString()),
  };
}

const NOTHING = { groups: 0, users: 0, credentials: 0, companies: 0, places: 0, databases: [] };

describe('the creation of a customer is atomic', () => {
  const psa = principalOf('PSA', { userId: fixtureId('user', 2) });

  for (const step of ['group', 'user', 'company', 'place', 'departments'] as const) {
    it(`leaves nothing, not even the database of the group, when it fails right after the ${step}`, async () => {
      const { service, access, log } = serviceFailingAt(step);
      const body = onboardingBody();
      await assert.rejects(service.create(psa, body as never, CLIENT), injected);
      assert.deepEqual(await leftovers(access().groupId, (body['user'] as { username: string }).username), NOTHING);
      assert.equal(log.entries.filter((entry) => entry.action.endsWith('.created')).length, 0, 'nothing is logged for a creation that did not happen');
    });
  }

  it('leaves nothing when the write service refuses a step it can never refuse in a new group (a bug is not a half customer)', async () => {
    const { service, access } = serviceFailingAt(null, { placeOutcome: 'notFound' });
    const body = onboardingBody();
    await assert.rejects(service.create(psa, body as never, CLIENT), /refused by the write service: notFound/);
    assert.deepEqual(await leftovers(access().groupId, (body['user'] as { username: string }).username), NOTHING);
  });

  it('creates everything, the database of the group included, when nothing fails', async () => {
    const { service, access, log } = serviceFailingAt(null);
    const body = onboardingBody();
    const created = await service.create(psa, body as never, CLIENT);
    assert.equal(created.groupId, access().groupId.toHexString());
    const groupId = access().groupId;
    const username = (body['user'] as { username: string }).username;
    assert.deepEqual(await leftovers(groupId, username), { groups: 1, users: 1, credentials: 1, companies: 1, places: 1, databases: [groupId.toHexString()] });
    assert.deepEqual(log.entries.filter((entry) => entry.action.endsWith('.created')).map((entry) => entry.action).sort(), ['company.created', 'group.created', 'place.created', 'user.created']);
  });

  it('a retry after a failure creates the customer: nothing of the failed attempt is in the way', async () => {
    const body = onboardingBody();
    const failing = serviceFailingAt('departments');
    await assert.rejects(failing.service.create(psa, body as never, CLIENT), injected);
    const retry = serviceFailingAt(null);
    const created = await retry.service.create(psa, body as never, CLIENT);
    assert.deepEqual(await leftovers(retry.access().groupId, (body['user'] as { username: string }).username), { groups: 1, users: 1, credentials: 1, companies: 1, places: 1, databases: [created.groupId] });
  });
});

describe('the administrator of the new group', () => {
  const psa = principalOf('PSA', { userId: fixtureId('user', 2) });
  const input = (username: string, access = issueGroupCreationAccess(psa, ctx.databases)) => ({ username, password: `Pw-${username}-Prov1`, firstName: null, lastName: null, email: null, phone: null, access, dealerId: null, priceListId: 'pl' });
  const usersServiceWith = (users: Partial<ReturnType<typeof createUsersRepository>>) => {
    const databases = ctx.databases;
    return createUsersService({
      config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: false },
      users: { ...createUsersRepository(databases), ...users },
      credentials: createCredentialsRepository(databases),
      sessions: createSessionsRepository(databases),
      directory: createGroupDirectoryRepository(databases),
      ...groupReaders(databases),
      dealers: createDealersRepository(databases),
      activityLog: memoryActivityLog(),
      transaction: (work) => databases.transaction(work),
      now: () => Date.now(),
    });
  };

  it('is prepared only on the creation access issued to the caller, and only for one who creates groups and holds what an SA holds', async () => {
    const service = usersServiceWith({});
    const access = issueGroupCreationAccess(psa, ctx.databases);
    // An access that is not a creation access (a verified access of an existing group), one of another user, a look-alike.
    const existing = (await accessFor(psa, fixtureId('group', 1)))!;
    for (const wrong of [existing, { ...access }, issueGroupCreationAccess(principalOf('D', { userId: fixtureId('user', 3) }), ctx.databases)]) {
      await assert.rejects(service.prepareGroupAdmin(psa, input('nobody.nobody', wrong)), /group creation access/);
    }
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      assert.throws(() => issueGroupCreationAccess(principalOf(role), ctx.databases), /permission to create groups/, role);
    }
    // The caller of the access without the permission, or with less than an SA has.
    await assert.rejects(service.prepareGroupAdmin({ ...psa, permissions: new Set() } as never, input('nobody.nobody', access)), { code: 'FORBIDDEN' });
    await assert.rejects(service.prepareGroupAdmin({ ...psa, permissions: new Set(['groups:create']) } as never, input('nobody.nobody', access)), { code: 'FORBIDDEN' });
    const step = await service.prepareGroupAdmin(psa, input('no.legacy.hash'));
    const session = ctx.client.startSession();
    try {
      await session.withTransaction(() => step.run(session));
    } finally {
      await session.endSession();
    }
    const stored = (await ctx.databases.common().collection('users').findOne({ _id: step.id }))!;
    assert.deepEqual([stored['userName'], 'password' in stored], ['no.legacy.hash', false]);
    assert.deepEqual(step.snapshot['password'], 'set');
  });

  it('is a 409 when another user takes the name between the check and the insert (the unique index decides), and any other failure goes on as it is', async () => {
    const duplicate = new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });
    const taken = await usersServiceWith({ insert: () => Promise.reject(duplicate) }).prepareGroupAdmin(psa, input('taken.at.insert'));
    await assert.rejects(ctx.databases.transaction((session) => taken.run(session)), { code: 'CONFLICT', details: [{ field: 'user.username', issue: 'taken' }] });
    const failing = await usersServiceWith({ insert: () => Promise.reject(injected) }).prepareGroupAdmin(psa, input('fails.at.insert'));
    await assert.rejects(ctx.databases.transaction((session) => failing.run(session)), injected);
  });
});

describe('the implicit creation of the collections inside the transaction of the platform', () => {
  it('creates a new database and its collections by insert, with the snapshot read concern and the majority write concern of databases.transaction, and leaves nothing when it aborts', async () => {
    const committedId = new ObjectId();
    const abortedId = new ObjectId();
    await ctx.databases.transaction(async (session) => {
      const db = ctx.databases.group(committedId, 'cluster0');
      await db.collection('companies').insertOne({ a: 1 }, { session });
      await db.collection('products_departments').insertMany([{ a: 1 }, { a: 2 }], { session });
      // A read of the new collection in the same transaction sees what the transaction wrote, and a read of one that does not exist yet is empty.
      assert.equal(await db.collection('companies').countDocuments({}, { session }), 1);
      assert.equal(await db.collection('places').countDocuments({}, { session }), 0);
      await ctx.databases.common().collection('groups').insertOne({ _id: committedId }, { session });
    });
    const committed = ctx.databases.group(committedId, 'cluster0');
    assert.deepEqual((await committed.listCollections().toArray()).map((collection) => collection.name).sort(), ['companies', 'products_departments']);
    assert.equal(await committed.collection('products_departments').countDocuments(), 2);
    await assert.rejects(
      ctx.databases.transaction(async (session) => {
        await ctx.databases.group(abortedId, 'cluster0').collection('companies').insertOne({ a: 1 }, { session });
        throw injected;
      }),
      injected,
    );
    assert.deepEqual((await ctx.databases.listGroupIds('cluster0')).map((id) => id.toHexString()).filter((id) => id === abortedId.toHexString()), []);
    assert.equal(await ctx.databases.group(abortedId, 'cluster0').collection('companies').countDocuments(), 0);
  });
});
