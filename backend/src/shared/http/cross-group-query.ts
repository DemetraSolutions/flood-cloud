import { integerString, objectId, optional } from '../validation/schema.ts';
import { listQueryShape } from './list.ts';
import type { ListConfig } from './list.ts';

/** Largest page of a list across groups (the lists of one group allow `MAX_LIMIT`). */
export const CROSS_GROUP_MAX_LIMIT = 100;

/**
 * The query parameters every list across groups has, as a schema shape to spread into the `object` of the route: the standard list parameters of the resource, with a page of at most
 * {@link CROSS_GROUP_MAX_LIMIT}, and the two group filters, `groupId` and `dealerId` (24 hexadecimal characters). Whether the caller may send `dealerId` is the service's decision (`403`).
 *
 * @param config The resource's list description.
 */
export function crossGroupShape(config: ListConfig) {
  return {
    ...listQueryShape(config),
    limit: optional(integerString({ min: 1, max: CROSS_GROUP_MAX_LIMIT })),
    groupId: optional(objectId()),
    dealerId: optional(objectId()),
  };
}
