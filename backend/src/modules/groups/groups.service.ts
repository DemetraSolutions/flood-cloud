import type { ClientSession, ObjectId } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { changesOf, forbiddenFields } from './group-changes.ts';
import { changeSnapshot, toLegacyUpdate, toResponse } from './group.mapper.ts';
import type { Group, GroupChanges, GroupResponse, Provider } from './group.types.ts';
import type { ManagedGroupsRepository } from './groups.repository.ts';
import type { PatchGroupBody } from './groups.schemas.ts';

/** Users handled in one transaction when the sessions of a whole group are ended: a group of thousands is walked in batches, never loaded whole. */
export const REVOCATION_BATCH_SIZE = 500;

/** The management of a group: its detail, its modification and its state (suspension, trash). */
export interface GroupsService {
  /**
   * Reads the group of a verified access. A PSA also sees the cluster of the group.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @throws {AppError} `NOT_FOUND` if the group disappeared since the access was checked.
   */
  get(principal: AuthPrincipal, access: GroupAccess): Promise<GroupResponse>;
  /**
   * Modifies a group (JSON Merge Patch) and records `group.updated` with the field changes. Which fields a role may send is
   * fixed by D-13; a request that changes nothing writes nothing.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param patch Validated body.
   * @param client Request context.
   * @throws {AppError} `VALIDATION_ERROR` for an empty body; `FORBIDDEN` (with a `notAllowed` detail per field) for a field the role may not send;
   * `NOT_FOUND`; `CONFLICT` when the stored document cannot take the change (a `settings` or `publicApi` container that is not an object). A dealer who changes a value of `publicApi` (the PSA's alone) gets `FORBIDDEN` with a `publicApi.<name>` `notAllowed` detail.
   */
  update(principal: AuthPrincipal, access: GroupAccess, patch: PatchGroupBody, client: ClientContext): Promise<GroupResponse>;
  /**
   * Suspends a group: it is refused to everybody but the PSA, every session of its users is revoked and their legacy tokens emptied (D-11),
   * before the write (so a failure leaves the group active and the action can be repeated) and again after it (for a concurrent login).
   *
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the group is already suspended.
   */
  suspend(principal: AuthPrincipal, access: GroupAccess, client: ClientContext): Promise<GroupResponse>;
  /**
   * Reactivates a suspended group. The sessions revoked by the suspension stay revoked, and any session of its users still open (left by a
   * failed revocation or opened in a race with the suspension) is ended before the group is reactivated.
   *
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the group is not suspended.
   */
  reactivate(principal: AuthPrincipal, access: GroupAccess, client: ClientContext): Promise<void>;
  /**
   * Moves a group to the trash, with the same revocation as a suspension. A group is never deleted for good.
   *
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the group is already in the trash.
   */
  trash(principal: AuthPrincipal, access: GroupAccess, client: ClientContext): Promise<GroupResponse>;
  /**
   * Takes a group out of the trash, ending first any session of its users still open, as the reactivation does.
   *
   * @throws {AppError} `NOT_FOUND`; `CONFLICT` when the group is not in the trash.
   */
  restore(principal: AuthPrincipal, access: GroupAccess, client: ClientContext): Promise<GroupResponse>;
}

