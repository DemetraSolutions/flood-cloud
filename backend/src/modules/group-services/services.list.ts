import { LOOKUP_LIST, LOOKUP_NAME, MAX_LOOKUP_LIMIT } from '../group-lookup/lookup.list.ts';

/** Name of the computed field the services are sorted and searched by: the name of the service in the language of the user. */
export const SERVICE_NAME = LOOKUP_NAME;

/** Largest page of the services of a group. */
export const MAX_SERVICES_LIMIT = MAX_LOOKUP_LIMIT;

/** How the services are sorted and searched: by name (in the language of the user), and `q` is searched in that name. */
export const SERVICES_LIST = LOOKUP_LIST;
