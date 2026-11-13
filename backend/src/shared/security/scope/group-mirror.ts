import { ObjectId } from 'mongodb';
import type { Document, Filter, Sort } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';
import { LIST_MAX_TIME_MS, MAX_LIMIT } from '../../http/list.ts';
import { assertVerifiedGroupAccess } from './group-access.ts';
import { assertCountedGroups, countByGroupPipeline, countsByGroup } from './group-counts.ts';
import type { TrashCount } from './group-counts.ts';
import type { GroupAccess } from './group-access.ts';
import type { AuthPrincipal } from './principal.ts';

/** The copies kept in the common database (`common.companies`, `common.places`) that this module can read. */
export type MirrorCollection = 'companies' | 'places';

/** Inclusion-only projection (`{ field: 1 }`): the allowlist of the fields a read may return. */
export type MirrorProjection = Readonly<Record<string, 1>>;

const MIRROR_COLLECTIONS: readonly string[] = ['companies', 'places'];

/**
 * The fields of each copy collection an application read may name, return or compute from: the one central allowlist.
 * The copies hold the credentials of the integrations of the places and the bank data of the companies, so nothing else is ever readable:
 * the companies expose, besides the compact reference (`name`, `trash`), the fields of the list of companies (`code`, `city`, `countryAreaCode`, `countryCode`, `status`).
 */
export const MIRROR_FIELDS: Readonly<Record<MirrorCollection, ReadonlySet<string>>> = Object.freeze({
  companies: new Set(['_id', 'name', 'trash', 'code', 'city', 'countryAreaCode', 'countryCode', 'status']),
  places: new Set(['_id', 'name', 'trash', 'companyId']),
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
    const root = value.slice(1).split('.', 1)[0]!;
    if (value.startsWith('$$') || !isReadable(root, name)) {
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
    } else if (key.startsWith('$') || !isReadable(key.split('.', 1)[0]!, name)) {
      throw new Error('Filter on a field that is not readable on the copies');
    } else {
      rejectForbiddenOperators(value);
    }
  }
}

/** Throws unless a projection is inclusion-only and names allowlisted fields (and, when computed keys are admitted, `__` keys). */
function assertProjection(projection: unknown, name: MirrorCollection, computed: boolean): asserts projection is MirrorProjection {
  if (!isContainer(projection)) {
    throw new Error('A read of the copies needs a projection');
  }
  const entries = Object.entries(projection);
  const allowed = ([field]: [string, unknown]): boolean => MIRROR_FIELDS[name].has(field.split('.', 1)[0]!) || (computed && field.startsWith(COMPUTED_PREFIX));
  if (entries.length === 0 || entries.some((entry) => entry[1] !== 1 || !allowed(entry))) {
    throw new Error('A read of the copies needs an allowlist projection (inclusion of allowed fields only)');
  }
}

function assertSort(sort: unknown, name: MirrorCollection): void {
  if (!isContainer(sort) || Object.entries(sort).some(([field, direction]) => (direction !== 1 && direction !== -1) || !isReadable(field.split('.', 1)[0]!, name))) {
    throw new Error('A sort of the copies needs readable fields and a direction');
  }
}

function assertPipeline(pipeline: unknown, name: MirrorCollection): asserts pipeline is readonly Document[] {
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
        assertProjection(body, name, true);
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
export function groupMirror(principal: AuthPrincipal, access: GroupAccess, databases: Databases, name: MirrorCollection): GroupMirror {
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
