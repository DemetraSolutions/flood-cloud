import type { Db, ObjectId } from 'mongodb';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { minimalCompany, toNewDocument } from '../../modules/dealers/dealer.mapper.ts';

/** Largest company name the dealer registry accepts. */
const MAX_BUSINESS_NAME = 200;

/** Users read from the cursor per round trip. */
const BATCH_SIZE = 100;

/** Counts only: the report never carries a user name or an id. */
export interface MigrationReport {
  /** Users with role `D`, trashed ones included. */
  readonly dealerUsers: number;
  /** Dealer users that already had a document in `dealers`. */
  readonly alreadyPresent: number;
  /** Documents written (`apply`) or that would be written (dry run). */
  readonly created: number;
  /** Users whose document could not be written. */
  readonly errors: number;
}

/** Options of {@link migrateDealers}. */
export interface MigrationOptions {
  /** `true` writes; `false` only counts. */
  readonly apply: boolean;
  /** Clock for `createdAt` and `updatedAt`. */
  readonly now: () => Date;
  /** Called with the error name (never the message, which may echo data) of each failed write. */
  readonly onError: (errorName: string) => void;
}

/** The company name a migrated dealer gets: the user name, or a name made of the end of the id when the user has none. */
function businessNameOf(user: Readonly<Record<string, unknown>>, id: ObjectId): string {
  for (const candidate of [user['userName'], user['username']]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim().slice(0, MAX_BUSINESS_NAME);
    }
  }
  return `dealer-${id.toHexString().slice(-6)}`;
}

/**
 * Gives every existing dealer (a user with role `D`) its document in `common.dealers` (D-09): the company
 * name is the user name, the other fields are empty, and the owner completes them. The document has the
 * user's `_id`, so `groups.dealerId` stays valid. The write is an upsert with `$setOnInsert`: running it
 * again changes nothing. The only collection written is `dealers`; `users` is only read and `groups` is not touched.
 *
 * @param db The common database.
 * @param options Mode, clock and error callback.
 * @returns The counts.
 */
export async function migrateDealers(db: Db, options: MigrationOptions): Promise<MigrationReport> {
  const users = db.collection('users');
  const dealers = db.collection('dealers');
  let dealerUsers = 0;
  let alreadyPresent = 0;
  let created = 0;
  let errors = 0;
  const cursor = users.find({ role: 'D' }, { projection: { userName: 1, username: 1 }, batchSize: BATCH_SIZE, maxTimeMS: LIST_MAX_TIME_MS });
  for await (const user of cursor) {
    dealerUsers += 1;
    const id = user['_id'] as ObjectId;
    try {
      if (!options.apply) {
        const present = (await dealers.findOne({ _id: id }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null;
        alreadyPresent += present ? 1 : 0;
        created += present ? 0 : 1;
        continue;
      }
      const { _id, ...fields } = toNewDocument(id, minimalCompany(businessNameOf(user, id)), 'migration', null, options.now());
      const result = await dealers.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
      alreadyPresent += result.upsertedCount === 1 ? 0 : 1;
      created += result.upsertedCount;
    } catch (error) {
      errors += 1;
      options.onError(error instanceof Error ? error.name : typeof error);
    }
  }
  return { dealerUsers, alreadyPresent, created, errors };
}
