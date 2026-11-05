import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the reference lists (groups, companies, places) are sorted and searched: by `name` only, ascending
 * by default, and `q` is searched in the name (case-insensitive, literal text).
 */
export const REFERENCE_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: 'name', kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});
