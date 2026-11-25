import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createContactGroupsRepository } from '../../src/modules/contact-groups/contact-groups.repository.ts';
import { createContactGroupsService } from '../../src/modules/contact-groups/contact-groups.service.ts';
import { birthDateOf, blankContact, cardsOf, clearText, contactComparable, contactData, contactVersion, displayNameOf, sameStored } from '../../src/modules/contacts/contacts.document.ts';
import { contactRow, contactView } from '../../src/modules/contacts/contacts.mapper.ts';
import { createContactsRepository } from '../../src/modules/contacts/contacts.repository.ts';
import type { ContactChange } from '../../src/modules/contacts/contacts.repository.ts';
import { REMOVAL_BUDGET_MS, guardContactRemoval } from '../../src/modules/contacts/contacts.removal.ts';
import { contactSearch, createContactsService } from '../../src/modules/contacts/contacts.service.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { CONTACT_DELETE_PER_HOUR } from '../../src/shared/security/rate-limit/rules.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { accessFor } from '../helpers/group-access.ts';
import { withHooks } from '../helpers/legacy-write.ts';
import type { Hooks } from '../helpers/legacy-write.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import type { ClientContext } from '../../src/shared/http/client-context.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';

const key = Buffer.alloc(32, 9);
const client: ClientContext = { requestId: 'r1', ip: '10.0.0.1', userAgent: null };
const hex = (id: ObjectId) => id.toHexString();
const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const DELETE_RULE = { bucket: 'contact-delete:user', limit: CONTACT_DELETE_PER_HOUR, windowSeconds: 3600, key: () => null };
const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });

