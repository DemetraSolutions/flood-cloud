/** Who did something to the key of a store, and with which role. */
export interface StoreKeyActor {
  readonly id: string;
  readonly role: string;
}

/** The active key of a store: never the key itself, only what identifies and describes it. */
export interface StoreKeyInfo {
  readonly id: string;
  readonly hint: string;
  readonly activatedAt: string;
  readonly activatedBy: StoreKeyActor | null;
  readonly installation: {
    readonly userAgent: string | null;
    readonly appVersion: string | null;
    readonly platform: string | null;
  } | null;
  readonly lastSeenAt: string | null;
  readonly lastSeenIp: string | null;
}

/** Why the last key of a store was revoked. */
export type RevocationReason = 'revoked' | 'replaced' | 'placeTrashed' | 'placeDeleted';

/** The state of the store key of a place (`GET …/store-key`). */
export interface StoreKeyStatus {
  readonly status: 'none' | 'active';
  readonly key: StoreKeyInfo | null;
  readonly pendingActivation: {
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly createdBy: StoreKeyActor | null;
  } | null;
  readonly lastRevoked: { readonly revokedAt: string; readonly reason: RevocationReason } | null;
}

/** A new activation code; shown once, the server keeps only its hash. */
export interface ActivationCode {
  readonly code: string;
  readonly expiresAt: string;
}
