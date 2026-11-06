import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { startBackoffice } from './backoffice.ts';
import type { Backoffice } from './backoffice.ts';
import { openTestDatabases, TEST_CLUSTER } from './mongo.ts';
import type { TestDatabases } from './mongo.ts';
import { actors } from './users.ts';

/** A running backoffice over throw-away databases, for the tests of the catalogs kept in the group document. */
export interface CatalogOffice {
  readonly ctx: TestDatabases;
  readonly office: Backoffice;
  readonly as: ReturnType<typeof actors>;
  /** Group `index` of the isolation cluster (0 and 1 belong to dealer A, 2 and 3 to dealer B). */
  group(index: number): Backoffice['cluster']['groups'][number];
  /** `/groups/{id}{rest}` of the group `index`. */
  path(index: number, rest?: string): string;
  /** The stored document of the group `index`. */
  stored(index: number): Promise<Document>;
  /** `$set`s some fields of the stored group document. */
  set(index: number, fields: Document): Promise<void>;
  /** Inserts documents in a collection of the database of the group `index`. */
  insertInGroup(index: number, collection: string, documents: Document[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the databases and starts the backoffice with the real modules.
 *
 * @returns The office with its helpers; `close` stops everything.
 */
export async function openCatalogOffice(): Promise<CatalogOffice> {
  const ctx = await openTestDatabases();
  const office = await startBackoffice(ctx);
  const group = (index: number) => office.cluster.groups[index]!;
  const groups = () => ctx.databases.common().collection('groups');
  return {
    ctx,
    office,
    as: actors(office),
    group,
    path: (index, rest = '') => `/groups/${group(index).groupId.toHexString()}${rest}`,
    stored: async (index) => (await groups().findOne({ _id: group(index).groupId }))!,
    set: async (index, fields) => void (await groups().updateOne({ _id: group(index).groupId }, { $set: fields })),
    insertInGroup: async (index, collection, documents) => void (await ctx.databases.group(group(index).groupId, TEST_CLUSTER).collection(collection).insertMany(documents)),
    close: async () => {
      await office.close();
      await ctx.cleanup();
    },
  };
}

/** A new `ObjectId` and its hexadecimal form. */
export function newHex(): { id: ObjectId; hex: string } {
  const id = new ObjectId();
  return { id, hex: id.toHexString() };
}
