import type { Logger } from '../logging/logger.ts';

/** What happens to a request made with the credentials of a user that does not look like a browser's: only reported, or also refused (`doc/Security-Model.md`). */
export const NON_BROWSER_POLICIES = Object.freeze(['report', 'block'] as const);

/** A value of {@link NON_BROWSER_POLICIES}. */
export type NonBrowserPolicy = (typeof NON_BROWSER_POLICIES)[number];

/** What happens over the hourly and daily limits of `/v1`: only reported, or also refused with `429` (never for a PSA or a D, never on the routes that revoke or change one's credentials). */
export const SUSTAINED_POLICIES = Object.freeze(['report', 'enforce'] as const);

/** A value of {@link SUSTAINED_POLICIES}. */
export type SustainedPolicy = (typeof SUSTAINED_POLICIES)[number];

/** Where the effective value of a field comes from: saved in the database by the PSA, or the default of the server (`report`, or `RATE_LIMIT_API_SUSTAINED_MODE` for the limits). */
export type PolicySource = 'database' | 'default' | 'forced';

/** What is saved of the security policy (the `value` of the `SECURITY_POLICY` setting): each field is there only once the PSA saved it. */
export interface StoredSecurityPolicy {
  readonly nonBrowserRequests?: NonBrowserPolicy;
  readonly sustainedLimits?: SustainedPolicy;
}

/** The security policy of the platform in force: every field resolved, with where it comes from. */
export interface SecurityPolicy {
  /** `report` (default): the request that does not look like a browser's goes on and an event is recorded; `block`: it is refused with `403 BROWSER_REQUIRED` (never for a PSA, never on the routes that revoke or change one's credentials). */
  readonly nonBrowserRequests: NonBrowserPolicy;
  /** `report`: over the hourly or daily limit the request goes on and an event is recorded; `enforce`: it is refused with `429 RATE_LIMITED` (never for a PSA or a D). */
  readonly sustainedLimits: SustainedPolicy;
  /** For each field, whether the value was saved in the database or is the default of the server. */
  readonly sources: Readonly<{ nonBrowserRequests: PolicySource; sustainedLimits: PolicySource }>;
}

/**
 * The fields of a stored value that are well formed. Anything else (no document, a wrong type, an unknown mode, a field that is not known) is ignored, so a damaged setting never blocks anybody: its
 * field is simply the default.
 *
 * @param stored The `value` of the document, as the database holds it (`null` when there is none).
 * @returns The valid fields.
 */
export function storedSecurityPolicyOf(stored: unknown): StoredSecurityPolicy {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {};
  }
  const record = stored as Record<string, unknown>;
  const nonBrowser = record['nonBrowserRequests'];
  const sustained = record['sustainedLimits'];
  return {
    ...((NON_BROWSER_POLICIES as readonly unknown[]).includes(nonBrowser) ? { nonBrowserRequests: nonBrowser as NonBrowserPolicy } : {}),
    ...((SUSTAINED_POLICIES as readonly unknown[]).includes(sustained) ? { sustainedLimits: sustained as SustainedPolicy } : {}),
  };
}

/**
 * The policy a stored value means: what was saved prevails, the rest is the default (`report` for the non-browser requests, the given one, from `RATE_LIMIT_API_SUSTAINED_MODE`, for the limits). When `forceReport` is
 * on (`SECURITY_POLICY_FORCE_REPORT`) both fields are `report` with the source `forced`, whatever was saved.
 *
 * @param stored The `value` of the document as the database holds it.
 * @param sustainedDefault The default of the hourly and daily limits.
 * @param forceReport `true` to force both fields to report only.
 * @returns The policy, frozen.
 */
export function securityPolicyOf(stored: unknown, sustainedDefault: SustainedPolicy, forceReport = false): SecurityPolicy {
  if (forceReport) {
    return Object.freeze({ nonBrowserRequests: 'report' as const, sustainedLimits: 'report' as const, sources: Object.freeze({ nonBrowserRequests: 'forced' as const, sustainedLimits: 'forced' as const }) });
  }
  const saved = storedSecurityPolicyOf(stored);
  return Object.freeze({
    nonBrowserRequests: saved.nonBrowserRequests ?? 'report',
    sustainedLimits: saved.sustainedLimits ?? sustainedDefault,
    sources: Object.freeze({ nonBrowserRequests: saved.nonBrowserRequests === undefined ? ('default' as const) : ('database' as const), sustainedLimits: saved.sustainedLimits === undefined ? ('default' as const) : ('database' as const) }),
  });
}

/** The policy in memory: read with a short expiry, replaced at once by the instance that serves a write. */
export interface SecurityPolicyProvider {
  /**
   * The policy in force. A fresh copy costs nothing; an expired one is read again from the database, one read at a time whatever the number of requests waiting. If the read fails the last known value is used
   * (the default of the server when there is none: `report` for the non-browser requests, `RATE_LIMIT_API_SUSTAINED_MODE` for the limits) and the error is logged: a failure never blocks anybody.
   */
  get(): Promise<SecurityPolicy>;
  /** Replaces the copy of this instance after a write (the other instances see it when their copy expires). */
  set(policy: SecurityPolicy): void;
}

/** How long a copy is kept, in milliseconds: the time the other instances take to see a change. */
export const SECURITY_POLICY_TTL_MS = 30_000;

/** How long to wait before reading again after a failed read, in milliseconds. */
export const SECURITY_POLICY_RETRY_MS = 5000;

/** Collaborators of {@link createSecurityPolicyProvider}. */
export interface SecurityPolicyProviderDeps {
  /** Reads the stored value (`SettingsRepository.readSecurityPolicy`, with its `maxTimeMS`). */
  readonly read: () => Promise<unknown>;
  /** The default of the hourly and daily limits when nothing is saved (`RATE_LIMIT_API_SUSTAINED_MODE`). */
  readonly sustainedDefault: SustainedPolicy;
  /** `SECURITY_POLICY_FORCE_REPORT` is on: both fields are report only, whatever is read. */
  readonly forceReport: boolean;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the in-memory provider of the security policy.
 *
 * @param deps Reader, logger and clock.
 * @returns The provider.
 */
export function createSecurityPolicyProvider(deps: SecurityPolicyProviderDeps): SecurityPolicyProvider {
  // Until the first read succeeds (a cold start with the database down) the policy is the default of the server, never a block.
  let current: SecurityPolicy = securityPolicyOf(null, deps.sustainedDefault, deps.forceReport);
  let expiresAt = 0;
  let loading: Promise<SecurityPolicy> | null = null;
  const load = async (): Promise<SecurityPolicy> => {
    try {
      current = securityPolicyOf(await deps.read(), deps.sustainedDefault, deps.forceReport);
      expiresAt = deps.now() + SECURITY_POLICY_TTL_MS;
    } catch (error) {
      deps.logger.error('security policy read failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      expiresAt = deps.now() + SECURITY_POLICY_RETRY_MS;
    } finally {
      loading = null;
    }
    return current;
  };
  return {
    get: () => {
      if (deps.now() < expiresAt) {
        return Promise.resolve(current);
      }
      loading ??= load();
      return loading;
    },
    set: (policy) => {
      current = policy;
      expiresAt = deps.now() + SECURITY_POLICY_TTL_MS;
    },
  };
}
