import type { ListConfig } from '../../shared/http/list.ts';

/** Name of the computed field the compact reads are sorted and searched by: the name to show. */
export const LOOKUP_NAME = '__name';

/** Largest page of a compact read, and so the most ids `ids` can resolve at once. */
export const MAX_LOOKUP_LIMIT = 100;

/** How a compact read is sorted and searched: by name, and `q` is searched in that name. */
export const LOOKUP_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: LOOKUP_NAME, kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze([LOOKUP_NAME]),
});
