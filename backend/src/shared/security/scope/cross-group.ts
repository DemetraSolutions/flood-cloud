import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';
import { AppError } from '../../http/errors.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../http/list.ts';
import type { ListConfig, ListPage, ListParams } from '../../http/list.ts';
import { bounded } from './bounded.ts';
import { MAX_LIST_GROUPS, readMirrorList } from './group-mirror.ts';
import type { MirrorCollection, MirrorListGroups } from './group-mirror.ts';
import type { AuthPrincipal } from './principal.ts';

/** The group filters of a cross-group list, as the client sent them (already validated as ids). */
export interface CrossGroupFilters {
  /** Narrows the list to one group; one outside the caller's perimeter gives an empty list. */
  readonly groupId?: ObjectId | undefined;
  /** Narrows the list to the groups of one dealer; the platform's alone. */
  readonly dealerId?: ObjectId | undefined;
}

/** A page of a cross-group list: the documents of the page, the page data and the names of the groups of the page. */
export interface CrossGroupPage extends ListPage {
  /** Name of each group of the page by hexadecimal id (a name that is not a text is `''`); a group that does not exist is missing. */
  readonly groupNames: ReadonlyMap<string, string>;
}

/**
 * Checks that a caller may use a cross-group list: only the platform (PSA) and a dealer (D) may, whatever the permission of the route says (a group administrator, a company
 * administrator, a place administrator, an employee and a store key reach one group only), and only the platform may filter by `dealerId`.
 *
 * @param principal The authenticated caller.
 * @param filters The group filters of the request.
 * @throws {AppError} `FORBIDDEN` for any other role, or for a dealer that sends `dealerId`.
 */
export function assertCrossGroupAccess(principal: Pick<AuthPrincipal, 'scope'>, filters: CrossGroupFilters): void {
  const { kind } = principal.scope;
  if ((kind !== 'platform' && kind !== 'dealer') || (filters.dealerId !== undefined && kind !== 'platform')) {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * The ids of the groups of a dealer whatever their state (trashed ones included: the platform's view is an administration one), read from `common.groups`. It fails closed rather than
 * truncating: more than {@link MAX_LIST_GROUPS} groups is an error. A read that exceeds its time limit is a `503`.
 */
async function groupsOfDealer(databases: Databases, dealerId: ObjectId): Promise<ObjectId[]> {
  const found = await bounded(() => databases.common().collection('groups').find({ dealerId }, { projection: { _id: 1 }, limit: MAX_LIST_GROUPS + 1, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
  if (found.length > MAX_LIST_GROUPS) {
    throw new Error('Too many groups for one cross-group list');
  }
  return found.map((group) => group['_id'] as ObjectId);
}

/**
 * The groups a cross-group list reads, computed from the caller's scope and the filters of the request: the platform reads every group (trashed and demo ones included), narrowed by
 * `groupId` and `dealerId`; a dealer reads the groups of his scope (the available ones, as everywhere), narrowed by `groupId`. A `groupId` outside the perimeter gives `null`, as a
 * perimeter or a filter that holds no group.
 *
 * @param databases Database accessor.
 * @param principal The authenticated caller.
 * @param filters The group filters of the request.
 * @returns The groups to read, or `null` when there is none (the list is empty without reading the copies).
 * @throws {AppError} `FORBIDDEN` as {@link assertCrossGroupAccess}.
 */
export async function resolveCrossGroups(databases: Databases, principal: Pick<AuthPrincipal, 'scope'>, filters: CrossGroupFilters): Promise<MirrorListGroups | null> {
  assertCrossGroupAccess(principal, filters);
  const { scope } = principal;
  let ids: ObjectId[] | null = null;
  if (scope.kind === 'dealer') {
    ids = [...scope.groupIds].map((hex) => ObjectId.createFromHexString(hex));
  } else if (filters.dealerId !== undefined) {
    ids = await groupsOfDealer(databases, filters.dealerId);
  }
  const { groupId } = filters;
  if (groupId !== undefined) {
    return ids === null || ids.some((id) => id.equals(groupId)) ? { kind: 'include', ids: [groupId] } : null;
  }
  if (ids === null) {
    return { kind: 'all' };
  }
  return ids.length === 0 ? null : { kind: 'include', ids };
}

/** The names of the groups of one page, from `common.groups`. */
async function groupNamesOf(databases: Databases, ids: readonly ObjectId[]): Promise<Map<string, string>> {
  const found = await bounded(() => databases.common().collection('groups').find({ _id: { $in: [...ids] } }, { projection: { name: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
  return new Map(found.map((group) => [(group['_id'] as ObjectId).toHexString(), typeof group['name'] === 'string' ? group['name'] : '']));
}

/** What {@link readCrossGroupPage} needs to know of the resource. */
export interface CrossGroupResource {
  /** The copy collection. */
  readonly name: MirrorCollection;
  /** Sort and search of the list. */
  readonly config: ListConfig;
  /** The fields the list loads (inclusion projection); `groupId` is added here. */
  readonly projection: Readonly<Record<string, 1>>;
}

/**
 * Reads one page of the cross-group list of a resource from the copies, with the names of the groups of the page. The groups come from {@link resolveCrossGroups}, so the perimeter is the
 * server's, never the client's; the request filter only narrows it. The names are looked up for the groups of the page only.
 *
 * @param databases Database accessor.
 * @param principal The authenticated caller.
 * @param resource The resource: copy, sort and search, projection.
 * @param groupFilters The group filters of the request.
 * @param filter The resource filter of the request (trash, status, country…).
 * @param params The validated list parameters.
 * @returns The page (each document carries `groupId`) and the group names; an empty page when the perimeter holds no group.
 * @throws {AppError} `FORBIDDEN` for a caller that is not the platform or a dealer; `SERVICE_UNAVAILABLE` when a read exceeds its time limit.
 */
export async function readCrossGroupPage(
  databases: Databases,
  principal: Pick<AuthPrincipal, 'scope'>,
  resource: CrossGroupResource,
  groupFilters: CrossGroupFilters,
  filter: Filter<Document>,
  params: ListParams,
): Promise<CrossGroupPage> {
  const groups = await resolveCrossGroups(databases, principal, groupFilters);
  if (groups === null) {
    return { items: [], page: { limit: params.limit, next: null }, groupNames: new Map() };
  }
  const projection = { ...resource.projection, groupId: 1 as const };
  const documents = await readMirrorList(databases, resource.name, groups, listPipeline({ $and: [filter, listSearch(params, resource.config)] }, params, resource.config, projection));
  const page = pageOf(documents, params);
  const ids = [...new Map(page.items.map((document) => [(document['groupId'] as ObjectId).toHexString(), document['groupId'] as ObjectId])).values()];
  return { ...page, groupNames: ids.length === 0 ? new Map() : await groupNamesOf(databases, ids) };
}
