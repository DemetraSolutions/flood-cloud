import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';

/** The collections that are copied from the group databases to the common database. */
export const SYNC_COLLECTIONS = ['companies', 'places'] as const;

/** Name of a copied collection. */
export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

/**
 * Kinds of discrepancy written to `common.syncIssues`.
 *
 * - `missingCopy`: the copy does not exist. `differentCopy`: it differs from the expected document.
 * - `extraCopy`: a copy without original (counted only: the command never deletes). `groupIdMismatch`: the `groupId` of the original is absent, not an ObjectId or not the group of its database (the copy is made with the right one).
 * - `orphanCompany`: a place whose `companyId` is absent or not a company of the group (reported only).
 * - `databaseWithoutGroup`: a group database without a `groups` document (not copied). `unknownCluster`: the `dataCluster` of the group cannot be used (group skipped). `nonObjectId`: a document whose `_id` is not an ObjectId (skipped).
 * - `idCollision`: the `_id` of an original is already used by the copy of another group (not copied, ids only). `invalidCopy`: a copy whose `_id` or `groupId` is not an ObjectId (counted only).
 */
export const ISSUE_KINDS = ['missingCopy', 'differentCopy', 'extraCopy', 'groupIdMismatch', 'orphanCompany', 'databaseWithoutGroup', 'unknownCluster', 'nonObjectId', 'idCollision', 'invalidCopy'] as const;

/** One kind of discrepancy. */
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Number of discrepancies per kind. */
export type IssueCounts = Record<IssueKind, number>;

/** Creates counters at zero. */
export function emptyIssueCounts(): IssueCounts {
  return Object.fromEntries(ISSUE_KINDS.map((kind) => [kind, 0])) as IssueCounts;
}

/** A discrepancy: ids and kind only, never a value of the documents. */
export interface IssueInput {
  readonly kind: IssueKind;
  readonly collection: SyncCollection | null;
  readonly groupId: ObjectId | null;
  readonly documentId: ObjectId | null;
  /** Whether this run fixed the discrepancy. */
  readonly repaired: boolean;
}

/** Number of `syncIssues` documents inserted at once. */
export const ISSUE_BATCH_SIZE = 500;

/** Counts discrepancies and, when it has a collection, writes them to `syncIssues` in batches. */
export interface IssueSink {
  /** Counts one discrepancy and buffers its document (written when the buffer is full or on {@link IssueSink.flush}). */
  record(issue: IssueInput): Promise<void>;
  /** Writes the buffered documents. */
  flush(): Promise<void>;
  /** Counters of the whole run. */
  totals(): IssueCounts;
  /** Counters of one group (24 hex characters); zeros for an unknown group. */
  ofGroup(groupHex: string): IssueCounts;
  /** Groups (24 hex characters) that have at least one discrepancy. */
  groupHexes(): string[];
}

/**
 * Builds the sink of a run.
 *
 * @param collection `common.syncIssues` to write to, or `null` for a dry run (counts only, nothing is written).
 * @param runId Identifier shared by all the documents of the run.
 * @param now Clock for `detectedAt`.
 * @param batchSize Documents inserted per call.
 */
export function createIssueSink(collection: Collection<Document> | null, runId: ObjectId, now: () => Date, batchSize: number = ISSUE_BATCH_SIZE): IssueSink {
  const totals = emptyIssueCounts();
  const perGroup = new Map<string, IssueCounts>();
  let buffer: Document[] = [];
  const flush = async (): Promise<void> => {
    if (collection === null || buffer.length === 0) {
      buffer = [];
      return;
    }
    const batch = buffer;
    buffer = [];
    await collection.insertMany(batch);
  };
  return {
    record: async (issue) => {
      totals[issue.kind] += 1;
      if (issue.groupId !== null) {
        const key = issue.groupId.toHexString();
        const counts = perGroup.get(key) ?? emptyIssueCounts();
        counts[issue.kind] += 1;
        perGroup.set(key, counts);
      }
      if (collection !== null) {
        buffer.push({
          _id: new ObjectId(),
          runId,
          detectedAt: now(),
          kind: issue.kind,
          collection: issue.collection,
          groupId: issue.groupId,
          documentId: issue.documentId,
          repaired: issue.repaired,
        });
        if (buffer.length >= batchSize) {
          await flush();
        }
      }
    },
    flush,
    totals: () => ({ ...totals }),
    ofGroup: (groupHex) => ({ ...(perGroup.get(groupHex) ?? emptyIssueCounts()) }),
    groupHexes: () => [...perGroup.keys()],
  };
}
