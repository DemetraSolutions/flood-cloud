import { ObjectId } from 'mongodb';
import type { ClientSession, Collection, Document, Filter } from 'mongodb';
import { COLLECTIONS, USERS_OWNED_TREES } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, escapeRegExp, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListParams } from '../../shared/http/list.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { legacyScopeIds } from '../../shared/security/scope/legacy-scope.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { normalizeUsername } from '../../shared/security/username.ts';
import { READ_ONLY_MODULE } from '../../shared/security/rbac/permission-matrix.ts';
import { OWNED_PERMISSION_MODULES, fromLegacy } from './user.mapper.ts';
import type { StoredUser } from '../../shared/security/scope/principal.ts';
import { USERS_LIST } from './users.list.ts';
import type { AuthRecord, LegacyUserDocument, LegacyUserUpdate, LoginRecord, MappedUser, UserStatus } from './user.types.ts';

/** Candidates read when looking a username up without regard to case: more than this is not a real situation. */
const MAX_USERNAME_CANDIDATES = 20;

/** A projection value: an inclusion flag or a computed expression. */
type Projection = Readonly<Record<string, 1 | Document>>;

/**
 * Computed fields that tell whether the picture and the PIN are set without loading them: the PIN is never read, and the lists
 * never load the picture (a picture is up to 200 KB, and 100 rows would carry 20 MB).
 */
const PRESENCE: Projection = Object.freeze({
  __hasAvatar: { $and: [{ $eq: [{ $type: '$avatar' }, 'string'] }, { $ne: ['$avatar', ''] }] },
  __pinSet: { $and: [{ $eq: [{ $type: '$pin' }, 'string'] }, { $ne: ['$pin', ''] }] },
});

/**
 * Fields read to build a {@link MappedUser}: the profile, status, scope, the flags of every module of the matrix, the POS data
 * (`permissions.apps`), the shifts, the service ids and the computed `__hasAvatar` and `__pinSet`. `password`, `pin`, `tokens`
 * and `avatar` are not in the list, so they are never loaded.
 */
const USER_PROJECTION: Projection = Object.freeze({
  userName: 1,
  username: 1,
  name: 1,
  surname: 1,
  email: 1,
  telephone: 1,
  description: 1,
  role: 1,
  dealerId: 1,
  groupId: 1,
  companyId: 1,
  placeId: 1,
  placesId: 1,
  servicesId: 1,
  status: 1,
  trash: 1,
  trashDate: 1,
  'settings.language': 1,
  'settings.theme': 1,
  'settings.hiddenInStats': 1,
  'permissions.status': 1,
  'permissions.hiddenInStats': 1,
  ...Object.fromEntries(OWNED_PERMISSION_MODULES.flatMap((module) => (module === READ_ONLY_MODULE ? [[`permissions.${module}.r`, 1]] : [[`permissions.${module}.r`, 1], [`permissions.${module}.w`, 1]]))),
  'permissions.apps': 1,
  shiftTime: 1,
  insertDate: 1,
  updateDate: 1,
  ...PRESENCE,
});

/** What the detail of a user needs on top of {@link USER_PROJECTION}: the picture. */
const DETAIL_PROJECTION: Projection = Object.freeze({ ...USER_PROJECTION, avatar: 1 });

/** What the login needs on top of {@link USER_PROJECTION}: the legacy hash, for the verifier only. */
const LOGIN_PROJECTION: Projection = Object.freeze({ ...USER_PROJECTION, password: 1 });

/**
 * What authenticating a request needs, read on every request: identity, role, status, scope and the
 * whole stored permission matrix (its non-core modules limit what the user can grant). No personal
 * data, no password, no token.
 */
const AUTH_PROJECTION: Projection = Object.freeze({
  userName: 1,
  username: 1,
  role: 1,
  dealerId: 1,
  groupId: 1,
  companyId: 1,
  placeId: 1,
  placesId: 1,
  status: 1,
  trash: 1,
  permissions: 1,
});

