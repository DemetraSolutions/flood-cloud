import type { IndexSpec } from './collections.ts';

/**
 * Indexes of `common.dealers` (`doc/Tasks.md` D-09): a VAT number identifies one dealer, so it is unique
 * among the documents that have one. The index is partial (`vatNumber` is a string) because most dealers
 * start without a VAT number, and many documents may hold `null`.
 */
export const DEALERS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'vatNumber_1', key: { vatNumber: 1 }, unique: true, partialFilterExpression: Object.freeze({ vatNumber: Object.freeze({ $type: 'string' }) }) },
]);
