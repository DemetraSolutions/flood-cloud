import { listQueryShape } from '../../shared/http/list.ts';
import { enumOf, object, objectId, optional } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { REFERENCE_LIST } from './reference.list.ts';

const trashed = () => optional(enumOf(['true', 'false'] as const));

/** Query of `GET /v1/groups`: the standard list parameters plus the `status`, `trashed`, `dealerId` and `demo` filters. */
export const groupsQuery = object({
  ...listQueryShape(REFERENCE_LIST),
  status: optional(enumOf(['active', 'suspended'] as const)),
  trashed: trashed(),
  dealerId: optional(objectId()),
  demo: optional(enumOf(['true', 'false'] as const)),
});

/** Validated query of the group list. */
export type GroupsQuery = Infer<typeof groupsQuery>;

/** Query of `GET /v1/groups/{groupId}/companies`. */
export const companiesQuery = object({ ...listQueryShape(REFERENCE_LIST), trashed: trashed() });

/** Validated query of the company list. */
export type CompaniesQuery = Infer<typeof companiesQuery>;

/** Query of `GET /v1/groups/{groupId}/places`: the optional `companyId` narrows to one company. */
export const placesQuery = object({ ...listQueryShape(REFERENCE_LIST), trashed: trashed(), companyId: optional(objectId()) });

/** Validated query of the place list. */
export type PlacesQuery = Infer<typeof placesQuery>;
