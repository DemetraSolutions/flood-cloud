import { ObjectId } from 'mongodb';
import type { Config } from '../../config.ts';
import type { ActivityActor, ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { isRole } from '../../shared/security/rbac/permissions.ts';
import { generateSecret, hashSecret, parseSecret } from '../../shared/security/secrets.ts';
import { verifyDummyPassword, verifyUserPassword } from '../../shared/security/password-verifier.ts';
import { hashPassword } from '../../shared/security/scrypt.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import type { NonBrowserSubject } from '../../shared/security/non-browser-signal.ts';
import type { CredentialsRepository } from '../users/credentials.repository.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { User } from '../users/user.types.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import type { RefreshLookup, Session } from '../sessions/sessions.repository.ts';
import { checkAccount } from './account-state.ts';

/** Longest username and password the login looks at, in UTF-16 units (revision of step 2A). */
export const MAX_LOGIN_FIELD_LENGTH = 1024;

/** A new token pair and the times it is valid until. The tokens exist only here and in the response. */
export interface IssuedSession {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}

/**
 * A check made on a login or a refresh once the user is certain (the credentials verified, the account in good state) and before anything is written: it may refuse by throwing, and then nothing has
 * happened (no session, no token, no refresh token rotated, no counter of failed logins cleared). Used by the signal of the requests that do not look like a browser's.
 *
 * @param subject The user the operation is for.
 */
export type SessionGate = (subject: NonBrowserSubject) => Promise<void>;

/** The token pair of a login, and whether the user must replace a provisional password before anything else. */
export interface LoginResult extends IssuedSession {
  readonly passwordChangeRequired: boolean;
}

/** What the login needs from the request body. */
export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

/** Sign-in, refresh and sign-out of backoffice users (`doc/Security-Model.md` section 4). */
export interface AuthService {
  /**
   * Signs a user in. Every refusal is the same `401 INVALID_CREDENTIALS`: unknown user, wrong password,
   * locked account, `E` or retired role, disabled or trashed user, suspended or trashed group, and a
   * username or password outside 1 to {@link MAX_LOGIN_FIELD_LENGTH} units (no hash is computed for those).
   * An unknown or locked account still costs one scrypt run, so the response time tells nothing.
   * The reason goes to the activity log, never the username.
   *
   * @param input Username and password.
   * @param client Request context for the session and the log.
   * @returns The new token pair, and `passwordChangeRequired` when an administrator set the password.
   * @throws {AppError} `INVALID_CREDENTIALS`.
   */
  login(input: LoginInput, client: ClientContext, gate?: SessionGate): Promise<LoginResult>;
  /**
   * Rotates a refresh token. A token that was already used revokes the whole session family and
   * is reported as `auth.refreshReuseDetected`. Every refusal is `401 UNAUTHENTICATED`.
   *
   * @param refreshToken The refresh token as sent by the client (untrusted).
   * @param client Request context.
   * @returns The new token pair.
   * @throws {AppError} `UNAUTHENTICATED`.
   */
  refresh(refreshToken: string, client: ClientContext, gate?: SessionGate): Promise<IssuedSession>;
  /**
   * Revokes one session family (logout).
   *
   * @param userId The authenticated user.
   * @param sessionId The session to end (the current one).
   * @param actor Actor of the event.
   * @param groupId Group of the user.
   * @param client Request context.
   */
  logout(userId: ObjectId, sessionId: ObjectId, actor: ActivityActor, groupId: ObjectId | null, client: ClientContext): Promise<void>;
  /**
   * Revokes every session of the user and empties the legacy `tokens[]` (D-11).
   *
   * @param userId The authenticated user.
   * @param actor Actor of the event.
   * @param groupId Group of the user.
   * @param client Request context.
   */
  logoutAll(userId: ObjectId, actor: ActivityActor, groupId: ObjectId | null, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createAuthService}. */
export interface AuthServiceDeps {
  readonly config: Pick<Config, 'accessTokenTtlSeconds' | 'refreshIdleTtlSeconds' | 'sessionMaxTtlSeconds' | 'refreshReuseGraceSeconds' | 'legacyPasswordPepper'>;
  readonly users: UsersRepository;
  readonly credentials: CredentialsRepository;
  readonly sessions: SessionsRepository;
  readonly groups: GroupsRepository;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/** The actor of an event about a user known by id (the role only when it is a real one). */
function userActor(user: User): ActivityActor {
  return { kind: 'user', id: ObjectId.createFromHexString(user.id), ...(isRole(user.role) ? { role: user.role } : {}) };
}

/** The user an operation is for, as the non-browser signal needs it. */
function subjectOf(user: User): NonBrowserSubject {
  return { userId: ObjectId.createFromHexString(user.id), actor: userActor(user), ...groupOf(user) };
}

function groupOf(user: User): { groupId?: ObjectId } {
  return user.groupId === null ? {} : { groupId: ObjectId.createFromHexString(user.groupId) };
}

const inBounds = (value: string): boolean => value.length >= 1 && value.length <= MAX_LOGIN_FIELD_LENGTH;

/**
 * Builds the authentication service.
 *
 * @param deps Repositories, configuration, activity log and clock.
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { config, users, credentials, sessions, groups, activityLog } = deps;
  const date = (): Date => new Date(deps.now());

  /** Token pair for a family ending at `familyExpiresAt`; no expiry goes beyond the family. */
  const issue = (now: Date, familyExpiresAt: Date) => {
    const cap = (seconds: number): Date => new Date(Math.min(now.getTime() + seconds * 1000, familyExpiresAt.getTime()));
    const accessToken = generateSecret('fc_at_');
    const refreshToken = generateSecret('fc_rt_');
    return {
      accessToken,
      refreshToken,
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      accessExpiresAt: cap(config.accessTokenTtlSeconds),
      refreshExpiresAt: cap(config.refreshIdleTtlSeconds),
    };
  };

  const issued = (pair: ReturnType<typeof issue>, sessionId: ObjectId): IssuedSession => ({
    accessToken: pair.accessToken,
    accessTokenExpiresAt: pair.accessExpiresAt,
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: pair.refreshExpiresAt,
    sessionId: sessionId.toHexString(),
  });

  const entry = (client: ClientContext) => ({
    requestId: client.requestId,
    ...(client.ip === null ? {} : { ip: client.ip }),
  });

  /** Records the failed attempt and refuses with the one answer every failure gets. */
  const denyLogin = async (client: ClientContext, reason: string, user?: User): Promise<never> => {
    await activityLog.record({
      category: 'security',
      action: 'auth.loginFailed',
      outcome: 'failure',
      actor: user === undefined ? { kind: 'anonymous' } : userActor(user),
      ...(user === undefined ? {} : groupOf(user)),
      ...entry(client),
      metadata: { reason },
    });
    throw new AppError('INVALID_CREDENTIALS');
  };

  /** Revokes the family of a session reused or over, records both events and refuses. */
  const revokeForState = async (session: Session, reason: string, user: User | null, client: ClientContext): Promise<void> => {
    if (await sessions.revoke(session.id, reason, date())) {
      await auditSessionsRevoked(activityLog, {
        actor: { kind: 'system' },
        ...(user === null ? {} : groupOf(user)),
        reason,
        sessionId: session.id,
        client,
      });
    }
  };

  /** Group of a user known by id, for the events that only have the session. */
  const groupOfUser = async (userId: ObjectId): Promise<{ groupId?: ObjectId }> => {
    const groupId = (await users.findAuthRecord(userId))?.stored.groupId;
    return groupId == null ? {} : { groupId };
  };

  /**
   * A refresh token that was already rotated. If it is the latest one and the rotation was seconds
   * ago, it is a retry after a lost response: refused without issuing anything and without ending the
   * session, so the pair the client received stays valid. Otherwise the family is compromised: it is
   * revoked and, if this request is the one that revoked it, the reuse is reported.
   */
  const handleRotated = async (found: Extract<RefreshLookup, { kind: 'rotated' }>, client: ClientContext): Promise<never> => {
    const { session } = found;
    const rotatedAt = session.rotatedAt?.getTime();
    const grace = config.refreshReuseGraceSeconds * 1000;
    const tolerated = found.latest && rotatedAt !== undefined && deps.now() - rotatedAt < grace;
    const base = { category: 'security', actor: { kind: 'user', id: session.userId }, ...(await groupOfUser(session.userId)), resource: { type: 'session', id: session.id.toHexString() }, ...entry(client) } as const;
    if (tolerated) {
      await activityLog.record({ ...base, action: 'auth.refreshRaceTolerated', outcome: 'denied' });
    } else if (await sessions.revoke(session.id, 'refreshReuse', date())) {
      await activityLog.record({ ...base, action: 'auth.refreshReuseDetected', outcome: 'denied' });
    }
    throw new AppError('UNAUTHENTICATED');
  };

  return {
    login: async ({ username, password }, client, gate) => {
      if (!inBounds(username) || !inBounds(password)) {
        return denyLogin(client, 'invalidInput');
      }
      const record = await users.findByUsernameForLogin(username);
      if (record === null) {
        await verifyDummyPassword(password);
        return denyLogin(client, 'unknownUser');
      }
      const { user } = record;
      const userId = ObjectId.createFromHexString(user.id);
      const now = date();
      const stored = await credentials.find(userId);
      if (stored?.lockedUntil && stored.lockedUntil.getTime() > now.getTime()) {
        await verifyDummyPassword(password);
        return denyLogin(client, 'locked', user);
      }
      const verification = await verifyUserPassword({
        password,
        legacyHash: record.legacyPasswordHash,
        credentials: stored?.passwordHash ? { passwordHash: stored.passwordHash, legacyHashFingerprint: stored.legacyHashFingerprint } : null,
        pepper: config.legacyPasswordPepper,
      });
      if (!verification.ok) {
        await credentials.recordFailure(userId, now);
        return denyLogin(client, 'wrongPassword', user);
      }
      const denial = await checkAccount(user, groups);
      if (denial !== null) {
        if (!verification.usedScrypt) {
          // Keep one scrypt on every refusal, so a right password on a blocked account costs the same as a wrong one.
          await verifyDummyPassword(password);
        }
        return denyLogin(client, denial, user);
      }
      await gate?.(subjectOf(user));
      await credentials.recordSuccess(userId, now);
      if (verification.rehash !== null) {
        await credentials.upsertPassword(userId, { passwordHash: await hashPassword(password), legacyHashFingerprint: verification.rehash.legacyHashFingerprint, passwordChanged: false, now });
      }
      const familyExpiresAt = new Date(now.getTime() + config.sessionMaxTtlSeconds * 1000);
      const pair = issue(now, familyExpiresAt);
      const session = await sessions.create({
        userId,
        accessTokenHash: pair.accessTokenHash,
        accessExpiresAt: pair.accessExpiresAt,
        refreshTokenHash: pair.refreshTokenHash,
        refreshExpiresAt: pair.refreshExpiresAt,
        familyExpiresAt,
        userAgent: client.userAgent,
        ip: client.ip,
        now,
      });
      await activityLog.record({
        category: 'security',
        action: 'auth.loginSucceeded',
        outcome: 'success',
        actor: userActor(user),
        ...groupOf(user),
        resource: { type: 'session', id: session.id.toHexString() },
        ...entry(client),
      });
      return { ...issued(pair, session.id), passwordChangeRequired: stored?.mustChangePassword === true };
    },

    refresh: async (refreshToken, client, gate) => {
      const token = parseSecret(refreshToken, 'fc_rt_');
      const found = token === null ? null : await sessions.findByRefreshHash(hashSecret(token));
      if (found === null || found.session.revokedAt !== null) {
        throw new AppError('UNAUTHENTICATED');
      }
      const { session } = found;
      if (found.kind === 'rotated') {
        return handleRotated(found, client);
      }
      const now = date();
      if (now.getTime() >= session.refreshExpiresAt.getTime() || now.getTime() >= session.familyExpiresAt.getTime()) {
        throw new AppError('UNAUTHENTICATED');
      }
      const user = (await users.findAuthRecord(session.userId))?.user ?? null;
      const denial = await checkAccount(user, groups);
      if (denial !== null) {
        await revokeForState(session, denial, user, client);
        throw new AppError('UNAUTHENTICATED');
      }
      await gate?.(subjectOf(user!));
      const pair = issue(now, session.familyExpiresAt);
      const rotated = await sessions.rotate(session.id, session.refreshTokenHash, {
        accessTokenHash: pair.accessTokenHash,
        accessExpiresAt: pair.accessExpiresAt,
        refreshTokenHash: pair.refreshTokenHash,
        refreshExpiresAt: pair.refreshExpiresAt,
        now,
      });
      if (rotated === null) {
        // Another request rotated or ended the session first: look again to see which.
        const again = await sessions.findByRefreshHash(hashSecret(token!));
        if (again === null || again.session.revokedAt !== null || again.kind !== 'rotated') {
          throw new AppError('UNAUTHENTICATED');
        }
        return handleRotated(again, client);
      }
      await activityLog.record({
        category: 'security',
        action: 'auth.refreshed',
        outcome: 'success',
        actor: userActor(user!),
        ...groupOf(user!),
        resource: { type: 'session', id: session.id.toHexString() },
        ...entry(client),
      });
      return issued(pair, session.id);
    },

    logout: async (userId, sessionId, actor, groupId, client) => {
      if (await sessions.revokeOwned(userId, sessionId, 'logout', date())) {
        await auditSessionsRevoked(activityLog, { actor, groupId, reason: 'logout', sessionId, client });
      }
    },

    logoutAll: async (userId, actor, groupId, client) => {
      const count = await sessions.revokeAllOfUser(userId, 'logoutAll', date());
      await users.clearLegacyTokens(userId);
      if (count > 0) {
        await auditSessionsRevoked(activityLog, { actor, groupId, reason: 'logoutAll', client });
      }
    },
  };
}
