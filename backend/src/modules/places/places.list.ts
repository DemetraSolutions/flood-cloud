import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the list of the places is sorted and searched: by `name` (default, ascending; `-name` descending) or by `expirationDate` (`-expirationDate` descending; a place without a date sorts
 * first ascending and last descending), always with the id as the tie-breaker, before the page is cut. `q` is looked for in the name and the city, case-insensitive, as literal text.
 */
export const PLACES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    expirationDate: Object.freeze({ field: 'expirationDate', kind: 'date' as const }),
  }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name', 'city']),
});