/** Collaborators of {@link createGroupsService}. */
export interface GroupsServiceDeps {
  readonly groups: ManagedGroupsRepository;
  readonly users: Pick<UsersRepository, 'findIdsOfGroup' | 'clearLegacyTokensOfMany'>;
  readonly sessions: Pick<SessionsRepository, 'revokeAllOfUsers'>;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Runs the work in a transaction on the common cluster, where users and sessions live. */
  readonly transaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** Who sees, in the detail of a group, the settings of its public API: the PSA and the dealers (the group administrator does not manage the keys). */
const seesPublicApi = (principal: AuthPrincipal): boolean => principal.role === 'PSA' || principal.role === 'D';

type StateAction = 'group.suspended' | 'group.reactivated' | 'group.trashed' | 'group.restored';

/**
 * Builds the group management service.
 *
 * @param deps Repositories, activity log, logger, transaction runner and clock.
 */
export function createGroupsService(deps: GroupsServiceDeps): GroupsService {
  const { groups, users, sessions, activityLog, logger, transaction } = deps;
  const date = (): Date => new Date(deps.now());

  const load = async (id: ObjectId): Promise<Group> => {
    const mapped = await groups.findById(id);
    if (mapped === null) {
      throw new AppError('NOT_FOUND');
    }
    if (mapped.anomalies.length > 0) {
      logger.warn('group anomalies', { groupId: id.toHexString(), anomalies: mapped.anomalies });
    }
    return mapped.group;
  };

  const write = async (id: ObjectId, changes: GroupChanges, now: Date): Promise<void> => {
    const outcome = await groups.updateOwned(id, toLegacyUpdate(changes, now));
    if (outcome === 'notFound') {
      throw new AppError('NOT_FOUND');
    }
    if (outcome === 'malformed') {
      throw new AppError('CONFLICT');
    }
  };

  const respond = async (principal: AuthPrincipal, id: ObjectId): Promise<GroupResponse> => toResponse(await load(id), principal.role === 'PSA', seesPublicApi(principal));

  /**
   * Ends the sessions of every user of the group and, when asked, empties their legacy tokens (D-11), a batch per transaction;
   * the number of sessions revoked.
   */
  const endSessions = async (groupId: ObjectId, reason: string, now: Date, clearTokens: boolean): Promise<number> => {
    let revoked = 0;
    let after: ObjectId | null = null;
    for (;;) {
      const ids: ObjectId[] = await users.findIdsOfGroup(groupId, after, REVOCATION_BATCH_SIZE);
      if (ids.length === 0) {
        return revoked;
      }
      revoked += await transaction(async (session) => {
        const count = await sessions.revokeAllOfUsers(ids, reason, now, session);
        if (clearTokens) {
          await users.clearLegacyTokensOfMany(ids, session);
        }
        return count;
      });
      after = ids[ids.length - 1]!;
    }
  };

  const securityEvent = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, action: StateAction) =>
    activityLog.record({
      category: 'security',
      action,
      outcome: 'success',
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'group', id: access.groupId.toHexString() },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });

  const dataEvent = (principal: AuthPrincipal, access: GroupAccess, client: ClientContext, action: 'group.trashed' | 'group.restored', trashed: boolean) =>
    recordDataChange(activityLog, {
      actor: actorOf(principal),
      groupId: access.groupId,
      resource: { type: 'group', id: access.groupId.toHexString() },
      action,
      before: { trashed: !trashed },
      after: { trashed },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });

  /**
   * A state change that must find the group in the opposite state (else `CONFLICT`). Every change first ends the sessions of the users of the group:
   * - suspension and trash (`revokes`) end them and empty the legacy tokens before the write, so that a failure half-way leaves the group as it
   *   was and the PSA can repeat the action, and once more after it, for a login that passed its check just before the write;
   * - reactivation and restore end, before the write, the sessions still open while the group was unavailable: none is legitimate (login, refresh
   *   and every request refuse such a group), so only a session left by a failed revocation or by that race can be there, and it must not come back
   *   to life with the group. The legacy tokens are left to the legacy here.
   */
  const changeState = async (
    principal: AuthPrincipal,
    access: GroupAccess,
    client: ClientContext,
    change: {
      readonly changes: GroupChanges;
      readonly applies: (group: Group) => boolean;
      readonly action: StateAction;
      /** The data event of the change, for the actions that are also writes to the trash flag. */
      readonly data?: { readonly action: 'group.trashed' | 'group.restored'; readonly trashed: boolean };
      /** Reason code of the sessions ended by the change. */
      readonly revocation: string;
      /** Whether the change makes the group unavailable (suspension, trash). */
      readonly revokes: boolean;
    },
  ): Promise<void> => {
    const before = await load(access.groupId);
    if (!change.applies(before)) {
      throw new AppError('CONFLICT');
    }
    const now = date();
    let revoked = await endSessions(access.groupId, change.revocation, now, change.revokes);
    await write(access.groupId, change.changes, now);
    if (change.revokes) {
      revoked += await endSessions(access.groupId, change.revocation, now, true);
    }
    await securityEvent(principal, access, client, change.action);
    if (change.data !== undefined) {
      await dataEvent(principal, access, client, change.data.action, change.data.trashed);
    }
    if (revoked > 0) {
      await auditSessionsRevoked(activityLog, { actor: actorOf(principal), groupId: access.groupId, reason: change.revocation, client });
    }
  };

  return {
    get: (principal, access) => respond(principal, access.groupId),

    update: async (principal, access, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      const refused = forbiddenFields(principal.role, patch);
      if (refused.length > 0) {
        throw new AppError('FORBIDDEN', { details: refused.map((field) => ({ field, issue: 'notAllowed' })) });
      }
      const before = await load(access.groupId);
      const changes = changesOf(before, patch);
      // Reserved field: the switch and the limits of the public API are the PSA's. A dealer may send the values the group already has, never a different one.
      if (principal.role !== 'PSA' && changes.publicApi !== undefined) {
        throw new AppError('FORBIDDEN', { details: Object.keys(changes.publicApi).map((name) => ({ field: `publicApi.${name}`, issue: 'notAllowed' })) });
      }
      if (Object.keys(changes).length === 0) {
        return toResponse(before, principal.role === 'PSA', seesPublicApi(principal));
      }
      await write(access.groupId, changes, date());
      const after = await load(access.groupId);
      await recordDataChange(activityLog, {
        actor: actorOf(principal),
        groupId: access.groupId,
        resource: { type: 'group', id: access.groupId.toHexString() },
        action: 'group.updated',
        before: changeSnapshot(before),
        after: changeSnapshot(after, (Object.entries(changes.integrations ?? {}) as Array<[Provider, { apiKey?: string | null }]>).filter(([, state]) => state.apiKey !== undefined).map(([provider]) => provider)),
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      return toResponse(after, principal.role === 'PSA', seesPublicApi(principal));
    },

    suspend: async (principal, access, client) => {
      await changeState(principal, access, client, { changes: { status: 'suspended' }, applies: (group) => group.status === 'active', action: 'group.suspended', revocation: 'groupSuspended', revokes: true });
      return respond(principal, access.groupId);
    },

    reactivate: (principal, access, client) =>
      changeState(principal, access, client, { changes: { status: 'active' }, applies: (group) => group.status === 'suspended', action: 'group.reactivated', revocation: 'groupSuspended', revokes: false }),

    trash: async (principal, access, client) => {
      await changeState(principal, access, client, { changes: { trashed: true }, applies: (group) => !group.trashed, action: 'group.trashed', data: { action: 'group.trashed', trashed: true }, revocation: 'groupTrashed', revokes: true });
      return respond(principal, access.groupId);
    },

    restore: async (principal, access, client) => {
      await changeState(principal, access, client, { changes: { trashed: false }, applies: (group) => group.trashed, action: 'group.restored', data: { action: 'group.restored', trashed: false }, revocation: 'groupTrashed', revokes: false });
      return respond(principal, access.groupId);
    },
  };
}
