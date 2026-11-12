import type { ObjectId } from 'mongodb';

/** A document with an `ObjectId` `_id`. */
export interface WithObjectId {
  readonly _id: ObjectId;
}

/** One step of the ordered merge: the original and the copy with the same `_id`, or only one of them. */
export interface MergedPair<T extends WithObjectId> {
  /** The document of the group database, `null` when only the copy exists. */
  readonly original: T | null;
  /** The document of the common database, `null` when only the original exists. */
  readonly copy: T | null;
}

/**
 * Ordered merge of two streams of documents sorted by ascending `_id` (ObjectIds compare as their bytes, which is the
 * lexicographic order of their hex form). Only one document of each stream is held at any time. When the consumer stops
 * early, or a stream throws, both streams are closed.
 *
 * @param originals Documents of the group database, sorted by `_id`.
 * @param copies Documents of the common database, sorted by `_id`.
 * @returns Pairs in `_id` order: both, only the original or only the copy.
 */
export async function* mergeById<T extends WithObjectId>(originals: AsyncIterable<T>, copies: AsyncIterable<T>): AsyncGenerator<MergedPair<T>, void, void> {
  const left = originals[Symbol.asyncIterator]();
  const right = copies[Symbol.asyncIterator]();
  try {
    let a = await left.next();
    let b = await right.next();
    while (a.done !== true || b.done !== true) {
      if (a.done === true) {
        yield { original: null, copy: (b as IteratorYieldResult<T>).value };
        b = await right.next();
        continue;
      }
      if (b.done === true) {
        yield { original: a.value, copy: null };
        a = await left.next();
        continue;
      }
      const x = a.value._id.toHexString();
      const y = b.value._id.toHexString();
      if (x === y) {
        yield { original: a.value, copy: b.value };
        a = await left.next();
        b = await right.next();
      } else if (x < y) {
        yield { original: a.value, copy: null };
        a = await left.next();
      } else {
        yield { original: null, copy: b.value };
        b = await right.next();
      }
    }
  } finally {
    await Promise.all([left.return?.(), right.return?.()]);
  }
}
