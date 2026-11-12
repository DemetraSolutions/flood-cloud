import { ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, ClientSession, Collection, Document } from 'mongodb';
import { documentSize, expectedCopy, hasCorrectGroupId, sameDocument } from './documents.ts';
import type { IssueKind, IssueSink, SyncCollection } from './issues.ts';
import { mergeById } from './merge.ts';
import type { WithObjectId } from './merge.ts';

/** Documents per block of repairs. */
export const BLOCK_DOCUMENTS = 200;

/** BSON bytes (about) per block of repairs: the block is closed when it reaches this size even if it has fewer documents. */
export const BLOCK_BYTES = 8 * 1024 * 1024;

/** Limits of a block of repairs. */
export interface BlockLimits {
  readonly documents: number;
  readonly bytes: number;
}

/** The default {@link BlockLimits}. */
export const DEFAULT_BLOCK_LIMITS: BlockLimits = Object.freeze({ documents: BLOCK_DOCUMENTS, bytes: BLOCK_BYTES });

/** Counters of one collection, over one group or the whole run. */
export interface CollectionStats {
  /** Documents with an ObjectId `_id` in the group database. */
  originals: number;
  /** Copies in the common database. */
  copies: number;
  missing: number;
  different: number;
  extra: number;
  /** Differences fixed by this run (always 0 in a dry run). */
  repaired: number;
}

/** Creates counters at zero. */
export function emptyStats(): CollectionStats {
  return { originals: 0, copies: 0, missing: 0, different: 0, extra: 0, repaired: 0 };
}

/**
 * Runs the writes of one block. Only replica sets are supported. For a group on the common cluster it is a transaction
 * (the driver retries on a write conflict, so a concurrent write of the legacy is never overwritten by stale data); for a
 * group on another cluster (`doc/Tasks.md` D-25) there is no transaction across clusters: `work` just runs without a session.
 */
export type BlockRunner = (work: (session: ClientSession | undefined) => Promise<void>) => Promise<void>;

/** Everything {@link reconcileCollection} needs besides the two collections. */
export interface ReconcileEnv {
  /** Group derived from the name of the database the originals were read from. */
  readonly groupId: ObjectId;
  /** When false nothing is written. */
  readonly apply: boolean;
  readonly limits: BlockLimits;
  readonly sink: IssueSink;
  readonly runBlock: BlockRunner;
}

/** A copied collection: the original in the group database and its mirror in the common database. */
export interface CopyTarget {
  readonly name: SyncCollection;
  readonly original: Collection<Document>;
  readonly copy: Collection<Document>;
}

/** A difference found by the comparison, waiting for its block to be settled. */
interface Pending {
  readonly id: ObjectId;
}

const OBJECT_ID_ONLY = { _id: { $type: 'objectId' } } as const;

/**
 * Read options that keep the BSON numeric types as they are stored (`Double`, `Int32`, `Long` wrappers instead of JS
 * numbers): without them a whole-number double would be written back as an int32 and the copy would not be an exact
 * mirror. The copy block of the legacy must read with the same options, or every comparison would find a difference.
 */
export const EXACT_TYPES = Object.freeze({ promoteValues: false, promoteLongs: false, bsonRegExp: true });

/** What a block did to one id: the kind seen at write time (the copy may have changed since the comparison). */
interface Written {
  readonly id: ObjectId;
  readonly kind: 'missingCopy' | 'differentCopy' | 'idCollision';
}

/**
 * Settles a block: in one transaction (when the runner makes one) re-reads the originals of the ids from the group
 * database and the copies of the group, and upserts each original that still exists with `replaceOne` (whole document,
 * `groupId` forced). An id whose original is gone is skipped (the command never deletes), as is one whose copy is already
 * identical. An id that the copy of **another** group already uses is not written and is returned as `idCollision`.
 * Reading inside the transaction is what makes a concurrent write conflict instead of being overwritten by the older data
 * seen by the comparison. The writes are filtered by `groupId` as well.
 *
 * @returns What was written (or refused), with the kind seen now: missing or different.
 */
async function settle(target: CopyTarget, env: ReconcileEnv, ids: readonly ObjectId[]): Promise<Written[]> {
  let written: Written[] = [];
  await env.runBlock(async (session) => {
    written = [];
    const options = session === undefined ? { ...EXACT_TYPES } : { ...EXACT_TYPES, session };
    const plain = session === undefined ? {} : { session };
    const wanted = [...ids];
    const originals = await target.original.find({ _id: { $in: wanted } }, options).toArray();
    const mine = await target.copy.find({ _id: { $in: wanted }, groupId: env.groupId }, options).toArray();
    const foreign = await target.copy.find({ _id: { $in: wanted }, groupId: { $ne: env.groupId } }, { projection: { _id: 1 }, ...plain }).toArray();
    const copyOf = new Map(mine.map((document) => [(document._id as ObjectId).toHexString(), document]));
    const taken = new Set(foreign.map((document) => (document._id as ObjectId).toHexString()));
    const operations: Array<AnyBulkWriteOperation<Document>> = [];
    for (const original of originals) {
      const id = original._id as ObjectId;
      const hex = id.toHexString();
      if (taken.has(hex)) {
        written.push({ id, kind: 'idCollision' });
        continue;
      }
      const expected = expectedCopy(original, env.groupId);
      const existing = copyOf.get(hex);
      if (existing !== undefined && sameDocument(expected, existing)) {
        continue;
      }
      written.push({ id, kind: existing === undefined ? 'missingCopy' : 'differentCopy' });
      operations.push({ replaceOne: { filter: { _id: id, groupId: env.groupId }, replacement: expected, upsert: true } });
    }
    if (operations.length > 0) {
      await target.copy.bulkWrite(operations, { ordered: false, ...plain });
    }
  });
  return written;
}

