import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { createSalesCustomerIndex, createSalesIndexGuard, SALES_CUSTOMER_INDEX, SALES_INDEX_RETRY_MS } from '../../src/modules/sales/sales.indexes.ts';
import { createSalesRepository } from '../../src/modules/sales/sales.repository.ts';
import { createSalesService } from '../../src/modules/sales/sales.service.ts';
import type { SalesRepository } from '../../src/modules/sales/sales.repository.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';

const hex = (id: ObjectId) => id.toHexString();
const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
const failing = (error: unknown) => ({ collection: () => ({ createIndex: () => Promise.reject(error) }) }) as never;

describe('the index of the purchases of a customer', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  it('is the one index this backend creates on the sales, not unique, named after its keys', () => {
    assert.deepEqual([SALES_CUSTOMER_INDEX.key, SALES_CUSTOMER_INDEX.options], [{ 'customer._id': 1, date: -1 }, { name: 'customer._id_1_date_-1' }]);
  });

  it('is created once per group and process, and a second creation next to it changes nothing and logs nothing', async () => {
    const logs = memoryLogger();
    const group = new ObjectId();
    const owner = principalOf('SA', { groupId: group });
    const access = (await accessFor(owner, group))!;
    let opened = 0;
    const counting = { ...ctx.databases, group: (...args: Parameters<typeof ctx.databases.group>) => ((opened += 1), ctx.databases.group(...args)) } as typeof ctx.databases;
    const guard = createSalesIndexGuard(counting, logs.logger);
    await Promise.all([guard.ensure(owner, access), guard.ensure(owner, access)]);
    await guard.ensure(owner, access);
    assert.equal(opened, 1);
    const sales = ctx.databases.group(group, 'cluster0').collection('sales');
    assert.deepEqual((await sales.indexes()).map((index) => index.name), ['_id_', 'customer._id_1_date_-1']);
    // Another process (a new guard) finds it there and says nothing.
    await createSalesIndexGuard(ctx.databases, logs.logger).ensure(owner, access);
    await createSalesCustomerIndex(ctx.databases.group(group, 'cluster0'), group, logs.logger);
    assert.equal(logs.events.length, 0);
    assert.equal((await sales.indexes()).length, 2);
    // Another group is checked on its own.
    const other = new ObjectId();
    const otherOwner = principalOf('SA', { groupId: other });
    await guard.ensure(otherOwner, (await accessFor(otherOwner, other))!);
    assert.equal(opened, 2);
  });

  it('says in the log, as information, that an index with the same keys under another name is there, and goes on', async () => {
    const group = new ObjectId();
    const sales = ctx.databases.group(group, 'cluster0').collection('sales');
    await sales.createIndex({ 'customer._id': 1, date: -1 }, { name: 'made_by_an_administrator' });
    const logs = memoryLogger();
    await createSalesCustomerIndex(ctx.databases.group(group, 'cluster0'), group, logs.logger);
    assert.deepEqual(logs.events.map((event) => [event['level'], event['groupId'], event['errorCode']]), [['info', hex(group), 85]]);
    assert.equal((await sales.indexes()).length, 2);
  });

  it('tries again after at least ten minutes when the creation failed, and never when it worked or was there already', async () => {
    const group = new ObjectId();
    const owner = principalOf('SA', { groupId: group });
    const access = (await accessFor(owner, group))!;
    let attempts = 0;
    let outcome: unknown = new MongoServerError({ message: 'no', code: 13, codeName: 'Unauthorized' });
    const databases = { ...ctx.databases, group: () => ({ collection: () => ({ createIndex: () => ((attempts += 1), outcome === null ? Promise.resolve('ok') : Promise.reject(outcome)) }) }) } as unknown as typeof ctx.databases;
    let clock = 1000;
    const logs = memoryLogger();
    const guard = createSalesIndexGuard(databases, logs.logger, () => clock);
    await Promise.all([guard.ensure(owner, access), guard.ensure(owner, access)]);
    assert.equal(attempts, 1);
    clock += SALES_INDEX_RETRY_MS - 1;
    await guard.ensure(owner, access);
    assert.equal(attempts, 1);
    clock += 1;
    await guard.ensure(owner, access);
    assert.equal(attempts, 2);
    // Still failing: waits again. Then it works, and is never tried again.
    clock += SALES_INDEX_RETRY_MS - 1;
    await guard.ensure(owner, access);
    assert.equal(attempts, 2);
    clock += 1;
    outcome = null;
    await guard.ensure(owner, access);
    assert.equal(attempts, 3);
    clock += 100 * SALES_INDEX_RETRY_MS;
    await guard.ensure(owner, access);
    assert.equal(attempts, 3);
    assert.equal(logs.events.filter((event) => event['level'] === 'error').length, 2);
    // An index that is there already is not a failure to retry.
    outcome = new MongoServerError({ message: 'conflict', code: 85, codeName: 'IndexOptionsConflict' });
    const there = createSalesIndexGuard(databases, memoryLogger().logger, () => clock);
    attempts = 0;
    await there.ensure(owner, access);
    clock += 100 * SALES_INDEX_RETRY_MS;
    await there.ensure(owner, access);
    assert.equal(attempts, 1);
  });

  it('logs an error with the group and the kind of failure, never the text of the server, and never fails', async () => {
    const group = new ObjectId();
    for (const [error, level, code] of [
      [new MongoServerError({ message: 'secret detail of the server', code: 13, codeName: 'Unauthorized' }), 'error', 13],
      [new MongoServerError({ message: 'a build is running', code: 68, codeName: 'IndexBuildAlreadyInProgress' }), 'info', 68],
      [new MongoServerError({ message: 'conflict', code: 85, codeName: 'IndexOptionsConflict' }), 'info', 85],
      ['plain text', 'error', null],
      [{ codeName: 5 }, 'error', null],
    ] as const) {
      const logs = memoryLogger();
      await createSalesCustomerIndex(failing(error), group, logs.logger);
      assert.deepEqual(logs.events.map((event) => [event['level'], event['groupId'], event['errorCode']]), [[level, hex(group), code]]);
      assert.ok(!logs.lines.join('').includes('secret detail'));
    }
  });
});

