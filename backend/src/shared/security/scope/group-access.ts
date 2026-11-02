import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import type { Request, RequestHandler } from 'express';
import type { Databases } from '../../../db/databases.ts';
import { AppError } from '../../http/errors.ts';
import type { PermissionDecisionHook } from '../rbac/require-permission.ts';
import type { GroupsRepository } from './groups.repository.ts';
import type { AuthPrincipal } from './principal.ts';

/** A group the caller was verified to reach. Only {@link resolveGroupAccess} creates one. */
export interface GroupAccess {
  readonly groupId: ObjectId;
  /** True when the caller is PSA or D, whose access to a group is audited. */
  readonly crossGroup: boolean;
}

const GROUP_ID_PATTERN = /^[0-9a-f]{24}$/;

/** Every access issued by {@link resolveGroupAccess}; {@link groupDatabaseFor} accepts nothing else. */
const issued = new WeakSet<GroupAccess>();

/**
 * Verifies a group id taken from the request path against the caller's perimeter (not against the
 * group's existence or state: {@link requireGroupAccess} does that).
 *
 * @param principal The authenticated caller.
 * @param rawGroupId The raw path parameter; must be 24 lower-case hex characters.
 * @returns The verified access, or `null` when the id is malformed or outside the perimeter
 * (the caller answers `404 NOT_FOUND`, never revealing which of the two it was).
 */
export function resolveGroupAccess(principal: AuthPrincipal, rawGroupId: string): GroupAccess | null {
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
      if (scope.groupId.toHexString() !== rawGroupId) {
        return null;
      }
      crossGroup = false;
      break;
    case 'none':
      return null;
  }
  const access: GroupAccess = Object.freeze({ groupId: ObjectId.createFromHexString(rawGroupId), crossGroup });
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
  readonly groups: GroupsRepository;
  /** Audit callback for PSA and D. */
  readonly onCrossGroupAccess: CrossGroupAccessHandler;
}

/**
 * Middleware for routes with a `:groupId` path parameter (the route builder mounts it for routes
 * declaring `group: true`). It verifies the group against the principal's scope and against
 * `common.groups`: a group that does not exist is `404` for everybody; a suspended or trashed
 * group is reachable only by PSA and `404` for everybody else. The result goes in `res.locals.groupAccess`.
 *
 * @param groups Group lookup.
 * @returns The handler: `401 UNAUTHENTICATED` without principal, `404 NOT_FOUND` otherwise when not reachable.
 */
export function requireGroupAccess(groups: GroupsRepository): RequestHandler {
  return async (req, res, next) => {
    const principal = res.locals.auth;
    if (principal === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    const access = resolveGroupAccess(principal, req.params['groupId'] as string);
    if (access === null) {
      throw new AppError('NOT_FOUND');
    }
    const availability = await groups.findAvailability(access.groupId);
    if (availability === null || (availability === 'unavailable' && principal.scope.kind !== 'platform')) {
      throw new AppError('NOT_FOUND');
    }
    res.locals.groupAccess = access;
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
 * Opens the database of a group. The only inputs are a principal and an access issued by
 * {@link resolveGroupAccess}; the access is checked again against the principal.
 *
 * @param principal The authenticated caller.
 * @param access A verified group access.
 * @param databases Database accessor.
 * @returns The group's database.
 * @throws {Error} If the access was not issued by {@link resolveGroupAccess} or does not belong to the principal.
 */
export function groupDatabaseFor(principal: AuthPrincipal, access: GroupAccess, databases: Databases): Db {
  if (!issued.has(access) || resolveGroupAccess(principal, access.groupId.toHexString()) === null) {
    throw new Error('Group database requested without a verified group access');
  }
  return databases.group(access.groupId);
}
