import { listQueryShape } from '../../shared/http/list.ts';
import { integerString, object, optional } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { MAX_SERVICES_LIMIT, SERVICES_LIST } from './services.list.ts';

/** Query of `GET /v1/groups/{groupId}/services`: the common list parameters with a page of at most 100. */
export const servicesQuery = object({ ...listQueryShape(SERVICES_LIST), limit: optional(integerString({ min: 1, max: MAX_SERVICES_LIMIT })) });

/** Validated query of the services list. */
export type ServicesQuery = Infer<typeof servicesQuery>;