describe('the document of a contact', () => {
  it('reads a stored value tolerantly: texts in clear, lists, dates, names', () => {
    assert.deepEqual([clearText(' x '), clearText(5), clearText(undefined), clearText('aabbccddeeff00112233445566778899$00112233445566778899aabbccddeeff')], ['x', '', '', '']);
    assert.deepEqual([birthDateOf(new Date('1990-02-03T10:00:00Z')), birthDateOf('1990-02-03'), birthDateOf('1990-02-03T23:00:00.000Z'), birthDateOf('1990-13-45'), birthDateOf('ieri'), birthDateOf(new Date('x')), birthDateOf(7)], ['1990-02-03', '1990-02-03', '1990-02-03', null, null, null, null]);
    assert.deepEqual([displayNameOf('Acme', 'A', 'B'), displayNameOf('', 'Mario', 'Rossi'), displayNameOf('', 'Mario', ''), displayNameOf('', '', 'Rossi'), displayNameOf('', '', '')], ['Acme', 'Mario Rossi', 'Mario', 'Rossi', null]);
    assert.deepEqual(cardsOf([{ code: 'A', points: 2 }, { code: 'B' }, { code: '' }, 'x', { points: 4 }]), [{ code: 'A', points: 2 }, { code: 'B', points: 0 }]);
    assert.deepEqual(cardsOf('x'), []);
    const data = contactData({});
    assert.deepEqual([data.code, data.customer, data.person.address, data.company.supplierPriceLists, data.eInvoicing.transmissionFormat, data.account, data.services], ['', false, { street: '', postcode: '', city: '', countryCode: null, areaCode: null }, [], 'FPR12', { email: null, phone: null }, []]);
  });

  it('compares stored values by value, and the version ignores the balance of the cards', () => {
    const id = new ObjectId();
    assert.equal(sameStored(id, new ObjectId(hex(id))), true);
    assert.equal(sameStored(id, hex(id)), false);
    assert.equal(sameStored(hex(id), id), false);
    assert.equal(sameStored([id, 'a'], [new ObjectId(hex(id)), 'a']), true);
    assert.equal(sameStored([id], [id, id]), false);
    assert.equal(sameStored([1], 'x'), false);
    assert.equal(sameStored({ a: 1, b: [id] }, { b: [new ObjectId(hex(id))], a: new Int32(1) }), true);
    assert.equal(sameStored({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(sameStored({ a: 1 }, { b: 1 }), false);
    assert.equal(sameStored({ a: 1 }, 5), false);
    assert.equal(sameStored(new Double(10), 10), true);
    assert.equal(sameStored(null, undefined), false);
    assert.equal(sameStored(new Date(5), new Date(5)), true);
    const document = legacyContact();
    const moved = { ...document, fidelities: [{ code: 'CARD-1', points: 999 }] };
    assert.equal(contactVersion(document, key), contactVersion(moved, key));
    assert.notEqual(contactVersion(document, key), contactVersion({ ...document, fidelities: [{ code: 'OTHER', points: 120 }] }, key));
    assert.notEqual(contactVersion(document, key), contactVersion({ ...document, city: 'Altrove' }, key));
    assert.equal(contactVersion(document, key), contactVersion({ ...document, account: { ...(document['account'] as Document), password: 'changed', tokens: [] }, legacyExtra: 1, cGroup: 2 }, key));
    assert.equal(contactVersion(document, key).length, 43);
    assert.deepEqual(contactComparable(document)['fidelityCards'], ['CARD-1']);
    assert.deepEqual(Object.keys(blankContact({ id: new ObjectId(), now: new Date() })).includes('account'), false);
  });

  it('shows a legacy contact without anything the backend does not own', () => {
    const view = contactView(legacyContact(), { services: false });
    assert.equal('services' in view, false);
    assert.ok(!JSON.stringify(view).includes('legacy-dead'));
    assert.equal(contactView(legacyContact(), { services: true }).services?.length, 0);
    assert.equal(contactRow(legacyContact({ trashDate: new Date('x') })).trashedAt, null);
    assert.deepEqual([contactRow(legacyContact({ email: [], companyEmail: ['c@x.test'], telephone: [], companyTelephone: [] })).email, contactRow(legacyContact({ email: [], telephone: [] })).phone], ['c@x.test', null]);
  });

  it('turns a search text into an escaped filter', () => {
    const filter = contactSearch('a.b');
    const regexes = JSON.stringify(filter);
    assert.ok(regexes.includes('a\\\\.b'));
    assert.equal(contactSearch('one two').$or!.length, 12);
    assert.equal(contactSearch('one').$or!.length, 10);
    assert.equal(contactSearch('one two three').$or!.length, 10);
  });
});

describe('the budget of the checks of a deletion', () => {
  it('gives each check what is left of ten seconds, at most five, and refuses to go on when it is used up', async () => {
    const seen: number[] = [];
    let clock = 0;
    const now = () => {
      const value = clock;
      clock += 3000;
      return value;
    };
    const principal = principalOf('SA', { groupId: new ObjectId() });
    const repository = { referencedBy: async (_p: unknown, _a: unknown, _i: unknown, _k: unknown, maxTimeMS: number) => (seen.push(maxTimeMS), [] as string[]), promotionsNamingContact: async () => [] as string[] };
    await assert.rejects(guardContactRemoval({ repository, now }, principal, {} as GroupAccess, new ObjectId()), reject('SERVICE_UNAVAILABLE'));
    assert.deepEqual(seen, [5000, 4000, 1000]);
    assert.equal(REMOVAL_BUDGET_MS, 10_000);
    // With time to spare every check gets the usual limit.
    seen.length = 0;
    await guardContactRemoval({ repository, now: () => 0 }, principal, {} as GroupAccess, new ObjectId());
    assert.deepEqual(seen, [5000, 5000, 5000, 5000, 5000, 5000, 5000]);
  });
});

describe('the repositories on a real database', () => {
  let ctx: TestDatabases;
  const groupId = new ObjectId();
  const principal = principalOf('SA', { groupId });
  let access: GroupAccess;
  const contacts = () => ctx.databases.group(groupId, 'cluster0').collection('contacts');
  const change = (overrides: Partial<ContactChange> = {}): ContactChange => ({ set: {}, unset: {}, containers: [], updateDate: new Date('2025-01-01T00:00:00Z'), readValues: {}, added: [], removed: [], ...overrides });

  before(async () => {
    ctx = await openTestDatabases();
    access = (await accessFor(principal, groupId))!;
  });
  after(async () => ctx.cleanup());

  it('refuses to write a key that is not owned, and the array of the cards as a whole', async () => {
    const repository = createContactsRepository(ctx.databases);
    const id = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: id }));
    await assert.rejects(repository.insert(principal, access, { _id: new ObjectId(), cGroup: {} }), /not an owned field/);
    await assert.rejects(repository.insert(principal, access, { _id: new ObjectId(), 'account.password': 'x' }), /not an owned field/);
    for (const set of [{ cGroup: 1 }, { fidelities: [] }, { 'fidelities.0.points': 1 }, { account: { email: 'x' } }, { 'account.password': 'x' }, { associatedCompany: 1 }]) {
      await assert.rejects(repository.update(principal, access, id, change({ set }), undefined), /not an owned field/, JSON.stringify(set));
    }
    await assert.rejects(repository.update(principal, access, id, change({ unset: { tokens: '' } }), undefined), /not an owned field/);
    // A container is accepted as a whole only when the write names it.
    assert.equal(await repository.update(principal, access, id, change({ set: { account: { email: 'a@x.test' } }, containers: ['account'] }), LEGACY_DATE_OF(await contacts().findOne({ _id: id }))), 'conflict');
  });

  it('maps the refusal of a unique index of the account to 409 taken, on a creation and on a modification', async () => {
    const repository = createContactsRepository(ctx.databases);
    await contacts().createIndex({ 'account.email': 1 }, { unique: true, partialFilterExpression: { 'account.email': { $type: 'string' } }, name: 'legacy_account_email' });
    await contacts().createIndex({ 'account.telephone': 1 }, { unique: true, partialFilterExpression: { 'account.telephone': { $type: 'string' } }, name: 'legacy_account_telephone' });
    const first = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: first, account: { email: 'one@x.test', telephone: '111' } }));
    const detail = (error: unknown) => (error as AppError).details;
    await assert.rejects(repository.insert(principal, access, { _id: new ObjectId(), account: { email: 'one@x.test' } }), (error: unknown) => reject('CONFLICT')(error) && JSON.stringify(detail(error)) === JSON.stringify([{ field: 'account.email', issue: 'taken' }]));
    await assert.rejects(repository.insert(principal, access, { _id: new ObjectId(), account: { telephone: '111' } }), (error: unknown) => JSON.stringify(detail(error)) === JSON.stringify([{ field: 'account.phone', issue: 'taken' }]));
    const second = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: second, account: undefined }));
    const read = (await contacts().findOne({ _id: second }))!['updateDate'];
    await assert.rejects(repository.update(principal, access, second, change({ set: { 'account.email': 'one@x.test' }, readValues: { 'account.email': undefined } }), read), (error: unknown) => JSON.stringify(detail(error)) === JSON.stringify([{ field: 'account.email', issue: 'taken' }]));
    await assert.rejects(repository.update(principal, access, second, change({ set: { 'account.telephone': '111' }, readValues: { 'account.telephone': undefined } }), read), (error: unknown) => JSON.stringify(detail(error)) === JSON.stringify([{ field: 'account.phone', issue: 'taken' }]));
    // Any other failure goes on as it is.
    await assert.rejects(repository.insert(principal, access, { _id: first }), (error: unknown) => error instanceof MongoServerError && !(error instanceof AppError));
    await contacts().dropIndexes();
    await contacts().deleteMany({});
  });

  it('writes added and removed cards in one update that keeps the balance a sale added meanwhile, and answers conflict when nothing matched', async () => {
    const id = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: id, fidelities: [{ code: 'OLD', points: 3 }, { code: ' KEEP ', points: 4 }, 'x'] }));
    const date = (await contacts().findOne({ _id: id }))!['updateDate'];
    const sale = createContactsRepository(
      withHooks(ctx.databases, {
        group: {
          contacts: {
            updateOne: async (run) => {
              // A sale adds points right before the write, and does not touch the date.
              await contacts().updateOne({ _id: id, 'fidelities.code': ' KEEP ' }, { $inc: { 'fidelities.$.points': 10 } });
              return run();
            },
          },
        },
      }),
    );
    const outcome = await sale.update(principal, access, id, change({ set: { city: 'Roma', 'fattura_elettronica.pec': '$literal@x.test' }, unset: { note: '' }, readValues: { city: 'Milano' }, removed: ['OLD'], added: ['NEW'] }), date);
    assert.equal(outcome, 'updated');
    const after = (await contacts().findOne({ _id: id }))!;
    assert.deepEqual(after['fidelities'], [{ code: ' KEEP ', points: 14 }, 'x', { code: 'NEW', points: 0 }]);
    assert.deepEqual([after['city'], (after['fattura_elettronica'] as Document)['pec'], 'note' in after], ['Roma', '$literal@x.test', false]);
    const repository = createContactsRepository(ctx.databases);
    assert.equal(await repository.update(principal, access, id, change({ set: { city: 'Altra' } }), date), 'conflict');
    // The guard on the container: a container that became an object is not replaced.
    const object = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: object }));
    const objectDate = (await contacts().findOne({ _id: object }))!['updateDate'];
    assert.equal(await repository.update(principal, access, object, change({ set: { account: { email: 'x@x.test' } }, containers: ['account'] }), objectDate), 'conflict');
    // Added and removed in one request, nothing in between.
    const done = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: done, fidelities: [{ code: 'A', points: 1 }] }));
    const doneDate = (await contacts().findOne({ _id: done }))!['updateDate'];
    assert.equal(await repository.update(principal, access, done, change({ set: { city: 'X' }, removed: ['A'], added: ['B'], readValues: { city: 'Milano' } }), doneDate), 'updated');
    assert.deepEqual((await contacts().findOne({ _id: done }))!['fidelities'], [{ code: 'B', points: 0 }]);
    // The checks that need no read.
    assert.deepEqual(await repository.accountTaken(principal, access, id, { email: null, phone: null }), { email: false, phone: false });
    assert.deepEqual(await repository.usingValues(principal, access, id, { code: null, taxCode: null, vatNumber: null, companyTaxCode: null }), []);
  });

  it('answers 503 when a read exceeds its time limit, never a partial answer', async () => {
    const cursor = (error: Error) => () => ({ toArray: () => Promise.reject(error) }) as unknown as Promise<unknown>;
    const reading = (error: Error) => ({ find: cursor(error), aggregate: cursor(error), findOne: () => Promise.reject(error), countDocuments: () => Promise.reject(error) });
    const failing = (error: Error): Hooks => ({ contacts: reading(error), products: reading(error), sales: reading(error), documents: reading(error), contacts_groups: reading(error), fidelity_cards: reading(error) });
    const repository = createContactsRepository(withHooks(ctx.databases, { group: failing(expired), common: { groups: { findOne: () => Promise.reject(expired) } } }));
    const groups = createContactGroupsRepository(withHooks(ctx.databases, { group: failing(expired), common: { groups: { findOne: () => Promise.reject(expired) } } }));
    const id = new ObjectId();
    const reads = [
      () => repository.list(principal, access, {}, { limit: 10, sort: 'displayName', q: null, cursor: null }),
      () => repository.findById(principal, access, id),
      () => repository.countTrashed(principal, access),
      () => repository.trashedIds(principal, access, 10, null),
      () => repository.referencedBy(principal, access, id, 'contactAssociations', 5000),
      () => repository.referencedBy(principal, access, id, 'products', 5000),
      () => repository.referencedBy(principal, access, id, 'sales', 5000),
      () => repository.referencedBy(principal, access, id, 'documents', 5000),
      () => repository.cardHolders(principal, access, ['A'], false),
      () => repository.cardHolderIds(principal, access, 'A'),
      () => repository.cardCodesOfContactsNamed(principal, access, 'a'),
      () => repository.contactsByIds(principal, access, [hex(id)]),
      () => repository.advancedCards(principal, access, ['A']),
      () => repository.isAdvancedCard(principal, access, ['A']),
      () => repository.productsUsingPriceLists(principal, access, id, ['a']),
      () => groups.contactsOf(principal, access, id),
      () => groups.promotionsNaming(access, id),
      () => repository.promotionsNamingContact(access, id),
      () => groups.countContacts(principal, access, id),
      () => groups.findById(principal, access, id),
    ];
    for (const read of reads) {
      await assert.rejects(read(), reject('SERVICE_UNAVAILABLE'));
    }
    const other = createContactsRepository(withHooks(ctx.databases, { group: failing(new Error('network')) }));
    await assert.rejects(other.findById(principal, access, id), /network/);
  });

  it('lets a failure that is not the refusal of an account through, and pages the trash after a cursor', async () => {
    const duplicate = new MongoServerError({ message: 'E11000', code: 11000 });
    const failing = (error: Error) => createContactsRepository(withHooks(ctx.databases, { group: { contacts: { insertOne: () => Promise.reject(error) } } }));
    await assert.rejects(failing(duplicate).insert(principal, access, { _id: new ObjectId() }), (error: unknown) => error === duplicate);
    const plainError = new Error('network');
    await assert.rejects(failing(plainError).insert(principal, access, { _id: new ObjectId() }), (error: unknown) => error === plainError);
    const repository = createContactsRepository(ctx.databases);
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
    await contacts().insertMany(ids.map((_id) => legacyContact({ _id, trash: true, account: undefined })));
    assert.deepEqual(await repository.trashedIds(principal, access, 2, ids[0]!), [ids[1], ids[2]]);
    assert.ok((await repository.countTrashed(principal, access)) >= 3);
  });

  it('adjusts the points with one update and tells the balance after', async () => {
    const repository = createContactsRepository(ctx.databases);
    const id = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: id, fidelities: [{ code: 'A', points: 5 }, { code: 'B', points: 1 }] }));
    assert.equal(await repository.adjustPoints(principal, access, id, 'A', 3), 8);
    assert.equal(await repository.adjustPoints(principal, access, id, 'A', -8), 0);
    assert.equal(await repository.adjustPoints(principal, access, id, 'A', -1), null);
    assert.equal(await repository.adjustPoints(principal, access, id, 'Z', 1), null);
    assert.equal(await repository.adjustPoints(principal, access, new ObjectId(), 'A', 1), null);
    assert.deepEqual((await repository.cardsOf(principal, access, id))!['fidelities'], [{ code: 'A', points: 0 }, { code: 'B', points: 1 }]);
  });
});

