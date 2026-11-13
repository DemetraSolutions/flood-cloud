import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the list of the companies is sorted and searched: by `name` only, ascending by default (`-name` descending), and `q` is looked for in the name and the
 * VAT number (`code`), case-insensitive, as literal text.
 */
export const COMPANIES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: 'name', kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name', 'code']),
});
