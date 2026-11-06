import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { SERVICES_LIST, SERVICE_NAME } from './services.list.ts';

/** The services of a group: the products of type `service` that are not in the trash. */
const SERVICE_FILTER: Filter<Document> = { type: 'service', trash: { $ne: true } };

/** Reads the services of a group (the `products` of the group database, read only). */
export interface ServicesRepository {
  /**
   * A page of the services of a group, with only the id and the name in the given language (the first language available when it has none).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group, which fixes the database and the cluster.
   * @param params Validated list parameters.
   * @param language Language of the name to show, from the user's settings.
   */
  list(principal: AuthPrincipal, access: GroupAccess, params: ListParams, language: string): Promise<ListPage>;
  /**
   * Which of the given ids are services of the group (and not in the trash).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param ids Candidate ids, at most a few hundred (the request schema bounds them).
   * @returns The hexadecimal ids found.
   */
  existing(principal: AuthPrincipal, access: GroupAccess, ids: readonly ObjectId[]): Promise<Set<string>>;
}

/**
 * The name of a service in a language: a service has a name by language (`{ it: '…' }`); when the language is missing, the first one available
 * is used, and anything that is not a text gives `null`. The language is a literal, never part of a path.
 */
function nameIn(language: string): Document {
  const picked = {
    $ifNull: [
      { $getField: { field: { $literal: language }, input: '$$names' } },
      { $first: { $map: { input: { $objectToArray: '$$names' }, as: 'entry', in: '$$entry.v' } } },
    ],
  };
  return {
    $let: {
      vars: { names: { $cond: [{ $eq: [{ $type: '$name' }, 'object'] }, '$name', {}] } },
      in: { $let: { vars: { picked }, in: { $cond: [{ $eq: [{ $type: '$$picked' }, 'string'] }, '$$picked', null] } } },
    },
  };
}

/**
 * Builds the services repository over the `products` of the group database, which is opened only through a verified group access.
 *
 * @param databases Database accessor.
 */
export function createServicesRepository(databases: Databases): ServicesRepository {
  const products = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products');
  return {
    list: async (principal, access, params, language) => {
      const documents = await products(principal, access)
        .aggregate(
          [
            { $match: SERVICE_FILTER },
            // Only the names travel down the pipeline: a product document can be large, and nothing else of it is needed.
            { $project: { name: 1 } },
            { $addFields: { [SERVICE_NAME]: nameIn(language) } },
            ...listPipeline(listSearch(params, SERVICES_LIST), params, SERVICES_LIST, { [SERVICE_NAME]: 1 }),
          ],
          { maxTimeMS: LIST_MAX_TIME_MS },
        )
        .toArray();
      return pageOf(documents, params);
    },

    existing: async (principal, access, ids) => {
      const found = await products(principal, access)
        .find({ ...SERVICE_FILTER, _id: { $in: [...ids] } }, { projection: { _id: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return new Set(found.map((product) => product._id.toHexString()));
    },
  };
}
