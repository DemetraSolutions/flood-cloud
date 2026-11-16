import type { ObjectId } from 'mongodb';
import type { Role } from '../../shared/security/rbac/permissions.ts';

/** The roles that manage a store key: only the PSA and the dealers (D-24). */
export type KeyIssuerRole = 'PSA' | 'D';

/** Who generated the activation code, as kept on the code and on the key activated with it. */
export interface KeyIssuer {
  readonly userId: ObjectId;
  readonly role: KeyIssuerRole;
}

/** Why a store key ended: an administrator revoked it, a new activation replaced it, or its place went to the trash or was deleted. A group that is suspended or trashed, a place that is disabled or whose license is over, and a company in the trash never revoke: they block. */
export type RevokeReason = 'revoked' | 'replaced' | 'placeTrashed' | 'placeDeleted';

/** Who revoked a key: a user (with his role: a group administrator trashes a place too) or the system (a request found that the place had left the operation). */
export type Revoker = { readonly kind: 'user'; readonly userId: ObjectId; readonly role: Role } | { readonly kind: 'system' };

/** What the app of a store declares about itself when it exchanges its code, cleaned and cut. */
export interface Installation {
  readonly userAgent: string | null;
  readonly appVersion: string | null;
  readonly platform: string | null;
}

/** A store key, without its hash: the key itself is shown once and never kept. */
export interface StoreKey {
  /** The id the backoffice sees (`keyId`). */
  readonly id: ObjectId;
  readonly groupId: ObjectId;
  readonly placeId: ObjectId;
  /** The first four characters of the secret body, to recognize a key. */
  readonly hint: string;
  readonly status: 'active' | 'revoked';
  readonly activatedAt: Date;
  readonly activatedBy: KeyIssuer;
  readonly installation: Installation;
  readonly activationIp: string | null;
  readonly lastSeenAt: Date;
  readonly lastSeenIp: string | null;
  readonly lastSeenUserAgent: string | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: Revoker | null;
  readonly revokeReason: RevokeReason | null;
}

/** An activation code waiting to be exchanged (never the code, only who made it and when). */
export interface PendingActivation {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly createdBy: KeyIssuer;
}

/** What {@link StoreKeysRepository.replaceActivationCode} stores. */
export interface NewActivationCode {
  readonly groupId: ObjectId;
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  /** SHA-256 of the normalized code. */
  readonly codeHash: string;
  readonly createdBy: KeyIssuer;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** What {@link StoreKeysRepository.consumeActivationCode} returns for the code it consumed. */
export interface ConsumedActivation {
  readonly groupId: ObjectId;
  readonly placeId: ObjectId;
  readonly createdBy: KeyIssuer;
}

/** What {@link StoreKeysRepository.createKey} stores. */
export interface NewStoreKey {
  readonly groupId: ObjectId;
  readonly placeId: ObjectId;
  /** SHA-256 of the key. */
  readonly keyHash: string;
  readonly hint: string;
  readonly activatedAt: Date;
  readonly activatedBy: KeyIssuer;
  readonly installation: Installation;
  readonly activationIp: string | null;
}

/** The facts of a revocation. */
export interface Revocation {
  readonly at: Date;
  readonly by: Revoker;
  readonly reason: RevokeReason;
}

/** The last revoked key of a place, for the support. */
export interface RevokedSummary {
  readonly revokedAt: Date;
  readonly reason: RevokeReason;
}
