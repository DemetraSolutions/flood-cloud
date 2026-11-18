/**
 * What the purge counts for one group, in the audit (what would be deleted) and in the run (what was deleted). Counts only: no document value ever leaves the tool.
 * `documents` is the estimate of the server for the group database. `idempotencyKeys` is counted only by the run (it is found through the users it deletes).
 */
export interface GroupCounts {
  /** Collections of the group database. */
  readonly collections: number;
  /** Estimated documents of the group database. */
  readonly documents: number;
  /** Users with a group role (`SA`, `CA`, `PA`, `E`). */
  readonly users: number;
  /** Copies of the companies in the common database. */
  readonly companies: number;
  /** Copies of the places in the common database. */
  readonly places: number;
  /** Public API keys. */
  readonly apiKeys: number;
  /** Daily usage rows of those keys. */
  readonly apiUsage: number;
  /** Store keys of the places of the group. */
  readonly storeKeys: number;
  /** Pending store activation codes. */
  readonly activationCodes: number;
  /** Records of the Reserve with Google feed. */
  readonly reserveWithGoogle: number;
  /** Idempotency keys of the deleted users. */
  readonly idempotencyKeys: number;
}

/** The names of the counters of {@link GroupCounts}, in the order they are printed and recorded. */
export const COUNT_KEYS: readonly (keyof GroupCounts)[] = Object.freeze([
  'collections',
  'documents',
  'users',
  'companies',
  'places',
  'apiKeys',
  'apiUsage',
  'storeKeys',
  'activationCodes',
  'reserveWithGoogle',
  'idempotencyKeys',
]);

/** Counters all at zero. */
export function emptyCounts(): GroupCounts {
  return { collections: 0, documents: 0, users: 0, companies: 0, places: 0, apiKeys: 0, apiUsage: 0, storeKeys: 0, activationCodes: 0, reserveWithGoogle: 0, idempotencyKeys: 0 };
}

/**
 * Adds counters.
 *
 * @param left First operand.
 * @param right Second operand.
 */
export function addCounts(left: GroupCounts, right: GroupCounts): GroupCounts {
  const sum: Record<string, number> = {};
  for (const key of COUNT_KEYS) {
    sum[key] = left[key] + right[key];
  }
  return sum as unknown as GroupCounts;
}
