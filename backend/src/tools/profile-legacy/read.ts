import type { Collection, Db, Document, Filter } from 'mongodb';

/** Documents fetched per round trip. */
export const BATCH_SIZE = 500;

/** Time limit of every read operation, in milliseconds. */
export const MAX_TIME_MS = 120_000;

/**
 * Streams the documents of a collection through a cursor, one batch at a time. Documents are
 * deserialized with `promoteValues: false` so that numeric BSON types stay distinguishable.
 * Read-only: the only driver call is `find`.
 *
 * @param collection Collection to read.
 * @param filter Filter written by this tool, never by a client.
 * @param projection Fields to return.
 * @returns The documents, lazily.
 */
export async function* streamDocuments(
  collection: Collection,
  filter: Filter<Document>,
  projection: Document,
): AsyncGenerator<Document> {
  const cursor = collection.find(filter, {
    projection,
    batchSize: BATCH_SIZE,
    maxTimeMS: MAX_TIME_MS,
    promoteValues: false,
  });
  for await (const document of cursor) {
    yield document;
  }
}

/**
 * Tells whether a collection exists (a missing collection is a normal situation in legacy databases).
 *
 * @param db Database to look in.
 * @param name Collection name.
 * @returns `true` if it exists.
 */
export async function hasCollection(db: Db, name: string): Promise<boolean> {
  const found = await db.listCollections({ name }, { nameOnly: true, maxTimeMS: MAX_TIME_MS }).toArray();
  return found.length > 0;
}
