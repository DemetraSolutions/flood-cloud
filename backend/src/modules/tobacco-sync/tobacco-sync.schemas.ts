import type { ObjectId } from 'mongodb';
import { array, boolean, enumOf, object, objectId, optional, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Most points of sale one synchronization may name (the same bound as the availability of the other entries of the catalog). */
export const MAX_SYNC_PLACES = 200;

/**
 * Body of `POST /v1/groups/{groupId}/tobacco-sync`: `warehouse` moves the products in the warehouse (needs the `warehouse` function of the group), `noDiscount` makes them not discountable, `placeIds` are the points of
 * sale the touched products and the new categories are available in (empty or missing: every point of sale). `confirmMassDisable` lets a synchronization that would disable more than 20 % of the enabled tobaccos of the group go on. Unknown keys are refused. The body is required: send `{}` for the defaults.
 */
export const syncBody = object({ warehouse: optional(boolean()), noDiscount: optional(boolean()), placeIds: optional(array(objectId(), { max: MAX_SYNC_PLACES })), confirmMassDisable: optional(boolean()) });

/** Validated body of the synchronization. */
export type SyncBody = Infer<typeof syncBody>;

/** Query of `POST /v1/groups/{groupId}/tobacco-sync`: `dryRun=true` computes and counts what would be written, writing nothing. */
export const syncQuery = object({ dryRun: optional(transform(enumOf(['true', 'false'] as const), (value) => value === 'true', 'enum')) });

/** Validated query of the synchronization. */
export type SyncQuery = Infer<typeof syncQuery>;

/** The parameters the service works with: defaults applied, places without repetitions. */
export interface SyncParams {
  readonly warehouse: boolean;
  readonly noDiscount: boolean;
  readonly placeIds: readonly ObjectId[];
}
