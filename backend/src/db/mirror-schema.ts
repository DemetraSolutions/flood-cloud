import type { IndexSpec } from './collections.ts';

/** Days after which a `syncIssues` document expires. */
export const SYNC_ISSUES_TTL_DAYS = 180;

/**
 * Indexes of `common.companies`, the mirror of the `companies` collections of the group databases: by group and `_id`
 * (the reconciliation scans one group in `_id` order), by group and name, by group and status (the filter of the list) and by group and
 * VAT number (`code`, the search of the list). All non-unique on purpose: a copy must never be refused, and the VAT number of the
 * companies is not unique in the data (the check is made by the write service, `doc/Tasks.md` 6.1). There is no `$jsonSchema`; the copy command validates in the application.
 */
export const COMPANIES_MIRROR_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'groupId_1__id_1', key: { groupId: 1, _id: 1 } },
  { name: 'groupId_1_name_1', key: { groupId: 1, name: 1 } },
  { name: 'groupId_1_status_1', key: { groupId: 1, status: 1 } },
  { name: 'groupId_1_code_1', key: { groupId: 1, code: 1 } },
]);

/** Indexes of `common.places`, the mirror of the `places` collections of the group databases: as the companies plus by company. */
export const PLACES_MIRROR_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'groupId_1__id_1', key: { groupId: 1, _id: 1 } },
  { name: 'groupId_1_name_1', key: { groupId: 1, name: 1 } },
  { name: 'groupId_1_companyId_1', key: { groupId: 1, companyId: 1 } },
]);

/**
 * Indexes of `common.syncIssues` (discrepancies found by `sync-copies`): by run, by kind newest first, and the TTL on
 * `detectedAt` (180 days). A document holds ids only: `{ _id, runId, detectedAt, kind, collection, groupId, documentId, repaired }`.
 * No `$jsonSchema`, like `activityEvents`: the collection must not depend on the `collMod` privilege.
 */
export const SYNC_ISSUES_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'runId_1', key: { runId: 1 } },
  { name: 'kind_1_detectedAt_-1', key: { kind: 1, detectedAt: -1 } },
  { name: 'detectedAt_ttl', key: { detectedAt: 1 }, expireAfterSeconds: SYNC_ISSUES_TTL_DAYS * 24 * 60 * 60 },
]);