describe('the service of the sales over a repository that does not answer in time', () => {
  const groupId = new ObjectId();
  const principal = principalOf('SA', { groupId });
  let access: GroupAccess;
  const indexes = { ensure: () => new Promise<void>(() => undefined) };
  const users = { findById: async () => null };
  const unreadable = (error: unknown): SalesRepository => ({ find: () => Promise.reject(error), totals: () => Promise.reject(error), findOne: () => Promise.reject(error), findInvoice: () => Promise.reject(error), operators: () => Promise.reject(error) });
  before(async () => {
    access = (await accessFor(principal, groupId))!;
  });

  it('does not wait for the index, and shows the names of the products in the first language when the user is gone', async () => {
    const sale: Document = { _id: new ObjectId(), date: new Date('2026-05-01T00:00:00Z'), products: [{ name: { fr: 'Pizza', it: 'Pizza it' }, qt: 1, price: { taxed: 3 } }] };
    const service = createSalesService({ repository: { find: async () => [sale], totals: async () => ({ count: 0, gross: 0, refunded: 0 }), findOne: async () => sale, findInvoice: async () => null, operators: async () => new Map() }, users, indexes });
    const contactId = new ObjectId();
    const page = await service.list(principal, access, { contactId });
    assert.equal(page.items.length, 1);
    assert.deepEqual(await service.summary(principal, access, { contactId }), { total: 0, count: 0, average: 0, refunded: 0 });
    assert.equal((await service.get(principal, access, sale['_id'] as ObjectId, 'exclude')).products[0]!.name, 'Pizza');
  });

  it('turns a read that exceeds its time limit into 503, never into an empty answer', async () => {
    const service = createSalesService({ repository: unreadable(expired), users, indexes });
    const contactId = new ObjectId();
    for (const read of [() => service.list(principal, access, { contactId }), () => service.summary(principal, access, { contactId }), () => service.get(principal, access, new ObjectId(), 'exclude')]) {
      await assert.rejects(read(), (error: unknown) => error === expired);
    }
    // The real repository maps the limit to the error of the API.
    const real = createSalesRepository({ ...ctxless(expired) } as never);
    await assert.rejects(real.find(principal, access, {}, 1), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(real.totals(principal, access, {}), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(real.findOne(principal, access, {}), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(real.findInvoice(principal, access, {}), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(real.operators(access, [new ObjectId()]), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    assert.deepEqual([...(await real.operators(access, []))], []);
  });
});

/** A `Databases` whose every read fails with the given error, as a read that exceeds its limit does. */
function ctxless(error: unknown) {
  const reads = {
    find: () => ({ toArray: () => Promise.reject(error) }),
    aggregate: () => ({ toArray: () => Promise.reject(error) }),
    findOne: () => Promise.reject(error),
  };
  const db = { collection: () => reads };
  return { group: () => db, common: () => db };
}
