import { MongoServerError, ObjectId } from 'mongodb';
import type { Collection, Document, Filter, Sort } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';
import { AppError } from '../../http/errors.ts';
import { LIST_MAX_TIME_MS, MAX_LIMIT } from '../../http/list.ts';
import { codeVariants } from '../../validation/code-variants.ts';
import { bounded, MAX_TIME_EXPIRED } from './bounded.ts';
import { MAX_DEALER_GROUPS } from './dealer-groups.repository.ts';
import { assertVerifiedGroupAccess } from './group-access.ts';
import { assertCountedGroups, countByGroupPipeline, countsByGroup } from './group-counts.ts';
import type { TrashCount } from './group-counts.ts';
import type { GroupAccess } from './group-access.ts';
import type { ScopeHolder } from './principal.ts';
import { ACTIVATION_COMPANY_PROJECTION, ACTIVATION_PLACE_PROJECTION, ACTIVATION_PROVIDERS, activationPlacesFilter } from './mirror-activations.ts';
import type { ActivationWindow } from './mirror-activations.ts';
import { deviceCountPipeline, deviceRowsPipeline, selectionCondition } from './mirror-devices.ts';
import type { DeviceAfter, DeviceRowsQuery, GroupSelection } from './mirror-devices.ts';

/** The copies kept in the common database (`common.companies`, `common.places`) that this module can read. */
export type MirrorCollection = 'companies' | 'places';

/** Inclusion-only projection (`{ field: 1 }`): the allowlist of the fields a read may return. */
export type MirrorProjection = Readonly<Record<string, 1>>;

const MIRROR_COLLECTIONS: readonly string[] = ['companies', 'places'];

/**
 * The fields of each copy collection an application read may name, return or compute from: the one central allowlist.
 * The copies hold the credentials of the integrations of the places and the bank data of the companies, so nothing else is ever readable:
 * the companies expose, besides the compact reference (`name`, `trash`, `trashDate`), the fields of the list of companies (`code`, `city`, `countryAreaCode`, `countryCode`, `status`);
 * the places the compact reference (`name`, `trash`, `trashDate`, `companyId`) and the fields of the list of places (`plan`, `status`, `city`, `countryAreaCode`, `countryCode`, `expirationDate`).
 * The public API (step 9A) adds the registry data it shows, and nothing else: of a company the fiscal code and the contact data (`code2`, `address`, `postcode`, `email`, `telephone`), of a place the contact data and the time zone
 * (`address`, `postcode`, `email`, `telephone`, `timezone`). The activations (billing of the dealers) add the date of the activation of a place (`insertDate`). No bank, invoicing, credential or setting field is ever in this list:
 * the few leaves of the containers that hold them are in {@link MIRROR_LEAVES}.
 */
export const MIRROR_FIELDS: Readonly<Record<MirrorCollection, ReadonlySet<string>>> = Object.freeze({
  companies: new Set(['_id', 'name', 'trash', 'trashDate', 'code', 'city', 'countryAreaCode', 'countryCode', 'status', 'code2', 'address', 'postcode', 'email', 'telephone']),
  places: new Set(['_id', 'name', 'trash', 'trashDate', 'companyId', 'plan', 'status', 'city', 'countryAreaCode', 'countryCode', 'expirationDate', 'address', 'postcode', 'email', 'telephone', 'timezone', 'insertDate']),
});

/**
 * The leaves of the containers that are not in {@link MIRROR_FIELDS} as a whole (the integrations of a place hold credentials, its settings and its devices network data, and the invoicing of a company its credentials) that a read may
 * nevertheless name, each as its exact dotted path and never as a prefix: the type of the devices, the `status` of each integration of the activations, the two switches of the reservation widget, `tgm.status` and the hub of the
 * electronic invoicing. Naming `integrations`, `devices` or `roomsSettings` themselves stays refused.
 */
export const MIRROR_LEAVES: Readonly<Record<MirrorCollection, ReadonlySet<string>>> = Object.freeze({
  companies: new Set(['fattura_elettronica.hub']),
  places: new Set(['devices.type', ...ACTIVATION_PROVIDERS.map((provider) => `integrations.${provider}.status`), 'roomsSettings.reservation.status', 'roomsSettings.reservation.webWidget.status', 'tgm.status']),
});

/** Prefix of the computed keys a pipeline may add (`__sortKey`); they are never stored fields. */
const COMPUTED_PREFIX = '__';

/** The stages a read of the copies may use: none of them reads another collection or writes. */
const READ_STAGES: ReadonlySet<string> = new Set(['$match', '$addFields', '$sort', '$limit', '$skip', '$project']);

