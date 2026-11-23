import type { IndexSpec } from './collections.ts';

/** Indexes of `common.settings`: one document per key. */
export const SETTINGS_INDEXES: readonly IndexSpec[] = Object.freeze([{ name: 'key_1', key: { key: 1 }, unique: true }]);