/**
 * Compares the originals of one group collection with their copies and, with `apply`, writes the missing and different
 * copies. Copies without an original (`extraCopy`) are only counted and reported: nothing is ever deleted.
 *
 * Both sides are read through cursors sorted by `_id` and merged, so memory holds one document per side plus one block
 * of at most {@link BlockLimits} (documents and bytes). Documents whose `_id` is not an ObjectId are skipped and
 * reported (`nonObjectId`). A `groupId` of the original that is not the group of the database is reported
 * (`groupIdMismatch`) and the copy is made with the right one. The caller's `stats` is updated in place, so the
 * counters survive an error.
 *
 * @param target The two collections.
 * @param env Group, mode, limits, issue sink and block runner.
 * @param stats Counters to update.
 * @throws Whatever the driver throws (the caller decides what a failed group means).
 */
export async function reconcileCollection(target: CopyTarget, env: ReconcileEnv, stats: CollectionStats): Promise<void> {
  const { groupId, sink } = env;
  const issue = (kind: IssueKind, documentId: ObjectId | null, repaired: boolean) => sink.record({ kind, collection: target.name, groupId, documentId, repaired });

  for await (const _skipped of target.original.find({ _id: { $not: { $type: 'objectId' } } }, { projection: { _id: 1 } })) {
    await issue('nonObjectId', null, false);
  }

  let block: Pending[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (block.length === 0) {
      return;
    }
    const done = block;
    block = [];
    bytes = 0;
    for (const { id, kind } of await settle(target, env, done.map(({ id }) => id))) {
      if (kind !== 'idCollision') {
        stats.repaired += 1;
      }
      await issue(kind, id, kind !== 'idCollision');
    }
  };

  const originals = target.original.find(OBJECT_ID_ONLY, { ...EXACT_TYPES }).sort({ _id: 1 }) as AsyncIterable<WithObjectId & Document>;
  const copies = target.copy.find({ groupId, ...OBJECT_ID_ONLY }, { allowDiskUse: true, ...EXACT_TYPES }).sort({ _id: 1 }) as AsyncIterable<WithObjectId & Document>;
  for await (const { original, copy } of mergeById(originals, copies)) {
    let kind: 'missingCopy' | 'differentCopy' | null = null;
    if (original !== null) {
      stats.originals += 1;
      if (!hasCorrectGroupId(original, groupId)) {
        await issue('groupIdMismatch', original._id, false);
      }
    }
    if (copy !== null) {
      stats.copies += 1;
    }
    if (original !== null && copy === null) {
      stats.missing += 1;
      kind = 'missingCopy';
    } else if (original === null && copy !== null) {
      stats.extra += 1;
      await issue('extraCopy', copy._id, false);
    } else if (original !== null && copy !== null && !sameDocument(expectedCopy(original, groupId), copy)) {
      stats.different += 1;
      kind = 'differentCopy';
    }
    if (kind === null) {
      continue;
    }
    const id = (original as WithObjectId)._id;
    if (!env.apply) {
      await issue(kind, id, false);
      continue;
    }
    block.push({ id });
    bytes += documentSize(original as Document);
    if (block.length >= env.limits.documents || bytes >= env.limits.bytes) {
      await flush();
    }
  }
  await flush();
}

/**
 * Reports (without changing anything) the places of a group whose `companyId` is absent, not an ObjectId or not the
 * `_id` of a company of the same group database. Places are read in blocks and the companies of each block are looked up
 * by `_id`, so no set of companies is kept.
 *
 * @param places The `places` collection of the group database.
 * @param companies The `companies` collection of the group database.
 * @param groupId Group derived from the database name.
 * @param limits Documents per block (the byte limit does not apply: only two ids per place are read).
 * @param sink Receives one `orphanCompany` per place.
 */
export async function reportOrphanPlaces(places: Collection<Document>, companies: Collection<Document>, groupId: ObjectId, limits: BlockLimits, sink: IssueSink): Promise<void> {
  let block: Array<{ id: ObjectId; companyId: unknown }> = [];
  const check = async (): Promise<void> => {
    const wanted = block.flatMap(({ companyId }) => (companyId instanceof ObjectId ? [companyId] : []));
    const existing = new Set<string>();
    if (wanted.length > 0) {
      for (const company of await companies.find({ _id: { $in: wanted } }, { projection: { _id: 1 } }).toArray()) {
        existing.add((company._id as ObjectId).toHexString());
      }
    }
    for (const { id, companyId } of block) {
      if (!(companyId instanceof ObjectId) || !existing.has(companyId.toHexString())) {
        await sink.record({ kind: 'orphanCompany', collection: 'places', groupId, documentId: id, repaired: false });
      }
    }
    block = [];
  };
  for await (const place of places.find(OBJECT_ID_ONLY, { projection: { _id: 1, companyId: 1 } }).sort({ _id: 1 })) {
    block.push({ id: place._id as ObjectId, companyId: place['companyId'] });
    if (block.length >= limits.documents) {
      await check();
    }
  }
  await check();
}
