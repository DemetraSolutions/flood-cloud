import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, SORT_KEY, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { activityLogScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import { ACTIVITY_LOG_PROJECTION } from './activity-log.mapper.ts';

/** Reads of `common.activityLog` and of the user names of its actors; nothing is ever written here. */
export interface ActivityLogRepository {
  /**
   * A page of entries, newest first, inside the caller's perimeter.
   *
   * @param principal The authenticated caller (his scope limits the result).
   * @param filter Filter of the request.
   * @param params Validated list parameters.
   */
  list(principal: Pick<AuthPrincipal, 'userId' | 'scope'>, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * The user names of some users, resolved in one query.
   *
   * @param ids Ids of the actors of a page.
   * @returns User name by hex id; users that do not exist are absent.
   */
  usernames(ids: readonly ObjectId[]): Promise<Map<string, string>>;
}

/** The condition that selects what comes after the cursor in the descending order of `at` and `_id`. */
function afterCursor(params: ListParams): Filter<Document> {
  const { cursor } = params;
  if (cursor === null) {
    return {};
  }
  if (cursor.value === null) {
    // Every entry has a date, so nothing sorts after an entry without one.
    return { _id: { $in: [] } };
  }
  const at = new Date(cursor.value as number);
  return { $or: [{ at: { $lt: at } }, { at, _id: { $lt: cursor.id } }] };
}

/**
 * The index that serves the perimeter of a scope. The scope condition is an equality (or a list of
 * equalities) on a field the index starts with, which lets the database read in the order of the list; left
 * to itself the planner may prefer the `category` index and sort in memory.
 */
function hintOf(kind: AuthPrincipal['scope']['kind']): { hint?: string } {
  switch (kind) {
    case 'dealer':
    case 'group':
      return { hint: 'groupId_1_at_-1__id_-1' };
    case 'companies':
    case 'places':
      return { hint: 'actor.id_1_at_-1__id_-1' };
    default:
      return {};
  }
}

/**
 * The query of one page: scope and request filter combined, the cursor, the projection and the order
 * (`at` and `_id`, descending, served by the indexes of the collection without a blocking sort).
 *
 * @param principal Id and scope of the caller.
 * @param filter Filter of the request.
 * @param params Validated list parameters.
 * @returns The filter and the find options.
 */
export function activityLogPageQuery(principal: Pick<AuthPrincipal, 'userId' | 'scope'>, filter: Filter<Document>, params: ListParams) {
  return {
    match: withScope(activityLogScopeFilter(principal), { $and: [filter, afterCursor(params)] }),
    options: { projection: ACTIVITY_LOG_PROJECTION, sort: { at: -1, _id: -1 }, limit: params.limit + 1, maxTimeMS: LIST_MAX_TIME_MS, ...hintOf(principal.scope.kind) } as const,
  };
}

/**
 * Builds the activity log repository. Every query combines the scope filter of the caller with the filter
 * of the request through `withScope` and projects an allowlist of fields. The order is the stored `at` and
 * `_id` (descending), so the indexes of the collection serve it.
 *
 * @param databases Database accessor.
 */
export function createActivityLogRepository(databases: Databases): ActivityLogRepository {
  return {
    list: async (principal, filter, params) => {
      const { match, options } = activityLogPageQuery(principal, filter, params);
      const documents = await databases.common().collection('activityLog').find(match, options).toArray();
      return pageOf(
        documents.map((document) => ({ ...document, [SORT_KEY]: document['at'] as Date })),
        params,
      );
    },

    usernames: async (ids) => {
      if (ids.length === 0) {
        return new Map();
      }
      const users = await databases
        .common()
        .collection('users')
        .find({ _id: { $in: [...ids] } }, { projection: { userName: 1 }, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return new Map(users.flatMap((user) => (typeof user['userName'] === 'string' ? [[(user['_id'] as ObjectId).toHexString(), user['userName']] as [string, string]] : [])));
    },
  };
}
