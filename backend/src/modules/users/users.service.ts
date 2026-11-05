import { MongoServerError, ObjectId } from 'mongodb';
import type { ClientSession, Document, Filter } from 'mongodb';
import type { Config } from '../../config.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { buildPasswordChange } from '../../shared/security/password-change.ts';
import { checkPasswordPolicy } from '../../shared/security/password-policy.ts';
import { flagsOf } from '../../shared/security/rbac/permission-matrix.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';
import { manageableRoles } from '../../shared/security/rbac/policy.ts';
import { canManageUser, checkUserChange, holdsEverythingOf, inheritedMatrix } from '../../shared/security/rbac/user-management.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { usersScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { CredentialsRepository } from './credentials.repository.ts';
import type { GroupDirectoryRepository } from './group-directory.repository.ts';
import { applyPermissions, changeViewOf, permissionChanges, scopeReferenceIssues, scopeShapeIssues, storedChangeView, violationError } from './user-access.ts';
import { DEFAULT_LANGUAGE, OWNED_PERMISSION_MODULES, toLegacyDocument, toLegacyUpdate, toResponse } from './user.mapper.ts';
import type { User, UserChanges, UserResponse } from './user.types.ts';
import { USERS_LIST } from './users.list.ts';
import type { UsersRepository } from './users.repository.ts';
import { GROUP_ROLES, PLATFORM_ROLES } from './users.schemas.ts';
import type {
  AllUsersQuery,
  CreateGroupUserBody,
  CreatePlatformUserBody,
  GroupUsersQuery,
  PatchGroupUserBody,
  PatchPlatformUserBody,
  ResetPasswordBody,
} from './users.schemas.ts';

/** Where a user lives: in a group (verified access) or on the platform (PSA and dealers, managed by the PSA only). */
export type UserArea = { readonly kind: 'group'; readonly access: GroupAccess } | { readonly kind: 'platform' };

/** A page of users in their response form. */
export interface UserListing {
  readonly items: readonly UserResponse[];
  readonly page: PageInfo;
}

/** Body of a creation, group or platform. */
export type CreateUserBody = CreateGroupUserBody | CreatePlatformUserBody;

/** Body of a modification, group or platform. */
export type PatchUserBody = PatchGroupUserBody | PatchPlatformUserBody;

