import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createDealersRepository } from '../../src/modules/dealers/dealers.repository.ts';
import type { DealersRepository } from '../../src/modules/dealers/dealers.repository.ts';
import { createDealersService } from '../../src/modules/dealers/dealers.service.ts';
import { createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { createGroupDirectoryRepository } from '../../src/modules/users/group-directory.repository.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createUsersService } from '../../src/modules/users/users.service.ts';
import { createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { ROLE_CEILING } from '../../src/shared/security/rbac/policy.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { legacyUser } from '../helpers/legacy-fixtures.ts';
import { TEST_PEPPER, addUser, startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { actors, send } from '../helpers/users.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;

const PASSWORD = `Prov-${randomBytes(8).toString('hex')}-pass`;
const users = () => ctx.databases.common().collection('users');
const dealers = () => ctx.databases.common().collection('dealers');
const credentials = () => ctx.databases.common().collection('userCredentials');
const psa = () => office.cluster.psa;
const hex = (id: ObjectId) => id.toHexString();
let sequence = 0;
const name = (): string => `dealer-user-${String(sequence++)}`;
const vat = (): string => String(10_000_000_000 + sequence++);
const invalid = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const conflict = (field: string) => ({ status: 409, code: 'CONFLICT', details: [{ field, issue: 'taken' }] });
const denied = { status: 403, code: 'FORBIDDEN', details: undefined };
const failure = (reply: Awaited<ReturnType<typeof as.call>>) => as.failure(reply);

const ADDRESS = { street: 'Via Roma 1', postcode: '00100', city: 'Roma', province: 'RM' };
const company = (overrides: Document = {}): Document => ({ businessName: 'Acme Distribuzione', vatNumber: vat(), ...overrides });
const body = (overrides: Document = {}, user: Document = {}): Document => ({ company: company(overrides), user: { username: name(), password: PASSWORD, ...user } });

let nextUser = 700;

/** Inserts a dealer document (and, unless told otherwise, a `D` user with the same id) straight into the database. */
async function seedDealer(overrides: Document = {}, user: Document | false = false): Promise<ObjectId> {
  const id = new ObjectId();
  const now = new Date();
  await dealers().insertOne({
    _id: id,
    businessName: 'Seed Srl',
    vatNumber: null,
    fiscalCode: null,
    address: null,
    pec: null,
    sdiCode: null,
    email: null,
    phone: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    source: 'migration',
    ...overrides,
  });
  if (user !== false) {
    await users().insertOne(legacyUser(nextUser++, { _id: id, role: 'D', ...user }));
  }
  return id;
}

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx);
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});

describe('who reaches the dealer registry', () => {
  it('lets only the PSA in: a dealer, an SA, a CA and a PA get 403 on every route', async () => {
    const id = await seedDealer();
    const g = office.cluster.groups[0]!;
    for (const actor of [office.cluster.dealerA, g.sa, g.ca, g.pa]) {
      assert.deepEqual(failure(await as.call(actor, 'GET', '/dealers')), denied);
      assert.deepEqual(failure(await as.call(actor, 'GET', `/dealers/${hex(id)}`)), denied);
      assert.deepEqual(failure(await as.call(actor, 'POST', '/dealers', body())), denied);
      assert.deepEqual(failure(await as.call(actor, 'PATCH', `/dealers/${hex(id)}`, { businessName: 'X' })), denied);
    }
    assert.equal((await as.call(psa(), 'GET', '/dealers')).status, 200);
  });

  it('refuses a PSA whose matrix lacks groups.w, and a PSA without users:create', async () => {
    const reader = await addUser(ctx, office, { role: 'PSA', groupId: null, dealerId: null, permissions: { status: false, groups: { r: true, w: false }, users: { r: true, w: true } } });
    const writer = await addUser(ctx, office, { role: 'PSA', groupId: null, dealerId: null, permissions: { status: false, groups: { r: true, w: true }, users: { r: true, w: false } } });
    const asReader = (await office.tokens(reader.name)).accessToken;
    const asWriter = (await office.tokens(writer.name)).accessToken;
    assert.equal((await send(office, 'GET', '/dealers', asReader)).status, 200);
    assert.equal((await send(office, 'POST', '/dealers', asReader, body())).status, 403);
    assert.equal((await send(office, 'PATCH', `/dealers/${hex(new ObjectId())}`, asReader, { businessName: 'X' })).status, 403);
    // dealers:create is there, users:create is not: the service refuses before anything is written.
    const before = await users().countDocuments();
    assert.deepEqual(failure(await send(office, 'POST', '/dealers', asWriter, body())), denied);
    assert.equal(await users().countDocuments(), before);
  });
});

