import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import type { Request, RequestHandler, Response } from 'express';
import type { ClusterId } from '../../../config.ts';
import type { Databases } from '../../../db/databases.ts';
import { featuresOf } from '../../../modules/groups/features.ts';
import type { FeatureFlags } from '../../../modules/groups/features.ts';
import { AppError } from '../../http/errors.ts';
import { hasPermission } from '../rbac/policy.ts';
import type { PermissionDecisionHook } from '../rbac/require-permission.ts';
import type { GroupsRepository } from './groups.repository.ts';
import type { AuthPrincipal, ScopeHolder } from './principal.ts';

/** A group the caller was verified to reach. Only {@link requireGroupAccess} creates one. */
export interface GroupAccess {
  readonly groupId: ObjectId;
  /** Cluster that holds the group's operational database, resolved from `groups.dataCluster`. */
  readonly clusterId: ClusterId;
  /** True when the caller is PSA or D, whose access to a group is audited. */
  readonly crossGroup: boolean;
  /** The features of the group, read in the same query as its state; a route that declares a `feature` is refused when it is off. */
  readonly features: FeatureFlags;
}

const GROUP_ID_PATTERN = /^[0-9a-f]{24}$/;

/** Every access issued by {@link requireGroupAccess}; {@link groupDatabaseFor} accepts nothing else. */
const issued = new WeakSet<GroupAccess>();

/** The outcome of the perimeter check: who may reach which group, before the cluster is known. */
interface Perimeter {
  readonly groupId: ObjectId;
  readonly crossGroup: boolean;
}

/** Checks a raw group id against the caller's perimeter; `null` when malformed or outside it. */
function checkPerimeter(principal: ScopeHolder, rawGroupId: string): Perimeter | null {
  if (typeof rawGroupId !== 'string' || !GROUP_ID_PATTERN.test(rawGroupId)) {
    return null;
  }
  const { scope } = principal;
  let crossGroup: boolean;
  switch (scope.kind) {
    case 'platform':
      crossGroup = true;
      break;
    case 'dealer':
      if (!scope.groupIds.has(rawGroupId)) {
        return null;
      }
      crossGroup = true;
      break;
    case 'group':
    case 'companies':
    case 'places':
    case 'store':
      if (scope.groupId.toHexString() !== rawGroupId) {
        return null;
      }
      crossGroup = false;
      break;
    case 'none':
      return null;
  }
  return { groupId: ObjectId.createFromHexString(rawGroupId), crossGroup };
}

/** Issues a verified access for a perimeter, the cluster and the features of the group. */
function issueGroupAccess(perimeter: Perimeter, clusterId: ClusterId, features: FeatureFlags): GroupAccess {
  const access: GroupAccess = Object.freeze({ ...perimeter, clusterId, features });
  issued.add(access);
  return access;
}

/** A PSA or D access to a group, as reported to the audit. */
export interface CrossGroupAccessEvent {
  readonly principal: AuthPrincipal;
  readonly groupId: ObjectId;
  readonly req: Request;
  /** Whether the permission check passed: a denied request (403) is an attempt, not an access. */
  readonly granted: boolean;
}

/** Called for every PSA or D request to a group, after the permission check; step 2C connects it to the activity log. */
export type CrossGroupAccessHandler = (event: CrossGroupAccessEvent) => void | Promise<void>;

/** What a group route needs from the application. */
export interface GroupAccessDeps {
  /** Group existence and state. */
  readonly groups: Pick<GroupsRepository, 'findAccess' | 'resolveCluster'>;
  /** Audit callback for PSA and D. */
  readonly onCrossGroupAccess: CrossGroupAccessHandler;
}

/**
 * Middleware for routes with a `:groupId` path parameter (the route builder mounts it for routes
 * declaring `group: true`). It verifies the group against the principal's scope and against
 * `common.groups`: a group that does not exist is `404` for everybody; a suspended or trashed
 * group is reachable only by PSA and `404` for everybody else. A group declared on a cluster that is not
 * configured fails with `UnknownClusterError` (`503`). The result, which carries the group's cluster and
 * features, goes in `res.locals.groupAccess`.
 *
 * @param groups Group lookup.
 * @param callerOf Where the caller is: the backoffice user in `res.locals.auth` by default; the route builder passes the store principal of `res.locals.store` for the requests authenticated with a store key.
 * @returns The handler: `401 UNAUTHENTICATED` without a caller, `404 NOT_FOUND` otherwise when not reachable.
 */