/** Operators that run code, or read a field by a name given as data: never allowed, anywhere. */
const FORBIDDEN_OPERATORS: ReadonlySet<string> = new Set(['$where', '$function', '$accumulator', '$getField', '$setField', '$unsetField']);

/** The only operators with a list of filters at the top of a filter document. */
const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(['$and', '$or', '$nor']);

/** Options of {@link GroupMirror.find}. */
export interface MirrorFindOptions {
  /** Allowlist of the fields to return (inclusion only, mandatory: the copies hold the credentials of the integrations). */
  readonly projection: MirrorProjection;
  /** Maximum number of documents, a positive integer (mandatory: no unbounded reads). */
  readonly limit: number;
  /** Sort order, if any. */
  readonly sort?: Sort;
  /** Server-side time limit in milliseconds, {@link LIST_MAX_TIME_MS} by default. */
  readonly maxTimeMS?: number;
}

/**
 * Read access to the copies of one collection restricted to one group. It is the only way the application reads
 * `common.companies` and `common.places`: the `groupId` condition cannot be left out (a `groupId` that is an array never matches),
 * and every read names the fields it returns, all of them from the central allowlist {@link MIRROR_FIELDS}.
 */
export interface GroupMirror {
  /**
   * Finds the documents of the group that match a filter.
   *
   * @param filter Filter of the operation; it is always combined with the group condition, so it can only narrow it.
   * @param options Projection allowlist, limit, sort and time limit.
   * @returns The documents, at most `limit`.
   * @throws {Error} If the filter names a field outside {@link MIRROR_FIELDS} or uses a forbidden operator, or the projection, the sort or the limit are not valid.
   */
  find(filter: Filter<Document>, options: MirrorFindOptions): Promise<Document[]>;
  /**
   * Runs a read pipeline over the documents of the group. The group condition is prepended as the first stage.
   *
   * @param pipeline Stages among `$match`, `$addFields` (computed `__` keys only), `$sort`, `$limit`, `$skip` and a final `$project`
   *   of allowlisted fields and computed keys; a `$limit` must come before the final `$project`.
   * @param maxTimeMS Server-side time limit in milliseconds, {@link LIST_MAX_TIME_MS} by default.
   * @returns The resulting documents.
   * @throws {Error} If a stage is not allowed (any stage that writes or reads another collection), a filter or expression names a field outside {@link MIRROR_FIELDS},
   *   an operator runs code, there is no `$limit`, or the last stage is not an allowlist projection.
   */
  aggregate(pipeline: readonly Document[], maxTimeMS?: number): Promise<Document[]>;
  /**
   * Counts the documents of the group that match a filter.
   *
   * @param filter Filter of the operation, combined with the group condition.
   * @param maxTimeMS Server-side time limit in milliseconds, {@link LIST_MAX_TIME_MS} by default.
   */
  countDocuments(filter: Filter<Document>, maxTimeMS?: number): Promise<number>;
}

function isPlainObject(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A document of the BSON tree that can hold operators: not an `ObjectId`, a date or a regular expression. */
function isContainer(value: unknown): value is Document {
  return isPlainObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** A field a filter or an expression may read: an allowlisted field, `groupId` (it can only narrow) or a computed key. */
function isReadable(root: string, name: MirrorCollection): boolean {
  return MIRROR_FIELDS[name].has(root) || root === 'groupId' || root.startsWith(COMPUTED_PREFIX);
}

/** A dotted path a filter, a sort or an expression may read: one of a readable field, or exactly one of the leaves of {@link MIRROR_LEAVES}. */
function isReadablePath(path: string, name: MirrorCollection): boolean {
  return isReadable(path.split('.', 1)[0]!, name) || MIRROR_LEAVES[name].has(path);
}

/** Throws if an operator that runs code, or reads a field by name, appears anywhere in a value. */
function rejectForbiddenOperators(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenOperators);
  } else if (isContainer(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(key)) {
        throw new Error(`Operator ${key} is not allowed on the copies`);
      }
      rejectForbiddenOperators(inner);
    }
  }
}

/** Throws if an aggregation expression references a field outside the allowlist (`'$integrations'`) or a system variable (`'$$ROOT'`). */
function assertExpression(value: unknown, name: MirrorCollection): void {
  rejectForbiddenOperators(value);
  if (typeof value === 'string' && value.startsWith('$')) {
    if (value.startsWith('$$') || !isReadablePath(value.slice(1), name)) {
      throw new Error('Reference to a field that is not readable on the copies');
    }
  } else if (Array.isArray(value)) {
    value.forEach((inner) => assertExpression(inner, name));
  } else if (isContainer(value)) {
    Object.values(value).forEach((inner) => assertExpression(inner, name));
  }
}

