import type { Document, ObjectId } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';

/**
 * Inserts documents in the copies of the common database (`common.companies`, `common.places`), the only place the
 * application reads companies and places from. `undefined` fields are dropped, so "missing" really is missing.
 *
 * @param databases Accessor over a throw-away prefix.
 * @param name The copy collection.
 * @param documents Complete documents, each with its own `groupId`.
 */
export async function insertCopies(databases: Databases, name: 'companies' | 'places', documents: readonly Document[]): Promise<void> {
  if (documents.length === 0) {
    return;
  }
  const clean = (document: Document): Document => Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
  await databases.common().collection(name).insertMany(documents.map(clean));
}

/**
 * Copies the companies and places stored in the group databases of some groups into the common copies, as the
 * `sync:copies` command would (documents as they are, `groupId` included).
 *
 * @param databases Accessor over a throw-away prefix.
 * @param groupIds Groups whose databases are copied.
 */
export async function copyGroupsToMirror(databases: Databases, groupIds: readonly ObjectId[]): Promise<void> {
  for (const groupId of groupIds) {
    const db = databases.group(groupId, databases.resolveGroupCluster({ _id: groupId }));
    for (const name of ['companies', 'places'] as const) {
      await insertCopies(databases, name, await db.collection(name).find({}).toArray());
    }
  }
}
