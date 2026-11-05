import type { ListConfig } from '../../shared/http/list.ts';

/**
 * How the user lists are sorted and searched. The public sort names map to the legacy fields
 * (`username` is `userName`, `lastName` is `surname`, `createdAt` is `insertDate`); `username` ascending
 * is the default. `q` is searched in the user name, the first and last name, the e-mail and the telephone.
 */
export const USERS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    username: Object.freeze({ field: 'userName', kind: 'string' as const }),
    lastName: Object.freeze({ field: 'surname', kind: 'string' as const }),
    createdAt: Object.freeze({ field: 'insertDate', kind: 'date' as const }),
  }),
  defaultSort: 'username',
  searchFields: Object.freeze(['userName', 'name', 'surname', 'email', 'telephone']),
});
