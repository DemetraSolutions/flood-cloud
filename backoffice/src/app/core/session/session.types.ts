import { FeatureFlags } from '../groups/feature-catalog';

/** Role codes of a backoffice user (`doc/Security-Model.md`). */
export type Role = 'PSA' | 'D' | 'SA' | 'CA' | 'PA' | 'E';

/** Summary of the data perimeter of a user (counts, never the full lists). */
export type ScopeSummary =
  | { readonly kind: 'platform' }
  | { readonly kind: 'dealer'; readonly groups: number; readonly groupIds: readonly string[] }
  | { readonly kind: 'group'; readonly groupId: string }
  | {
      readonly kind: 'companies';
      readonly groupId: string;
      readonly companies: number;
      readonly places: number;
    }
  | { readonly kind: 'places'; readonly groupId: string; readonly places: number }
  | { readonly kind: 'none' };

/** The current user as returned by `GET /v1/me`. */
export interface Profile {
  readonly id: string;
  readonly username: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: Role;
  readonly groupId: string | null;
  readonly dealerId: string | null;
  readonly status: string;
  readonly language: string;
  /** Effective permissions (`resource:action`) computed by the server. */
  readonly permissions: readonly string[];
  /** Whether the user may change the permission matrix of other users. */
  readonly canManagePermissions: boolean;
  readonly passwordChangeRequired: boolean;
  readonly scope: ScopeSummary;
  readonly group: { readonly id: string; readonly name: string } | null;
  /**
   * Features of the user's group (SA, CA, PA). `null` for the roles that work on several groups
   * (PSA, dealers), who read them from the group they work on.
   */
  readonly groupFeatures: FeatureFlags | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** Subset of a login/refresh response the client needs; the access token is never persisted. */
export interface TokenPair {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

/** An active session of the current user (`GET /v1/me/sessions`). */
export interface SessionInfo {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly current: boolean;
}

/**
 * Lifecycle of the session: `unknown` until the startup restore finished, then `anonymous`,
 * `authenticated` or `passwordChangeRequired` (logged in with a temporary password).
 */
export type SessionStatus = 'unknown' | 'anonymous' | 'authenticated' | 'passwordChangeRequired';
