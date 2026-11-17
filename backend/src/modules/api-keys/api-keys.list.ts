import type { ListConfig } from '../../shared/http/list.ts';

/** How the list of the keys of a group is sorted: newest first, and nothing else (no search, no other order). */
export const API_KEYS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ createdAt: Object.freeze({ field: 'createdAt', kind: 'date' as const }) }),
  defaultSort: '-createdAt',
  searchFields: Object.freeze([] as string[]),
});
