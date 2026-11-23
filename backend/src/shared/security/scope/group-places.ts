import type { ObjectId } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../http/list.ts';
import { bounded } from './bounded.ts';
import { groupDatabaseFor } from './group-access.ts';
import type { GroupAccess } from './group-access.ts';
import type { ScopeHolder } from './principal.ts';

/**
 * The ids of the places of the group that are not in the trash, read from the `places` collection of the **group database** (the source of truth, not the copy in the common database), at most two:
 * more than one means the group is not a single point of sale. It is the only read of the places of a group database outside the tools: it exists so that the rule of the group with one place can
 * be checked against both sources and refused when they disagree. The database is opened from the verified access; one bounded read (`maxTimeMS` and `503`), `_id` only.
 *
 * @param principal The caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @returns At most two ids.
 */
export async function activeGroupPlaceIds(principal: ScopeHolder, access: GroupAccess, databases: Databases): Promise<ObjectId[]> {
  const db = groupDatabaseFor(principal, access, databases);
  const found = await bounded(() => db.collection('places').find({ trash: { $ne: true } }, { projection: { _id: 1 }, sort: { _id: 1 }, limit: 2, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
  return found.map((place) => place['_id'] as ObjectId);
}