describe('POST /v1/dealers', () => {
  it('creates the dealer and his D user with the same _id, in the legacy format, and records both events', async () => {
    const username = name();
    const vatNumber = vat();
    const mark = office.activity.entries.length;
    const reply = await as.call(psa(), 'POST', '/dealers', {
      company: { businessName: 'Rossi & Figli', vatNumber, fiscalCode: 'rssmra80a01h501u', address: { ...ADDRESS, province: 'rm' }, pec: 'PEC@Rossi.test', sdiCode: 'abcdefg', email: 'Info@Rossi.test', phone: '+39 06 111' },
      user: { username, password: PASSWORD, firstName: 'Mario', email: 'mario@rossi.test' },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const data = reply.body.data;
    assert.equal(reply.headers.get('location'), `/v1/dealers/${String(data.id)}`);
    assert.deepEqual(data.user, { id: data.id, username, status: 'active' });
    assert.deepEqual(
      { ...data, id: undefined, createdAt: undefined, updatedAt: undefined, user: undefined },
      {
        businessName: 'Rossi & Figli',
        vatNumber,
        fiscalCode: 'RSSMRA80A01H501U',
        address: { street: 'Via Roma 1', postcode: '00100', city: 'Roma', province: 'RM', countryCode: 'IT' },
        pec: 'pec@rossi.test',
        sdiCode: 'ABCDEFG',
        email: 'info@rossi.test',
        phone: '+39 06 111',
        source: 'manual',
        id: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        user: undefined,
      },
    );
    assert.ok(!('createdBy' in data));

    const id = ObjectId.createFromHexString(data.id);
    const user = (await users().findOne({ _id: id }))!;
    assert.equal(user['role'], 'D');
    assert.equal(user['userName'], username);
    assert.equal(user['groupId'], null);
    assert.equal((await credentials().findOne({ _id: id }))!['mustChangePassword'], true);
    const stored = (await dealers().findOne({ _id: id }))!;
    assert.equal(stored['source'], 'manual');
    assert.ok((stored['createdBy'] as ObjectId).equals(psa()));
    assert.ok(stored['createdAt'] instanceof Date && stored['updatedAt'] instanceof Date);

    const events = office.activity.entries.slice(mark);
    assert.deepEqual(events.map((entry) => [entry.action, entry.category, entry.resource?.type, entry.resource?.id]), [
      ['user.created', 'data', 'user', data.id],
      ['dealer.created', 'data', 'dealer', data.id],
    ]);
    assert.ok(events[1]!.changes!.some((change) => change.field === 'businessName' && change.after === 'Rossi & Figli'));
    assert.ok(!JSON.stringify(events).includes(PASSWORD));

    // The new dealer can sign in and sees his company in the profile.
    const login = await office.login(username, PASSWORD);
    assert.equal(login.status, 200);
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const me = (await (await office.call('GET', '/me', token)).json()) as { data: { dealer: unknown } };
    assert.deepEqual(me.data.dealer, { id: data.id, businessName: 'Rossi & Figli' });
  });

  it('accepts just a company name, and a foreign company with its own rules', async () => {
    const bare = await as.call(psa(), 'POST', '/dealers', { company: { businessName: 'Solo Nome' }, user: { username: name(), password: PASSWORD } });
    assert.equal(bare.status, 201, JSON.stringify(bare.body));
    assert.deepEqual([bare.body.data.vatNumber, bare.body.data.fiscalCode, bare.body.data.address, bare.body.data.pec, bare.body.data.sdiCode], [null, null, null, null, null]);
    const german = await as.call(
      psa(),
      'POST',
      '/dealers',
      body({ vatNumber: 'de123456789', fiscalCode: 'x1', address: { street: 'Hauptstrasse 5', postcode: '10115', city: 'Berlin', countryCode: 'de' } }),
    );
    assert.equal(german.status, 201, JSON.stringify(german.body));
    assert.deepEqual([german.body.data.vatNumber, german.body.data.fiscalCode, german.body.data.address], ['DE123456789', 'X1', { street: 'Hauptstrasse 5', postcode: '10115', city: 'Berlin', province: null, countryCode: 'DE' }]);
  });

  it('applies the Italian rules to VAT number, fiscal code, province and recipient code', async () => {
    const post = async (company: Document) => failure(await as.call(psa(), 'POST', '/dealers', { company: { businessName: 'X', ...company }, user: { username: name(), password: PASSWORD } }));
    assert.deepEqual(await post({ vatNumber: '1234567890' }), invalid(['company.vatNumber', 'pattern']));
    assert.deepEqual(await post({ vatNumber: '1234567890A' }), invalid(['company.vatNumber', 'pattern']));
    assert.deepEqual(await post({ fiscalCode: 'ABC' }), invalid(['company.fiscalCode', 'pattern']));
    assert.deepEqual(await post({ sdiCode: 'ABC12' }), invalid(['company.sdiCode', 'pattern']));
    assert.deepEqual(await post({ address: { ...ADDRESS, province: 'ROMA' } }), invalid(['company.address.province', 'pattern']));
    assert.deepEqual(await post({ address: { ...ADDRESS, province: '1A' } }), invalid(['company.address.province', 'pattern']));
    assert.deepEqual(await post({ address: { street: 'Via Roma 1', postcode: '00100', city: 'Roma' } }), invalid(['company.address.province', 'required']));
    assert.deepEqual(await post({ address: { street: 'Via Roma 1' } }), invalid(['company.address.postcode', 'required'], ['company.address.city', 'required']));
    assert.deepEqual(await post({ address: { ...ADDRESS, countryCode: 'ITA' } }), invalid(['company.address.countryCode', 'maxLength']));
    assert.deepEqual(await post({ vatNumber: 'D' }), invalid(['company.vatNumber', 'pattern']));
    assert.deepEqual(await post({ address: { ...ADDRESS, countryCode: 'DE', province: null }, vatNumber: 'D' }), invalid(['company.vatNumber', 'pattern']));
  });

  it('validates the shape of the body and of the user', async () => {
    const post = async (payload: unknown) => failure(await as.call(psa(), 'POST', '/dealers', payload));
    assert.deepEqual(await post({ user: { username: name(), password: PASSWORD } }), invalid(['company', 'required']));
    assert.deepEqual(await post({ company: {}, user: { username: name(), password: PASSWORD } }), invalid(['company.businessName', 'required']));
    assert.deepEqual(await post({ company: { businessName: 'X' } }), invalid(['user', 'required']));
    assert.deepEqual(await post({ company: { businessName: 'X', extra: 1 }, user: { username: name(), password: PASSWORD } }), invalid(['company.extra', 'unknown']));
    assert.deepEqual(await post({ company: { businessName: 'X' }, user: { username: name(), password: PASSWORD, role: 'PSA' } }), invalid(['user.role', 'unknown']));
    assert.deepEqual(await post({ company: { businessName: 'X', pec: 'not-mail' }, user: { username: 'a b', password: PASSWORD } }), invalid(['company.pec', 'format'], ['user.username', 'pattern']));
    assert.deepEqual((await post({ company: { businessName: 'X' }, user: { username: name(), password: 'short' } })).code, 'VALIDATION_ERROR');
  });

  it('answers 409 for a taken user name or VAT number and leaves nothing behind', async () => {
    const taken = vat();
    assert.equal((await as.call(psa(), 'POST', '/dealers', body({ vatNumber: taken }))).status, 201);
    const countUsers = await users().countDocuments();
    const countDealers = await dealers().countDocuments();
    assert.deepEqual(failure(await as.call(psa(), 'POST', '/dealers', body({ vatNumber: taken }))), conflict('company.vatNumber'));
    assert.deepEqual(failure(await as.call(psa(), 'POST', '/dealers', body({}, { username: 'USER-001' }))), conflict('username'));
    assert.deepEqual([await users().countDocuments(), await dealers().countDocuments()], [countUsers, countDealers]);
  });
});

describe('creating a dealer is all or nothing', () => {
  const client = { requestId: 'req-12345678', ip: null, userAgent: null };
  const build = (override: Partial<DealersRepository> = {}) => {
    const real = createDealersRepository(ctx.databases);
    const repository: DealersRepository = { ...real, ...override };
    const activityLog = memoryActivityLog();
    const usersRepository = createUsersRepository(ctx.databases);
    const usersService = createUsersService({
      config: { legacyPasswordPepper: new Secret(TEST_PEPPER), legacyPasswordCoexistence: true },
      users: usersRepository,
      credentials: createCredentialsRepository(ctx.databases),
      sessions: createSessionsRepository(ctx.databases),
      directory: createGroupDirectoryRepository(ctx.databases),
      dealers: repository,
      activityLog,
      transaction: (work) => ctx.databases.transaction(work),
      now: () => Date.now(),
    });
    return { activityLog, service: createDealersService({ dealers: repository, users: usersRepository, usersService, activityLog, now: () => Date.now() }) };
  };
  const input = (username: string, vatNumber?: string) => ({ company: { businessName: 'Atomic Srl', ...(vatNumber === undefined ? {} : { vatNumber }) }, user: { username, password: PASSWORD } });

  it('leaves neither the user, nor his credentials, nor the dealer when the second write fails', async () => {
    const { service, activityLog } = build({ insert: () => Promise.reject(new Error('disk full')) });
    const username = name();
    await assert.rejects(service.create(principalOf('PSA'), input(username), client), /disk full/);
    assert.equal(await users().countDocuments({ userName: username }), 0);
    assert.equal(await dealers().countDocuments({ businessName: 'Atomic Srl' }), 0);
    assert.equal(await credentials().countDocuments({ passwordHash: { $exists: false } }), 0);
    assert.deepEqual(activityLog.entries, []);
  });

  it('answers 409 on the VAT number when the unique index catches a duplicate created at the same moment', async () => {
    const taken = vat();
    await seedDealer({ vatNumber: taken });
    const { service } = build({ isVatTaken: () => Promise.resolve(false) });
    const username = name();
    await assert.rejects(service.create(principalOf('PSA'), input(username, taken), client), { code: 'CONFLICT', details: [{ field: 'company.vatNumber', issue: 'taken' }] });
    assert.equal(await users().countDocuments({ userName: username }), 0);
  });

  it('answers 409 on the VAT number of an update caught by the unique index, and 404 when the dealer vanished', async () => {
    const taken = vat();
    await seedDealer({ vatNumber: taken });
    const id = await seedDealer();
    const { service } = build({ isVatTaken: () => Promise.resolve(false) });
    await assert.rejects(service.update(principalOf('PSA'), id, { vatNumber: taken }, client), { code: 'CONFLICT', details: [{ field: 'vatNumber', issue: 'taken' }] });
    const gone = build({ update: () => Promise.resolve(false) });
    await assert.rejects(gone.service.update(principalOf('PSA'), id, { businessName: 'Gone' }, client), { code: 'NOT_FOUND' });
    const broken = build({ update: () => Promise.reject(new Error('socket closed')) });
    await assert.rejects(broken.service.update(principalOf('PSA'), id, { businessName: 'Broken' }, client), /socket closed/);
  });

  it('refuses anybody who is not a PSA holding dealers:create and users:create, before looking at the VAT number', async () => {
    const { service } = build({ isVatTaken: () => Promise.reject(new Error('must not be reached')) });
    const withVat = input(name(), vat());
    const everything = ROLE_CEILING.PSA;
    const without = (removed: string) => new Set([...everything].filter((permission) => permission !== removed));
    for (const principal of [
      principalOf('D', { permissions: everything }),
      principalOf('SA', { permissions: everything }),
      principalOf('PSA', { permissions: without('dealers:create') }),
      principalOf('PSA', { permissions: without('users:create') }),
    ]) {
      await assert.rejects(service.create(principal, withVat, client), { code: 'FORBIDDEN' });
    }
  });

  it('records a creation and an update without a client address', async () => {
    const { service, activityLog } = build();
    const created = await service.create(principalOf('PSA'), input(name()), client);
    await service.update(principalOf('PSA'), ObjectId.createFromHexString(created.id), { email: 'a@b.test' }, client);
    assert.deepEqual(activityLog.entries.map((entry) => [entry.action, 'ip' in entry]), [['user.created', false], ['dealer.created', false], ['dealer.updated', false]]);
  });
});

describe('PATCH /v1/dealers/{dealerId}', () => {
  const create = async (overrides: Document = {}): Promise<{ id: string; data: Document }> => {
    const reply = await as.call(psa(), 'POST', '/dealers', body(overrides));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return { id: reply.body.data.id as string, data: reply.body.data };
  };

  it('changes the company data as a merge patch, bumps updatedAt and records the before and after', async () => {
    const { id, data } = await create({ address: ADDRESS, email: 'old@x.test', phone: '123' });
    const mark = office.activity.entries.length;
    office.clock.advance(1000);
    const reply = await as.call(psa(), 'PATCH', `/dealers/${id}`, { businessName: 'Nuova Ragione', email: null, address: { city: 'Milano', province: 'mi' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.businessName, 'Nuova Ragione');
    assert.equal(reply.body.data.email, null);
    assert.equal(reply.body.data.phone, '123');
    assert.deepEqual(reply.body.data.address, { street: 'Via Roma 1', postcode: '00100', city: 'Milano', province: 'MI', countryCode: 'IT' });
    assert.equal(reply.body.data.vatNumber, data['vatNumber']);
    assert.notEqual(reply.body.data.updatedAt, data['updatedAt']);
    assert.equal(reply.body.data.createdAt, data['createdAt']);
    assert.deepEqual(reply.body.data.user, (data as Document)['user']);
    const events = office.activity.entries.slice(mark);
    assert.deepEqual(events.map((entry) => [entry.action, entry.resource?.id]), [['dealer.updated', id]]);
    const changes = events[0]!.changes!;
    assert.deepEqual(changes.find((change) => change.field === 'businessName'), { field: 'businessName', before: 'Acme Distribuzione', after: 'Nuova Ragione' });
    assert.deepEqual(changes.find((change) => change.field === 'email'), { field: 'email', before: 'old@x.test', after: null });
    assert.deepEqual(changes.find((change) => change.field === 'address.city'), { field: 'address.city', before: 'Roma', after: 'Milano' });
    assert.equal(changes.some((change) => change.field === 'phone'), false);
  });

  it('clears the address and the VAT number with null, and fills an address from nothing', async () => {
    const { id } = await create({ address: ADDRESS });
    const cleared = await as.call(psa(), 'PATCH', `/dealers/${id}`, { address: null, vatNumber: null });
    assert.deepEqual([cleared.body.data.address, cleared.body.data.vatNumber], [null, null]);
    const incomplete = await as.call(psa(), 'PATCH', `/dealers/${id}`, { address: { street: 'Via Nuova 2' } });
    assert.deepEqual(failure(incomplete), invalid(['address.postcode', 'required'], ['address.city', 'required']));
    const filled = await as.call(psa(), 'PATCH', `/dealers/${id}`, { address: { ...ADDRESS, countryCode: 'fr', province: null }, vatNumber: 'FR12345678901' });
    assert.equal(filled.status, 200, JSON.stringify(filled.body));
    assert.deepEqual(filled.body.data.address, { street: 'Via Roma 1', postcode: '00100', city: 'Roma', province: null, countryCode: 'FR' });
    // The country decides the rules of the numbers already stored: an Italian VAT number is not a French one, but both pass the foreign pattern.
    const back = await as.call(psa(), 'PATCH', `/dealers/${id}`, { address: { countryCode: 'it' } });
    assert.deepEqual(failure(back), invalid(['vatNumber', 'pattern'], ['address.province', 'required']));
  });

  it('is a no-op when nothing changes: no write, no event', async () => {
    const { id, data } = await create({ phone: '999' });
    const mark = office.activity.entries.length;
    const reply = await as.call(psa(), 'PATCH', `/dealers/${id}`, { phone: '999', businessName: 'Acme Distribuzione' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.updatedAt, data['updatedAt']);
    assert.equal(office.activity.entries.length, mark);
  });

  it('rejects an empty body, bad values, other users\' fields and an unknown or malformed id', async () => {
    const { id } = await create();
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${id}`, {})), invalid(['(body)', 'required']));
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${id}`, { fiscalCode: 'bad' })), invalid(['fiscalCode', 'pattern']));
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${id}`, { user: { username: 'x' } })), invalid(['user', 'unknown']));
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${id}`, { businessName: null })), invalid(['businessName', 'type']));
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${hex(new ObjectId())}`, { businessName: 'X' })), { status: 404, code: 'NOT_FOUND', details: undefined });
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', '/dealers/not-an-id', { businessName: 'X' })), invalid(['dealerId', 'format']));
  });

  it('answers 409 when the VAT number belongs to another dealer, and lets a dealer keep his own', async () => {
    const mine = vat();
    const { id } = await create({ vatNumber: mine });
    const other = await create();
    assert.deepEqual(failure(await as.call(psa(), 'PATCH', `/dealers/${other.id}`, { vatNumber: mine })), conflict('vatNumber'));
    assert.equal((await as.call(psa(), 'PATCH', `/dealers/${id}`, { vatNumber: mine, businessName: 'Same VAT' })).status, 200);
  });
});

describe('GET /v1/dealers', () => {
  it('lists dealers sorted by company name with their user, searches by name and VAT number, and pages by cursor', async () => {
    const tag = randomBytes(4).toString('hex');
    const names = ['Charlie', 'Alpha', 'Bravo', 'Delta'].map((n) => `${tag} ${n}`);
    const ids: ObjectId[] = [];
    for (const businessName of names) {
      ids.push(await seedDealer({ businessName, vatNumber: vat() }));
    }
    // Only Charlie has a real user, a disabled one; the others have none.
    await users().insertOne(legacyUser(nextUser++, { _id: ids[0], userName: `${tag}-charlie`, role: 'D', status: false }));
    const first = await as.call(psa(), 'GET', `/dealers?q=${tag}&limit=3`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data.map((d: Document) => d['businessName']), [`${tag} Alpha`, `${tag} Bravo`, `${tag} Charlie`]);
    assert.deepEqual(first.body.data[2].user, { id: hex(ids[0]!), username: `${tag}-charlie`, status: 'disabled' });
    assert.equal(first.body.data[0].user, null);
    // A user with the dealer's id that is not a dealer is not shown as his user.
    await users().insertOne(legacyUser(nextUser++, { _id: ids[1], userName: `${tag}-not-a-dealer`, role: 'PSA' }));
    const again = await as.call(psa(), 'GET', `/dealers/${hex(ids[1]!)}`);
    assert.equal(again.body.data.user, null);
    assert.ok(first.body.data.every((d: Document) => !('createdBy' in d)));
    assert.equal(first.body.page.limit, 3);
    const second = await as.call(psa(), 'GET', `/dealers?q=${tag}&limit=3&cursor=${String(first.body.page.next)}`);
    assert.deepEqual(second.body.data.map((d: Document) => d['businessName']), [`${tag} Delta`]);
    assert.equal(second.body.page.next, null);
    const reversed = await as.call(psa(), 'GET', `/dealers?q=${tag}&sort=-businessName&limit=2`);
    assert.deepEqual(reversed.body.data.map((d: Document) => d['businessName']), [`${tag} Delta`, `${tag} Charlie`]);
    const byVat = await as.call(psa(), 'GET', `/dealers?q=${String(first.body.data[1].vatNumber)}`);
    assert.deepEqual(byVat.body.data.map((d: Document) => d['businessName']), [`${tag} Bravo`]);
    // A cursor made for another sort is refused, and so is an unknown sort or filter.
    assert.deepEqual(failure(await as.call(psa(), 'GET', `/dealers?q=${tag}&sort=-businessName&cursor=${String(first.body.page.next)}`)), invalid(['cursor', 'format']));
    assert.deepEqual(failure(await as.call(psa(), 'GET', '/dealers?sort=vatNumber')), invalid(['sort', 'enum']));
    assert.deepEqual(failure(await as.call(psa(), 'GET', '/dealers?status=active')), invalid(['status', 'unknown']));
  });

  it('reads one dealer, 404 for an unknown one', async () => {
    const id = await seedDealer({ businessName: 'Detail Srl' });
    const reply = await as.call(psa(), 'GET', `/dealers/${hex(id)}`);
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.data.id, reply.body.data.businessName, reply.body.data.source, reply.body.data.user], [hex(id), 'Detail Srl', 'migration', null]);
    assert.deepEqual(failure(await as.call(psa(), 'GET', `/dealers/${hex(new ObjectId())}`)), { status: 404, code: 'NOT_FOUND', details: undefined });
  });
});

describe('dealers and the platform users', () => {
  it('POST /v1/users with role D also writes the minimal dealer document in the same transaction', async () => {
    const username = name();
    const mark = office.activity.entries.length;
    const reply = await as.call(psa(), 'POST', '/users', { username, password: PASSWORD, role: 'D' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const id = ObjectId.createFromHexString(reply.body.data.id);
    const stored = (await dealers().findOne({ _id: id }))!;
    assert.deepEqual(
      { ...stored, createdAt: undefined, updatedAt: undefined, _id: undefined, createdBy: hex(stored['createdBy'] as ObjectId) },
      { businessName: username, vatNumber: null, fiscalCode: null, address: null, pec: null, sdiCode: null, email: null, phone: null, createdAt: undefined, updatedAt: undefined, _id: undefined, createdBy: hex(psa()), source: 'user' },
    );
    assert.deepEqual(office.activity.entries.slice(mark).map((entry) => [entry.action, entry.resource?.type]), [['user.created', 'user'], ['dealer.created', 'dealer']]);
    // The other roles get no dealer document.
    const count = await dealers().countDocuments();
    assert.equal((await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'PSA' })).status, 201);
    assert.equal(await dealers().countDocuments(), count);
  });

  it('leaves no dealer behind when the platform user cannot be created', async () => {
    const count = await dealers().countDocuments();
    assert.equal((await as.call(psa(), 'POST', '/users', { username: 'user-001', password: PASSWORD, role: 'D' })).status, 409);
    assert.equal(await dealers().countDocuments(), count);
  });

  it('deleting a D user for good deletes his dealer document, and records it', async () => {
    const created = await as.call(psa(), 'POST', '/dealers', body());
    const id = created.body.data.id as string;
    assert.equal((await as.call(psa(), 'POST', `/users/${id}/trash`)).status, 200);
    const mark = office.activity.entries.length;
    assert.equal((await as.call(psa(), 'DELETE', `/users/${id}`)).status, 204);
    assert.equal(await dealers().countDocuments({ _id: ObjectId.createFromHexString(id) }), 0);
    assert.equal(await users().countDocuments({ _id: ObjectId.createFromHexString(id) }), 0);
    assert.deepEqual(office.activity.entries.slice(mark).map((entry) => [entry.action, entry.resource?.type, entry.resource?.id]), [['user.deleted', 'user', id], ['dealer.deleted', 'dealer', id]]);
    const deleted = office.activity.entries.slice(mark)[1]!;
    assert.deepEqual(deleted.changes!.find((change) => change.field === 'businessName'), { field: 'businessName', before: 'Acme Distribuzione' });
  });

  it('deleting a D user that has no dealer document works and records no dealer event', async () => {
    const { id } = await addUser(ctx, office, { role: 'D', groupId: null, dealerId: null, trash: true });
    const mark = office.activity.entries.length;
    assert.equal((await as.call(psa(), 'DELETE', `/users/${hex(id)}`)).status, 204);
    assert.deepEqual(office.activity.entries.slice(mark).map((entry) => entry.action), ['user.deleted']);
  });

  it('deleting a user who is not a dealer touches no dealer document', async () => {
    const created = await as.call(psa(), 'POST', '/users', { username: name(), password: PASSWORD, role: 'PSA' });
    const id = created.body.data.id as string;
    await as.call(psa(), 'POST', `/users/${id}/trash`);
    const count = await dealers().countDocuments();
    assert.equal((await as.call(psa(), 'DELETE', `/users/${id}`)).status, 204);
    assert.equal(await dealers().countDocuments(), count);
  });

  it('GET /v1/me shows the company of a D user, null when the registry has no document for him, and null for the other roles', async () => {
    await dealers().insertOne({
      _id: office.cluster.dealerA,
      businessName: 'Dealer A Srl',
      vatNumber: null,
      fiscalCode: null,
      address: null,
      pec: null,
      sdiCode: null,
      email: null,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      source: 'migration',
    });
    const me = async (actor: ObjectId) => (await as.call(actor, 'GET', '/me')).body.data.dealer;
    assert.deepEqual(await me(office.cluster.dealerA), { id: hex(office.cluster.dealerA), businessName: 'Dealer A Srl' });
    assert.equal(await me(office.cluster.dealerB), null);
    assert.equal(await me(psa()), null);
    assert.equal(await me(office.cluster.groups[0]!.sa), null);
  });
});

describe('the dealers collection', () => {
  it('has a unique partial index on the VAT number: many null, one per string', async () => {
    const indexes = await dealers().indexes();
    const index = indexes.find((entry) => entry.name === 'vatNumber_1')!;
    assert.deepEqual([index.unique, index.partialFilterExpression], [true, { vatNumber: { $type: 'string' } }]);
    await seedDealer({ vatNumber: null });
    await seedDealer({ vatNumber: null });
    const number = vat();
    await seedDealer({ vatNumber: number });
    await assert.rejects(seedDealer({ vatNumber: number }), { code: 11000 });
  });

  it('refuses documents that break the validator', async () => {
    const valid = { businessName: 'V', vatNumber: null, fiscalCode: null, address: null, pec: null, sdiCode: null, email: null, phone: null, createdAt: new Date(), updatedAt: new Date(), createdBy: null, source: 'manual' };
    for (const broken of [{ ...valid, extra: 1 }, { ...valid, businessName: '' }, { ...valid, source: 'other' }, { ...valid, address: { street: 'x' } }, { ...valid, vatNumber: 5 }]) {
      await assert.rejects(dealers().insertOne({ ...broken }), { code: 121 });
    }
    await dealers().insertOne({ ...valid });
  });
});