/** Throws unless a filter names only readable fields, uses `$expr` only with readable references, and holds no forbidden operator. */
function assertFilter(filter: unknown, name: MirrorCollection): asserts filter is Filter<Document> {
  if (!isContainer(filter)) {
    throw new Error('A read of the copies needs a filter object');
  }
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL_OPERATORS.has(key)) {
      if (!Array.isArray(value)) {
        throw new Error('A logical operator needs a list of filters');
      }
      value.forEach((inner) => assertFilter(inner, name));
    } else if (key === '$expr') {
      assertExpression(value, name);
    } else if (key.startsWith('$') || !isReadablePath(key, name)) {
      throw new Error('Filter on a field that is not readable on the copies');
    } else {
      rejectForbiddenOperators(value);
    }
  }
}

/** No extra projectable field. */
const NO_FIELDS: ReadonlySet<string> = new Set();

/** Throws unless a projection is inclusion-only and names allowlisted fields (and, when computed keys are admitted, `__` keys). */
function assertProjection(projection: unknown, name: MirrorCollection, computed: boolean, extra: ReadonlySet<string> = NO_FIELDS): asserts projection is MirrorProjection {
  if (!isContainer(projection)) {
    throw new Error('A read of the copies needs a projection');
  }
  const entries = Object.entries(projection);
  const allowed = ([field]: [string, unknown]): boolean => extra.has(field) || MIRROR_FIELDS[name].has(field.split('.', 1)[0]!) || MIRROR_LEAVES[name].has(field) || (computed && field.startsWith(COMPUTED_PREFIX));
  if (entries.length === 0 || entries.some((entry) => entry[1] !== 1 || !allowed(entry))) {
    throw new Error('A read of the copies needs an allowlist projection (inclusion of allowed fields only)');
  }
}

function assertSort(sort: unknown, name: MirrorCollection): void {
  if (!isContainer(sort) || Object.entries(sort).some(([field, direction]) => (direction !== 1 && direction !== -1) || !isReadablePath(field, name))) {
    throw new Error('A sort of the copies needs readable fields and a direction');
  }
}

function assertPipeline(pipeline: unknown, name: MirrorCollection, extra: ReadonlySet<string> = NO_FIELDS): asserts pipeline is readonly Document[] {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new Error('A read of the copies needs a pipeline');
  }
  pipeline.forEach((stage: unknown, index) => {
    const keys = isContainer(stage) ? Object.keys(stage) : [];
    const kind = keys[0];
    if (keys.length !== 1 || !READ_STAGES.has(kind!)) {
      throw new Error('Pipeline stage not allowed on the copies');
    }
    const body = (stage as Document)[kind!] as unknown;
    const last = index === pipeline.length - 1;
    switch (kind) {
      case '$match':
        assertFilter(body, name);
        break;
      case '$addFields':
        if (!isContainer(body) || Object.keys(body).some((key) => !key.startsWith(COMPUTED_PREFIX))) {
          throw new Error('$addFields may only compute keys with the __ prefix');
        }
        assertExpression(body, name);
        break;
      case '$sort':
        assertSort(body, name);
        break;
      case '$limit':
      case '$skip':
        if (!Number.isInteger(body) || (body as number) < (kind === '$limit' ? 1 : 0)) {
          throw new Error('A limit or a skip needs an integer');
        }
        break;
      default:
        if (!last) {
          throw new Error('Only the final stage may be a $project');
        }
        assertProjection(body, name, true, extra);
    }
  });
  const final = pipeline[pipeline.length - 1] as Document;
  if (!('$project' in final)) {
    throw new Error('A read of the copies needs a final allowlist projection');
  }
  if (!pipeline.slice(0, -1).some((stage: Document) => '$limit' in stage)) {
    throw new Error('A read of the copies needs a $limit before the final projection');
  }
}

/** The condition every read starts with: the group (equality, for the index) and a `groupId` that is not an array (a `groupId: [a, b]` would match both groups). */
function groupCondition(groupId: ObjectId): Filter<Document> {
  return { $and: [{ groupId }, { groupId: { $not: { $type: 'array' } } }] };
}

