import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';
import { inGroupTransaction, sessionDatabases } from '../../src/db/session-databases.ts';

type Call = { operation: string; args: unknown[] };

const SESSION = { id: 'session-under-test' } as unknown as ClientSession;
const OTHER_SESSION = { id: 'another-session' } as unknown as ClientSession;
const SYMBOL_METHOD = Symbol('method');

/** The operations of the table and the position of their options. */
const TABLE: ReadonlyArray<readonly [string, number]> = [
  ['find', 1],
  ['findOne', 1],
  ['aggregate', 1],
  ['countDocuments', 1],
  ['deleteOne', 1],
  ['deleteMany', 1],
  ['insertOne', 1],
  ['insertMany', 1],
  ['bulkWrite', 1],
  ['updateOne', 2],
  ['updateMany', 2],
  ['replaceOne', 2],
  ['findOneAndUpdate', 2],
  ['distinct', 2],
];

/** A fake collection that records every call, with a method that is not in the table and a symbol method. */
function fakeCollection(calls: Call[]): Record<string | symbol, unknown> {
  const collection: Record<string | symbol, unknown> = { collectionName: 'things', note: 7 };
  for (const [operation] of TABLE) {
    collection[operation] = function (this: unknown, ...args: unknown[]) {
      calls.push({ operation, args });
      assert.equal(this, collection, 'the operation runs on the real collection');
      return `result of ${operation}`;
    };
  }
  collection['drop'] = () => 'dropped';
  collection[SYMBOL_METHOD] = () => 'symbol';
  return collection;
}

/** A fake database with a collection factory, one more function and plain properties. */
function fakeDb(calls: Call[], names: string[]): Record<string, unknown> {
  return {
    databaseName: 'fake_db',
    collection: (name: string) => {
      names.push(name);
      return fakeCollection(calls);
    },
    listCollections: () => 'listed',
  };
}

function world() {
  const groupCalls: Call[] = [];
  const names: string[] = [];
  const commonCalls: Call[] = [];
  const groupDb = fakeDb(groupCalls, names);
  const commonDb = fakeDb(commonCalls, []);
  const groupArgs: unknown[][] = [];
  const databases = {
    clusterIds: ['a'],
    commonCluster: 'a',
    marker: 'kept',
    common: () => commonDb,
    group: (...args: unknown[]) => {
      groupArgs.push(args);
      return groupDb;
    },
  } as unknown as Databases;
  return { databases, groupCalls, names, commonCalls, commonDb, groupDb, groupArgs };
}

// The collections are proxies built over fakes: reach them through `any` in the tests.
const collectionOf = (databases: Databases, name = 'things'): any => databases.group(GROUP, 'a' as never).collection(name);

const GROUP = new ObjectId();

