import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryLogger } from '../helpers/app.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { accessFor } from '../helpers/group-access.ts';
import { withHooks } from '../helpers/legacy-write.ts';
import type { Hooks } from '../helpers/legacy-write.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { createContactsRepository } from '../../src/modules/contacts/contacts.repository.ts';
import { cardBalance, isCollectionActive } from '../../src/modules/fidelity-cards/fidelity-cards.document.ts';
import { createCardsRepository } from '../../src/modules/fidelity-cards/fidelity-cards.repository.ts';
import { createCardIndexGuard, createCardCodeIndex } from '../../src/modules/fidelity-cards/fidelity-cards.indexes.ts';
import { createCardsService } from '../../src/modules/fidelity-cards/fidelity-cards.service.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { ClientContext } from '../../src/shared/http/client-context.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';

const key = Buffer.alloc(32, 3);
const client: ClientContext = { requestId: 'r1', ip: null, userAgent: null };
const hex = (id: ObjectId) => id.toHexString();
const num = (value: unknown): unknown => (value instanceof Double ? value.valueOf() : value);
const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });

describe('the pure rules of the cards', () => {
  it('rounds the credit, and tells when a collection gives points', () => {
    assert.deepEqual([cardBalance(1.005), cardBalance(2), cardBalance('x'), cardBalance(undefined)], [1, 2, null, null]);
    const collection = { id: 'c', enabled: true, name: 'C', pointConversion: null, minAmount: null, dateFrom: null, dateTo: null, pointsExpirationDate: null, prizeCatalogueId: null };
    const now = Date.parse('2026-06-01T00:00:00Z');
    assert.equal(isCollectionActive(collection, now), true);
    assert.equal(isCollectionActive({ ...collection, enabled: false }, now), false);
    assert.equal(isCollectionActive({ ...collection, dateFrom: '2027-01-01T00:00:00Z' }, now), false);
    assert.equal(isCollectionActive({ ...collection, dateTo: '2026-01-01T00:00:00Z' }, now), false);
    assert.equal(isCollectionActive({ ...collection, pointsExpirationDate: '2026-01-01T00:00:00Z' }, now), false);
    assert.equal(isCollectionActive({ ...collection, dateFrom: '2026-01-01T00:00:00Z', dateTo: '2027-01-01T00:00:00Z', pointsExpirationDate: '2027-01-01T00:00:00Z' }, now), true);
  });
});

