import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the dealer list is sorted and searched: by company name, ascending by default; `q` is searched
 * (case-insensitive, literal text) in the company name and the VAT number.
 */
export const DEALERS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ businessName: Object.freeze({ field: 'businessName', kind: 'string' as const }) }),
  defaultSort: 'businessName',
  searchFields: Object.freeze(['businessName', 'vatNumber']),
});