function build(groupId: ObjectId, databases: Databases, name: MirrorCollection): GroupMirror {
  if (!(groupId instanceof ObjectId)) {
    throw new Error('A read of the copies needs a group id');
  }
  if (!MIRROR_COLLECTIONS.includes(name)) {
    throw new Error('Not a copy collection');
  }
  // Literal names: the collection registry check requires every collection name to be a string literal.
  const collection = () => (name === 'companies' ? databases.common().collection('companies') : databases.common().collection('places'));
  const inGroup = (filter: Filter<Document>): Filter<Document> => {
    assertFilter(filter, name);
    return { $and: [groupCondition(groupId), filter] };
  };
  return {
    find: async (filter, options) => {
      const match = inGroup(filter);
      assertProjection(options.projection, name, false);
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error('A read of the copies needs a positive limit');
      }
      let cursor = collection().find(match, { projection: options.projection, limit: options.limit, maxTimeMS: options.maxTimeMS ?? LIST_MAX_TIME_MS });
      if (options.sort !== undefined) {
        assertSort(options.sort, name);
        cursor = cursor.sort(options.sort);
      }
      return cursor.toArray();
    },
    aggregate: async (pipeline, maxTimeMS = LIST_MAX_TIME_MS) => {
      assertPipeline(pipeline, name);
      return collection()
        .aggregate([{ $match: groupCondition(groupId) }, ...pipeline], { maxTimeMS })
        .toArray();
    },
    countDocuments: async (filter, maxTimeMS = LIST_MAX_TIME_MS) => collection().countDocuments(inGroup(filter), { maxTimeMS }),
  };
}

/**
 * Opens the copies of one collection for a group the caller was verified to reach. The access is checked again
 * against the principal (it must have been issued by `requireGroupAccess`), and every read is restricted to that group.
 * The group database and its cluster are not involved: the copies live in the common database.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param name `companies` or `places`.
 * @returns The read access to the copies of the group.
 * @throws {Error} If the access was not issued by `requireGroupAccess` or does not belong to the principal.
 */
export function groupMirror(principal: ScopeHolder, access: GroupAccess, databases: Databases, name: MirrorCollection): GroupMirror {
  assertVerifiedGroupAccess(principal, access);
  return build(access.groupId, databases, name);
}

/**
 * Opens the copies of one collection for a group id that does not come from the request but from a stored document
 * (the group a user belongs to). Use {@link groupMirror} whenever a verified access exists.
 *
 * @param groupId Id of the group, from a stored document.
 * @param databases Database accessor.
 * @param name `companies` or `places`.
 * @returns The read access to the copies of the group.
 * @throws {Error} If `groupId` is not an `ObjectId`.
 */
export function trustedGroupMirror(groupId: ObjectId, databases: Databases, name: MirrorCollection): GroupMirror {
  return build(groupId, databases, name);
}

/**
 * Counts, with one aggregation, the copies of several groups by group and by trash state (`trash: true` is trashed, anything
 * else is active). It is the only multi-group read of the copies: the pipeline is built here (a `$match` on the groups and a
 * `$group`), nothing is taken from the caller, and a copy whose `groupId` is an array or is not an `ObjectId` is never counted.
 * The group ids must come from a page already restricted to the caller's perimeter, never from the client.
 *
 * @param databases Database accessor.
 * @param name `companies` or `places`.
 * @param groupIds Ids of the groups of the page: a non-empty list of at most {@link MAX_LIMIT} `ObjectId`s.
 * @returns The counts by group (hex id), with zeros for a group that holds nothing.
 * @throws {Error} If `name` is not a copy collection, or the list is empty, too long or holds something that is not an `ObjectId`.
 */
