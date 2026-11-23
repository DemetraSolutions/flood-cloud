import type { IndexSpec } from './collections.ts';

/** Most lines one closure document holds: the document stays far below the 16 MB limit of MongoDB. */
export const MAX_CLOSURE_LINES = 5000;

/** Indexes of `common.billingClosures`: one document per kind, period and dealer (`dealerId` is `null` for the dealer-less groups). */
export const BILLING_CLOSURES_INDEXES: readonly IndexSpec[] = Object.freeze([{ name: 'kind_1_period_1_dealerId_1', key: { kind: 1, period: 1, dealerId: 1 }, unique: true }]);
