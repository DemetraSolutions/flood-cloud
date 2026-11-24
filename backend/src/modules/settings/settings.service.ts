import { createHmac } from 'node:crypto';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { canonicalJson } from '../../shared/http/etag.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { securityPolicyOf, storedSecurityPolicyOf } from '../../shared/security/security-policy.ts';
import type { SecurityPolicy, SecurityPolicyProvider, SustainedPolicy, StoredSecurityPolicy } from '../../shared/security/security-policy.ts';
import { computeChanges } from '../../shared/activity-log/changes.ts';
import { priceListOf } from './price-list.ts';
import type { PriceList } from './price-list.ts';
import type { SettingsRepository } from './settings.repository.ts';
import type { PriceListBody, SecurityPolicyBody } from './settings.schemas.ts';

/** The price list with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface PriceListResult {
  readonly list: PriceList;
  readonly version: string;
}

/** The thresholds of the rate limit of `/v1` per user, from the environment: shown by the setting, read only (the backoffice does not change them). */
export interface RateLimitThresholds {
  readonly perMinute: number;
  readonly perHour: number;
  readonly perDay: number;
}

/** The security policy with the thresholds in force and its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface SecurityPolicyResult {
  readonly policy: SecurityPolicy;
  readonly limits: RateLimitThresholds;
  readonly version: string;
}

/** The settings of the platform: the price list of the activations and the security policy. */
export interface SettingsService {
  /** The price list in force (the default one while none was saved) with its version. */
  getPriceList(): Promise<PriceListResult>;
  /**
   * Replaces the price list.
   *
   * @param principal The authenticated administrator (the route requires `activations:manage`).
   * @param expected The version the client read.
   * @param body The validated whole list.
   * @param client Request context.
   * @throws {AppError} `PRECONDITION_FAILED` when the list is no longer the one that was read.
   */
  replacePriceList(principal: AuthPrincipal, expected: string, body: PriceListBody, client: ClientContext): Promise<PriceListResult>;
  /** The security policy in force (what the PSA saved, else the default of the server: `report`, and `RATE_LIMIT_API_SUSTAINED_MODE` for the limits; a damaged field is its default) with where each field comes from, the thresholds and the version. Always read from the database, never from the copy in memory. */
  getSecurityPolicy(): Promise<SecurityPolicyResult>;
  /**
   * Replaces the security policy, records `settings.securityPolicyUpdated` and updates the copy in memory of this instance at once.
   *
   * @param principal The authenticated administrator (the route requires `securityPolicy:manage`, the PSA's alone).
   * @param expected The version the client read.
   * @param body The validated fields to set (at least one; the others keep what is saved).
   * @param client Request context.
   * @param nonBrowser The reason this very request does not look like a browser's (`res.locals.nonBrowserReason`), `null` when it does, `undefined` when the signal did not evaluate it (turned off).
   * @throws {AppError} `PRECONDITION_FAILED` when the policy is no longer the one that was read; `CONFLICT` (`nonBrowserRequests` / `browserRequired`) when the policy is `block` and the request itself does not look like a browser's, or was not evaluated because the signal is off: the block is turned on only from a browser the check recognises.
   */
  replaceSecurityPolicy(principal: AuthPrincipal, expected: string, body: SecurityPolicyBody, client: ClientContext, nonBrowser: string | null | undefined): Promise<SecurityPolicyResult>;
}

/** Collaborators of {@link createSettingsService}. */
export interface SettingsServiceDeps {
  readonly repository: SettingsRepository;
  readonly activityLog: ActivityLog;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  /** The security policy in memory of this instance: replaced at once after a write. */
  readonly securityPolicy?: Pick<SecurityPolicyProvider, 'set'>;
  /** The default of the hourly and daily limits when the PSA saved nothing (`RATE_LIMIT_API_SUSTAINED_MODE`). */
  readonly sustainedDefault: SustainedPolicy;
  /** `SECURITY_POLICY_FORCE_REPORT` is on: the policy in force is report only (source `forced`) whatever is saved; a write is still saved but has no effect. */
  readonly forceReport?: boolean;
  /** The thresholds in force (`RATE_LIMIT_API_PER_USER*`), shown read only. */
  readonly limits: RateLimitThresholds;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * The version of a price list: HMAC-SHA256 with the secret key of the server, in base64url, of its canonical JSON.
 *
 * @param list The price list.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function priceListVersion(list: PriceList, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson({ kind: 'priceList', list })).digest('base64url');
}

