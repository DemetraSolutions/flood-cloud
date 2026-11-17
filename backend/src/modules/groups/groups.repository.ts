import type { Collection, Document, Filter, ObjectId } from 'mongodb';
import { GROUPS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import type { PublicApiLimits } from '../../shared/security/public-api-limits.ts';
import { API_KEY_SET_PROJECTION, BUILT_IN_PUBLIC_API_LIMITS, GROUP_PROJECTION, fromLegacy } from './group.mapper.ts';
import type { LegacyGroupDocument, LegacyGroupUpdate, MappedGroup } from './group.types.ts';

/** The result of {@link ManagedGroupsRepository.updateOwned}. */
export type GroupUpdateOutcome = 'updated' | 'notFound' | 'malformed';

/** Reads and updates the shared legacy `common.groups` collection, translating it to the domain model. The state used to authorize access lives in the scope repositories. */
export interface ManagedGroupsRepository {
  /**
   * Reads a group by id with the fields the domain maps and nothing else (no API key, host or integration key is loaded: whether a key is set is computed by the database).
   *
   * @param id Id of the group.
   * @returns The group and its anomalies, or `null` when it does not exist.
   */
  findById(id: ObjectId): Promise<MappedGroup | null>;
  /**
   * Applies an update built by `toLegacyUpdate` (`$set`, and `$unset` for the date of the trash when a group is restored). The update is refused if it touches a field the backend does not own, and it is not
   * applied when a container it writes into (`settings`, `settings.stats`, `settings.integrations`, a provider) holds something that is
   * not an object, which would make the database fail: the group is left as it is.
   *
   * @param id Id of the group.
   * @param update `$set` update.
   * @returns `updated`, `notFound` when the group does not exist, `malformed` when a container of the document is not an object.
   * @throws {Error} If the update contains a field outside the owned fields.
   */
  updateOwned(id: ObjectId, update: LegacyGroupUpdate): Promise<GroupUpdateOutcome>;
}

/** The containers a dotted path is written into: `a.b.c` needs `a` and `a.b`. */
function containersOf(paths: readonly string[]): string[] {
  const containers = new Set<string>();
  for (const path of paths) {
    const segments = path.split('.');
    for (let length = 1; length < segments.length; length += 1) {
      containers.add(segments.slice(0, length).join('.'));
    }
  }
  return [...containers];
}

/**
 * Builds the groups repository over `common.groups`. The only code that knows the legacy document shape of a group.
 *
 * @param databases Database accessor.
 * @param publicApiDefaults The platform defaults of the limits of a public API key, which a group without limits of its own shows.
 */
export function createManagedGroupsRepository(databases: Databases, publicApiDefaults: PublicApiLimits = BUILT_IN_PUBLIC_API_LIMITS): ManagedGroupsRepository {
  const groups = (): Collection<Document> => databases.common().collection('groups');
  const owned = new Set(GROUPS_OWNED_FIELDS);
  return {
    findById: async (id) => {
      // An aggregation, not a `find`, so that whether each integration key is set is computed in the database and the keys themselves are never loaded.
      const [document] = await groups()
        .aggregate([{ $match: { _id: id } }, { $project: { ...GROUP_PROJECTION, ...API_KEY_SET_PROJECTION } }], { maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return document === undefined ? null : fromLegacy(document as LegacyGroupDocument, publicApiDefaults);
    },

    updateOwned: async (id, update) => {
      const operators = Object.keys(update).filter((key) => key !== '$set' && key !== '$unset');
      if (operators.length > 0) {
        throw new Error('Refusing an update with operators other than $set');
      }
      const fields = [...Object.keys(update.$set), ...Object.keys(update.$unset ?? {})];
      const foreign = fields.filter((field) => !owned.has(field));
      if (foreign.length > 0) {
        throw new Error(`Refusing to write fields the backend does not own: ${foreign.join(', ')}`);
      }
      const intact: Filter<Document>[] = containersOf(fields).map((path) => ({ $or: [{ [path]: { $exists: false } }, { [path]: { $type: 'object' } }] }));
      const result = await groups().updateOne(
        { _id: id, ...(intact.length === 0 ? {} : { $and: intact }) },
        { $set: { ...update.$set }, ...(update.$unset === undefined ? {} : { $unset: { ...update.$unset } }) },
      );
      if (result.matchedCount === 1) {
        return 'updated';
      }
      return (await groups().countDocuments({ _id: id }, { limit: 1 })) === 0 ? 'notFound' : 'malformed';
    },
  };
}
