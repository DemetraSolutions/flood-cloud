import type { Document, Filter, ObjectId } from 'mongodb';
import { listQueryShape } from '../../shared/http/list.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { object } from '../../shared/validation/schema.ts';
import { USERS_LIST } from '../users/users.list.ts';

/** Query of `GET /v1/store-context/users`: the page only (`limit` 1–200, default 50, and the opaque `cursor`); no filter, no search, no sort, and any other parameter is `422`. */
export const storeUsersQuery = object({ limit: listQueryShape(USERS_LIST).limit, cursor: listQueryShape(USERS_LIST).cursor });

/** The validated query of the users of a store. */
export type StoreUsersQuery = Infer<typeof storeUsersQuery>;

/**
 * Who the server of a store may read, as a filter built from the store principal alone (the group, the place, the company of the place now), never from a request value:
 * the users of the group that are not in the trash and whose perimeter covers the place.
 * - `E` (a missing role counts as `E`, as everywhere in the model) and `PA` with the place in `placeId` or `placesId`;
 * - `CA` of the company the place belongs to now (`companyId`);
 * - `SA` of the group.
 * A `PSA`, a dealer, a user of another group, a user with an unknown role and a user whose perimeter does not cover the place never match. Disabled users do: the store blocks them.
 *
 * @param groupId Group of the store key.
 * @param placeId Place of the store key.
 * @param companyId The company the place has now.
 */
export function storeUsersFilter(groupId: ObjectId, placeId: ObjectId, companyId: ObjectId): Filter<Document> {
  return {
    groupId,
    trash: { $ne: true },
    $or: [
      { role: { $in: ['E', 'PA', null] }, $or: [{ placeId }, { placesId: placeId }] },
      { role: 'CA', companyId },
      { role: 'SA' },
    ],
  };
}