export async function countMirrorByGroups(databases: Databases, name: MirrorCollection, groupIds: readonly ObjectId[]): Promise<Map<string, TrashCount>> {
  if (!MIRROR_COLLECTIONS.includes(name)) {
    throw new Error('Not a copy collection');
  }
  assertCountedGroups(groupIds);
  // Literal names: the collection registry check requires every collection name to be a string literal.
  const collection = name === 'companies' ? databases.common().collection('companies') : databases.common().collection('places');
  const rows = await collection.aggregate(countByGroupPipeline(groupIds), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
  return countsByGroup(groupIds, rows);
}

/** The groups a cross-group list reads: every group (the platform), or exactly the listed ones (a dealer, or a filter). */
export type MirrorListGroups = { readonly kind: 'all' } | { readonly kind: 'include'; readonly ids: readonly ObjectId[] };

/** Most groups one cross-group list names: the cap on the groups of a dealer, so the group set of a read is bounded like the others. */
export const MAX_LIST_GROUPS = MAX_DEALER_GROUPS;

/** The one field a cross-group list adds to the allowlist of the projection: the group each document belongs to. */
const LIST_EXTRA_FIELDS: ReadonlySet<string> = new Set(['groupId']);

/** The condition of a cross-group list on the group: a real `ObjectId` (never an array) that is one of the listed groups, or any. */
function listGroupsCondition(groups: MirrorListGroups): Filter<Document> {
  const notArray: Filter<Document> = { groupId: { $not: { $type: 'array' } } };
  return groups.kind === 'all' ? { $and: [{ groupId: { $type: 'objectId' } }, notArray] } : { $and: [{ groupId: { $in: [...groups.ids] } }, notArray] };
}

/**
 * Reads a page of the copies of several groups at once (the cross-group lists of companies and places): the only multi-group read of the copies that returns registry data. The group
 * condition is built here from the groups the caller resolved from the caller's verified scope (never from the client), prepended to the pipeline; the pipeline passes the same checks as
 * {@link GroupMirror.aggregate} (read stages only, allowlisted fields, a `$limit` before the final allowlist projection), and the projection may also name `groupId`. A read that
 * exceeds its time limit is a `503`.
 *
 * @param databases Database accessor.
 * @param name `companies` or `places`.
 * @param groups Every group, or the listed ones (a non-empty list of at most {@link MAX_LIST_GROUPS} `ObjectId`s).
 * @param pipeline The stages of the list (see {@link GroupMirror.aggregate}).
 * @returns The documents, as the pipeline cuts them.
 * @throws {Error} If `name` is not a copy collection, the groups are not valid, or the pipeline is not allowed.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
 */
export async function readMirrorList(databases: Databases, name: MirrorCollection, groups: MirrorListGroups, pipeline: readonly Document[]): Promise<Document[]> {
  if (!MIRROR_COLLECTIONS.includes(name)) {
    throw new Error('Not a copy collection');
  }
  if (groups.kind === 'include' && (groups.ids.length === 0 || groups.ids.length > MAX_LIST_GROUPS || groups.ids.some((id: unknown) => !(id instanceof ObjectId)))) {
    throw new Error(`A cross-group read needs between 1 and ${MAX_LIST_GROUPS} group ids`);
  }
  assertPipeline(pipeline, name, LIST_EXTRA_FIELDS);
  // Literal names: the collection registry check requires every collection name to be a string literal.
  const collection = name === 'companies' ? databases.common().collection('companies') : databases.common().collection('places');
  return bounded(() => collection.aggregate([{ $match: listGroupsCondition(groups) }, ...pipeline], { maxTimeMS: LIST_MAX_TIME_MS }).toArray());
}

/**
 * Reads a page of device rows from the copies of the places of several groups (the diagnostics): the only multi-group read of the places that returns data of the places. The pipeline is
 * built by {@link deviceRowsPipeline}, so nothing but the allowed fields of the devices leaves the database, and the groups and the perimeter must come from the caller's verified scope.
 *
 * @param databases Database accessor.
 * @param query The groups, the perimeter and the filters.
 * @param after Where to continue from, or `null` for the first page.
 * @param limit How many rows to read, a positive integer.
 * @returns The rows, at most `limit`.
 * @throws {Error} If there is no group to read, or the limit is not a positive integer.
 */
export async function readMirrorDevices(databases: Databases, query: DeviceRowsQuery, after: DeviceAfter | null, limit: number): Promise<Document[]> {
  assertDeviceQuery(query, limit);
  return databases.common().collection('places').aggregate(deviceRowsPipeline(query, after, limit), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
}

/**
 * Counts the device rows of a query, stopping just past `cap`.
 *
 * @param databases Database accessor.
 * @param query The groups, the perimeter and the filters.
 * @param cap The largest count that matters, a positive integer.
 * @returns The number of rows, at most `cap + 1`.
 * @throws {Error} If there is no group to read, or the cap is not a positive integer.
 */
export async function countMirrorDevices(databases: Databases, query: DeviceRowsQuery, cap: number): Promise<number> {
  assertDeviceQuery(query, cap);
  const [counted] = await databases.common().collection('places').aggregate(deviceCountPipeline(query, cap), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
  return (counted?.['total'] as number | undefined) ?? 0;
}

/**
 * The ids of the companies in the trash of the groups of a read, read from the copies, so that the places of a trashed company can be left out of it. With a `companyId` the
 * question is only whether that company is in the trash.
 *
 * @param databases Database accessor.
 * @param groups The groups of the read.
 * @param companyId The company the read is narrowed to, if any.
 * @param max The most ids to read; reaching it is an error, because the exclusion would be incomplete.
 * @returns The ids.
 * @throws {Error} If the groups are not valid or there are `max` trashed companies or more.
 */
export async function trashedCompanyIds(databases: Databases, groups: GroupSelection, companyId: ObjectId | undefined, max: number): Promise<ObjectId[]> {
  assertSelection(groups);
  const found = await databases
    .common()
    .collection('companies')
    .find({ $and: [selectionCondition(groups), { trash: true }, ...(companyId === undefined ? [] : [{ _id: companyId }])] }, { projection: { _id: 1 }, limit: max, maxTimeMS: LIST_MAX_TIME_MS })
    .toArray();
  if (found.length >= max) {
    throw new Error('Too many companies in the trash to exclude them');
  }
  return found.map((company) => company['_id'] as ObjectId);
}

/** Most places (or companies) a read of the activations returns in one batch. */
export const ACTIVATION_BATCH_MAX = 1000;

/**
 * Reads a batch of the places activated in a window from the copies, for the activations (the billing of the dealers): the places not in the trash of the given groups, by `_id`, after a position. The filter is built here
 * from the window and the ids, and the projection is the fixed {@link ACTIVATION_PLACE_PROJECTION}: of a place only its registry fields, the date of its activation and the leaves that decide a service ever leave the database.
 *
 * @param databases Database accessor.
 * @param window The window of the activation date: `from` included (`null` for none), `to` excluded.
 * @param groupIds The groups to read (already restricted to the caller's perimeter), or `null` for every group.
 * @param after The `_id` of the last place already read, or `null` for the first batch.
 * @param limit How many places to read at most, from 1 to {@link ACTIVATION_BATCH_MAX}.
 * @returns The places, by `_id`.
 * @throws {Error} If the window, the groups, the position or the limit are not valid.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
 */
export async function readMirrorActivationPlaces(databases: Databases, window: ActivationWindow, groupIds: readonly ObjectId[] | null, after: ObjectId | null, limit: number): Promise<Document[]> {
  if (!(window.to instanceof Date) || Number.isNaN(window.to.getTime()) || (window.from !== null && (!(window.from instanceof Date) || Number.isNaN(window.from.getTime())))) {
    throw new Error('A read of the activations needs a window of dates');
  }
  if (groupIds !== null && (groupIds.length === 0 || groupIds.some((id: unknown) => !(id instanceof ObjectId)))) {
    throw new Error('A read of the activations needs group ids');
  }
  if (after !== null && !(after instanceof ObjectId)) {
    throw new Error('A read of the activations needs a position that is an id');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVATION_BATCH_MAX) {
    throw new Error('A read of the activations needs a limit between 1 and the batch maximum');
  }
  return bounded(() =>
    databases
      .common()
      .collection('places')
      .find(activationPlacesFilter(window, groupIds, after), { projection: { ...ACTIVATION_PLACE_PROJECTION }, sort: { _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS })
      .toArray(),
  );
}

/**
 * Reads the companies of a batch of places from the copies, for the activations: the companies with the given ids (the caller checks that each belongs to the group of the place), projected with the fixed
 * {@link ACTIVATION_COMPANY_PROJECTION}, so nothing of a company but its name, its state and the hub of its electronic invoicing leaves the database.
 *
 * @param databases Database accessor.
 * @param companyIds The ids of the companies, a non-empty list of at most {@link ACTIVATION_BATCH_MAX}.
 * @returns The companies found (not necessarily all of them).
 * @throws {Error} If the list is empty, too long or holds something that is not an `ObjectId`.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
 */
export async function readMirrorActivationCompanies(databases: Databases, companyIds: readonly ObjectId[]): Promise<Document[]> {
  if (companyIds.length === 0 || companyIds.length > ACTIVATION_BATCH_MAX || companyIds.some((id: unknown) => !(id instanceof ObjectId))) {
    throw new Error('A read of the companies of the activations needs between 1 and the batch maximum company ids');
  }
  return bounded(() =>
    databases
      .common()
      .collection('companies')
      .find({ _id: { $in: [...companyIds] } }, { projection: { ...ACTIVATION_COMPANY_PROJECTION }, limit: companyIds.length, maxTimeMS: LIST_MAX_TIME_MS })
      .toArray(),
  );
}

function assertSelection(groups: GroupSelection): void {
  if ((groups.kind === 'include' && groups.ids.length === 0) || groups.ids.some((id: unknown) => !(id instanceof ObjectId))) {
    throw new Error('A read of the devices needs group ids');
  }
}

function assertDeviceQuery(query: DeviceRowsQuery, limit: number): void {
  assertSelection(query.groups);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('A read of the devices needs a positive limit');
  }
}

/** The stored paths of a place that name an e-mail template: the five of the reservations and the one of the appointments. */
const TEMPLATE_REFERENCE_PATHS: readonly string[] = Object.freeze([
  'roomsSettings.reservation.emailNotification.templateId',
  'roomsSettings.reservation.email.templateId',
  'roomsSettings.reservation.emailConfirmedStatus.templateId',
  'roomsSettings.reservation.emailRefusedStatus.templateId',
  'roomsSettings.reservation.emailChangeStatus.templateId',
  'appointment.email.templateId',
]);

/**
 * Finds the places of a group, trashed ones included, that name an e-mail template in the settings of their reservations or appointments (step T2: the deletion of a template is refused while
 * one does). It is the only read of the copies that looks inside `appointment` and `roomsSettings`, and it returns nothing of them: only `_id`, `name` and `companyId` (so the caller can tell which places are inside the perimeter of the user). The paths are fixed here and the
 * template id is the only thing the caller supplies (as an `ObjectId`, matched also in its text form, which the legacy may have stored).
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param templateId Id of the template.
 * @param limit How many places to return at most, a positive integer.
 * @returns The places (`_id`, `name`, `companyId`), by id, at most `limit`.
 * @throws {Error} If the access was not issued by `requireGroupAccess` for the principal, the id is not an `ObjectId`, or the limit is not a positive integer.
 */
export async function findPlacesUsingTemplate(principal: ScopeHolder, access: GroupAccess, databases: Databases, templateId: ObjectId, limit: number): Promise<Document[]> {
  assertVerifiedGroupAccess(principal, access);
  if (!(templateId instanceof ObjectId)) {
    throw new Error('A read of the places that use a template needs a template id');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('A read of the places that use a template needs a positive limit');
  }
  const named = [templateId, templateId.toHexString()];
  return databases
    .common()
    .collection('places')
    .find({ $and: [groupCondition(access.groupId), { $or: TEMPLATE_REFERENCE_PATHS.map((path) => ({ [path]: { $in: named } })) }] }, { projection: { _id: 1, name: 1, companyId: 1 }, limit, sort: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })
    .toArray();
}

/**
 * Reads the lists of items of some places of a group that the categories and the products of its catalog refer to (steps C2 and C3): `printStations[].id`, `productionCenter[].id` (a category or a product names a print
 * station and a production center of each place it is for) and `storages[].id` (a product has a stock in a storage of a place). It is the only read of the copies that looks inside those three lists, and it returns nothing but the ids in them.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param placeIds The places, at most a few hundred (the read is limited to their number).
 * @returns The places that exist in the copies (`_id`, and the ids of the two lists).
 * @throws {Error} If the access was not issued by `requireGroupAccess` for the principal, or the list is empty or has anything but `ObjectId`s.
 */
export async function readPlaceSetups(principal: ScopeHolder, access: GroupAccess, databases: Databases, placeIds: readonly ObjectId[]): Promise<Document[]> {
  assertVerifiedGroupAccess(principal, access);
  if (placeIds.length === 0 || !placeIds.every((id) => id instanceof ObjectId)) {
    throw new Error('A read of the print stations of some places needs their ids');
  }
  return databases
    .common()
    .collection('places')
    .find({ $and: [groupCondition(access.groupId), { _id: { $in: [...placeIds] } }] }, { projection: { _id: 1, 'printStations.id': 1, 'productionCenter.id': 1, 'storages.id': 1 }, limit: placeIds.length, maxTimeMS: LIST_MAX_TIME_MS })
    .toArray();
}

/**
 * The points of sale of a group that are not in the trash, with the id and name of their print stations, by name: what the columns of the catalog workbook (step C6) are made of. Read from the copies in
 * the common database, only with that projection. A company or place administrator passes the places of his perimeter.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param placeIds The places to read (the perimeter of the caller), `null` for every place of the group.
 * @param limit How many places to return at most, a positive integer.
 * @returns The places (`_id`, `name`, `printStations`), at most `limit`.
 * @throws {Error} If the access was not issued by `requireGroupAccess` for the principal, or the ids are not `ObjectId`s.
 */
export async function readCatalogPlaces(principal: ScopeHolder, access: GroupAccess, databases: Databases, placeIds: readonly ObjectId[] | null, limit: number): Promise<Document[]> {
  assertVerifiedGroupAccess(principal, access);
  if (placeIds !== null && !placeIds.every((id) => id instanceof ObjectId)) {
    throw new Error('A read of the places of the catalog workbook needs their ids');
  }
  return databases
    .common()
    .collection('places')
    .find({ $and: [groupCondition(access.groupId), { trash: { $ne: true } }, ...(placeIds === null ? [] : [{ _id: { $in: [...placeIds] } }])] }, { projection: { _id: 1, name: 1, 'printStations.id': 1, 'printStations.name': 1 }, sort: { name: 1, _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS })
    .toArray();
}

/**
 * Finds the places of a group, trashed ones included, that still refer to a product category (step C2: the deletion of a category is refused while one does): in the categories a print station makes
 * a summary of, in the kiosk, in the self ordering of any price list and in the map to the categories of TS Hospitality. It is the only read of the copies that looks inside those settings, and it
 * returns nothing but ids. The paths are fixed here and the category id is the only thing the caller supplies (as an `ObjectId`; the places keep it as text).
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @param categoryId Id of the category.
 * @param limit How many places to return at most, a positive integer.
 * @returns The ids of the places, by id, at most `limit`.
 * @throws {Error} If the access was not issued by `requireGroupAccess` for the principal, the id is not an `ObjectId`, or the limit is not a positive integer.
 */
export async function findPlacesUsingCategory(principal: ScopeHolder, access: GroupAccess, databases: Databases, categoryId: ObjectId, limit: number): Promise<ObjectId[]> {
  assertVerifiedGroupAccess(principal, access);
  if (!(categoryId instanceof ObjectId)) {
    throw new Error('A read of the places that use a category needs a category id');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('A read of the places that use a category needs a positive limit');
  }
  const hex = categoryId.toHexString();
  // `selfOrdering.priceListsConfig` is a map by price list: its keys are made at run time, so it is read with `$objectToArray`.
  const inSelfOrdering: Document = {
    $expr: {
      $anyElementTrue: {
        $map: {
          input: { $objectToArray: { $cond: [{ $eq: [{ $type: '$selfOrdering.priceListsConfig' }, 'object'] }, '$selfOrdering.priceListsConfig', {}] } },
          as: 'config',
          in: { $cond: [{ $isArray: '$$config.v.productsCategories' }, { $in: [hex, { $map: { input: '$$config.v.productsCategories', as: 'category', in: '$$category._id' } }] }, false] },
        },
      },
    },
  };
  const found = await databases
    .common()
    .collection('places')
    .find(
      {
        $and: [
          groupCondition(access.groupId),
          { $or: [{ 'printStations.summaryCategoriesIds': hex }, { 'kiosk.upsellingCategoryId': hex }, { 'kiosk.productsCategories._id': hex }, { [`integrations.tsh.categoriesMap.${hex}`]: { $exists: true } }, inSelfOrdering] },
        ],
      },
      { projection: { _id: 1 }, limit, sort: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS },
    )
    .toArray();
  return found.map((place) => place['_id'] as ObjectId);
}

/** The ids of the companies or places of the copies that use a country or a province (trashed ones included), at most the limit of the read: a client cannot tell exactly the limit from more. */
export interface CountryUsageOfKind {
  /** Ids of the documents, by id. */
  readonly ids: ObjectId[];
}

/** The companies and the places of every group that use a country, or a province of it. */
export interface CountryUsage {
  readonly companies: CountryUsageOfKind;
  readonly places: CountryUsageOfKind;
}

/** The format of a country code and of an area code, the only values {@link readCountryUsage} accepts. */
const COUNTRY_CODE_FORMAT = /^[A-Z]{2}$/;

/**
 * Finds the companies and the places, of any group and trashed ones included, that name a country (`countryCode`) or a province of it (`countryAreaCode`) in the copies of the common database: the deletion
 * of a country or of a province is refused while one does (step 9-ter). It is the only read of the copies that looks across all the groups by a country, and it returns nothing but ids. The fields are
 * fixed here and the codes are the only things the caller supplies (checked as two uppercase letters, so no operator can be passed through them); they are matched in their four spellings (`IT`, `it`, `It`, `iT`),
 * because the legacy may have stored them in another case. The read is bounded by `limit` and by a time limit: nothing is counted without a bound.
 *
 * @param databases Database accessor.
 * @param countryCode The country code, two uppercase letters.
 * @param areaCode The province code, two uppercase letters, or `null` to look at the whole country.
 * @param limit How many ids of each kind to return at most, a positive integer.
 * @returns For each kind, the ids (at most `limit`, by id).
 * @throws {Error} If a code is not two uppercase letters or the limit is not a positive integer.
 * @throws {AppError} `SERVICE_UNAVAILABLE` when a read exceeds its time limit: the answer is unknown, so the caller must not go on as if nothing used the country.
 */
export async function readCountryUsage(databases: Databases, countryCode: string, areaCode: string | null, limit: number): Promise<CountryUsage> {
  if (!COUNTRY_CODE_FORMAT.test(countryCode) || (areaCode !== null && !COUNTRY_CODE_FORMAT.test(areaCode))) {
    throw new Error('A read of the copies by country needs codes of two uppercase letters');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('A read of the copies by country needs a positive limit');
  }
  const filter: Filter<Document> = areaCode === null ? { countryCode: { $in: codeVariants(countryCode) } } : { countryCode: { $in: codeVariants(countryCode) }, countryAreaCode: { $in: codeVariants(areaCode) } };
  const read = async (collection: Collection<Document>): Promise<CountryUsageOfKind> => {
    const documents = await collection.find(filter, { projection: { _id: 1 }, limit, sort: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }).toArray();
    return { ids: documents.map((document) => document['_id'] as ObjectId) };
  };
  try {
    // Literal names: the collection registry check requires every collection name to be a string literal.
    const [companies, places] = await Promise.all([read(databases.common().collection('companies')), read(databases.common().collection('places'))]);
    return { companies, places };
  } catch (error) {
    throw error instanceof MongoServerError && error.code === MAX_TIME_EXPIRED ? new AppError('SERVICE_UNAVAILABLE') : error;
  }
}
