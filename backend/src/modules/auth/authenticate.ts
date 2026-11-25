import type { RequestHandler } from 'express';
import type { ActivityActor, ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { isRole } from '../../shared/security/rbac/permissions.ts';
import { safeEqual } from '../../shared/security/compare.ts';
import { expectedHtu, invalidDpopProof, verifyDpopProof } from '../../shared/security/dpop.ts';
import type { DpopEventReason, DpopRejectedAudit } from '../../shared/security/dpop-audit.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { hashSecret, parseSecret } from '../../shared/security/secrets.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import { buildPrincipal } from '../../shared/security/scope/principal.ts';
import type { ComputeScopeDeps } from '../../shared/security/scope/scope.ts';
import type { CredentialsRepository } from '../users/credentials.repository.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { auditSessionsRevoked } from '../sessions/session-audit.ts';
import { LAST_USED_RESOLUTION_MS } from '../sessions/sessions.repository.ts';
import type { Session, SessionsRepository } from '../sessions/sessions.repository.ts';
import { checkAccount } from './account-state.ts';

const DPOP_SCHEME = /^DPoP (\S+)$/i;

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
  /** Records the refused proofs (`auth.dpopRejected`, capped per user except `keyMismatch`). */
  readonly dpopAudit: DpopRejectedAudit;
  /** `API_PUBLIC_BASE_URL`: the proof must name the public URL of the request (`htu`), never rebuilt from the request headers. */
  readonly apiPublicBaseUrl: string;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the authentication of the users of the `/v1` surface (`doc/Security-Model.md` section 4, D-33): `Authorization: DPoP fc_at_…` plus the `DPoP` proof of possession of the key the session is bound to.
 *
 * The checks, in this order, none of which says to the client which one failed:
 * 1. The scheme must be `DPoP` with a token (`Bearer` is refused, no downgrade): else `401 UNAUTHENTICATED`, with no lookup.
 * 2. The proof (`htm`, `htu` built from `apiPublicBaseUrl`, `iat` against the clock, `ath` of the presented token): if it is not valid the answer is `401 INVALID_DPOP_PROOF`, whatever the token is. When
 *    the token belongs to an active session the refusal is also recorded (`auth.dpopRejected`, source `api`, capped per user).
 * 3. The token must be the current access token of a session that is not revoked, else `401 UNAUTHENTICATED`.
 * 4. A session without `jkt` (created before D-33) is revoked on the spot (`dpopUnbound`): `401 UNAUTHENTICATED`.
 * 5. The key of the proof must be the one of the session (constant-time comparison): else the whole family is revoked (`dpopKeyMismatch`), the answer is `401 UNAUTHENTICATED`:
 *    a valid token with a valid proof of another key is a theft. The `auth.dpopRejected` (`keyMismatch`, uncapped) and `auth.sessionsRevoked` events are written only by the request that actually revoked the
 *    session, so concurrent mismatching requests produce exactly one of each.
 * 6. The user and his group are checked (`checkAccount`); a denial revokes the session and answers `401 UNAUTHENTICATED`, also when the token is expired.
 * 7. An expired token is `401 TOKEN_EXPIRED`, so it is only ever said to a valid proof bound to the session of an account still in good standing.
 *
 * Then, on every request, the user and his group are read (once): a disabled or trashed user, a role that may not use the backoffice, a suspended or trashed group revoke the session at once
 * (`401 UNAUTHENTICATED`). Permissions and scope are recomputed from the stored user on every request and stored, with the session id, in `res.locals`; a user who still has to replace a provisional
 * password gets `res.locals.passwordChangeRequired`, which the route builder turns into `403 PASSWORD_CHANGE_REQUIRED` on every route not declared to allow it. `lastUsedAt` is refreshed at most once a minute, off
 * the response path: a failure is logged and never fails the request.
 *
 * @param deps Repositories, activity log, logger, proof audit, public base URL and clock.
 * @returns The middleware to pass to `mountRoutes` for `/v1`.
 */
export function createAuthenticate(deps: AuthenticateDeps): RequestHandler {
  const { sessions, users, credentials, groups, scope, activityLog, logger, dpopAudit, apiPublicBaseUrl } = deps;
  return async (req, res, next) => {
    const presented = DPOP_SCHEME.exec(req.get('authorization') ?? '')?.[1];
    if (presented === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    const client = clientContextOf(req, res);
    const token = parseSecret(presented, 'fc_at_');
    const proof = verifyDpopProof(req.get('dpop'), {
      method: req.method,
      htu: expectedHtu(apiPublicBaseUrl, req.originalUrl),
      nowSeconds: Math.floor(deps.now() / 1000),
      accessToken: presented,
    });
    const found = token === null ? null : await sessions.findByAccessHash(hashSecret(token));
    const session = found !== null && found.revokedAt === null ? found : null;
    /** The user of a session for the events: the actor (with the role when it is a real one) and his group. */
    const ownerOf = async (owned: Session) => {
      const owner = await users.findAuthRecord(owned.userId);
      const groupId = owner?.stored.groupId ?? undefined;
      const actor: ActivityActor = { kind: 'user', id: owned.userId, ...(isRole(owner?.user.role) ? { role: owner.user.role } : {}) };
      return { actor, groupId };
    };
    const rejected = async (owned: Session, reason: DpopEventReason): Promise<void> => {
      const { actor, groupId } = await ownerOf(owned);
      await dpopAudit({ userId: owned.userId, actor, ...(groupId === undefined ? {} : { groupId }), sessionId: owned.id, reason, source: 'api', context: client });
    };
    if (!proof.ok) {
      if (session !== null) {
        await rejected(session, proof.reason);
      }
      throw invalidDpopProof();
    }
    if (session === null) {
      throw new AppError('UNAUTHENTICATED');
    }
    const now = new Date(deps.now());
    if (session.jkt === null || !safeEqual(proof.proof.jkt, session.jkt)) {
      const reason = session.jkt === null ? 'dpopUnbound' : 'dpopKeyMismatch';
      // Only the request that actually revokes writes the events: concurrent mismatching requests produce exactly one.
      if (await sessions.revoke(session.id, reason, now)) {
        const { groupId } = await ownerOf(session);
        await auditSessionsRevoked(activityLog, { actor: { kind: 'system' }, ...(groupId === undefined ? {} : { groupId }), reason, sessionId: session.id, client });
        if (session.jkt !== null) {
          await rejected(session, 'keyMismatch');
        }
      }
      throw new AppError('UNAUTHENTICATED');
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
          client,
        });
      }
      throw new AppError('UNAUTHENTICATED');
    }
    if (session.accessExpiresAt.getTime() <= now.getTime()) {
      throw new AppError('TOKEN_EXPIRED');
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
 * Builds the authentication of a surface that accepts two kinds of credential, told apart by the scheme and the prefix of the secret and nothing else: `Bearer fc_sk_` goes to the store key
 * authentication (which ignores any `DPoP` header: DPoP is for users only), every other value to the user authentication (which answers `401` to anything that is not `DPoP fc_at_…` with a valid proof: a `Bearer`
 * access token, an `fc_pk_` API key and a refresh token included). Never "try one, then the other":
 * the prefix decides, so a credential of one kind is never checked against the data of the other.
 *
 * @param user The authentication of a backoffice user (`createAuthenticate`).
 * @param store The authentication of a store key (`createAuthenticateStore`).
 * @returns The middleware to mount on `/v1`.
 */
export function createCredentialDispatcher(user: RequestHandler, store: RequestHandler): RequestHandler {
  return (req, res, next) => (STORE_KEY_BEARER.test(req.get('authorization') ?? '') ? store : user)(req, res, next);
}