export function requireGroupAccess(
  groups: Pick<GroupsRepository, 'findAccess' | 'resolveCluster'>,
  callerOf: (res: Response) => ScopeHolder | undefined = (res) => res.locals.auth,
): RequestHandler {
  return async (req, res, next) => {
    const principal = callerOf(res);
    if (principal === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    const perimeter = checkPerimeter(principal, req.params['groupId'] as string);
    if (perimeter === null) {
      throw new AppError('NOT_FOUND');
    }
    const found = await groups.findAccess(perimeter.groupId);
    if (found === null || (found.availability === 'unavailable' && principal.scope.kind !== 'platform')) {
      throw new AppError('NOT_FOUND');
    }
    // The cluster is resolved only now: a suspended or trashed group is already a uniform 404 for non-PSA,
    // whatever its (possibly broken) dataCluster says.
    res.locals.groupAccess = issueGroupAccess(perimeter, groups.resolveCluster(found.group), featuresOf(found.group.settings));
    next();
  };
}

/**
 * Builds the permission-decision hook that reports PSA and D requests to the audit callback. If the
 * callback fails the request fails too (no unaudited cross-group access).
 *
 * @param onCrossGroupAccess Audit callback.
 */
export function reportCrossGroupAccess(onCrossGroupAccess: CrossGroupAccessHandler): PermissionDecisionHook {
  return async (principal, granted, req, res) => {
    const access = res.locals.groupAccess;
    if (access?.crossGroup === true) {
      await onCrossGroupAccess({ principal, groupId: access.groupId, req, granted });
    }
  };
}

/**
 * Checks that an access was issued by {@link requireGroupAccess} and belongs to the principal.
 *
 * @param principal The authenticated caller.
 * @param access A group access.
 * @throws {Error} If the access was not issued by {@link requireGroupAccess} or does not belong to the principal.
 */
export function assertVerifiedGroupAccess(principal: ScopeHolder, access: GroupAccess): void {
  if (!issued.has(access) || checkPerimeter(principal, access.groupId.toHexString()) === null) {
    throw new Error('Group database requested without a verified group access');
  }
}

/**
 * Opens the database of a group. The only inputs are a principal and an access issued by
 * {@link requireGroupAccess}; the access is checked again against the
 * principal, and the database is opened on the cluster the access carries.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @returns The group's database.
 * @throws {Error} If the access was not issued by {@link requireGroupAccess} or does not belong to the principal.
 * @throws {UnknownClusterError} If the access's cluster is not configured.
 */
export function groupDatabaseFor(principal: ScopeHolder, access: GroupAccess, databases: Databases): Db {
  assertVerifiedGroupAccess(principal, access);
  return databases.group(access.groupId, access.clusterId);
}

/** The accesses issued to create a group, with the user they were issued to: {@link groupCreationDatabase} accepts nothing else. */
const creations = new WeakMap<GroupAccess, ObjectId>();

/**
 * Issues the access to a group that does not exist yet, for the onboarding of a new customer (`doc/Tasks.md` area 8). The id is generated here (never taken from the
 * client), the group is on the cluster of the common database (D-25: the transaction that creates it spans the common and the group database, so there is no choice of cluster),
 * and only a caller who holds `groups:create` gets one. It is **not** an access {@link groupDatabaseFor} accepts: it opens the group database only through
 * {@link groupCreationDatabase}, for the user it was issued to, so it can never be used to write into a group that exists.
 *
 * @param principal The authenticated caller.
 * @param databases Database accessor (for the cluster of the common database).
 * @returns The access, with a new group id.
 * @throws {Error} If the caller does not hold `groups:create` (a bug: the route has already required it).
 */
export function issueGroupCreationAccess(principal: AuthPrincipal, databases: Pick<Databases, 'commonCluster'>): GroupAccess {
  if (!hasPermission(principal, 'groups:create')) {
    throw new Error('Group creation access requested without the permission to create groups');
  }
  const access: GroupAccess = Object.freeze({ groupId: new ObjectId(), clusterId: databases.commonCluster, crossGroup: true, features: featuresOf(undefined) });
  creations.set(access, principal.userId);
  return access;
}

/**
 * Checks that an access is a creation access issued to this caller (see {@link issueGroupCreationAccess}): every write that depends on the new group
 * (its database, its administrator) asks for it first, so none can be aimed at a group that exists.
 *
 * @param principal The authenticated caller the access was issued to.
 * @param access The creation access.
 * @throws {Error} If the access is not a creation access or was issued to another user.
 */
export function assertGroupCreationAccess(principal: AuthPrincipal, access: GroupAccess): void {
  const owner = creations.get(access);
  if (owner === undefined || !owner.equals(principal.userId)) {
    throw new Error('Group database requested without a group creation access');
  }
}

/**
 * Opens the database of a group being created, with an access from {@link issueGroupCreationAccess}.
 *
 * @param principal The authenticated caller the access was issued to.
 * @param access The creation access.
 * @param databases Database accessor.
 * @returns The group's database, on the cluster of the common database.
 * @throws {Error} If the access is not a creation access, was issued to another user, or is not on the cluster of the common database.
 */
export function groupCreationDatabase(principal: AuthPrincipal, access: GroupAccess, databases: Databases): Db {
  assertGroupCreationAccess(principal, access);
  if (access.clusterId !== databases.commonCluster) {
    throw new Error('Group database requested without a group creation access');
  }
  return databases.group(access.groupId, access.clusterId);
}