describe('the cards on a real database', () => {
  let ctx: TestDatabases;
  const groupId = new ObjectId();
  const principal = principalOf('SA', { groupId });
  let access: GroupAccess;
  const cards = () => ctx.databases.group(groupId, 'cluster0').collection('fidelity_cards');
  const history = () => ctx.databases.group(groupId, 'cluster0').collection('fidelity_cards_movements');
  const contacts = () => ctx.databases.group(groupId, 'cluster0').collection('contacts');
  const movement = (cardId: ObjectId, code: string) => ({ userId: principal.userId, cardId, cardCode: code, date: new Date(), type: 'manually' as const, balance: 1, pointsCollectionId: null, points: 0 });

  before(async () => {
    ctx = await openTestDatabases();
    access = (await accessFor(principal, groupId))!;
  });
  after(async () => ctx.cleanup());

  it('maps the unique index of the legacy on the code to 409 taken, and lets any other failure through', async () => {
    const repository = createCardsRepository(ctx.databases);
    await cards().createIndex({ code: 1 }, { unique: true, name: 'legacy_code' });
    const card = (id = new ObjectId()) => ({ _id: id, code: 'UNIQUE', cardTypeId: 't', status: true, balance: new Double(0), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    await repository.insert(principal, access, card(), []);
    await assert.rejects(repository.insert(principal, access, card(), []), (error: unknown) => reject('CONFLICT')(error) && JSON.stringify((error as AppError).details) === JSON.stringify([{ field: 'code', issue: 'taken' }]));
    const same = card();
    await repository.insert(principal, access, { ...same, code: 'OTHER' }, []);
    await assert.rejects(repository.insert(principal, access, { ...same, code: 'THIRD' }, []), (error: unknown) => error instanceof MongoServerError && !(error instanceof AppError));
    const failing = (error: Error) => createCardsRepository(withHooks(ctx.databases, { group: { fidelity_cards: { insertOne: () => Promise.reject(error) } } }));
    const duplicate = new MongoServerError({ message: 'E11000', code: 11000 });
    await assert.rejects(failing(duplicate).insert(principal, access, card(), []), (error: unknown) => error === duplicate);
    const plainError = new Error('network');
    await assert.rejects(failing(plainError).insert(principal, access, card(), []), (error: unknown) => error === plainError);
    await cards().dropIndexes();
    await cards().deleteMany({});
  });

  it('refuses to write a field a modification may not set, and a collection that is not a safe id', async () => {
    const repository = createCardsRepository(ctx.databases);
    const id = new ObjectId();
    for (const set of [{ code: 'x' }, { balance: 1 }, { pointsCollections: {} }, { legacyExtra: 1 }]) {
      await assert.rejects(repository.update(principal, access, id, set, new Date(), { updateDate: undefined, cardTypeId: undefined, status: undefined }), /not a field a modification may set/, JSON.stringify(set));
    }
    await assert.rejects(repository.adjust(principal, access, id, { points: [{ collectionId: 'a.b', delta: 1 }] }, undefined), /safe id/);
    assert.deepEqual(await repository.collectionUsers(principal, access, 'a.b'), []);
  });

  it('answers 503 when a read exceeds its time limit, and names no operator it does not find', async () => {
    const cursor = (error: Error) => () => ({ toArray: () => Promise.reject(error) }) as unknown as Promise<unknown>;
    const reading = { find: cursor(expired), aggregate: cursor(expired), findOne: () => Promise.reject(expired) };
    const hooks: Hooks = { fidelity_cards: reading, fidelity_cards_movements: reading };
    const repository = createCardsRepository(withHooks(ctx.databases, { group: hooks, common: { users: { find: cursor(expired) }, apiKeys: { find: cursor(expired) } } }));
    const id = new ObjectId();
    const reads = [
      () => repository.list(principal, access, {}, { limit: 5, sort: 'code', q: null, cursor: null }),
      () => repository.findById(principal, access, id),
      () => repository.codeTaken(principal, access, 'A'),
      () => repository.movements(principal, access, { id, code: 'A' }, { limit: 5, sort: '-date', q: null, cursor: null }),
      () => repository.hasMovements(principal, access, { id, code: 'A' }),
      () => repository.operatorNames(access, [id]),
      () => repository.apiKeyNames(access, [id]),
      () => repository.cardTypeUsers(principal, access, 't'),
      () => repository.collectionUsers(principal, access, 'c'),
    ];
    for (const read of reads) {
      await assert.rejects(read(), reject('SERVICE_UNAVAILABLE'));
    }
    assert.deepEqual([...(await createCardsRepository(ctx.databases).operatorNames(access, [new ObjectId()])).entries()], []);
    const user = new ObjectId();
    await ctx.databases.common().collection('users').insertMany([{ _id: user, groupId, name: 'Mario', surname: 'Rossi' }, { _id: new ObjectId(), groupId, name: 5 }]);
    assert.deepEqual([...(await createCardsRepository(ctx.databases).operatorNames(access, [user])).entries()], [[hex(user), 'Mario Rossi']]);
    const [named, unnamed] = [new ObjectId(), new ObjectId()];
    await ctx.databases.common().collection('apiKeys').insertMany([{ _id: named, groupId, name: 'Webshop' }, { _id: unnamed, groupId, name: 5 }, { _id: new ObjectId(), groupId: new ObjectId(), name: 'Altro' }]);
    assert.deepEqual([...(await createCardsRepository(ctx.databases).apiKeyNames(access, [named, unnamed])).entries()].sort(), [[hex(named), 'Webshop'], [hex(unnamed), null]].sort());
    const blank = await ctx.databases.common().collection('users').insertOne({ groupId, name: ' ', surname: '' });
    assert.equal((await createCardsRepository(ctx.databases).operatorNames(access, [blank.insertedId])).get(hex(blank.insertedId)), null);
  });

  it('gives back at most a thousand codes of the contacts a search by name finds', async () => {
    const repository = createContactsRepository(ctx.databases);
    await contacts().insertOne({ _id: new ObjectId(), name: 'Collezionista', fidelities: Array.from({ length: 1100 }, (_, index) => ({ code: ` K${String(index)} `, points: 0 })) });
    const codes = await repository.cardCodesOfContactsNamed(principal, access, 'collezionista');
    assert.equal(codes.length, 1000);
    assert.equal(codes[0], 'K0');
  });

  it('writes the cards of the contacts only to the contacts that do not have the code, and gives them a new date', async () => {
    const repository = createContactsRepository(ctx.databases);
    const [empty, has, trashed, odd] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
    const date = new Date('2024-01-01T00:00:00Z');
    await contacts().insertMany([
      { _id: empty, updateDate: date },
      { _id: has, fidelities: [{ code: 'LINK', points: 3 }], updateDate: date },
      { _id: trashed, fidelities: [], trash: true, updateDate: date },
      { _id: odd, fidelities: 'rotto', updateDate: date },
    ]);
    const now = new Date('2025-01-01T00:00:00Z');
    assert.equal(await repository.linkCard(principal, access, [empty, has, trashed, odd], 'LINK', now), 1);
    assert.deepEqual((await contacts().findOne({ _id: empty }))!['fidelities'], [{ code: 'LINK', points: 0 }]);
    assert.deepEqual((await contacts().findOne({ _id: has }))!['fidelities'], [{ code: 'LINK', points: 3 }]);
    assert.deepEqual((await contacts().findOne({ _id: has }))!['updateDate'], date);
    assert.deepEqual([(await contacts().findOne({ _id: empty }))!['updateDate']], [now]);
    assert.deepEqual((await repository.contactsByIds(principal, access, [hex(empty), hex(trashed), hex(new ObjectId())])).map((contact) => hex(contact['_id'] as ObjectId)), [hex(empty)]);
  });
});

describe('the service of the cards on a real database', () => {
  let ctx: TestDatabases;
  const groupId = new ObjectId();
  const principal = principalOf('SA', { groupId });
  let access: GroupAccess;
  const cards = () => ctx.databases.group(groupId, 'cluster0').collection('fidelity_cards');
  const type = { id: 't1', enabled: true, name: 'T', discountPercentage: 0, priceListId: null, prepaid: { enabled: true, type: 'multi', taxPercentage: null }, pointsCollect: { enabled: true, collectionIds: ['c1'] }, placeIds: [] };
  const collection = { id: 'c1', enabled: true, name: 'C', pointConversion: null, minAmount: null, dateFrom: null, dateTo: null, pointsExpirationDate: null, prizeCatalogueId: null };

  before(async () => {
    ctx = await openTestDatabases();
    access = (await accessFor(principal, groupId))!;
  });
  after(async () => ctx.cleanup());

  const build = (hooks: Hooks = {}, overrides: Partial<Parameters<typeof createCardsService>[0]> = {}) => {
    const log = memoryActivityLog();
    const service = createCardsService({
      repository: createCardsRepository(withHooks(ctx.databases, { group: hooks })),
      databases: ctx.databases,
      indexes: { ensure: async () => undefined },
      repositoriesOver: (databases) => ({ cards: createCardsRepository(withHooks(databases, { group: hooks })), contacts: createContactsRepository(databases) }),
      contacts: createContactsRepository(ctx.databases),
      catalogs: { list: async (catalog) => (catalog.name === 'cardType' ? [type] : [collection]) },
      activityLog: log,
      versionKey: key,
      now: () => Date.parse('2026-06-01T00:00:00Z'),
      ...overrides,
    });
    return { service, log };
  };

  it('records what it does with no address of the client', async () => {
    const { service, log } = build();
    const created = await service.create(principal, access, { code: 'NOIP', cardTypeId: 't1', initialBalance: 2 }, client);
    const id = ObjectId.createFromHexString(created.entity.id);
    await service.adjust(principal, access, id, { balanceDelta: 1 }, client);
    const updated = await service.update(principal, access, id, created.version, { enabled: false }, client);
    await service.remove(principal, access, id, updated.version, client).catch((error: unknown) => assert.ok(reject('CONFLICT')(error)));
    assert.ok(log.entries.length >= 3 && log.entries.every((entry) => entry.ip === undefined));
  });

  it('writes a card, its movements and its contacts, or an adjustment and its movements, all or nothing', async () => {
    const contact = new ObjectId();
    await ctx.databases.group(groupId, 'cluster0').collection('contacts').insertOne({ _id: contact, fidelities: [], updateDate: new Date(0) });
    const failing = build({ fidelity_cards_movements: { insertMany: () => Promise.reject(new Error('disk full')) } });
    await assert.rejects(failing.service.create(principal, access, { code: 'ALLNONE', cardTypeId: 't1', initialBalance: 2, contactIds: [hex(contact)] }, client), /disk full/);
    assert.equal(await cards().countDocuments({ code: 'ALLNONE' }), 0);
    assert.deepEqual((await ctx.databases.group(groupId, 'cluster0').collection('contacts').findOne({ _id: contact }))!['fidelities'], []);
    assert.equal(failing.log.entries.length, 0);
    const id = new ObjectId();
    await cards().insertOne({ _id: id, code: 'UNDO', cardTypeId: 't1', status: true, balance: new Double(10), pointsCollections: { c1: 5 }, insertDate: new Date(), updateDate: new Date() });
    await assert.rejects(failing.service.adjust(principal, access, id, { balanceDelta: 3, pointsDeltas: [{ collectionId: 'c1', delta: -2 }] }, client), /disk full/);
    const back = (await cards().findOne({ _id: id }))!;
    assert.deepEqual([back['balance'] as number, (back['pointsCollections'] as Document)['c1']], [10, 5]);
    assert.equal(failing.log.entries.length, 0);
  });

  it('runs the work again on a transient error of the transaction, and writes the card once', async () => {
    let attempts = 0;
    const transient = new MongoServerError({ message: 'try again', code: 112 });
    transient.addErrorLabel('TransientTransactionError');
    const { service } = build({
      fidelity_cards_movements: {
        insertMany: async (run) => {
          attempts += 1;
          if (attempts === 1) {
            throw transient;
          }
          return run();
        },
      },
    });
    const created = await service.create(principal, access, { code: 'RETRY', cardTypeId: 't1', initialBalance: 4 }, client);
    assert.equal(attempts, 2);
    assert.equal(await cards().countDocuments({ code: 'RETRY' }), 1);
    assert.equal(await ctx.databases.group(groupId, 'cluster0').collection('fidelity_cards_movements').countDocuments({ cardCode: 'RETRY' }), 1);
    assert.equal(created.entity.balance, 4);
  });

  it('answers 409 when the card changed between the read and the write of a modification, and 404 when it went during a refused adjustment', async () => {
    const id = new ObjectId();
    await cards().insertOne({ _id: id, code: 'RACE', cardTypeId: 't1', status: true, balance: new Double(1), pointsCollections: {}, insertDate: new Date(), updateDate: new Date('2024-01-01T00:00:00Z') });
    const { service } = build({ fidelity_cards: { updateOne: async (run) => (await cards().updateOne({ _id: id }, { $set: { updateDate: new Date('2030-01-01T00:00:00Z') } }), run()) } });
    const { cardVersion } = await import('../../src/modules/fidelity-cards/fidelity-cards.document.ts');
    await assert.rejects(service.update(principal, access, id, cardVersion((await cards().findOne({ _id: id }))!, key), { enabled: false }, client), reject('CONFLICT'));
    const gone = build({ fidelity_cards: { findOneAndUpdate: async () => (await cards().deleteOne({ _id: id }), null) } });
    await assert.rejects(gone.service.adjust(principal, access, id, { balanceDelta: -1 }, client), reject('NOT_FOUND'));
    // A refusal that no value explains (it changed back) is a plain 409.
    const other = new ObjectId();
    await cards().insertOne({ _id: other, code: 'FLIP', cardTypeId: 't1', status: true, balance: new Double(5), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    const flip = build({ fidelity_cards: { findOneAndUpdate: async () => null } });
    await assert.rejects(flip.service.adjust(principal, access, other, { balanceDelta: -1 }, client), (error: unknown) => reject('CONFLICT')(error) && (error as AppError).details === undefined);
    const removal = build({ fidelity_cards: { deleteOne: async (run) => (await cards().updateOne({ _id: other }, { $set: { updateDate: new Date('2031-01-01T00:00:00Z') } }), run()) } });
    const { cardVersion: version } = await import('../../src/modules/fidelity-cards/fidelity-cards.document.ts');
    await assert.rejects(removal.service.remove(principal, access, other, version((await cards().findOne({ _id: other }))!, key), client), reject('CONFLICT'));
  });

  it('reads everything an answer shows before the write: a failing read after the commit changes nothing, and the same key writes once', async () => {
    const id = new ObjectId();
    await cards().insertOne({ _id: id, code: 'B1', cardTypeId: 't1', status: true, balance: new Double(10), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    const real = createContactsRepository(ctx.databases);
    let reads = 0;
    const contacts = {
      ...real,
      cardHolders: async (...args: Parameters<typeof real.cardHolders>) => {
        reads += 1;
        if (reads > 1) {
          throw new Error('the contacts are not readable any more');
        }
        return real.cardHolders(...args);
      },
    };
    const { service } = build({}, { contacts });
    const answer = await service.adjust(principal, access, id, { balanceDelta: 2 }, client);
    assert.equal(answer.entity.balance, 12);
    assert.equal(reads, 1);
    assert.equal(num((await cards().findOne({ _id: id }))!['balance']), 12);
    reads = 1;
    const created = await build({}, { contacts }).service.create(principal, access, { code: 'B1-NEW', cardTypeId: 't1', initialBalance: 1 }, client).catch((error: unknown) => error);
    assert.ok(created instanceof Error);
    assert.equal(await cards().countDocuments({ code: 'B1-NEW' }), 0, 'a read that fails before the write writes nothing');
  });

  it('answers 409 when the type changed between the read and the adjustment, and when a sale gave a card credit while it was moved to a type that has none', async () => {
    const id = new ObjectId();
    await cards().insertOne({ _id: id, code: 'M2', cardTypeId: 't1', status: true, balance: new Double(10), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    const switching = build({ fidelity_cards: { findOneAndUpdate: async (run) => (await cards().updateOne({ _id: id }, { $set: { cardTypeId: 'altro' } }), run()) } });
    await assert.rejects(switching.service.adjust(principal, access, id, { balanceDelta: 1 }, client), (error: unknown) => reject('CONFLICT')(error) && (error as AppError).details === undefined);
    assert.equal(num((await cards().findOne({ _id: id }))!['balance']), 10);
    // Moved to a type without credit while a sale adds some: the write refuses it.
    const other = new ObjectId();
    await cards().insertOne({ _id: other, code: 'M3', cardTypeId: 't1', status: true, balance: new Double(0), pointsCollections: {}, insertDate: new Date(), updateDate: new Date('2024-01-01T00:00:00Z') });
    const unpaid = { ...type, id: 't2', prepaid: { ...type.prepaid, enabled: false } };
    const racing = build({ fidelity_cards: { updateOne: async (run) => (await cards().updateOne({ _id: other }, { $inc: { balance: 5 } }), run()) } }, { catalogs: { list: async (catalog) => (catalog.name === 'cardType' ? [type, unpaid] : [collection]) } });
    const { cardVersion } = await import('../../src/modules/fidelity-cards/fidelity-cards.document.ts');
    await assert.rejects(racing.service.update(principal, access, other, cardVersion((await cards().findOne({ _id: other }))!, key), { cardTypeId: 't2' }, client), reject('CONFLICT'));
    assert.equal((await cards().findOne({ _id: other }))!['cardTypeId'], 't1');
  });

  it('deletes a card only if the checks and the deletion see the same credit and points: a concurrent adjustment keeps it', async () => {
    const id = new ObjectId();
    await cards().insertOne({ _id: id, code: 'C2', cardTypeId: 't1', status: true, balance: new Double(0), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    let attempts = 0;
    const { service } = build({ fidelity_cards: { deleteOne: async (run) => ((attempts += 1), attempts === 1 ? await cards().updateOne({ _id: id }, { $inc: { balance: 2 } }) : undefined, run()) } });
    const { cardVersion } = await import('../../src/modules/fidelity-cards/fidelity-cards.document.ts');
    await assert.rejects(service.remove(principal, access, id, cardVersion((await cards().findOne({ _id: id }))!, key), client), reject('CONFLICT'));
    assert.equal(await cards().countDocuments({ _id: id }), 1);
  });

  it('creates the unique index of the legacy once per group, and logs, without a code, when it cannot', async () => {
    const logs = memoryLogger();
    const group = new ObjectId();
    const owner = principalOf('SA', { groupId: group });
    const groupAccess = (await accessFor(owner, group))!;
    const guard = createCardIndexGuard(ctx.databases, logs.logger);
    await Promise.all([guard.ensure(owner, groupAccess), guard.ensure(owner, groupAccess)]);
    await guard.ensure(owner, groupAccess);
    const index = (await ctx.databases.group(group, 'cluster0').collection('fidelity_cards').indexes()).find((entry) => entry.name === 'code_1')!;
    assert.deepEqual([index.key, index.unique], [{ code: 1 }, true]);
    assert.equal(logs.events.length, 0);
    // A group that already has two cards with the same code keeps working (the check of the code stays), and the failure is in the log with the group only.
    const clash = new ObjectId();
    const clashPrincipal = principalOf('SA', { groupId: clash });
    const clashAccess = (await accessFor(clashPrincipal, clash))!;
    await ctx.databases.group(clash, 'cluster0').collection('fidelity_cards').insertMany([{ code: 'SECRET-CODE' }, { code: 'SECRET-CODE' }]);
    const failing = memoryLogger();
    const clashGuard = createCardIndexGuard(ctx.databases, failing.logger);
    await clashGuard.ensure(clashPrincipal, clashAccess);
    await clashGuard.ensure(clashPrincipal, clashAccess);
    const errors = failing.events.filter((event) => event['level'] === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!['groupId'], hex(clash));
    assert.ok(!JSON.stringify(failing.events).includes('SECRET-CODE'));
    const quiet = memoryLogger();
    await createCardCodeIndex(ctx.databases.group(group, 'cluster0'), group, quiet.logger);
    assert.equal(quiet.events.length, 0);
    const odd = memoryLogger();
    await createCardCodeIndex({ collection: () => ({ createIndex: () => Promise.reject('plain text') }) } as never, group, odd.logger);
    assert.equal(odd.events.filter((event) => event['level'] === 'error')[0]!['errorCode'], null);
  });
});
