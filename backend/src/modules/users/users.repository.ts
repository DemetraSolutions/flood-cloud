import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { COLLECTIONS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { legacyScopeIds } from '../../shared/security/scope/legacy-scope.ts';
import { normalizeUsername } from '../../shared/security/username.ts';
import { OWNED_PERMISSION_MODULES, fromLegacy } from './user.mapper.ts';
import type { StoredUser } from '../../shared/security/scope/principal.ts';
import type { AuthRecord, LegacyUserDocument, LegacyUserUpdate, LoginRecord, MappedUser } from './user.types.ts';

/** Candidates read when looking a username up without regard to case: more than this is not a real situation. */
const MAX_USERNAME_CANDIDATES = 20;

/**
 * Fields read to build a {@link MappedUser}: the profile, status, scope and the core permission
 * flags. `password`, `pin`, `tokens`, `avatar`, `servicesId`, `shiftTime` and `permissions.apps`
 * are not in the list, so they are never loaded.
 */
const USER_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  userName: 1,
  username: 1,
  name: 1,
  surname: 1,
  email: 1,
  telephone: 1,
  role: 1,
  dealerId: 1,
  groupId: 1,
  companyId: 1,
  placeId: 1,
  placesId: 1,
  status: 1,
  trash: 1,
  'settings.language': 1,
  'settings.hiddenInStats': 1,
  'permissions.status': 1,
  ...Object.fromEntries(OWNED_PERMISSION_MODULES.flatMap((module) => [[`permissions.${module}.r`, 1], [`permissions.${module}.w`, 1]])),
  insertDate: 1,
  updateDate: 1,
});

/** What the login needs on top of {@link USER_PROJECTION}: the legacy hash, for the verifier only. */
const LOGIN_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({ ...USER_PROJECTION, password: 1 });

/**
 * What authenticating a request needs, read on every request: identity, role, status, scope and the
 * whole stored permission matrix (its non-core modules limit what the user can grant). No personal
 * data, no password, no token.
 */
const AUTH_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
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

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
   * @returns `false` when the user does not exist.
   * @throws {Error} If the update contains a field outside the owned fields or an operator other than `$set` and `$unset`.
   */
  updateOwned(id: ObjectId, update: LegacyUserUpdate): Promise<boolean>;
  /**
   * Empties the legacy `tokens[]` so that the legacy platform disconnects the user at once (D-11).
   *
   * @param id Id of the user.
   * @returns `false` when the user does not exist.
   */
  clearLegacyTokens(id: ObjectId): Promise<boolean>;
}

/**
 * Builds the users repository over `common.users`. The only code that knows the legacy document shape.
 *
 * @param databases Database accessor.
 */
export function createUsersRepository(databases: Databases): UsersRepository {
  const users = (): Collection<Document> => databases.common().collection('users');
  const owned = new Set(COLLECTIONS.common.users.ownedFields);

  const toLoginRecord = (document: Document): LoginRecord => ({
    ...fromLegacy(document as LegacyUserDocument),
    legacyPasswordHash: typeof document['password'] === 'string' ? document['password'] : null,
  });

  const normalizedMatch = (candidate: Document, normalized: string): boolean =>
    [candidate['userName'], candidate['username']].some((name) => typeof name === 'string' && normalizeUsername(name) === normalized);

  return {
    findById: async (id) => {
      const document = await users().findOne({ _id: id }, { projection: USER_PROJECTION });
      return document === null ? null : fromLegacy(document as LegacyUserDocument);
    },

    findAuthRecord: async (id) => {
      const document = await users().findOne({ _id: id }, { projection: AUTH_PROJECTION });
      if (document === null) {
        return null;
      }
      const mapped = fromLegacy(document as LegacyUserDocument);
      const { companyIds, placeIds } = legacyScopeIds(document);
      return {
        ...mapped,
        stored: {
          userId: id,
          // A role outside the six stays as the marker: `buildPrincipal` gives such a user nothing.
          role: mapped.user.role as StoredUser['role'],
          groupId: document['groupId'] instanceof ObjectId ? document['groupId'] : null,
          companyIds,
          placeIds,
          legacyPermissions: document['permissions'],
        },
      };
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
        .find({ $or: [{ userName: pattern }, { username: pattern }], ...(excludeId === undefined ? {} : { _id: { $ne: excludeId } }) }, { projection: { userName: 1, username: 1 }, limit: MAX_USERNAME_CANDIDATES })
        .toArray();
      return candidates.some((candidate) => normalizedMatch(candidate, normalized));
    },

    updateOwned: async (id, update) => {
      const operators = Object.keys(update).filter((key) => key !== '$set' && key !== '$unset');
      if (operators.length > 0) {
        throw new Error('Refusing an update with operators other than $set and $unset');
      }
      const fields = [...Object.keys(update.$set), ...Object.keys(update.$unset ?? {})];
      const foreign = fields.filter((field) => !owned.has(field));
      if (foreign.length > 0) {
        throw new Error(`Refusing to write fields the backend does not own: ${foreign.join(', ')}`);
      }
      const result = await users().updateOne({ _id: id }, { $set: { ...update.$set }, ...(update.$unset === undefined ? {} : { $unset: { ...update.$unset } }) });
      return result.matchedCount === 1;
    },

    clearLegacyTokens: async (id) => {
      const result = await users().updateOne({ _id: id }, { $set: { tokens: [] } });
      return result.matchedCount === 1;
    },
  };
}