/**
 * The version of a security policy: HMAC-SHA256 with the secret key of the server, in base64url, of its canonical JSON.
 *
 * @param policy The policy.
 * @param key The secret key of the HMAC (`VERSION_HMAC_KEY`).
 * @returns The version, 43 characters.
 */
export function securityPolicyVersion(policy: SecurityPolicy, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson({ kind: 'securityPolicy', policy })).digest('base64url');
}

/**
 * Builds the service of the settings. Whoever calls it has the `activations:manage` permission (the route says so).
 *
 * @param deps Repository, activity log, version key and clock.
 */
export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { repository, activityLog, versionKey } = deps;
  const resultOf = (list: PriceList): PriceListResult => ({ list, version: priceListVersion(list, versionKey) });
  const policyResultOf = (policy: SecurityPolicy): SecurityPolicyResult => ({ policy, limits: deps.limits, version: securityPolicyVersion(policy, versionKey) });
  const resolve = (stored: StoredSecurityPolicy): SecurityPolicy => securityPolicyOf(stored, deps.sustainedDefault, deps.forceReport === true);
  return {
    getSecurityPolicy: async () => policyResultOf(resolve(storedSecurityPolicyOf(await repository.readSecurityPolicy()))),

    replaceSecurityPolicy: async (principal, expected, body, client, nonBrowser) => {
      const read = await repository.readSecurityPolicy();
      const saved = storedSecurityPolicyOf(read);
      const before = resolve(saved);
      if (securityPolicyVersion(before, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      // The block is turned on only from a request the check recognises as a browser's: one that was not evaluated (the signal is off) proves nothing, and a block that cannot be verified is not accepted.
      if (body.nonBrowserRequests === 'block' && nonBrowser !== null) {
        throw new AppError('CONFLICT', { message: 'The block can only be turned on from a request that looks like a browser\'s, with the check on', details: [{ field: 'nonBrowserRequests', issue: 'browserRequired' }] });
      }
      const merged: StoredSecurityPolicy = { ...saved, ...(body.nonBrowserRequests === undefined ? {} : { nonBrowserRequests: body.nonBrowserRequests }), ...(body.sustainedLimits === undefined ? {} : { sustainedLimits: body.sustainedLimits }) };
      if (canonicalJson(merged) === canonicalJson(saved)) {
        return policyResultOf(before);
      }
      const next = resolve(merged);
      if (!(await repository.replaceSecurityPolicy(read, merged, principal.userId, new Date(deps.now())))) {
        throw new AppError('PRECONDITION_FAILED');
      }
      deps.securityPolicy?.set(next);
      await activityLog.record({
        category: 'security',
        action: 'settings.securityPolicyUpdated',
        outcome: 'success',
        actor: actorOf(principal),
        resource: { type: 'securityPolicy', id: 'SECURITY_POLICY' },
        // The values in force before and after (a value saved equal to the default changes nothing in practice, and the entry then has no field change).
        changes: computeChanges({ nonBrowserRequests: before.nonBrowserRequests, sustainedLimits: before.sustainedLimits }, { nonBrowserRequests: next.nonBrowserRequests, sustainedLimits: next.sustainedLimits }),
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      return policyResultOf(next);
    },

    getPriceList: async () => resultOf(priceListOf(await repository.readPriceList())),

    replacePriceList: async (principal, expected, body, client) => {
      const read = await repository.readPriceList();
      const before = priceListOf(read);
      if (priceListVersion(before, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const next = priceListOf(body);
      if (canonicalJson(next) === canonicalJson(before)) {
        return resultOf(before);
      }
      if (!(await repository.replacePriceList(read, next, principal.userId, new Date(deps.now())))) {
        throw new AppError('PRECONDITION_FAILED');
      }
      await recordDataChange(activityLog, {
        actor: actorOf(principal),
        resource: { type: 'priceList', id: 'PRICE_LIST' },
        action: 'priceList.updated',
        before: { ...before },
        after: { ...next },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
      });
      return resultOf(next);
    },
  };
}