const LEGACY_DATE_OF = (document: Document | null): unknown => document!['updateDate'];

describe('the services without an address of the client', () => {
  it('record what they do with no ip when the request has none', async () => {
    const ctx = await openTestDatabases();
    try {
      const groupId = new ObjectId();
      const principal = principalOf('SA', { groupId });
      const access = (await accessFor(principal, groupId))!;
      const log = memoryActivityLog();
      const noIp: ClientContext = { requestId: 'r2', ip: null, userAgent: null };
      const service = createContactsService({ repository: createContactsRepository(ctx.databases), catalogs: { list: async () => [] }, findCountry: async () => null, activityLog: log, rateLimiter: memoryRateLimiter(), deleteRule: DELETE_RULE, versionKey: key, now: () => Date.now() });
      const created = await service.create(principal, access, { person: { firstName: 'Senza ip' }, fidelityCards: [{ code: 'C' }] }, noIp);
      const id = ObjectId.createFromHexString(created.entity.id);
      const updated = await service.update(principal, access, id, created.version, { notes: 'x' }, noIp);
      await service.adjustPoints(principal, access, id, 'C', { delta: 2 }, noIp);
      const trashed = await service.trash(principal, access, id, updated.version, noIp);
      const restored = await service.restore(principal, access, id, trashed.version, noIp);
      assert.equal(restored.entity.trashed, false);
      await service.trash(principal, access, id, restored.version, noIp);
      await service.deleteFromTrash(principal, access, id, noIp);
      const groups = createContactGroupsService({ repository: createContactGroupsRepository(ctx.databases), catalogs: { list: async () => [] }, activityLog: log, versionKey: key, now: () => Date.now() });
      await groups.create(principal, access, { name: 'G' }, noIp);
      assert.equal(log.entries.length, 8);
      assert.ok(log.entries.every((entry) => entry.ip === undefined));
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('the services on a real database', () => {
  let ctx: TestDatabases;
  const groupId = new ObjectId();
  const principal = principalOf('SA', { groupId });
  let access: GroupAccess;
  const contacts = () => ctx.databases.group(groupId, 'cluster0').collection('contacts');
  const versionOf = (document: Document) => contactVersion(document, key);

  before(async () => {
    ctx = await openTestDatabases();
    access = (await accessFor(principal, groupId))!;
  });
  after(async () => ctx.cleanup());

  const build = (hooks: Hooks = {}) => {
    const log = memoryActivityLog();
    const limiter = memoryRateLimiter();
    const service = createContactsService({
      repository: createContactsRepository(withHooks(ctx.databases, { group: hooks })),
      catalogs: { list: async () => [] },
      findCountry: async () => null,
      activityLog: log,
      rateLimiter: limiter,
      deleteRule: DELETE_RULE,
      versionKey: key,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    return { service, log, limiter };
  };

  it('answers 409 and logs when the contact changes between the read and the write, in a modification, a trash and a deletion', async () => {
    const id = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: id }));
    let tick = 0;
    const sneaky = (method: 'updateOne' | 'deleteOne', touch: Document): Hooks => ({
      contacts: {
        [method]: async (run) => {
          tick += 1;
          await contacts().updateOne({ _id: id }, { $set: { ...touch, updateDate: new Date(Date.UTC(2029, 0, 1, 0, 0, tick)) } });
          return run();
        },
      },
    });
    const stored = async () => (await contacts().findOne({ _id: id }))!;
    const { service } = build(sneaky('updateOne', { city: 'Altrove', updateDate: new Date('2029-01-01T00:00:00Z') }));
    await assert.rejects(service.update(principal, access, id, versionOf(await stored()), { notes: 'x' }, client), reject('CONFLICT'));
    const raced = build(sneaky('updateOne', { updateDate: new Date('2029-02-01T00:00:00Z') }));
    await assert.rejects(raced.service.trash(principal, access, id, versionOf(await stored()), client), reject('CONFLICT'));
    assert.deepEqual((await raced.service.trashMany(principal, access, [id], client)).results, [{ id: hex(id), outcome: 'skipped', issue: 'conflict' }]);
    await contacts().updateOne({ _id: id }, { $set: { trash: true } });
    const removal = build(sneaky('deleteOne', { updateDate: new Date('2029-03-01T00:00:00Z') }));
    await assert.rejects(removal.service.remove(principal, access, id, versionOf(await stored()), client), reject('CONFLICT'));
    assert.deepEqual(await removal.service.deleteFromTrash(principal, access, id, client), { done: false, issue: 'notTrashed' });
  });

  it('counts every contact deleted for good against the hourly limit of the user, and answers 429 with Retry-After over it', async () => {
    const { service, limiter } = build();
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()];
    await contacts().insertMany(ids.map((_id) => legacyContact({ _id, trash: true, account: undefined })));
    const tiny = { ...DELETE_RULE, limit: 2 };
    const limited = createContactsService({ repository: createContactsRepository(ctx.databases), catalogs: { list: async () => [] }, findCountry: async () => null, activityLog: memoryActivityLog(), rateLimiter: limiter, deleteRule: tiny, versionKey: key, now: () => Date.now() });
    assert.deepEqual(await limited.deleteFromTrash(principal, access, ids[0]!, client), { done: true });
    assert.deepEqual(await limited.deleteFromTrash(principal, access, ids[1]!, client), { done: true });
    await assert.rejects(limited.deleteFromTrash(principal, access, ids[2]!, client), (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED' && error.headers?.['Retry-After'] === '30');
    assert.deepEqual(limiter.calls.map((call) => [call.bucket, call.limit]), [['contact-delete:user', 2], ['contact-delete:user', 2], ['contact-delete:user', 2]]);
    assert.deepEqual(limiter.calls.map((call) => call.key), Array(3).fill(hex(principal.userId)));
    // A contact that is not in the trash is refused before it is counted.
    const live = new ObjectId();
    await contacts().insertOne(legacyContact({ _id: live, account: undefined }));
    await assert.rejects(service.remove(principal, access, live, versionOf((await contacts().findOne({ _id: live }))!), client), reject('CONFLICT'));
    assert.equal(limiter.calls.length, 3);
  });

  it('keeps the groups of contacts from being changed or deleted by a write that lost a race', async () => {
    const groupsCollection = () => ctx.databases.group(groupId, 'cluster0').collection('contacts_groups');
    const id = new ObjectId();
    await groupsCollection().insertOne({ _id: id, name: 'G', priceListId: null, discountPercentage: null, insertDate: new Date(0), updateDate: new Date(0) });
    const log = memoryActivityLog();
    let tick = 0;
    const sneaky = (method: 'updateOne' | 'deleteOne'): Hooks => ({
      contacts_groups: {
        [method]: async (run) => {
          tick += 1;
          await groupsCollection().updateOne({ _id: id }, { $set: { updateDate: new Date(Date.UTC(2029, 0, 1, 0, 0, tick)) } });
          return run();
        },
      },
    });
    const service = (hooks: Hooks) =>
      createContactGroupsService({ repository: createContactGroupsRepository(withHooks(ctx.databases, { group: hooks })), catalogs: { list: async () => [] }, activityLog: log, versionKey: key, now: () => Date.parse('2026-01-01T00:00:00Z') });
    const version = async () => {
      const read = (await groupsCollection().findOne({ _id: id }))!;
      const { entityVersion } = await import('../../src/modules/product-catalog/entity.service.ts');
      const { CONTACTS_GROUPS_OWNED_FIELDS } = await import('../../src/db/collections.ts');
      return entityVersion(read, CONTACTS_GROUPS_OWNED_FIELDS, key);
    };
    await assert.rejects(service(sneaky('updateOne')).update(principal, access, id, await version(), { name: 'Nuovo' }, client), reject('CONFLICT'));
    await assert.rejects(service(sneaky('deleteOne')).remove(principal, access, id, await version(), client), reject('CONFLICT'));
    await assert.rejects(createContactGroupsRepository(ctx.databases).update(principal, access, id, { set: { trash: true }, updateDate: new Date(), readValues: {} }, undefined), /not an owned field/);
    assert.equal(log.entries.length, 0);
    // Without the clock of the test the new id and the date are the real ones.
    const created = await createContactGroupsService({ repository: createContactGroupsRepository(ctx.databases), catalogs: { list: async () => [] }, activityLog: log, versionKey: key, now: () => Date.now() }).create(principal, access, { name: 'Vera' }, client);
    assert.equal(created.entity.name, 'Vera');
    assert.equal(log.entries.length, 1);
  });
});
