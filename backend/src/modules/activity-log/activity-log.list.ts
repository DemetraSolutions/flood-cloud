import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the activity log list is ordered: newest first by `at`, `_id` as the tie-breaker, and nothing else
 * (the client sends neither `sort` nor `q`). It exists to give {@link listParamsOf} the cursor rules.
 */
export const ACTIVITY_LOG_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ at: Object.freeze({ field: 'at', kind: 'date' as const }) }),
  defaultSort: '-at',
  searchFields: Object.freeze([] as string[]),
});