/** The management of the users of the platform and of the groups (`doc/Tasks.md` 3.4). */
export interface UsersService {
  /**
   * Lists the users of a group inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  listGroup(principal: AuthPrincipal, access: GroupAccess, query: GroupUsersQuery): Promise<UserListing>;
  /**
   * Lists the users of every group the caller reaches: all of them for the PSA, those of the dealer's groups for a dealer.
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` for any other role, and for the `dealerId` filter used by a dealer.
   */
  listAll(principal: AuthPrincipal, query: AllUsersQuery): Promise<UserListing>;
  /**
   * Reads one user. A user that does not exist, is outside the perimeter or in another group is one and the same `404`.
   *
   * @throws {AppError} `NOT_FOUND`; `FORBIDDEN` for a platform user asked by someone who is not a PSA.
   */
  get(principal: AuthPrincipal, area: UserArea, userId: ObjectId): Promise<UserResponse>;
  /**
   * Creates a user with a provisional password the user must replace at the first access (not for `E`).
   *
   * @throws {AppError} `VALIDATION_ERROR` (scope, references, password policy), `FORBIDDEN` (role, permissions), `CONFLICT` (username taken).
   */
  create(principal: AuthPrincipal, area: UserArea, body: CreateUserBody, client: ClientContext): Promise<UserResponse>;
  /**
   * Modifies a user (JSON Merge Patch). A change of role, scope, status or permissions ends his sessions (D-11).
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN` (himself, rank, permissions), `VALIDATION_ERROR`, `CONFLICT` (username taken).
   */
  update(principal: AuthPrincipal, area: UserArea, userId: ObjectId, patch: PatchUserBody, client: ClientContext): Promise<UserResponse>;
  /**
   * Resets the password of a user to a provisional one and ends his sessions.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR` on `password` with the policy issues.
   */
  resetPassword(principal: AuthPrincipal, area: UserArea, userId: ObjectId, body: ResetPasswordBody, client: ClientContext): Promise<void>;
  /**
   * Moves a user to the trash and ends his sessions.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `CONFLICT` when he is already there.
   */
  trash(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<UserResponse>;
  /**
   * Takes a user out of the trash.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `CONFLICT` when he is not there.
   */
  restore(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<UserResponse>;
  /**
   * Deletes a user for good (D-14): the user, his credentials and all his sessions, together.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `CONFLICT` when he is not in the trash.
   */
  remove(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<void>;
  /**
   * Tells whether a username is free (D-15).
   *
   * @param username A valid username.
   */
  isUsernameAvailable(username: string): Promise<boolean>;
}

/** Collaborators of {@link createUsersService}. */
export interface UsersServiceDeps {
  readonly config: Pick<Config, 'legacyPasswordPepper' | 'legacyPasswordCoexistence'>;
  readonly users: UsersRepository;
  readonly credentials: CredentialsRepository;
  readonly sessions: SessionsRepository;
  readonly directory: GroupDirectoryRepository;
  readonly activityLog: ActivityLog;
  /**
   * Runs the operations in a transaction on the common database: they commit together or not at all
   * (`Databases.transaction`). The function may run more than once.
   */
  readonly transaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** The scope lists a body of the group area may carry. */
interface ScopeFields {
  readonly companyIds?: ObjectId[];
  readonly placeIds?: ObjectId[];
}

const GROUP_ROLE_FILTER = [...GROUP_ROLES, null];

const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

/** Hex ids without duplicates, in order of appearance. */
function uniqueIds(ids: readonly ObjectId[]): ObjectId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const hex = id.toHexString();
    return seen.has(hex) ? false : (seen.add(hex), true);
  });
}

const hexes = (ids: readonly ObjectId[]): string[] => ids.map((id) => id.toHexString());

/** What the activity log records of a user: no secret, no legacy-only field. */
function snapshot(user: User): Record<string, unknown> {
  return {
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    trashed: user.trashed,
    language: user.language,
    companyIds: user.companyIds,
    placeIds: user.placeIds,
    permissions: { status: user.permissions.status, modules: user.permissions.modules },
  };
}

function conflictUsernameTaken(): AppError {
  return new AppError('CONFLICT', { details: [{ field: 'username', issue: 'taken' }] });
}

function validationError(details: ReadonlyArray<{ field: string; issue: string }>): AppError {
  return new AppError('VALIDATION_ERROR', { details });
}

/**
 * Builds the user management service. Every lookup is limited by the caller's perimeter (`usersScopeFilter`
 * through `withScope`), every creation or change goes through the anti-escalation rules, and a user who
 * is not found is indistinguishable from one the caller cannot see.
 *
 * @param deps Repositories, directory, transaction runner, activity log and clock.
 */
export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { config, users, credentials, sessions, directory, activityLog, transaction } = deps;
  const date = (): Date => new Date(deps.now());

  const groupIdOf = (area: UserArea): ObjectId | null => (area.kind === 'group' ? area.access.groupId : null);

  /** Who did what, where and from which request: the part every entry of one operation shares. */
  const context = (principal: AuthPrincipal, area: UserArea, client: ClientContext) => {
    const groupId = groupIdOf(area);
    return {
      actor: actorOf(principal),
      ...(groupId === null ? {} : { groupId }),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    };
  };

  const assertPlatformAdmin = (principal: AuthPrincipal, area: UserArea): void => {
    if (area.kind === 'platform' && principal.role !== 'PSA') {
      throw new AppError('FORBIDDEN');
    }
  };

  /** A role the caller does not manage is refused before anything else is looked at, so the rest of the request tells him nothing about it. */
  const assertManageableRole = (principal: AuthPrincipal, role: Role): void => {
    if (!manageableRoles(principal.role).includes(role)) {
      throw new AppError('FORBIDDEN');
    }
  };

  /** The user the caller reaches with this id in this area; anything else is `404`. */
  const findTarget = async (principal: AuthPrincipal, area: UserArea, userId: ObjectId) => {
    assertPlatformAdmin(principal, area);
    const scoped = usersScopeFilter(principal);
    const filter = area.kind === 'group' ? { _id: userId, groupId: area.access.groupId, role: { $in: GROUP_ROLE_FILTER } } : { _id: userId, role: { $in: [...PLATFORM_ROLES] } };
    const record = await users.findManaged(withScope(scoped, filter));
    if (record === null) {
      throw new AppError('NOT_FOUND');
    }
    return record;
  };

  /** The target of a state change: found, and manageable (not himself, a role and a perimeter the caller manages). */
  const findManageable = async (principal: AuthPrincipal, area: UserArea, userId: ObjectId, options: { readonly locksOut?: true } = {}) => {
    const record = await findTarget(principal, area, userId);
    const view = storedChangeView(record);
    // Locking an account out or removing it needs at least the permissions the account has.
    if (!canManageUser(principal, view) || (options.locksOut === true && !holdsEverythingOf(principal, view))) {
      throw new AppError('FORBIDDEN');
    }
    return { record, view };
  };

