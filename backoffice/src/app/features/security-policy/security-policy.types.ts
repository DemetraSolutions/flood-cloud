import { Versioned } from '../price-list/price-list.types';

/** What happens to a call made with a user's credentials that does not come from a browser. */
export type NonBrowserMode = 'report' | 'block';
/** What happens to a user who is over the hourly or daily limit of `/v1`. */
export type SustainedMode = 'report' | 'enforce';
/** Where a value in force comes from: saved by an administrator, the default of the server, or forced by the server (report only whatever is saved). */
export type PolicySource = 'database' | 'default' | 'forced';

/** The security policy (`GET /v1/settings/security-policy`). */
export interface SecurityPolicy {
  readonly nonBrowserRequests: NonBrowserMode;
  readonly sustainedLimits: SustainedMode;
  readonly sources: {
    readonly nonBrowserRequests: PolicySource;
    readonly sustainedLimits: PolicySource;
  };
  /** The thresholds in force, from the configuration of the server (read only). */
  readonly limits: {
    readonly perMinute: number;
    readonly perHour: number;
    readonly perDay: number;
  };
}

/** The fields a save can change; at least one. */
export interface SecurityPolicyChange {
  readonly nonBrowserRequests?: NonBrowserMode;
  readonly sustainedLimits?: SustainedMode;
}

/** The policy with its version. */
export type VersionedPolicy = Versioned<SecurityPolicy>;
