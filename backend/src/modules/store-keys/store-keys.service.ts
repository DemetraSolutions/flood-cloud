import type { ClientSession, ObjectId } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { clientIpKey } from '../../shared/security/client-ip.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { generateSecret, hashSecret } from '../../shared/security/secrets.ts';
import { generateActivationCode, hashActivationCode, normalizeActivationCode } from './activation-code.ts';
import { auditActivationCode, auditActiveKeyReplaced, auditActiveKeyRevoked, auditCodeForActivePlace, auditKeyRevoked } from './store-keys.audit.ts';
import type { StoreKeysRepository } from './store-keys.repository.ts';
import type { StoreStateReader } from './store-state.ts';
import type { Installation, KeyIssuer, PendingActivation, RevokedSummary, StoreKey } from './store-keys.types.ts';

/** Longest text kept of what a store app declares about itself, and of its user agent. */
export const MAX_INSTALLATION_TEXT = 200;

/** Failed exchanges recorded in the activity log per client address and hour: the rate limit already bounds the attempts, this bounds the log. */
const FAILED_AUDIT_PER_HOUR = 10;

const HOUR_SECONDS = 3600;

const MINUTE_MS = 60_000;

/** What a PSA or a dealer sees about the key of a place. */
export interface StoreKeyStatus {
  /** `active` while the place has a key, `none` otherwise (never activated, or the last key was revoked). */
  readonly status: 'none' | 'active';
  readonly key: StoreKey | null;
  readonly pendingActivation: PendingActivation | null;
  /** When and why the most recent revoked key ended, `null` when no key was ever revoked. */
  readonly lastRevoked: RevokedSummary | null;
}

/** An activation code just made: shown once. */
export interface IssuedActivationCode {
  /** The code to show, `XXXX-XXXX-XXXX-XXXX`. Never stored, never recorded. */
  readonly code: string;
  readonly expiresAt: Date;
}

/** What an exchange of a code for a key answers: the key is shown once. */
export interface ActivatedStore {
  /** The store key (`fc_sk_…`). Never stored, never recorded. */
  readonly key: string;
  readonly keyId: ObjectId;
  readonly groupId: ObjectId;
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
}

/** What the app of a store declares about itself in the exchange. */
export interface ActivationRequest {
  readonly activationCode: string;
  readonly installation?: { readonly appVersion?: string; readonly platform?: string };
}

