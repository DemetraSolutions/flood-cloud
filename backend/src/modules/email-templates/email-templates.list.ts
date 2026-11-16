import type { ListConfig } from '../../shared/http/list.ts';

/** Largest page of the list of the e-mail templates of a group. */
export const MAX_EMAIL_TEMPLATES_PAGE = 100;

/**
 * How the list of the e-mail templates is sorted and searched: by name by default, or by the date of the last change (`updatedAt`, newest first as `-updatedAt`); `q` is looked for in
 * the name, case-insensitive, as literal text. The content of a template is never searched.
 */
export const EMAIL_TEMPLATES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }),
  }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});
