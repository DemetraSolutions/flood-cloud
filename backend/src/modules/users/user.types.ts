import type { ObjectId } from 'mongodb';
import type { ModuleFlags } from '../../shared/security/rbac/permission-matrix.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';
import type { StoredUser } from '../../shared/security/scope/principal.ts';

/** Marker of a stored role that is not one of the six roles (including the retired `API`): the user gets no access. */
export const INVALID_ROLE = 'invalid';

/** The role of a user as read from storage: a real role or {@link INVALID_ROLE}. */
export type UserRole = Role | typeof INVALID_ROLE;

/** Whether a user may sign in. */
export type UserStatus = 'active' | 'disabled';

/** The user's own permission matrix in the domain: the core modules only, plus the right to manage other matrices. */
export interface UserPermissions {
  /** Legacy `permissions.status`: may manage other users' matrix. */
  readonly status: boolean;
  /** Flags of every core module (`groups`, `users`, `companies`, `places`, `logs`), absent ones as `false`. */
  readonly modules: Readonly<Record<string, ModuleFlags>>;
  /** Whether the user may change other users' permission matrix (never for `E` or an invalid role). */
  readonly canManagePermissions: boolean;
}

/** A user of the platform, in the domain model (`doc/Tasks.md` 3.1). No secret and no legacy-only field. */
export interface User {
  /** Hexadecimal `_id`. */
  readonly id: string;
  readonly username: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: UserRole;
  /** Group of the user, `null` for PSA and D (and for corrupt data). */
  readonly groupId: string | null;
  /** Dealer (`D` user) the user refers to. */
  readonly dealerId: string | null;
  /** Companies in scope (CA), without duplicates. */
  readonly companyIds: readonly string[];
  /** Places in scope (PA, E): union of the legacy `placeId` and `placesId`, without duplicates. */
  readonly placeIds: readonly string[];
  readonly status: UserStatus;
  /** Whether the user is in the trash. */
  readonly trashed: boolean;
  readonly language: string;
  readonly hiddenInStats: boolean;
  readonly permissions: UserPermissions;
  /** `insertDate`, `null` when the document has none (it happens in production). */
  readonly createdAt: Date | null;
  /** `updateDate`, `null` when the document has none. */
  readonly updatedAt: Date | null;
}

/** What is wrong with a legacy document, found while reading it (the read itself never fails). */
export type UserAnomalyKind =
  | 'invalidRole'
  | 'invalidStatus'
  | 'missingUsername'
  | 'encryptedPersonalData'
  | 'invalidType'
  | 'invalidReference'
  | 'missingScope';

/** One anomaly of a legacy user document. */
export interface UserAnomaly {
  readonly kind: UserAnomalyKind;
  /** Legacy field concerned, when there is one. */
  readonly field?: string;
}

/** Result of reading a legacy document. */
export interface MappedUser {
  readonly user: User;
  /** Problems of the stored document, to be logged by the caller. */
  readonly anomalies: readonly UserAnomaly[];
}

/** A legacy `tokens[]` element: the current object form or the older string form. */
export type LegacyToken = string | { readonly token?: string; readonly ip?: string; readonly ips?: readonly string[]; readonly userAgent?: string; readonly date?: Date };

/**
 * A document of `<env>_common.users` as the legacy platform writes it. Every field except `_id` is
 * optional because production data is irregular; the types are the ones the 2026-11-01 profiling
 * found. `password`, `pin`, `tokens`, `permissions.apps`, `servicesId`, `shiftTime` and `avatar` are
 * part of the type because they exist in the documents, but they are never mapped to a {@link User}.
 */
