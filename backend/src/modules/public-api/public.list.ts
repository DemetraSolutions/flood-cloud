import type { ListConfig } from '../../shared/http/list.ts';

/** How the public lists of places and of companies are sorted: by name, ascending, with the id as the tie-breaker. The client chooses nothing. */
export const PUBLIC_NAME_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: 'name', kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze([] as string[]),
});