describe('sessionDatabases', () => {
  it('refuses the database of a group other than the one the transaction was opened for', () => {
    const { databases, groupArgs } = world();
    assert.throws(() => sessionDatabases(databases, SESSION, GROUP).group(new ObjectId(), 'a' as never), /only the group it was opened for/);
    assert.deepEqual(groupArgs, []);
  });

  it('adds the session to the options of every operation of the table, at the right position', () => {
    const { databases, groupCalls } = world();
    const bound = sessionDatabases(databases, SESSION, GROUP);
    const collection = collectionOf(bound);
    for (const [operation, index] of TABLE) {
      groupCalls.length = 0;
      const full = ['a', 'b', 'c'].slice(0, index);
      const result = collection[operation](...full, { limit: 3 });
      assert.equal(result, `result of ${operation}`);
      assert.equal(groupCalls.length, 1);
      assert.equal(groupCalls[0]!.operation, operation);
      assert.deepEqual(groupCalls[0]!.args, [...full, { limit: 3, session: SESSION }], operation);
    }
  });

  it('adds the options when there are none, and fills the arguments before them', () => {
    const { databases, groupCalls } = world();
    const collection = collectionOf(sessionDatabases(databases, SESSION, GROUP));
    for (const [operation, index] of TABLE) {
      groupCalls.length = 0;
      collection[operation]();
      const expected = Array.from({ length: index }, () => ({}));
      assert.deepEqual(groupCalls[0]!.args, [...expected, { session: SESSION }], `${operation} without arguments`);
    }
    groupCalls.length = 0;
    collection.updateOne({ _id: 1 });
    assert.deepEqual(groupCalls[0]!.args, [{ _id: 1 }, {}, { session: SESSION }]);
    groupCalls.length = 0;
    collection.find({ x: 1 });
    assert.deepEqual(groupCalls[0]!.args, [{ x: 1 }, { session: SESSION }]);
  });

  it('keeps the other options and replaces a session the caller gave, without touching the original options', () => {
    const { databases, groupCalls } = world();
    const collection = collectionOf(sessionDatabases(databases, SESSION, GROUP));
    const options = { upsert: true, session: OTHER_SESSION };
    collection.updateOne({ a: 1 }, { $set: { b: 2 } }, options);
    assert.deepEqual(groupCalls[0]!.args, [{ a: 1 }, { $set: { b: 2 } }, { upsert: true, session: SESSION }]);
    assert.equal(options.session, OTHER_SESSION);
  });

  it('refuses an operation that is not in the table, even before it is called', () => {
    const { databases } = world();
    const collection = collectionOf(sessionDatabases(databases, SESSION, GROUP));
    assert.throws(() => collection.drop, /The collection operation drop cannot run in a session/);
    assert.throws(() => collection[SYMBOL_METHOD], /The collection operation Symbol\(method\) cannot run in a session/);
  });

  it('lets a property that is not a function through', () => {
    const { databases } = world();
    const collection = collectionOf(sessionDatabases(databases, SESSION, GROUP));
    assert.equal(collection.collectionName, 'things');
    assert.equal(collection.note, 7);
  });

  it('opens the collection of the group by name, on the database of the group', () => {
    const { databases, names, groupArgs } = world();
    const groupId = GROUP;
    const collection = sessionDatabases(databases, SESSION, GROUP).group(groupId, 'a' as never).collection('products');
    assert.deepEqual(names, ['products']);
    assert.deepEqual(groupArgs, [[groupId, 'a']]);
    assert.equal(typeof collection.find, 'function');
  });

  it('allows `collection` only: every other function of the database throws, the properties pass', () => {
    const { databases } = world();
    const db: any = sessionDatabases(databases, SESSION, GROUP).group(GROUP, 'a' as never);
    assert.equal(db.databaseName, 'fake_db');
    assert.throws(() => db.listCollections, /The database operation listCollections cannot run in a session/);
    assert.throws(() => db.nothingHere(), /TypeError|not a function/);
  });

  it('leaves the common database and the other keys of the accessor alone', () => {
    const { databases, commonCalls, commonDb } = world();
    const bound: any = sessionDatabases(databases, SESSION, GROUP);
    assert.equal(bound.common(), commonDb);
    assert.equal(bound.marker, 'kept');
    assert.deepEqual(bound.clusterIds, ['a']);
    assert.equal(bound.commonCluster, 'a');
    bound.common().collection('users').find({ a: 1 });
    assert.deepEqual(commonCalls, [{ operation: 'find', args: [{ a: 1 }] }]);
  });
});

describe('inGroupTransaction', () => {
  const groupId = new ObjectId();
  const sa = principalOf('SA', { groupId });

  /** Databases whose group database has a client that runs the transaction callback on a fake session. */
  function transactional() {
    const seen: { options: unknown; groupArgs: unknown[]; commits: number } = { options: undefined, groupArgs: [], commits: 0 };
    const session = {
      withTransaction: async (work: () => Promise<unknown>, options: unknown) => {
        seen.options = options;
        const result = await work();
        seen.commits += 1;
        return result;
      },
    };
    const databases = {
      group: (...args: unknown[]) => {
        seen.groupArgs = args;
        return { client: { withSession: (callback: (session: unknown) => Promise<unknown>) => callback(session) } };
      },
    } as unknown as Databases;
    return { databases, seen, session };
  }

  it('runs the work in a transaction with snapshot reads and majority writes, on the cluster of the group, and returns its result', async () => {
    const { databases, seen, session } = transactional();
    const access = (await accessFor(sa, groupId, 'cluster1'))!;
    let received: unknown;
    const result = await inGroupTransaction(sa, access, databases, async (given) => {
      received = given;
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(received, session);
    assert.deepEqual(seen.options, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    assert.deepEqual(seen.groupArgs, [groupId, 'cluster1']);
    assert.equal(seen.commits, 1);
  });

  it('propagates what the work throws, without committing', async () => {
    const { databases, seen } = transactional();
    const access = (await accessFor(sa, groupId))!;
    const boom = new Error('work failed');
    await assert.rejects(
      inGroupTransaction(sa, access, databases, async () => {
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.equal(seen.commits, 0);
  });

  it('refuses an access that was not verified, before opening any database', () => {
    const { databases, seen } = transactional();
    const forged = { groupId, clusterId: 'cluster0', crossGroup: false, features: {} } as never;
    assert.throws(() => inGroupTransaction(sa, forged, databases, async () => 1), /without a verified group access/);
    assert.deepEqual(seen.groupArgs, []);
  });
});
