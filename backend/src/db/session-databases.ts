import type { ClientSession, Collection, Db, Document, ObjectId } from 'mongodb';
import { groupDatabaseFor } from '../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../shared/security/scope/principal.ts';
import type { Databases } from './databases.ts';

/** Options of every transaction: a consistent snapshot for the reads and a majority acknowledgement for the commit. */
const TRANSACTION_OPTIONS = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } } as const;

/** The position of the `options` argument of each collection operation a group repository may use: the session is added there. */
const OPTIONS_INDEX: Readonly<Record<string, number>> = Object.freeze({
  find: 1,
  findOne: 1,
  aggregate: 1,
  countDocuments: 1,
  deleteOne: 1,
  deleteMany: 1,
  insertOne: 1,
  insertMany: 1,
  bulkWrite: 1,
  updateOne: 2,
  updateMany: 2,
  replaceOne: 2,
  findOneAndUpdate: 2,
  distinct: 2,
});

/** A collection whose every operation runs in a session; an operation that is not in the table is refused, so nothing can ever bypass the session by accident. */
function boundCollection(collection: Collection<Document>, session: ClientSession): Collection<Document> {
  return new Proxy(collection, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const index = typeof property === 'string' ? OPTIONS_INDEX[property] : undefined;
      if (index === undefined) {
        throw new Error(`The collection operation ${String(property)} cannot run in a session`);
      }
      return (...args: unknown[]) => {
        for (let position = 0; position < index; position += 1) {
          args[position] ??= {};
        }
        args[index] = { ...(args[index] as Document | undefined), session };
        return (value as (...call: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** A database whose collections run every operation in a session. */
function boundDb(db: Db, session: ClientSession): Db {
  return new Proxy(db, {
    get: (target, property) => {
      if (property === 'collection') {
        return (name: string) => boundCollection(target.collection(name), session);
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value === 'function') {
        throw new Error(`The database operation ${String(property)} cannot run in a session`);
      }
      return value;
    },
  });
}

/**
 * The database accessor of a transaction: the same as `databases`, except that every operation on the database of a group runs in the given session (the common database is left alone: it is on
 * another cluster in general and a transaction never spans two). The repositories built over it make their reads and writes part of the transaction without knowing it.
 *
 * @param databases The database accessor.
 * @param session The session that holds the transaction.
 * @param groupId The group the transaction was opened for (the one of the verified access): the database of any other group is refused.
 * @returns The accessor to build the repositories of the transaction over.
 */
export function sessionDatabases(databases: Databases, session: ClientSession, groupId: ObjectId): Databases {
  return {
    ...databases,
    group: (requested, clusterId) => {
      if (!requested.equals(groupId)) {
        throw new Error('A transaction reaches only the group it was opened for');
      }
      return boundDb(databases.group(requested, clusterId), session);
    },
  };
}

/**
 * Runs `work` in a transaction on the **cluster of a group** (not the common cluster: every write of the work is in the group database), from the verified access. The session is the one the repositories
 * built over {@link sessionDatabases} write in. The driver retries `work` on a transient error, so `work` must be repeatable; whatever it throws aborts the transaction and is rethrown.
 *
 * @param principal The authenticated caller.
 * @param access The verified group access.
 * @param databases Database accessor.
 * @param work The work.
 * @returns What `work` returns.
 */
export function inGroupTransaction<T>(principal: ScopeHolder, access: GroupAccess, databases: Databases, work: (session: ClientSession) => Promise<T>): Promise<T> {
  return groupDatabaseFor(principal, access, databases).client.withSession((session) => session.withTransaction(() => work(session), TRANSACTION_OPTIONS));
}