  /** Filters of a list request on top of the scope. */
  const requestFilter = (query: { role?: string; status?: string; trashed?: string; groupId?: ObjectId; dealerId?: ObjectId }): Filter<Document> => {
    const conditions: Filter<Document>[] = [query.trashed === 'true' ? { trash: true } : { trash: { $ne: true } }];
    if (query.role !== undefined) {
      // A user without a role counts as `E`, as in the legacy.
      conditions.push({ role: query.role === 'E' ? { $in: ['E', null] } : query.role });
    }
    if (query.status !== undefined) {
      conditions.push({ status: query.status === 'active' ? true : { $ne: true } });
    }
    if (query.groupId !== undefined) {
      conditions.push({ groupId: query.groupId });
    }
    if (query.dealerId !== undefined) {
      conditions.push({ dealerId: query.dealerId });
    }
    return { $and: conditions };
  };

  const listing = async (scopeFilter: Filter<Document>, filter: Filter<Document>, query: { limit?: number; cursor?: string; sort?: string; q?: string }): Promise<UserListing> => {
    const { users: found, page } = await users.list(scopeFilter, filter, listParamsOf(query, USERS_LIST));
    return { items: found.map((mapped) => toResponse(mapped.user)), page };
  };

  /** Ends the sessions of a user and the legacy ones (D-11); the number of sessions revoked. */
  const endSessions = async (userId: ObjectId, reason: string, now: Date, session: ClientSession): Promise<number> => {
    const revoked = await sessions.revokeAllOfUser(userId, reason, now, undefined, session);
    await users.clearLegacyTokens(userId, session);
    return revoked;
  };

  const reportRevoked = async (principal: AuthPrincipal, area: UserArea, client: ClientContext, reason: string, revoked: number): Promise<void> => {
    if (revoked > 0) {
      await auditSessionsRevoked(activityLog, { actor: actorOf(principal), groupId: groupIdOf(area), reason, client });
    }
  };

  const securityEvent = (principal: AuthPrincipal, area: UserArea, client: ClientContext, action: 'user.roleChanged' | 'user.scopeChanged' | 'user.statusChanged' | 'user.permissionsChanged', userId: ObjectId, metadata?: Record<string, string>) =>
    activityLog.record({
      category: 'security',
      action,
      outcome: 'success',
      ...context(principal, area, client),
      resource: { type: 'user', id: userId.toHexString() },
      ...(metadata === undefined ? {} : { metadata }),
    });

  const passwordFor = async (password: string, username: string): Promise<Extract<Awaited<ReturnType<typeof buildPasswordChange>>, { ok: true }>> => {
    const change = await buildPasswordChange(password, { username, pepper: config.legacyPasswordPepper, legacyCoexistence: config.legacyPasswordCoexistence });
    if (!change.ok) {
      throw validationError(change.issues.map((issue) => ({ field: 'password', issue })));
    }
    return change;
  };

