import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the list of the images is sorted and searched: newest first by default (`createdAt`, or `-createdAt`), or by `name`; `q` is looked for in the name, the title and the file name,
 * case-insensitive, as literal text.
 */
export const IMAGES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    createdAt: Object.freeze({ field: 'insertDate', kind: 'date' as const }),
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
  }),
  defaultSort: '-createdAt',
  searchFields: Object.freeze(['name', 'title', 'basename']),
});
