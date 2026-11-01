import type { Collection, Document } from 'mongodb';
import { ENCRYPTED_LEGACY } from './classify.ts';
import { MAX_TIME_MS } from './read.ts';

/** How many values occur more than once and how many documents carry them. */
export interface DuplicateCount {
  duplicateValues: number;
  documentsInvolved: number;
}

/** Fields on which duplicates are counted. */
export type DuplicateField = 'userName' | 'email' | 'telephone' | 'code';

/** Variants of the duplicate count. */
export interface DuplicateOptions {
  /** Compare after trimming and lowercasing. */
  readonly caseInsensitive?: boolean;
  /** Ignore documents whose `trash` is `true`. */
  readonly skipTrashed?: boolean;
}

/**
 * Counts duplicated values of a field with a server-side `$group`, so that no value leaves the
 * database. Missing, null, non-string, empty and legacy-encrypted values are ignored.
 *
 * @param collection Collection to analyze.
 * @param field Field to compare (a fixed allowlist, never client input).
 * @param options Comparison variants.
 * @returns Only counts.
 */
export async function countDuplicates(
  collection: Collection,
  field: DuplicateField,
  options: DuplicateOptions = {},
): Promise<DuplicateCount> {
  const source = `$${field}`;
  const pipeline: Document[] = [
    {
      $match: {
        [field]: { $type: 'string', $not: ENCRYPTED_LEGACY },
        ...(options.skipTrashed === true ? { trash: { $ne: true } } : {}),
      },
    },
    { $group: { _id: options.caseInsensitive === true ? { $toLower: { $trim: { input: source } } } : source, n: { $sum: 1 } } },
    { $match: { _id: { $ne: '' }, n: { $gt: 1 } } },
    { $group: { _id: null, duplicateValues: { $sum: 1 }, documentsInvolved: { $sum: '$n' } } },
  ];
  const [row] = await collection.aggregate(pipeline, { allowDiskUse: true, maxTimeMS: MAX_TIME_MS }).toArray();
  return { duplicateValues: row?.['duplicateValues'] ?? 0, documentsInvolved: row?.['documentsInvolved'] ?? 0 };
}

/**
 * Streams, per value of a string field, how many documents carry it (server-side `$group`).
 * Used to merge counts across databases; callers must keep the values in memory only.
 *
 * @param collection Collection to analyze.
 * @param field Field to count (a fixed allowlist).
 * @returns Each non-empty value with its number of documents, lazily.
 */
export async function* valueCounts(collection: Collection, field: DuplicateField): AsyncGenerator<[string, number]> {
  const cursor = collection.aggregate(
    [
      { $match: { [field]: { $type: 'string', $ne: '' } } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ],
    { allowDiskUse: true, maxTimeMS: MAX_TIME_MS, batchSize: 500 },
  );
  for await (const row of cursor) {
    yield [String(row['_id']), Number(row['n'])];
  }
}
