import { MongoServerError, ObjectId } from 'mongodb';
import type { ClientSession, Document, Filter } from 'mongodb';
import type { Config } from '../../config.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { companyOf, minimalCompany, toNewDocument } from '../dealers/dealer.mapper.ts';
import type { DealersRepository } from '../dealers/dealers.repository.ts';
import { buildPasswordChange } from '../../shared/security/password-change.ts';
import { checkPasswordPolicy } from '../../shared/security/password-policy.ts';
import { defaultMatrix, flagsOf } from '../../shared/security/rbac/permission-matrix.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';
import { hasPermission, manageableRoles } from '../../shared/security/rbac/policy.ts';
import { canManageUser, checkUserChange, holdsEverythingOf, inheritedMatrix } from '../../shared/security/rbac/user-management.ts';
import { assertGroupCreationAccess } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { usersScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import { settleItem } from '../../shared/trash/trash.ts';
import type { TrashItemOutcome } from '../../shared/trash/trash.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { ServicesRepository } from '../group-services/services.repository.ts';
import type { CredentialsRepository } from './credentials.repository.ts';
import type { GroupDirectoryRepository } from './group-directory.repository.ts';
import { avatarFingerprint } from './avatar.ts';
import { defaultPriceLists, optionReferenceIssues, referencesGroupLists } from './group-options.ts';
import type { GroupOptionLists, GroupOptionsReader } from './group-options.ts';
import { inheritedPos, isPosLimited, posAccessError, posPermissionsChanged } from './pos-access.ts';
import type { PosActor } from './pos-access.ts';
import { applyPosPatch, diffPos } from './pos.mapper.ts';
import type { Pos } from './pos.catalog.ts';
import { applyShiftTime, diffShiftTime, emptyShiftTime, shiftTimeIssues } from './shift-time.ts';
import { applyPermissions, changeViewOf, permissionChanges, scopeReferenceIssues, scopeShapeIssues, storedChangeView, violationError } from './user-access.ts';
import { DEFAULT_LANGUAGE, DEFAULT_THEME, OWNED_PERMISSION_MODULES, fromLegacy, toLegacyDocument, toLegacyUpdate, toResponse } from './user.mapper.ts';
import type { LegacyUserDocument, User, UserChanges, UserResponse } from './user.types.ts';
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

/** Writes of the transaction that creates a user, run after the user and his credentials were written: it receives the session and the id of the new user. */
export type AlongsideWrite = (session: ClientSession, userId: ObjectId) => Promise<void>;

/** What the onboarding of a customer gives for the first administrator (SA) of the new group. */
export interface GroupAdminInput {
  readonly username: string;
  /** The provisional password: it must be replaced at the first access. */
  readonly password: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** The creation access to the new group (`issueGroupCreationAccess`): the only way to name the group, so the administrator cannot be created in one that exists. */
  readonly access: GroupAccess;
  /** The dealer of the group, `null` for none. */
  readonly dealerId: ObjectId | null;
  /** The default price list of the new group: the POS options of the user name it. */
  readonly priceListId: string;
}

/** The first administrator of a new group, ready to be written inside the transaction that creates the group. */
export interface GroupAdminStep {
  readonly id: ObjectId;
  /** What the activity log records of the user (no secret). */
  readonly snapshot: Readonly<Record<string, unknown>>;
  /**
   * Writes the user and his credentials (the scrypt hash, with the flag that forces the change of the password) with the session of the caller's transaction.
   *
   * @throws {AppError} `CONFLICT` (`username` `taken`) when another user took the name in the meantime (the unique index of the legacy decides).
   */
  run(session: ClientSession): Promise<void>;
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
   * A user `D` always comes with a dealer document of the same id (D-09), written in the same transaction:
   * the minimal one (company name = user name) unless `alongside` writes the real one.
   *
   * @param alongside Extra writes of the same transaction, run after the user and his credentials; used by the dealer registry. It may run more than once.
   * @throws {AppError} `VALIDATION_ERROR` (scope, references, password policy), `FORBIDDEN` (role, permissions), `CONFLICT` (username taken).
   */
  create(principal: AuthPrincipal, area: UserArea, body: CreateUserBody, client: ClientContext, alongside?: AlongsideWrite): Promise<UserResponse>;
  /**
   * Prepares the first administrator of a group that is being created (area 8): checks the password policy (D-19) and the username (D-15), hashes the password and builds the complete
   * legacy document of an SA with the whole matrix of his role, the POS data of his role with the default price list, and the scope of the whole group. Nothing is written: the caller runs
   * the returned step in its own transaction, so the user exists only if the whole customer does. Only a caller who creates groups (`groups:create`: PSA, D) gets one.
   *
   * @param principal The authenticated caller.
   * @param input The data of the user and of the group.
   * @throws {AppError} `FORBIDDEN` (role), `VALIDATION_ERROR` (password policy), `CONFLICT` (username taken).
   */
  prepareGroupAdmin(principal: AuthPrincipal, input: GroupAdminInput): Promise<GroupAdminStep>;
  /**
   * Modifies a user (JSON Merge Patch). A change of role, scope, status or permissions (the POS app switch and grants included, not the POS options) ends his sessions and empties his legacy tokens (D-11).
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
   * Deletes a user for good (D-14): the user, his credentials and all his sessions, together; a dealer's registry document goes with him.
   *
   * @throws {AppError} `NOT_FOUND`, `FORBIDDEN`, `CONFLICT` when he is not in the trash.
   */
  remove(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<void>;
  /**
   * Takes a user out of the trash for a bulk operation: exactly {@link UsersService.restore}, with its refusals returned as the issue instead of thrown.
   *
   * @returns `{ done: true }`, or the issue: `notFound`, `forbidden` (a user the caller does not manage) or `notTrashed`.
   */
  restoreFromTrash(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /**
   * Deletes a user that is in the trash for a bulk operation: exactly {@link UsersService.remove}, with its refusals returned as the issue instead of thrown.
   *
   * @returns `{ done: true }`, or the issue: `notFound`, `forbidden`, `notTrashed` or `referenced` (a dealer that still has groups).
   */
  deleteFromTrash(principal: AuthPrincipal, area: UserArea, userId: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  /**
   * The ids of the users in the trash of a group that the caller reaches (the users he sees, which he may not manage all), in `_id` order, at most `limit`.
   *
   * @param limit Most ids returned.
   * @param after Only the ids greater than this one, `null` for the first call.
   */
  trashedIds(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /** How many users in the trash of the group the caller reaches. */
  countTrashed(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
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
  /** The dealer registry: a user `D` is created and deleted together with his document. */
  readonly dealers: Pick<DealersRepository, 'insert' | 'deleteById'>;
  /** The services of a group, to verify the `serviceIds` of a user. */
  readonly services: Pick<ServicesRepository, 'existing'>;
  /** The price lists and favorites lists of a group, to verify and default the POS options of a user. */
  readonly groupOptions: GroupOptionsReader;
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

/**
 * What the activity log records of a user: no secret and no legacy-only field. The PIN is never there, only whether it is set; the picture is
 * replaced by whether there is one and a short fingerprint of it, so a change of picture shows without storing it.
 */
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
    theme: user.theme,
    hiddenInStats: user.hiddenInStats,
    description: user.description,
    hasAvatar: user.hasAvatar,
    avatarHash: user.avatar === undefined || user.avatar === null ? null : avatarFingerprint(user.avatar),
    pinSet: user.pinSet,
    serviceIds: user.serviceIds,
    companyIds: user.companyIds,
    placeIds: user.placeIds,
    permissions: { status: user.permissions.status, modules: user.permissions.modules },
    pos: user.pos,
    shiftTime: user.shiftTime,
  };
}

/** The roles whose users can provide services. */
const SERVICE_ROLES: readonly string[] = ['SA', 'CA', 'PA'];

/** The extra fields of the group bodies: the services the user provides. */
interface ServiceFields {
  readonly serviceIds?: ObjectId[];
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
  const { config, users, credentials, sessions, directory, dealers, services, groupOptions, activityLog, transaction } = deps;
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

  const passwordFor = async (password: string, username: string, field = 'password'): Promise<Extract<Awaited<ReturnType<typeof buildPasswordChange>>, { ok: true }>> => {
    const change = await buildPasswordChange(password, { username, pepper: config.legacyPasswordPepper, legacyCoexistence: config.legacyPasswordCoexistence });
    if (!change.ok) {
      throw validationError(change.issues.map((issue) => ({ field, issue })));
    }
    return change;
  };

  /** The one who gives the POS permissions; his own POS data are read once, and only if the rules need them. */
  const posActorOf = (principal: AuthPrincipal): PosActor => {
    let own: Promise<Pos> | undefined;
    return {
      role: principal.role,
      canManagePermissions: principal.canManagePermissions,
      // The caller was read by the authentication a moment ago: if he is gone, the request fails as the unexpected thing it is.
      pos: () => (own ??= users.findById(principal.userId).then((mapped) => mapped!.user.pos)),
    };
  };

  /** The lists of the group a user is in, which his POS options refer to; `null` for a platform user. */
  const groupListsOf = async (area: UserArea): Promise<GroupOptionLists | null> => (area.kind === 'group' ? groupOptions.read(area.access.groupId) : null);

  /**
   * The problems of the services a user would provide. Only the ids he does not already have are checked; they must be services of the group
   * (not products of another kind, not in the trash, not of another group), and they can be set only for SA, CA and PA of a group that has the
   * `services` feature on, as in the legacy form. Clearing the list is always allowed. A feature that is off is a `422 notAllowed` on the field,
   * not a `403 FEATURE_DISABLED`: the route itself is available and only this optional field is refused, so the rest of the request is still reported.
   */
  const serviceIssues = async (principal: AuthPrincipal, area: UserArea, role: Role, requested: readonly ObjectId[] | undefined, known: ReadonlySet<string>): Promise<ErrorDetail[]> => {
    if (requested === undefined) {
      return [];
    }
    const issues: ErrorDetail[] = [];
    const seen = new Set<string>();
    requested.forEach((id, index) => {
      if (seen.has(id.toHexString())) {
        issues.push({ field: `serviceIds.${String(index)}`, issue: 'incorrect' });
      }
      seen.add(id.toHexString());
    });
    const fresh = uniqueIds(requested).filter((id) => !known.has(id.toHexString()));
    if (fresh.length === 0) {
      return issues;
    }
    if (area.kind !== 'group' || !SERVICE_ROLES.includes(role) || !area.access.features.services) {
      return [...issues, { field: 'serviceIds', issue: 'notAllowed' }];
    }
    const found = await services.existing(principal, area.access, fresh);
    requested.forEach((id, index) => {
      if (!known.has(id.toHexString()) && !found.has(id.toHexString())) {
        issues.push({ field: `serviceIds.${String(index)}`, issue: 'incorrect' });
      }
    });
    return issues;
  };

  /** The users of a group the caller sees (the scope of the list of the group). */
  const groupScope = (principal: AuthPrincipal, access: GroupAccess): Filter<Document> => withScope(usersScopeFilter(principal), { groupId: access.groupId, role: { $in: GROUP_ROLE_FILTER } });

  /** The users of the group in the trash that the caller sees. */
  const groupTrashScope = (principal: AuthPrincipal, access: GroupAccess): Filter<Document> => withScope(groupScope(principal, access), { trash: true });

  const service: UsersService = {
    listGroup: (principal, access, query) =>
      listing(groupScope(principal, access), requestFilter(query), query),

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

    create: async (principal, area, body, client, alongside) => {
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
      // The POS data: the default of the role (limited to what a CA or PA creator holds), the price lists of the group, then what the request sets.
      const actor = posActorOf(principal);
      const group = await groupListsOf(area);
      const started = inheritedPos(isPosLimited(principal.role) ? await actor.pos() : null, role);
      const pos = applyPosPatch({ ...started, options: { ...started.options, priceLists: defaultPriceLists(group) } }, body.pos);
      const posDenied = await posAccessError(actor, role, null, pos);
      if (posDenied !== null) {
        throw posDenied;
      }
      const requestedServices = (body as ServiceFields).serviceIds;
      const shiftTime = applyShiftTime(emptyShiftTime(), body.shiftTime);
      const dataIssues = [
        ...optionReferenceIssues(body.pos?.options, null, group),
        ...(await serviceIssues(principal, area, role, requestedServices, new Set())),
        ...(body.shiftTime === undefined ? [] : shiftTimeIssues(shiftTime)),
      ];
      if (dataIssues.length > 0) {
        throw validationError(dataIssues);
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
          theme: body.theme ?? DEFAULT_THEME,
          hiddenInStats: body.hiddenInStats ?? false,
          description: body.description ?? null,
          avatar: body.avatar ?? null,
          pin: body.pin ?? null,
          serviceIds: requestedServices === undefined ? [] : hexes(uniqueIds(requestedServices)),
          permissions: { status: matrix.status, modules: Object.fromEntries(OWNED_PERMISSION_MODULES.map((name) => [name, flagsOf(matrix, name)])) },
          pos,
          shiftTime,
          legacyPasswordHash: change.legacyHash,
        },
        now,
      );
      // A dealer user without the registry's writer gets the minimal document; the registry itself passes the real one.
      const minimalDealer = role === 'D' && alongside === undefined ? minimalCompany(body.username) : null;
      let created;
      try {
        created = await transaction(async (session) => {
          const inserted = await users.insert(document, session);
          await credentials.upsertPassword(
            id,
            { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint, passwordChanged: true, mustChangePassword: true, now },
            session,
          );
          if (minimalDealer !== null) {
            await dealers.insert(toNewDocument(id, minimalDealer, 'user', principal.userId, now), session);
          }
          await alongside?.(session, id);
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
      if (minimalDealer !== null) {
        await recordDataChange(activityLog, {
          ...context(principal, area, client),
          resource: { type: 'dealer', id: id.toHexString() },
          action: 'dealer.created',
          before: undefined,
          after: { ...minimalDealer },
        });
      }
      return toResponse(created.user);
    },

    prepareGroupAdmin: async (principal, input) => {
      // Only the creation of a customer gives a group its administrator: PSA and dealers, who create groups and manage the role SA, on the group they are creating.
      assertGroupCreationAccess(principal, input.access);
      if (!hasPermission(principal, 'groups:create')) {
        throw new AppError('FORBIDDEN');
      }
      const access = input.access;
      // The policy first: a weak password must not be a way to find out which usernames exist.
      const policy = checkPasswordPolicy(input.password, { username: input.username });
      if (!policy.ok) {
        throw validationError(policy.issues.map((issue) => ({ field: 'user.password', issue })));
      }
      if (await users.isUsernameTaken(input.username)) {
        throw new AppError('CONFLICT', { details: [{ field: 'user.username', issue: 'taken' }] });
      }
      const change = await passwordFor(input.password, input.username, 'user.password');
      const id = new ObjectId();
      const now = date();
      // Everything his role can have: the groups of the legacy form give the SA the whole matrix, and he manages the permissions of his group.
      const role = defaultMatrix('SA');
      const permissions = { status: true, modules: Object.fromEntries(OWNED_PERMISSION_MODULES.map((name) => [name, flagsOf(role, name)])) };
      // Defense in depth: nobody creates an administrator who can do more than himself.
      if (!holdsEverythingOf(principal, changeViewOf({ userId: id, role: 'SA', groupId: access.groupId, companyIds: [], placeIds: [], matrix: { status: true, modules: role.modules } }))) {
        throw new AppError('FORBIDDEN');
      }
      const started = inheritedPos(null, 'SA');
      const pos = { ...started, options: { ...started.options, priceLists: [{ priceListId: input.priceListId, enabled: true, isDefault: true }] } };
      const document = toLegacyDocument(
        {
          id,
          username: input.username,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          role: 'SA',
          groupId: access.groupId.toHexString(),
          dealerId: input.dealerId === null ? null : input.dealerId.toHexString(),
          companyIds: [],
          placeIds: [],
          status: 'active',
          language: DEFAULT_LANGUAGE,
          theme: DEFAULT_THEME,
          hiddenInStats: false,
          description: null,
          avatar: null,
          pin: null,
          serviceIds: [],
          permissions,
          pos,
          shiftTime: emptyShiftTime(),
          legacyPasswordHash: change.legacyHash,
        },
        now,
      );
      const created = fromLegacy(document as LegacyUserDocument);
      return {
        id,
        snapshot: { ...snapshot(created.user), password: 'set' },
        run: async (session) => {
          try {
            await users.insert(document, session);
            await credentials.upsertPassword(
              id,
              { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint, passwordChanged: true, mustChangePassword: true, now },
              session,
            );
          } catch (error) {
            throw error instanceof MongoServerError && error.code === 11000 ? new AppError('CONFLICT', { details: [{ field: 'user.username', issue: 'taken' }] }) : error;
          }
        },
      };
    },

    update: async (principal, area, userId, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw validationError([{ field: '(body)', issue: 'required' }]);
      }
      const { record: target, view } = await findManageable(principal, area, userId, { locksOut: true });
      const before = target.user;
      const role: Role = patch.role ?? (before.role as Role);
      // A dealer is a user and a registry document with the same id: the role never moves to or from `D`.
      if ((role === 'D') !== (before.role === 'D')) {
        throw validationError([{ field: 'role', issue: 'immutable' }]);
      }
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
      const pos = applyPosPatch(before.pos, patch.pos);
      const posDenied = await posAccessError(posActorOf(principal), role, before.pos, pos);
      if (posDenied !== null) {
        throw posDenied;
      }
      const requestedServices = (patch as ServiceFields).serviceIds;
      const shiftTime = applyShiftTime(before.shiftTime, patch.shiftTime);
      const dataIssues = [
        ...optionReferenceIssues(patch.pos?.options, before.pos.options, referencesGroupLists(patch.pos?.options) ? await groupListsOf(area) : null),
        ...(await serviceIssues(principal, area, role, requestedServices, new Set(before.serviceIds))),
        ...(patch.shiftTime === undefined ? [] : shiftTimeIssues(shiftTime)),
      ];
      if (dataIssues.length > 0) {
        throw validationError(dataIssues);
      }
      if (patch.username !== undefined && patch.username !== before.username && (await users.isUsernameTaken(patch.username, userId))) {
        throw conflictUsernameTaken();
      }

      const differs = <T>(next: T | undefined, current: T): next is T => next !== undefined && next !== current;
      const permissionDiff = permissionChanges(view.matrix, matrix);
      const posDiff = diffPos(before.pos, pos);
      const shiftDiff = diffShiftTime(before.shiftTime, shiftTime);
      const serviceIds = requestedServices === undefined ? undefined : hexes(uniqueIds(requestedServices));
      const changes: UserChanges = {
        ...(differs(patch.username, before.username) ? { username: patch.username } : {}),
        ...(differs(patch.firstName, before.firstName) ? { firstName: patch.firstName } : {}),
        ...(differs(patch.lastName, before.lastName) ? { lastName: patch.lastName } : {}),
        ...(differs(patch.email, before.email) ? { email: patch.email } : {}),
        ...(differs(patch.phone, before.phone) ? { phone: patch.phone } : {}),
        ...(differs(patch.language, before.language) ? { language: patch.language } : {}),
        ...(differs(patch.theme, before.theme) ? { theme: patch.theme } : {}),
        ...(differs(patch.role, before.role as Role) ? { role: patch.role } : {}),
        ...(differs(patch.status, before.status) ? { status: patch.status } : {}),
        ...(scopeChanged ? { companyIds: hexes(companyIds), placeIds: hexes(placeIds) } : {}),
        ...(permissionDiff === undefined ? {} : { permissions: permissionDiff }),
        ...(differs(patch.hiddenInStats, before.hiddenInStats) ? { hiddenInStats: patch.hiddenInStats } : {}),
        ...(differs(patch.description, before.description) ? { description: patch.description } : {}),
        // A stored picture that cannot be shown reads as none, yet `null` must still remove it.
        ...(differs(patch.avatar, before.avatar ?? null) || (patch.avatar === null && before.hasAvatar) ? { avatar: patch.avatar } : {}),
        // The stored PIN is never read, so a PIN in the request is always written.
        ...(patch.pin === undefined ? {} : { pin: patch.pin }),
        ...(serviceIds === undefined || sameIds(serviceIds, before.serviceIds) ? {} : { serviceIds }),
        ...(posDiff === undefined ? {} : { pos: posDiff }),
        ...(shiftDiff === undefined ? {} : { shiftTime: shiftDiff }),
      };
      if (Object.keys(changes).length === 0) {
        return toResponse(before);
      }

      const now = date();
      // The POS app switch and grants are permissions too; the POS options are not.
      const permissionsChanged = permissionDiff !== undefined || posPermissionsChanged(before.pos, pos);
      const revocation = changes.role !== undefined ? 'roleChanged' : scopeChanged ? 'scopeChanged' : changes.status !== undefined ? 'statusChanged' : permissionsChanged ? 'permissionsChanged' : null;
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
        // The PIN is never read, so a change of it is told by a marker; the value is nowhere.
        after: { ...snapshot(updated.user), ...(patch.pin === undefined ? {} : { pinChange: patch.pin === null ? 'removed' : 'set' }) },
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
      if (permissionsChanged) {
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
      return toResponse({ ...target.user, trashed: true, trashedAt: now, updatedAt: now });
    },

    restore: async (principal, area, userId, client) => {
      const { record: target } = await findManageable(principal, area, userId);
      if (!target.user.trashed) {
        throw new AppError('CONFLICT');
      }
      const now = date();
      // The check and the write are one operation: a user restored (or deleted) since he was read is a conflict, and only the request that restores him records the event.
      if (!(await users.updateOwned(userId, toLegacyUpdate({ trashed: false }, now), undefined, { trash: true }))) {
        throw new AppError('CONFLICT');
      }
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.restored',
        before: { trashed: true },
        after: { trashed: false },
      });
      return toResponse({ ...target.user, trashed: false, trashedAt: null, updatedAt: now });
    },

    remove: async (principal, area, userId, client) => {
      const { record: target } = await findManageable(principal, area, userId, { locksOut: true });
      if (!target.user.trashed) {
        throw new AppError('CONFLICT');
      }
      // A dealer that still has groups (also trashed ones) would leave them pointing at nobody.
      if (target.user.role === 'D' && (await directory.isDealerOfAnyGroup(userId))) {
        throw new AppError('CONFLICT', { details: [{ field: 'groups', issue: 'referenced' }] });
      }
      const dealerRemoved = await transaction(async (session) => {
        // Check and delete are one write: a user restored in the meantime is not deleted.
        if (!(await users.deleteTrashed(userId, session))) {
          throw new AppError('CONFLICT');
        }
        await credentials.delete(userId, session);
        await sessions.deleteAllOfUser(userId, session);
        // The dealer's registry document has the same id; a `D` user created before the registry may have none.
        return target.user.role === 'D' ? await dealers.deleteById(userId, session) : null;
      });
      await recordDataChange(activityLog, {
        ...context(principal, area, client),
        resource: { type: 'user', id: userId.toHexString() },
        action: 'user.deleted',
        before: undefined,
        after: undefined,
        metadata: { role: target.user.role },
      });
      if (dealerRemoved !== null) {
        await recordDataChange(activityLog, {
          ...context(principal, area, client),
          resource: { type: 'dealer', id: userId.toHexString() },
          action: 'dealer.deleted',
          before: { ...companyOf(dealerRemoved) },
          after: undefined,
        });
      }
    },

    restoreFromTrash: (principal, area, userId, client) => settleItem(() => service.restore(principal, area, userId, client)),

    deleteFromTrash: (principal, area, userId, client) => settleItem(() => service.remove(principal, area, userId, client)),

    trashedIds: (principal, access, limit, after) => users.findTrashedIds(after === null ? groupTrashScope(principal, access) : withScope(groupTrashScope(principal, access), { _id: { $gt: after } }), limit),

    countTrashed: (principal, access) => users.countTrashed(groupTrashScope(principal, access)),

    isUsernameAvailable: async (username) => !(await users.isUsernameTaken(username)),
  };
  return service;
}
