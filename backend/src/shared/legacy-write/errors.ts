import type { ObjectId } from 'mongodb';

/**
 * Thrown when a write of companies or places is requested for a group whose data lives on a cluster other than the common one.
 * The write must change the group database and the common database together, and there are no transactions across clusters
 * (`doc/Architecture.md` §3.2.1, D-25): nothing is written. The route that receives it answers a clear refusal, never a partial write.
 */
export class CrossClusterWriteError extends Error {
  /** The group concerned, as 24 hex characters. */
  readonly groupId: string;
  /** Cluster of the group data. */
  readonly groupCluster: string;
  /** Cluster of the common database. */
  readonly commonCluster: string;

  /**
   * @param groupId The group concerned.
   * @param groupCluster Cluster that holds the group database.
   * @param commonCluster Cluster that holds the common database.
   */
  constructor(groupId: ObjectId, groupCluster: string, commonCluster: string) {
    super('Companies and places of a group on another cluster than the common one cannot be written atomically');
    this.name = 'CrossClusterWriteError';
    this.groupId = groupId.toHexString();
    this.groupCluster = groupCluster;
    this.commonCluster = commonCluster;
  }
}

/**
 * Thrown when the input of a write is not what the service accepts: a field outside the allowlist, a value of the wrong type, an
 * empty change or an id that is not an `ObjectId`. The callers validate their input first, so this signals a programming error
 * and never carries a value of the input (only the name of the field).
 */
export class InvalidWriteInputError extends Error {
  /** Name of the offending field, or `null` when the problem is not about a field. */
  readonly field: string | null;

  /**
   * @param message What is wrong, without values.
   * @param field Name of the offending field, if any.
   */
  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = 'InvalidWriteInputError';
    this.field = field;
  }
}
