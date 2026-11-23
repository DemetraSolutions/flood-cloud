import { ObjectId } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../../shared/http/list.ts';
import { bounded } from '../../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../../shared/security/scope/principal.ts';
import type { ReferenceCheck, ReferenceCollection } from './catalog.ts';

/** The kinds of reference read from the group database; `places` is not among them: it is read from the copies in the common database. */
type GroupDatabaseReference = Exclude<ReferenceCollection, 'places'>;

/** The collection of the group database behind each kind of reference, and whether its documents can be in the trash (a trashed one does not count). */
const TARGETS: Readonly<Record<GroupDatabaseReference, { readonly collection: string; readonly trashable: boolean }>> = Object.freeze({
  products: { collection: 'products', trashable: true },
  categories: { collection: 'products_categories', trashable: true },
  contacts: { collection: 'contacts', trashable: true },
  contactGroups: { collection: 'contacts_groups', trashable: false },
});

const HEX_ID = /^[0-9a-f]{24}$/;

/** Checks, in the data of a group, that the ids a catalog refers to exist. */
export interface ReferencesRepository {
  /**
   * Tells which ids of a check do not exist (or are in the trash). One query by id list, limited to the list, with only the id projected.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group, which fixes the group (and, for the group-database targets, the database and the cluster).
   * @param check The ids and where they must be.
   * @returns The positions, in the list, of the ids that are missing; empty when all exist.
   */
  missing(principal: AuthPrincipal, access: GroupAccess, check: ReferenceCheck): Promise<number[]>;
}

/**
 * Builds the references repository.
 *
 * @param databases Database accessor.
 */
export function createReferencesRepository(databases: Databases): ReferencesRepository {
  return {
    missing: async (principal, access, check) => {
      const wanted = [...new Set(check.ids.filter((id) => HEX_ID.test(id)))].map((id) => ObjectId.createFromHexString(id));
      const found = new Set<string>();
      if (wanted.length > 0) {
        let documents: Array<{ _id?: unknown }>;
        if (check.collection === 'places') {
          documents = await groupMirror(principal, access, databases, 'places').find({ _id: { $in: wanted }, trash: { $ne: true } }, { projection: { _id: 1 }, limit: wanted.length });
        } else {
          const target = TARGETS[check.collection];
          documents = await bounded(() =>
            groupDatabaseFor(principal, access, databases)
              .collection<{ _id: ObjectId }>(target.collection)
              .find({ _id: { $in: wanted }, ...(target.trashable ? { trash: { $ne: true } } : {}) }, { projection: { _id: 1 }, limit: wanted.length, maxTimeMS: LIST_MAX_TIME_MS })
              .toArray(),
          );
        }
        for (const document of documents) {
          found.add((document._id as ObjectId).toHexString());
        }
      }
      return check.ids.flatMap((id, index) => (found.has(id) ? [] : [index]));
    },
  };
}