/**
 * What managing a user needs: the detail of {@link DETAIL_PROJECTION} and, whole, the stored permission matrix
 * (its non-core modules limit what the actor may grant). No password, PIN or token.
 */
const MANAGE_PROJECTION: Projection = Object.freeze({
  ...Object.fromEntries(Object.entries(DETAIL_PROJECTION).filter(([key]) => !key.startsWith('permissions.'))),
  permissions: 1,
});

/** A page of users. */
export interface UserPage {
  readonly users: readonly MappedUser[];
  readonly page: PageInfo;
}

/** Collects the leaf paths of a document: plain objects with content are walked, anything else (arrays, dates, ids, an empty object) is a leaf. */
function leafPaths(value: Document, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype && Object.keys(item).length > 0
      ? leafPaths(item as Document, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

/** Whether a path may be written: an owned field, or anything below one of the owned maps. */
const isOwnedPath = (owned: ReadonlySet<string>, path: string): boolean => owned.has(path) || USERS_OWNED_TREES.some((tree) => path.startsWith(`${tree}.`));

/** The containers of the POS and of the shifts. */
const REPAIRABLE = /^(shiftTime|permissions\.apps)(\.|$)/;

/** The part of a user that other modules show next to their own data. */
export interface UserSummary {
  readonly username: string;
  readonly status: UserStatus;
}

/** Reads and updates the shared legacy `common.users` collection, translating it to the domain model. */
export interface UsersRepository {
  /**
   * Reads a user by id.
   *
   * @param id Id of the user.
   * @returns The user and its anomalies, or `null` when it does not exist.
   */
  findById(id: ObjectId): Promise<MappedUser | null>;
  /**
   * Reads a user with the minimum a request needs to be authenticated (see {@link AuthRecord}).
   *
   * @param id Id of the user.
   * @returns The record, or `null` when the user does not exist.
   */
  findAuthRecord(id: ObjectId): Promise<AuthRecord | null>;
  /**
   * Reads the user name and status of several dealer users (role `D`) at once (one query), for the modules that show a linked user.
   *
   * @param ids Ids of the users, at most a page (a few hundred).
   * @returns The summaries by hex id; an id with no user is simply absent.
   */
  findSummaries(ids: readonly ObjectId[]): Promise<Map<string, UserSummary>>;
  /**
   * Reads one user to manage him: the profile, the scope ids and the whole stored permission matrix.
   * The filter decides who can be found, so callers build it with `withScope`.
   *
   * @param filter Scope-limited filter that selects exactly one user (by `_id`).
   * @returns The record, or `null` when no user matches.
   */
  findManaged(filter: Filter<Document>): Promise<AuthRecord | null>;
  /**
   * Reads a page of users. The scope filter is combined with `withScope`, then the resource filters,
   * the search and the cursor; the order is applied before the page is cut, with `_id` as the tie-breaker.
   *
   * @param scopeFilter Filter of the caller's perimeter (`usersScopeFilter`) and of the area (a group, the platform).
   * @param filter Filters of the request (role, status, trash…).
   * @param params Validated list parameters.
   * @returns The users of the page and its `{ limit, next }`.
   */
  list(scopeFilter: Filter<Document>, filter: Filter<Document>, params: ListParams): Promise<UserPage>;
  /**
   * The ids of the users that match a filter, in `_id` order (a stable order, so a bulk operation that repeats finds the next ones), at most `limit`. The filter carries the scope
   * (`usersScopeFilter`) and the trash condition: callers build it with `withScope`.
   *
   * @param filter Scope-limited filter.
   * @param limit Most ids returned (a positive integer).
   */
  findTrashedIds(filter: Filter<Document>, limit: number): Promise<ObjectId[]>;
  /**
   * How many users match a filter (scope-limited, as for {@link UsersRepository.findTrashedIds}).
   *
   * @param filter Scope-limited filter.
   */
  countTrashed(filter: Filter<Document>): Promise<number>;
  /**
   * Inserts a new user document built by `toLegacyDocument`.
   *
   * @param document The document, with `_id`.
   * @param session Transaction the write belongs to, if any.
   * @returns The user as read back from the stored shape.
   * @throws {Error} If the document has a field the backend does not own.
   * @throws {MongoServerError} Duplicate key (`11000`) when the exact user name exists.
   */
  insert(document: Document, session?: ClientSession): Promise<MappedUser>;
  /**
   * Deletes a user document, but only while it is in the trash: the check and the delete are one operation.
   *
   * @param id Id of the user.
   * @param session Transaction the write belongs to, if any.
   * @returns `false` when the user does not exist or is not in the trash.
   */
  deleteTrashed(id: ObjectId, session?: ClientSession): Promise<boolean>;
  /**
   * Reads a user with the legacy password hash, to check a password outside the login.
   *
   * @param id Id of the user.
   * @returns The login record (the hash never leaves the verification flow), or `null`.
   */
  findLoginRecordById(id: ObjectId): Promise<LoginRecord | null>;
  /**
   * Finds the user a login attempt refers to. First an exact match on `userName`; if there is none,
   * a case-insensitive search with an anchored, escaped pattern whose candidates are filtered in
   * memory with {@link normalizeUsername}, accepted only when exactly one user matches (an ambiguous
   * name logs nobody in). The legacy password hash is read for the verifier.
   *
   * @param username Username as typed by the client.
   * @returns The login record, or `null` for no match or an ambiguous one.
   */
  findByUsernameForLogin(username: string): Promise<LoginRecord | null>;
  /**
   * Tells whether a username is already used by another user (D-15), comparing
   * {@link normalizeUsername} of `userName` and of the older `username` field.
   *
   * @param username Candidate username.
   * @param excludeId User that may keep its own name (the one being edited).
   */
  isUsernameTaken(username: string, excludeId?: ObjectId): Promise<boolean>;
  /**
   * Applies an update built by `toLegacyUpdate`. The update is refused if it touches a field the
   * backend does not own.
   *
   * @param id Id of the user.
   * @param update `$set`/`$unset` update.
   * @param session Transaction the write belongs to, if any.
   * @param onlyIf When `{ trash: true }`, the update applies only to a user that is in the trash at the moment of the write (the check and the write are one operation: a lost race is `false`).
   * @returns `false` when the user does not exist, or is not in the state `onlyIf` asks for.
   * @throws {Error} If the update contains a field outside the owned fields or an operator other than `$set` and `$unset`.
   */
  updateOwned(id: ObjectId, update: LegacyUserUpdate, session?: ClientSession, onlyIf?: { readonly trash: true }): Promise<boolean>;
  /**
   * Empties the legacy `tokens[]` so that the legacy platform disconnects the user at once (D-11).
   *
   * @param id Id of the user.
   * @param session Transaction the write belongs to, if any.
   * @returns `false` when the user does not exist.
   */
  clearLegacyTokens(id: ObjectId, session?: ClientSession): Promise<boolean>;
  /**
   * Empties the legacy `tokens[]` of several users at once (D-11), for the operations that end the sessions of a whole group.
   *
   * @param ids Ids of the users, at most one batch.
   * @param session Transaction the write belongs to (a batch commits whole or not at all).
   * @returns How many users matched.
   */
  clearLegacyTokensOfMany(ids: readonly ObjectId[], session: ClientSession): Promise<number>;
  /**
   * Reads, in the order of their ids, a batch of the ids of the users of a group (every role, trashed ones included), to walk
   * a large group without loading it whole.
   *
   * @param groupId The group.
   * @param after The last id of the previous batch, `null` for the first.
   * @param limit Size of the batch.
   * @returns At most `limit` ids; an empty list when there are no more.
   */
  findIdsOfGroup(groupId: ObjectId, after: ObjectId | null, limit: number): Promise<ObjectId[]>;
}

/**
 * Builds the users repository over `common.users`. The only code that knows the legacy document shape.
 *
 * @param databases Database accessor.
 */
export function createUsersRepository(databases: Databases): UsersRepository {
  const users = (): Collection<Document> => databases.common().collection('users');
  const owned = new Set(COLLECTIONS.common.users.ownedFields);

  /**
   * A `$set` of a path below `shiftTime` or `permissions.apps` fails when a parent exists but is not an object (a legacy `shiftTime: null` or `0`).
   * Before the update, each such parent is replaced by an empty object: nothing else of it could be kept, and a parent that is missing is created
   * by the update itself.
   */
  const repairParents = async (id: ObjectId, paths: readonly string[], session: ClientSession | undefined): Promise<void> => {
    const ancestors = paths.flatMap((path) => path.split('.').slice(0, -1).map((_segment, index, parts) => parts.slice(0, index + 1).join('.')));
    const parents = [...new Set(ancestors)].filter((path) => REPAIRABLE.test(path));
    if (parents.length === 0) {
      return;
    }
    const broken = (path: string): Document => ({ [path]: { $exists: true, $not: { $type: 'object' } } });
    const options = session === undefined ? {} : { session };
    // The common case is a document without a broken parent: one cheap query says so.
    if ((await users().findOne({ _id: id, $or: parents.map(broken) }, { projection: { _id: 1 }, ...options })) === null) {
      return;
    }
    // From the outermost, so that a parent replaced by an object never hides a broken child.
    for (const path of parents.sort((a, b) => a.split('.').length - b.split('.').length)) {
      await users().updateOne({ _id: id, ...broken(path) }, { $set: { [path]: {} } }, options);
    }
  };

  const toLoginRecord = (document: Document): LoginRecord => ({
    ...fromLegacy(document as LegacyUserDocument),
    legacyPasswordHash: typeof document['password'] === 'string' ? document['password'] : null,
  });

  const normalizedMatch = (candidate: Document, normalized: string): boolean =>
    [candidate['userName'], candidate['username']].some((name) => typeof name === 'string' && normalizeUsername(name) === normalized);

  const toAuthRecord = (document: Document): AuthRecord => {
    const mapped = fromLegacy(document as LegacyUserDocument);
    const { companyIds, placeIds } = legacyScopeIds(document);
    return {
      ...mapped,
      stored: {
        userId: document['_id'] as ObjectId,
        // A role outside the six stays as the marker: `buildPrincipal` gives such a user nothing.
        role: mapped.user.role as StoredUser['role'],
        groupId: document['groupId'] instanceof ObjectId ? document['groupId'] : null,
        companyIds,
        placeIds,
        legacyPermissions: document['permissions'],
      },
    };
  };

  return {
    findById: async (id) => {
      const document = await users().findOne({ _id: id }, { projection: DETAIL_PROJECTION });
      return document === null ? null : fromLegacy(document as LegacyUserDocument);
    },

    findAuthRecord: async (id) => {
      const document = await users().findOne({ _id: id }, { projection: AUTH_PROJECTION });
      return document === null ? null : toAuthRecord(document);
    },

    findSummaries: async (ids) => {
      const documents = await users()
        .find({ _id: { $in: [...ids] }, role: 'D' }, { projection: { userName: 1, username: 1, status: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return new Map(
        documents.map((document) => {
          const { user } = fromLegacy(document as LegacyUserDocument);
          return [(document['_id'] as ObjectId).toHexString(), { username: user.username, status: user.status }];
        }),
      );
    },

    findManaged: async (filter) => {
      const document = await users().findOne(filter, { projection: MANAGE_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : toAuthRecord(document);
    },

    list: async (scopeFilter, filter, params) => {
      const match = withScope(scopeFilter, { $and: [filter, listSearch(params, USERS_LIST)] });
      const documents = await users().aggregate(listPipeline(match, params, USERS_LIST, USER_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
      const { items, page } = pageOf(documents, params);
      return { users: items.map((document) => fromLegacy(document as LegacyUserDocument, { summary: true })), page };
    },

    findTrashedIds: async (filter, limit) =>
      (await users().find(filter, { projection: { _id: 1 }, sort: { _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray()).map((document) => document._id),

    countTrashed: (filter) => users().countDocuments(filter, { maxTimeMS: LIST_MAX_TIME_MS }),

    insert: async (document, session) => {
      const foreign = leafPaths(document).filter((path) => path !== '_id' && !isOwnedPath(owned, path));
      if (foreign.length > 0) {
        throw new Error(`Refusing to write fields the backend does not own: ${foreign.join(', ')}`);
      }
      await users().insertOne({ ...document }, session === undefined ? {} : { session });
      return fromLegacy(document as LegacyUserDocument);
    },

    deleteTrashed: async (id, session) => {
      const result = await users().deleteOne({ _id: id, trash: true }, session === undefined ? {} : { session });
      return result.deletedCount === 1;
    },

    findLoginRecordById: async (id) => {
      const document = await users().findOne({ _id: id }, { projection: LOGIN_PROJECTION });
      return document === null ? null : toLoginRecord(document);
    },

    findByUsernameForLogin: async (username) => {
      const exact = await users().findOne({ userName: username }, { projection: LOGIN_PROJECTION });
      if (exact !== null) {
        return toLoginRecord(exact);
      }
      const normalized = normalizeUsername(username);
      if (normalized === '') {
        return null;
      }
      const candidates = await users()
        .find({ userName: { $regex: `^${escapeRegExp(normalized)}$`, $options: 'i' } }, { projection: LOGIN_PROJECTION, limit: MAX_USERNAME_CANDIDATES })
        .toArray();
      const matches = candidates.filter((candidate) => typeof candidate['userName'] === 'string' && normalizeUsername(candidate['userName']) === normalized);
      return matches.length === 1 ? toLoginRecord(matches[0]!) : null;
    },

    isUsernameTaken: async (username, excludeId) => {
      const normalized = normalizeUsername(username);
      const pattern = { $regex: `^${escapeRegExp(normalized)}$`, $options: 'i' };
      const candidates = await users()
        .find({ $or: [{ userName: pattern }, { username: pattern }], ...(excludeId === undefined ? {} : { _id: { $ne: excludeId } }) }, { projection: { userName: 1, username: 1 }, limit: MAX_USERNAME_CANDIDATES, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return candidates.some((candidate) => normalizedMatch(candidate, normalized));
    },

    updateOwned: async (id, update, session, onlyIf) => {
      const operators = Object.keys(update).filter((key) => key !== '$set' && key !== '$unset');
      if (operators.length > 0) {
        throw new Error('Refusing an update with operators other than $set and $unset');
      }
      const fields = [...Object.keys(update.$set), ...Object.keys(update.$unset ?? {})];
      const foreign = fields.filter((field) => !owned.has(field));
      if (foreign.length > 0) {
        throw new Error(`Refusing to write fields the backend does not own: ${foreign.join(', ')}`);
      }
      await repairParents(id, fields, session);
      const result = await users().updateOne(
        { _id: id, ...(onlyIf === undefined ? {} : { trash: onlyIf.trash }) },
        { $set: { ...update.$set }, ...(update.$unset === undefined ? {} : { $unset: { ...update.$unset } }) },
        session === undefined ? {} : { session },
      );
      return result.matchedCount === 1;
    },

    clearLegacyTokens: async (id, session) => {
      const result = await users().updateOne({ _id: id }, { $set: { tokens: [] } }, session === undefined ? {} : { session });
      return result.matchedCount === 1;
    },

    clearLegacyTokensOfMany: async (ids, session) => {
      const result = await users().updateMany({ _id: { $in: [...ids] } }, { $set: { tokens: [] } }, { session });
      return result.matchedCount;
    },

    findIdsOfGroup: async (groupId, after, limit) => {
      const documents = await users()
        .find({ groupId, ...(after === null ? {} : { _id: { $gt: after } }) }, { projection: { _id: 1 }, sort: { _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      return documents.map((document) => document._id);
    },
  };
}