  return {
    listGroup: (principal, access, query) =>
      listing(withScope(usersScopeFilter(principal), { groupId: access.groupId, role: { $in: GROUP_ROLE_FILTER } }), requestFilter(query), query),

    listAll: (principal, query) => {
      const { kind } = principal.scope;
      if (kind !== 'platform' && kind !== 'dealer') {
        throw new AppError('FORBIDDEN');
      }
      if (query.dealerId !== undefined && kind !== 'platform') {
        throw new AppError('FORBIDDEN');
      }
      return listing(usersScopeFilter(principal), requestFilter(query), query);
    },

    get: async (principal, area, userId) => toResponse((await findTarget(principal, area, userId)).user),

    create: async (principal, area, body, client) => {
      assertPlatformAdmin(principal, area);
      const role: Role = body.role;
      assertManageableRole(principal, role);
      const companyIds = uniqueIds((body as ScopeFields).companyIds ?? []);
      const placeIds = uniqueIds((body as ScopeFields).placeIds ?? []);
      const groupId = groupIdOf(area);

      let issues = scopeShapeIssues(role, companyIds, placeIds);
      if (issues.length === 0 && area.kind === 'group') {
        issues = await scopeReferenceIssues(directory, principal, area.access, { companyIds, placeIds });
      }
      if (issues.length > 0) {
        throw validationError(issues);
      }

      const id = new ObjectId();
      const matrix = applyPermissions(inheritedMatrix(principal, role), body.permissions);
      const denied = violationError(checkUserChange(principal, null, changeViewOf({ userId: id, role, groupId, companyIds, placeIds, matrix })), role);
      if (denied !== null) {
        throw denied;
      }
      // The policy first: a weak password must not be a way to find out which usernames exist.
      const policy = checkPasswordPolicy(body.password, { username: body.username });
      if (!policy.ok) {
        throw validationError(policy.issues.map((issue) => ({ field: 'password', issue })));
      }
      if (await users.isUsernameTaken(body.username)) {
        throw conflictUsernameTaken();
      }
      const change = await passwordFor(body.password, body.username);

      const now = date();
      const dealerId = area.kind === 'group' ? await directory.findDealerId(area.access.groupId) : null;
      const document = toLegacyDocument(
        {
          id,
          username: body.username,
          firstName: body.firstName ?? null,
          lastName: body.lastName ?? null,
          email: body.email ?? null,
          phone: body.phone ?? null,
          role,
          groupId: groupId === null ? null : groupId.toHexString(),
          dealerId: dealerId === null ? null : dealerId.toHexString(),
          companyIds: hexes(companyIds),
          placeIds: hexes(placeIds),
          status: body.status ?? 'active',
          language: body.language ?? DEFAULT_LANGUAGE,
          permissions: { status: matrix.status, modules: Object.fromEntries(OWNED_PERMISSION_MODULES.map((name) => [name, flagsOf(matrix, name)])) },
          legacyPasswordHash: change.legacyHash,
        },
        now,
      );
      let created;
      try {
        created = await transaction(async (session) => {
          const inserted = await users.insert(document, session);
          await credentials.upsertPassword(
            id,
            { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint, passwordChanged: true, mustChangePassword: true, now },
            session,
          );
          return inserted;
        });
      } catch (error) {
        // Two creations of the same name at once: the unique index of the legacy decides.
        throw error instanceof MongoServerError && error.code === 11000 ? conflictUsernameTaken() : error;
      }
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: id.toHexString() },
        action: 'user.created',
        before: undefined,
        after: { ...snapshot(created.user), password: 'set' },
      });
      return toResponse(created.user);
    },

    update: async (principal, area, userId, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw validationError([{ field: '(body)', issue: 'required' }]);
      }
      const { record: target, view } = await findManageable(principal, area, userId, { locksOut: true });
      const before = target.user;
      const role: Role = patch.role ?? (before.role as Role);
      assertManageableRole(principal, role);
      const requested = patch as ScopeFields;
      const companyIds = requested.companyIds === undefined ? view.companyIds : uniqueIds(requested.companyIds);
      const placeIds = requested.placeIds === undefined ? view.placeIds : uniqueIds(requested.placeIds);

      // D-08 on the final state, but only when the change touches the scope: an old SA with a leftover company can still be renamed.
      const scopeChanged = !sameIds(hexes(companyIds), before.companyIds) || !sameIds(hexes(placeIds), before.placeIds);
      if (scopeChanged || (patch.role !== undefined && patch.role !== before.role)) {
        let issues = scopeShapeIssues(role, companyIds, placeIds);
        if (issues.length === 0 && area.kind === 'group') {
          issues = await scopeReferenceIssues(directory, principal, area.access, { companyIds, placeIds, known: { companyIds: new Set(before.companyIds), placeIds: new Set(before.placeIds) } });
        }
        if (issues.length > 0) {
          throw validationError(issues);
        }
      }

      const matrix = applyPermissions(view.matrix, patch.permissions);
      const denied = violationError(checkUserChange(principal, view, changeViewOf({ ...view, role, companyIds, placeIds, matrix })), role);
      if (denied !== null) {
        throw denied;
      }
      if (patch.username !== undefined && patch.username !== before.username && (await users.isUsernameTaken(patch.username, userId))) {
        throw conflictUsernameTaken();
      }

      const differs = <T>(next: T | undefined, current: T): next is T => next !== undefined && next !== current;
      const permissionDiff = permissionChanges(view.matrix, matrix);
      const changes: UserChanges = {
        ...(differs(patch.username, before.username) ? { username: patch.username } : {}),
        ...(differs(patch.firstName, before.firstName) ? { firstName: patch.firstName } : {}),
        ...(differs(patch.lastName, before.lastName) ? { lastName: patch.lastName } : {}),
        ...(differs(patch.email, before.email) ? { email: patch.email } : {}),
        ...(differs(patch.phone, before.phone) ? { phone: patch.phone } : {}),
        ...(differs(patch.language, before.language) ? { language: patch.language } : {}),
        ...(differs(patch.role, before.role as Role) ? { role: patch.role } : {}),
        ...(differs(patch.status, before.status) ? { status: patch.status } : {}),
        ...(scopeChanged ? { companyIds: hexes(companyIds), placeIds: hexes(placeIds) } : {}),
        ...(permissionDiff === undefined ? {} : { permissions: permissionDiff }),
      };
      if (Object.keys(changes).length === 0) {
        return toResponse(before);
      }

      const now = date();
      const revocation = changes.role !== undefined ? 'roleChanged' : scopeChanged ? 'scopeChanged' : changes.status !== undefined ? 'statusChanged' : permissionDiff !== undefined ? 'permissionsChanged' : null;
      const revoked = await transaction(async (session) => {
        if (!(await users.updateOwned(userId, toLegacyUpdate(changes, now), session))) {
          return null;
        }
        return revocation === null ? 0 : endSessions(userId, revocation, now, session);
      });
      const updated = revoked === null ? null : await users.findById(userId);
      if (revoked === null || updated === null) {
        throw new AppError('NOT_FOUND');
      }

      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.updated',
        before: snapshot(before),
        after: snapshot(updated.user),
      });
      if (changes.role !== undefined) {
        await securityEvent(principal, area, client, 'user.roleChanged', userId, { from: before.role, to: role });
      }
      if (scopeChanged) {
        await securityEvent(principal, area, client, 'user.scopeChanged', userId);
      }
      if (changes.status !== undefined) {
        await securityEvent(principal, area, client, 'user.statusChanged', userId, { from: before.status, to: updated.user.status });
      }
      if (permissionDiff !== undefined) {
        await securityEvent(principal, area, client, 'user.permissionsChanged', userId);
      }
      await reportRevoked(principal, area, client, revocation ?? '', revoked);
      return toResponse(updated.user);
    },

    resetPassword: async (principal, area, userId, body, client) => {
      const { record: target } = await findManageable(principal, area, userId, { locksOut: true });
      const change = await passwordFor(body.password, target.user.username);
      const now = date();
      const revoked = await transaction(async (session) => {
        if (!(await users.updateOwned(userId, toLegacyUpdate({ password: change.legacyHash }, now), session))) {
          // Gone since it was read: nothing is written, no orphan credentials.
          throw new AppError('NOT_FOUND');
        }
        await credentials.upsertPassword(
          userId,
          { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint, passwordChanged: true, mustChangePassword: true, now },
          session,
        );
        await credentials.clearLock(userId, now, session);
        return endSessions(userId, 'passwordReset', now, session);
      });
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.updated',
        before: { password: 'previous' },
        after: { password: 'reset' },
      });
      await reportRevoked(principal, area, client, 'passwordReset', revoked);
    },

    trash: async (principal, area, userId, client) => {
      const { record: target } = await findManageable(principal, area, userId, { locksOut: true });
      if (target.user.trashed) {
        throw new AppError('CONFLICT');
      }
      const now = date();
      const revoked = await transaction(async (session) => {
        await users.updateOwned(userId, toLegacyUpdate({ trashed: true }, now), session);
        return endSessions(userId, 'userTrashed', now, session);
      });
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.trashed',
        before: { trashed: false },
        after: { trashed: true },
      });
      await reportRevoked(principal, area, client, 'userTrashed', revoked);
      return toResponse({ ...target.user, trashed: true, updatedAt: now });
    },

    restore: async (principal, area, userId, client) => {
      const { record: target } = await findManageable(principal, area, userId);
      if (!target.user.trashed) {
        throw new AppError('CONFLICT');
      }
      const now = date();
      await users.updateOwned(userId, toLegacyUpdate({ trashed: false }, now));
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.restored',
        before: { trashed: true },
        after: { trashed: false },
      });
      return toResponse({ ...target.user, trashed: false, updatedAt: now });
    },

    remove: async (principal, area, userId, client) => {
      const { record: target } = await findManageable(principal, area, userId, { locksOut: true });
      if (!target.user.trashed) {
        throw new AppError('CONFLICT');
      }
      // A dealer that still has groups (also trashed ones) would leave them pointing at nobody.
      if (target.user.role === 'D' && (await directory.isDealerOfAnyGroup(userId))) {
        throw new AppError('CONFLICT');
      }
      await transaction(async (session) => {
        // Check and delete are one write: a user restored in the meantime is not deleted.
        if (!(await users.deleteTrashed(userId, session))) {
          throw new AppError('CONFLICT');
        }
        await credentials.delete(userId, session);
        await sessions.deleteAllOfUser(userId, session);
      });
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.deleted',
        before: undefined,
        after: undefined,
        metadata: { role: target.user.role },
      });
    },

    isUsernameAvailable: async (username) => !(await users.isUsernameTaken(username)),
  };
}
