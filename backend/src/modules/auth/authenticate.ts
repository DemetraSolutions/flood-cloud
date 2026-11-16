import type { RequestHandler } from 'express';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { hashSecret, parseSecret } from '../../shared/security/secrets.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import { buildPrincipal } from '../../shared/security/scope/principal.ts';
import type { ComputeScopeDeps } from '../../shared/security/scope/scope.ts';
import type { CredentialsRepository } from '../users/credentials.repository.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import { LAST_USED_RESOLUTION_MS } from '../sessions/sessions.repository.ts';
import type { SessionsRepository } from '../sessions/sessions.repository.ts';
import { checkAccount } from './account-state.ts';

const BEARER = /^Bearer (\S+)$/i;

/** Collaborators of {@link createAuthenticate}. */
export interface AuthenticateDeps {
  readonly sessions: SessionsRepository;
  readonly users: UsersRepository;
  /** Tells whether the user still has to replace a provisional password. */
  readonly credentials: Pick<CredentialsRepository, 'isPasswordChangeRequired'>;
  readonly groups: GroupsRepository;
  /** Dealer groups and company places, for the scope computed on every request. */
  readonly scope: ComputeScopeDeps;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the Bearer authentication of the `/v1` surface (`doc/Security-Model.md` section 4).
 *
 * A request needs `Authorization: Bearer fc_at_…` of exact format whose hash is the current access
 * token of a session that is not revoked, else `401 UNAUTHENTICATED`; an expired token is
 * `401 TOKEN_EXPIRED`. The response never says which check failed. Then, on every request, the
 * user and his group are read again: a disabled or trashed user, a role that may not use the
 * backoffice, a suspended or trashed group revoke the session at once (`401 UNAUTHENTICATED`).
 * Permissions and scope are recomputed from the stored user on every request and stored, with the
 * session id, in `res.locals`; a user who still has to replace a provisional password gets
 * `res.locals.passwordChangeRequired`, which the route builder turns into `403 PASSWORD_CHANGE_REQUIRED`
 * on every route not declared to allow it. `lastUsedAt` is refreshed at most once a minute, off the response
 * path: a failure is logged and never fails the request.
 *
 * @param deps Repositories, activity log, logger and clock.
 * @returns The middleware to pass to `mountRoutes` for `/v1`.
 */
export function createAuthenticate(deps: AuthenticateDeps): RequestHandler {
  const { sessions, users, credentials, groups, scope, activityLog, logger } = deps;
  return async (req, res, next) => {
    const presented = BEARER.exec(req.get('authorization') ?? '')?.[1];
    const token = parseSecret(presented, 'fc_at_');
    const session = token === null ? null : await sessions.findByAccessHash(hashSecret(token));
    if (session === null || session.revokedAt !== null) {
      throw new AppError('UNAUTHENTICATED');
    }
    const now = new Date(deps.now());
    if (session.accessExpiresAt.getTime() <= now.getTime()) {
      throw new AppError('TOKEN_EXPIRED');
    }
    const record = await users.findAuthRecord(session.userId);
    const denial = await checkAccount(record?.user ?? null, groups);
    if (denial !== null) {
      if (await sessions.revoke(session.id, denial, now)) {
        await auditSessionsRevoked(activityLog, {
          actor: { kind: 'system' },
          ...(record?.stored.groupId == null ? {} : { groupId: record.stored.groupId }),
          reason: denial,
          sessionId: session.id,
          client: clientContextOf(req, res),
        });
      }
      throw new AppError('UNAUTHENTICATED');
    }
    const { principal, anomalies } = await buildPrincipal(record!.stored, scope);
    if (anomalies.length > 0) {
      logger.warn('scope anomaly', { userId: session.userId.toHexString(), anomalies });
    }
    res.locals.auth = principal;
    res.locals.sessionId = session.id;
    if (await credentials.isPasswordChangeRequired(session.userId)) {
      res.locals.passwordChangeRequired = true;
    }
    if (now.getTime() - session.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
      sessions.touch(session.id, now).catch((error: unknown) => {
        logger.error('updating the last use of a session failed', { error });
      });
    }
    next();
  };
}

const STORE_KEY_BEARER = /^Bearer fc_sk_/i;

/**
 * Builds the authentication of a surface that accepts two kinds of credential, told apart by the prefix of the Bearer secret and nothing else: `fc_sk_` goes to the store key
 * authentication, every other value to the user authentication (which answers `401` to anything that is not one of its tokens, an `fc_pk_` API key included). Never "try one, then the other":
 * the prefix decides, so a credential of one kind is never checked against the data of the other.
 *
 * @param user The authentication of a backoffice user (`createAuthenticate`).
 * @param store The authentication of a store key (`createAuthenticateStore`).
 * @returns The middleware to mount on `/v1`.
 */
export function createCredentialDispatcher(user: RequestHandler, store: RequestHandler): RequestHandler {
  return (req, res, next) => (STORE_KEY_BEARER.test(req.get('authorization') ?? '') ? store : user)(req, res, next);
}
