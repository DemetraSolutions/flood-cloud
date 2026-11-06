import type { ObjectId } from 'mongodb';
import type { Config } from '../../config.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { buildPasswordChange } from '../../shared/security/password-change.ts';
import { verifyUserPassword } from '../../shared/security/password-verifier.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { DealersRepository } from '../dealers/dealers.repository.ts';
import type { CredentialsRepository } from '../users/credentials.repository.ts';
import { toLegacyUpdate } from '../users/user.mapper.ts';
import type { User } from '../users/user.types.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import type { Session, SessionsRepository } from '../sessions/sessions.repository.ts';
import type { ChangePasswordBody, PatchMeBody } from './me.schemas.ts';
import type { GroupSummaryRepository } from './group-summary.repository.ts';
import { toProfile } from './profile.ts';
import type { Profile } from './profile.ts';

/** One of the user's own sessions, as shown by `GET /v1/me/sessions`. */
export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly userAgent: string | null;
  readonly ip: string | null;
  /** Whether it is the session of the request. */
  readonly current: boolean;
}

/** The profile and the account operations of the authenticated user on himself. */
export interface MeService {
  /**
   * Reads the profile.
   *
   * @param principal The authenticated user.
   * @throws {AppError} `NOT_FOUND` if the user disappeared since the authentication.
   */
  getProfile(principal: AuthPrincipal): Promise<Profile>;
  /**
   * Updates the personal fields (JSON Merge Patch) and records `user.updated` with the field changes.
   *
   * @param principal The authenticated user.
   * @param changes Validated, non-empty changes.
   * @param client Request context.
   * @returns The updated profile.
   * @throws {AppError} `VALIDATION_ERROR` for an empty patch; `NOT_FOUND` if the user disappeared.
   */
  updateProfile(principal: AuthPrincipal, changes: PatchMeBody, client: ClientContext): Promise<Profile>;
  /**
   * Changes the password: checks the current one (no progressive lock, but a dedicated rate limit on
   * the route; a wrong one is logged as `auth.passwordCheckFailed`), applies the policy, writes the legacy hash while the legacy coexists (removes it otherwise), then the scrypt
   * credentials (clearing the "must change the password" flag of a provisional one), revokes the other sessions and empties the legacy `tokens[]` (D-11).
   *
   * @param principal The authenticated user.
   * @param sessionId The current session, which stays valid.
   * @param input Current and new password.
   * @param client Request context.
   * @throws {AppError} `VALIDATION_ERROR` with `currentPassword`/`incorrect` or the policy issues on `newPassword`.
   */
  changePassword(principal: AuthPrincipal, sessionId: ObjectId, input: ChangePasswordBody, client: ClientContext): Promise<void>;
  /**
   * Lists the user's active sessions.
   *
   * @param principal The authenticated user.
   * @param currentSessionId The session of the request.
   */
  listSessions(principal: AuthPrincipal, currentSessionId: ObjectId): Promise<readonly SessionView[]>;
  /**
   * Revokes one of the user's own sessions.
   *
   * @param principal The authenticated user.
   * @param sessionId The session to revoke.
   * @param client Request context.
   * @throws {AppError} `NOT_FOUND` when it does not exist, is not his, or is already revoked.
   */
  revokeSession(principal: AuthPrincipal, sessionId: ObjectId, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createMeService}. */
export interface MeServiceDeps {
  readonly config: Pick<Config, 'legacyPasswordPepper' | 'legacyPasswordCoexistence'>;
  readonly users: UsersRepository;
  readonly credentials: CredentialsRepository;
  readonly sessions: SessionsRepository;
  readonly groups: GroupSummaryRepository;
  /** The dealer registry, for the profile of a `D` user. */
  readonly dealers: Pick<DealersRepository, 'findSummary'>;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** The fields `PATCH /v1/me` can change, as recorded in the activity log. */
const editable = (user: Pick<User, 'firstName' | 'lastName' | 'email' | 'phone' | 'language'>) => ({ firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, language: user.language });

const toSessionView = (session: Session, currentSessionId: ObjectId): SessionView => ({
  id: session.id.toHexString(),
  createdAt: session.createdAt.toISOString(),
  lastUsedAt: session.lastUsedAt.toISOString(),
  userAgent: session.userAgent,
  ip: session.ip,
  current: session.id.equals(currentSessionId),
});

/**
 * Builds the service of the authenticated user's own account.
 *
 * @param deps Repositories, configuration, activity log and clock.
 */
export function createMeService(deps: MeServiceDeps): MeService {
  const { config, users, credentials, sessions, groups, dealers, activityLog } = deps;
  const date = (): Date => new Date(deps.now());

  const load = async (principal: AuthPrincipal): Promise<Profile> => {
    const mapped = await users.findById(principal.userId);
    if (mapped === null) {
      throw new AppError('NOT_FOUND');
    }
    const groupId = principal.scope.kind === 'group' || principal.scope.kind === 'companies' || principal.scope.kind === 'places' ? principal.scope.groupId : null;
    const stored = await credentials.find(principal.userId);
    const dealer = principal.role === 'D' ? await dealers.findSummary(principal.userId) : null;
    return toProfile(mapped.user, principal, groupId === null ? null : await groups.find(groupId), dealer, stored?.mustChangePassword === true);
  };

  return {
    getProfile: load,

    updateProfile: async (principal, changes, client) => {
      if (Object.keys(changes).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      const before = await users.findById(principal.userId);
      if (before === null || !(await users.updateOwned(principal.userId, toLegacyUpdate(changes, date())))) {
        throw new AppError('NOT_FOUND');
      }
      const profile = await load(principal);
      await recordDataChange(activityLog, {
        actor: actorOf(principal),
        ...(principal.groupId === null ? {} : { groupId: principal.groupId }),
        resource: { type: 'user', id: principal.userId.toHexString() },
        action: 'user.updated',
        before: editable(before.user),
        after: editable(profile),
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      return profile;
    },

    changePassword: async (principal, sessionId, { currentPassword, newPassword }, client) => {
      const record = await users.findLoginRecordById(principal.userId);
      if (record === null) {
        throw new AppError('NOT_FOUND');
      }
      const stored = await credentials.find(principal.userId);
      const verification = await verifyUserPassword({
        password: currentPassword,
        legacyHash: record.legacyPasswordHash,
        credentials: stored?.passwordHash ? { passwordHash: stored.passwordHash, legacyHashFingerprint: stored.legacyHashFingerprint } : null,
        pepper: config.legacyPasswordPepper,
      });
      if (!verification.ok) {
        await activityLog.record({
          category: 'security',
          action: 'auth.passwordCheckFailed',
          outcome: 'failure',
          actor: actorOf(principal),
          ...(principal.groupId === null ? {} : { groupId: principal.groupId }),
          resource: { type: 'user', id: principal.userId.toHexString() },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
        });
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'currentPassword', issue: 'incorrect' }] });
      }
      if (newPassword.normalize('NFC') === currentPassword.normalize('NFC')) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'newPassword', issue: 'reused' }] });
      }
      const change = await buildPasswordChange(newPassword, {
        username: record.user.username,
        pepper: config.legacyPasswordPepper,
        legacyCoexistence: config.legacyPasswordCoexistence,
      });
      if (!change.ok) {
        throw new AppError('VALIDATION_ERROR', { details: change.issues.map((issue) => ({ field: 'newPassword', issue })) });
      }
      const now = date();
      // The legacy first: if the second write fails, the legacy hash alone decides and the new password already works.
      // With the coexistence off there is no legacy hash to keep in step: the old one is removed.
      await users.updateOwned(principal.userId, toLegacyUpdate({ password: change.legacyHash }, now));
      await credentials.upsertPassword(principal.userId, { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint, passwordChanged: true, mustChangePassword: false, now });
      const revoked = await sessions.revokeAllOfUser(principal.userId, 'passwordChanged', now, sessionId);
      await users.clearLegacyTokens(principal.userId);
      const groupId = principal.groupId === null ? {} : { groupId: principal.groupId };
      await recordDataChange(activityLog, {
        actor: actorOf(principal),
        ...groupId,
        resource: { type: 'user', id: principal.userId.toHexString() },
        action: 'user.updated',
        before: { password: 'previous' },
        after: { password: 'changed' },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      if (revoked > 0) {
        await auditSessionsRevoked(activityLog, { actor: actorOf(principal), groupId: principal.groupId, reason: 'passwordChanged', client });
      }
    },

    listSessions: async (principal, currentSessionId) =>
      (await sessions.listActive(principal.userId, date())).map((session) => toSessionView(session, currentSessionId)),

    revokeSession: async (principal, sessionId, client) => {
      if (!(await sessions.revokeOwned(principal.userId, sessionId, 'revokedByUser', date()))) {
        throw new AppError('NOT_FOUND');
      }
      await auditSessionsRevoked(activityLog, { actor: actorOf(principal), groupId: principal.groupId, reason: 'revokedByUser', sessionId, client });
    },
  };
}
