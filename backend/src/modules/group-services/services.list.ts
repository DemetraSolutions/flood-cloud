import type { ListConfig } from '../../shared/http/list.ts';

/** Name of the computed field the services are sorted and searched by: the name of the service in the language of the user. */
export const SERVICE_NAME = '__name';

/** Largest page of the services of a group. */
export const MAX_SERVICES_LIMIT = 100;

/** How the services are sorted and searched: by name (in the language of the user), and `q` is searched in that name. */
export const SERVICES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: SERVICE_NAME, kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze([SERVICE_NAME]),
});