export type LegacyUserDocument = {
  readonly _id: ObjectId;
  readonly userName?: string | null;
  /** Written by an old signup flow instead of `userName`. */
  readonly username?: string | null;
  readonly name?: string | null;
  readonly surname?: string | null;
  readonly email?: string | null;
  readonly telephone?: string | null;
  readonly description?: string | null;
  /** HMAC-SHA512 hex hash; never mapped. */
  readonly password?: string | null;
  /** Plain-text PIN; never mapped. */
  readonly pin?: string | null;
  /** One of the six roles, or an irregular value. */
  readonly role?: string | null;
  readonly dealerId?: ObjectId | null;
  readonly groupId?: ObjectId | null;
  readonly companyId?: ObjectId | null;
  readonly placeId?: ObjectId | null;
  readonly placesId?: readonly ObjectId[] | null;
  readonly servicesId?: readonly ObjectId[] | null;
  /** `status`, the `{ r, w }` flags of each module and `apps` (cash domain, never mapped); read defensively. */
  readonly permissions?: Readonly<Record<string, unknown>> | null;
  readonly settings?: { readonly language?: string; readonly hiddenInStats?: boolean } | null;
  readonly shiftTime?: number | null;
  readonly status?: boolean;
  readonly trash?: boolean;
  /** Legacy sessions; never mapped. */
  readonly tokens?: readonly LegacyToken[] | null;
  /** Data URL of the picture; never mapped. */
  readonly avatar?: string | null;
  readonly insertDate?: Date;
  readonly updateDate?: Date;
};

/** A user read for the login: the domain user plus the stored legacy password hash, for the verifier only. */
export interface LoginRecord extends MappedUser {
  /** The legacy hash (`password`) when it is a string, otherwise `null`. Never leaves the login flow. */
  readonly legacyPasswordHash: string | null;
}

/**
 * A user read to authenticate a request: the domain user plus what `buildPrincipal` needs (scope ids
 * as ObjectIds and the stored permission matrix, untouched). Never carries a secret.
 */
export interface AuthRecord extends MappedUser {
  readonly stored: StoredUser;
}

/** Permission flags a change may set; a missing flag is left alone. */
export type PermissionChange = Partial<ModuleFlags>;

/** The changes of {@link toLegacyUpdate}: every field optional, a present field is written. */
export interface UserChanges {
  readonly username?: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly role?: Role;
  readonly groupId?: string | null;
  readonly dealerId?: string | null;
  readonly companyIds?: readonly string[];
  readonly placeIds?: readonly string[];
  readonly status?: UserStatus;
  readonly trashed?: boolean;
  readonly language?: string;
  readonly hiddenInStats?: boolean;
  /** The legacy password hash (HMAC-SHA512) to write while the legacy coexists; `null` removes it. */
  readonly password?: string | null;
  readonly permissions?: {
    readonly status?: boolean;
    /** Core modules only; any other name is refused. */
    readonly modules?: Readonly<Record<string, PermissionChange>>;
  };
}

/** Everything {@link toLegacyDocument} needs to build the document of a new user. */
export interface NewUser {
  /** Id of the new document, generated by the caller so that it is known before the insert. */
  readonly id: ObjectId;
  readonly username: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: Role;
  readonly groupId: string | null;
  readonly dealerId: string | null;
  readonly companyIds: readonly string[];
  readonly placeIds: readonly string[];
  readonly status: UserStatus;
  readonly language: string;
  /** Flags of every core module and the right to manage other matrices. */
  readonly permissions: { readonly status: boolean; readonly modules: Readonly<Record<string, ModuleFlags>> };
  /** The legacy password hash while the legacy coexists, `null` otherwise. */
  readonly legacyPasswordHash: string | null;
}

/** The `$set`/`$unset` update produced by {@link toLegacyUpdate}; never a replacement document. */
export interface LegacyUserUpdate {
  readonly $set: Readonly<Record<string, unknown>>;
  readonly $unset?: Readonly<Record<string, ''>>;
}

/** Result of the response mapper: what `/v1` shows of a user, dates in ISO 8601. */
export interface UserResponse {
  readonly id: string;
  readonly username: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: UserRole;
  readonly groupId: string | null;
  readonly dealerId: string | null;
  readonly companyIds: readonly string[];
  readonly placeIds: readonly string[];
  readonly status: UserStatus;
  readonly trashed: boolean;
  readonly language: string;
  readonly hiddenInStats: boolean;
  readonly permissions: { readonly status: boolean; readonly modules: Readonly<Record<string, ModuleFlags>>; readonly canManagePermissions: boolean };
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}