/** The management of the store keys: the codes and the keys of the places, the exchange the server of a store makes, and the revocation. */
export interface StoreKeysService {
  /**
   * Makes the activation code of a place, valid for the configured time and for one exchange, replacing the pending one of the place. The active key, if any, stays valid until the new server activates.
   *
   * @param principal The caller (PSA or a dealer, by the route's permission).
   * @param access Verified access to the group.
   * @param placeId Id of the place.
   * @param client The calling client.
   * @param confirmReplaceActiveKey `true` when the caller confirms that a place with an active key is to be activated again (the key is replaced when the new server activates); ignored for a place without one.
   * @throws {AppError} `NOT_FOUND` (the place does not exist, is in the trash or is outside the perimeter), `CONFLICT` (the group, the place or its company is not operational: nothing could be activated; or the place has an active key and `confirmReplaceActiveKey` is not `true`: `details` `confirmReplaceActiveKey` / `required`, nothing is created).
   */
  createActivationCode(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext, confirmReplaceActiveKey?: boolean): Promise<IssuedActivationCode>;
  /**
   * Cancels the pending activation code of a place.
   *
   * @throws {AppError} `NOT_FOUND` for a place that is not reachable or that has no pending code.
   */
  cancelActivationCode(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext): Promise<void>;
  /**
   * The key of a place as the backoffice shows it.
   *
   * @throws {AppError} `NOT_FOUND` for a place that is not reachable.
   */
  status(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, now: Date): Promise<StoreKeyStatus>;
  /**
   * Revokes the active key of a place: the store stops at its next request.
   *
   * @throws {AppError} `NOT_FOUND` for a place that is not reachable or that has no active key.
   */
  revoke(principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId, client: ClientContext): Promise<void>;
  /**
   * Exchanges an activation code for a store key. In one transaction the code is consumed (one winner among concurrent exchanges), the state of group, place and company is checked, the key
   * of the place that was active is revoked (`replaced`) and the new one stored. Every failure (code malformed, unknown, expired, used, or a place that is not operational) is the same
   * `401 INVALID_CREDENTIALS`; a code that existed is consumed even when the place is not operational.
   *
   * @param request The code and what the app declares about itself.
   * @param client The calling client (address and user agent are kept with the key).
   * @throws {AppError} `INVALID_CREDENTIALS`.
   */
  exchange(request: ActivationRequest, client: ClientContext): Promise<ActivatedStore>;
  /**
   * Revokes the key of a place that goes to the trash or is deleted, in the operation that does it (right after the write: the check on every request of the store is the net).
   * Does nothing for a place with no active key.
   *
   * @param groupId Group of the place.
   * @param placeId The place.
   * @param reason `placeTrashed` or `placeDeleted`.
   * @param actor Who trashed or deleted the place.
   * @param client The calling client.
   */
  revokeForPlace(groupId: ObjectId, placeId: ObjectId, reason: 'placeTrashed' | 'placeDeleted', actor: AuthPrincipal, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createStoreKeysService}. */
export interface StoreKeysServiceDeps {
  readonly repository: StoreKeysRepository;
  readonly state: StoreStateReader;
  readonly activityLog: ActivityLog;
  readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  /** Runs work in a transaction on the common database (`Databases.transaction`). */
  readonly transaction: <T>(work: (session: ClientSession) => Promise<T>) => Promise<T>;
  /** The rule that counts failed authentications per address (`auth-fail:ip`): a failed exchange feeds it. */
  readonly failureRule: Pick<RateLimitRule, 'bucket' | 'limit' | 'windowSeconds'>;
  /** Minutes an activation code is valid (`STORE_ACTIVATION_CODE_TTL_MINUTES`). */
  readonly activationCodeTtlMinutes: number;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

const cut = (value: string | null | undefined): string | null => (value === undefined || value === null || value === '' ? null : value.slice(0, MAX_INSTALLATION_TEXT));

/**
 * Builds the service of the store keys.
 *
 * @param deps Repository, state reader, activity log, rate limiter, transaction, validity of the codes and clock.
 */
export function createStoreKeysService(deps: StoreKeysServiceDeps): StoreKeysService {
  const { repository, state, activityLog, rateLimiter, transaction, failureRule } = deps;
  const clock = (): Date => new Date(deps.now());
  const issuerOf = (principal: AuthPrincipal): KeyIssuer => ({ userId: principal.userId, role: principal.role as KeyIssuer['role'] });

  /** The place of the caller's group: not reachable is `404`. */
  const managed = async (principal: AuthPrincipal, access: GroupAccess, placeId: ObjectId) => {
    const place = await state.managedPlace(principal, access, placeId, clock());
    if (place === null) {
      throw new AppError('NOT_FOUND');
    }
    return place;
  };

  /** Records a failed exchange, at most {@link FAILED_AUDIT_PER_HOUR} an hour for an address, and never what was presented. */
  const auditFailure = async (client: ClientContext): Promise<void> => {
    const decision = await rateLimiter.consume('storeActivationFailed:ip', clientIpKey(client.ip ?? 'unknown'), FAILED_AUDIT_PER_HOUR, HOUR_SECONDS);
    if (decision.allowed) {
      await activityLog.record({
        category: 'security',
        action: 'store.activationFailed',
        outcome: 'denied',
        actor: { kind: 'anonymous' },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { reason: 'rejected' },
      });
    }
  };

  return {
    createActivationCode: async (principal, access, placeId, client, confirmReplaceActiveKey = false) => {
      const place = await managed(principal, access, placeId);
      if (!place.operational || (await state.assess(access.groupId, placeId, clock())).kind !== 'ok') {
        throw new AppError('CONFLICT');
      }
      const activeKey = await repository.findActiveOfPlace(access.groupId, placeId);
      if (activeKey !== null && !confirmReplaceActiveKey) {
        throw new AppError('CONFLICT', { message: 'The place has an active key: confirm to replace it', details: [{ field: 'confirmReplaceActiveKey', issue: 'required' }] });
      }
      const { normalized, presented } = generateActivationCode();
      const createdAt = clock();
      const expiresAt = new Date(createdAt.getTime() + deps.activationCodeTtlMinutes * MINUTE_MS);
      await repository.replaceActivationCode({
        groupId: access.groupId,
        companyId: place.companyId,
        placeId,
        codeHash: hashActivationCode(normalized),
        createdBy: issuerOf(principal),
        createdAt,
        expiresAt,
      });
      await auditActivationCode(activityLog, { action: 'store.activationCodeCreated', actor: actorOf(principal), groupId: access.groupId, placeId, client });
      if (activeKey !== null) {
        await auditCodeForActivePlace(activityLog, { actor: actorOf(principal), activeKey, client });
      }
      return { code: presented, expiresAt };
    },

    cancelActivationCode: async (principal, access, placeId, client) => {
      await managed(principal, access, placeId);
      if (!(await repository.deleteActivationCode(access.groupId, placeId))) {
        throw new AppError('NOT_FOUND');
      }
      await auditActivationCode(activityLog, { action: 'store.activationCodeCancelled', actor: actorOf(principal), groupId: access.groupId, placeId, client });
    },

    status: async (principal, access, placeId, now) => {
      await managed(principal, access, placeId);
      const [key, pendingActivation, lastRevoked] = await Promise.all([
        repository.findActiveOfPlace(access.groupId, placeId),
        repository.findPendingActivation(access.groupId, placeId, now),
        repository.findLastRevokedOfPlace(access.groupId, placeId),
      ]);
      return { status: key === null ? 'none' : 'active', key, pendingActivation, lastRevoked };
    },

    revoke: async (principal, access, placeId, client) => {
      await managed(principal, access, placeId);
      const key = await repository.revokeActiveOfPlace(access.groupId, placeId, { at: clock(), by: { kind: 'user', userId: principal.userId, role: principal.role }, reason: 'revoked' });
      if (key === null) {
        throw new AppError('NOT_FOUND');
      }
      await auditKeyRevoked(activityLog, { key, reason: 'revoked', actor: actorOf(principal), client });
      await auditActiveKeyRevoked(activityLog, { key, actor: actorOf(principal), client });
    },

    exchange: async (request, client) => {
      const normalized = normalizeActivationCode(request.activationCode);
      const now = clock();
      const outcome =
        normalized === null
          ? null
          : await transaction(async (session) => {
              const consumed = await repository.consumeActivationCode(hashActivationCode(normalized), now, session);
              if (consumed === null) {
                return null;
              }
              // A code that existed is spent even when the place is not operational: the transaction commits the consumption and writes nothing else.
              const assessment = await state.assess(consumed.groupId, consumed.placeId, now);
              if (assessment.kind !== 'ok') {
                return null;
              }
              const replaced = await repository.revokeActiveOfPlace(
                consumed.groupId,
                consumed.placeId,
                { at: now, by: { kind: 'user', userId: consumed.createdBy.userId, role: consumed.createdBy.role }, reason: 'replaced' },
                session,
              );
              const secret = generateSecret('fc_sk_');
              const installation: Installation = {
                userAgent: cut(client.userAgent),
                appVersion: cut(request.installation?.appVersion),
                platform: cut(request.installation?.platform),
              };
              const key = await repository.createKey(
                { groupId: consumed.groupId, placeId: consumed.placeId, keyHash: hashSecret(secret), hint: secret.slice('fc_sk_'.length, 'fc_sk_'.length + 4), activatedAt: now, activatedBy: consumed.createdBy, installation, activationIp: client.ip },
                session,
              );
              return { consumed, replaced, secret, key, companyId: assessment.companyId };
            });
      if (outcome === null) {
        // A failed exchange counts in the failed authentications of its address, like a wrong token: the address is slowed down on the whole of `/v1`.
        await rateLimiter.consume(failureRule.bucket, clientIpKey(client.ip ?? 'unknown'), failureRule.limit, failureRule.windowSeconds);
        await auditFailure(client);
        throw new AppError('INVALID_CREDENTIALS');
      }
      const { consumed, replaced, secret, key, companyId } = outcome;
      if (replaced !== null) {
        await auditKeyRevoked(activityLog, { key: replaced, reason: 'replaced', actor: { kind: 'user', id: consumed.createdBy.userId, role: consumed.createdBy.role }, client });
      }
      if (replaced !== null) {
        await auditActiveKeyReplaced(activityLog, { newKeyId: key.id, replaced, client });
      }
      await activityLog.record({
        category: 'security',
        action: 'store.activated',
        outcome: 'success',
        actor: { kind: 'store', id: key.id },
        groupId: key.groupId,
        resource: { type: 'storeKey', id: key.id.toHexString() },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { replacedKeyId: replaced === null ? null : replaced.id.toHexString() },
      });
      return { key: secret, keyId: key.id, groupId: key.groupId, companyId, placeId: key.placeId };
    },

    revokeForPlace: async (groupId, placeId, reason, actor, client) => {
      const key = await repository.revokeActiveOfPlace(groupId, placeId, { at: clock(), by: { kind: 'user', userId: actor.userId, role: actor.role }, reason });
      if (key !== null) {
        await auditKeyRevoked(activityLog, { key, reason, actor: actorOf(actor), client });
      }
    },
  };
}
