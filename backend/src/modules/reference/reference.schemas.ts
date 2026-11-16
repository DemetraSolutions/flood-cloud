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
