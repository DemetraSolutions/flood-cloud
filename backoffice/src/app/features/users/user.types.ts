import { Role } from '../../core/session/session.types';
import { UserPos } from '../../core/users/pos.catalog';
import { ShiftTime, ShiftWeekRecord, SpecialDay } from '../../core/users/shift-time';

/** Account status of a user. */
export type UserStatus = 'active' | 'disabled';

/** Permission modules of the matrix, in display order. */
export const PERMISSION_MODULES = [
  'groups',
  'users',
  'companies',
  'places',
  'documents',
  'products',
  'calendar',
  'warehouse',
  'contacts',
  'fidelity',
  'settings',
  'stats',
  'logs',
] as const;

/** Name of a permission module. */
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/** Read and write flags of a module. */
export interface ModuleFlags {
  r: boolean;
  w: boolean;
}

/** Permission matrix of a user as the form edits it. */
export interface PermissionMatrix {
  modules: Record<PermissionModule, ModuleFlags>;
  canManagePermissions: boolean;
}

/** A user as returned by the `/v1` user routes (never credentials). */
export interface UserRecord {
  readonly id: string;
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
  readonly trashed: boolean;
  readonly language: string;
  readonly description: string | null;
  /** Data URL of the avatar; only in the detail (`null` also when a legacy image cannot be shown). */
  readonly avatar?: string | null;
  readonly hasAvatar: boolean;
  /** Whether a PIN is set (the PIN itself is never returned). */
  readonly pinSet: boolean;
  readonly hiddenInStats: boolean;
  readonly serviceIds: readonly string[];
  readonly pos: UserPos;
  readonly shiftTime: ShiftTime;
  readonly permissions: {
    readonly modules?: Partial<Record<PermissionModule, Partial<ModuleFlags>>>;
    readonly canManagePermissions?: boolean;
  };
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** Where users are managed: the users of a group, or the platform users (PSA and dealers). */
export type UserArea =
  { readonly kind: 'group'; readonly groupId: string } | { readonly kind: 'platform' };

/** Body of a permissions write (only the flags sent are changed). */
export interface PermissionsPatch {
  modules?: Partial<Record<PermissionModule, Partial<ModuleFlags>>>;
  canManagePermissions?: boolean;
}

/** Fields shared by the creation and the modification of a user. */
export interface UserWrite {
  username?: string;
  role?: Role;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  language?: string;
  status?: UserStatus;
  companyIds?: string[];
  placeIds?: string[];
  permissions?: PermissionsPatch;
  description?: string | null;
  avatar?: string | null;
  pin?: string | null;
  hiddenInStats?: boolean;
  serviceIds?: string[];
  pos?: PosPatch;
  shiftTime?: ShiftTimePatch;
}

/** POS part of a write (only what changes; `null` clears the values that allow it). */
export interface PosPatch {
  enabled?: boolean;
  grants?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

/** Shifts part of a write: `weeks` and `specialDays`, when present, replace the stored lists. */
export interface ShiftTimePatch {
  enabled?: boolean;
  weeks?: ShiftWeekRecord[];
  specialDays?: SpecialDay[];
}

/** Body of `POST` (creation): the username, password and role are mandatory. */
export interface UserCreate extends UserWrite {
  username: string;
  password: string;
  role: Role;
}

/** Kind of perimeter a role is bound to. */
export type ScopeKind = 'companies' | 'places' | 'none';

/** Perimeter kind of a role: companies for CA, stores for PA and E, none otherwise. */
export function scopeKindOf(role: Role | ''): ScopeKind {
  if (role === 'CA') {
    return 'companies';
  }
  return role === 'PA' || role === 'E' ? 'places' : 'none';
}

/**
 * Roles the actor may assign (the server enforces the same table): the PSA assigns every role
 * (platform roles in the platform area, group roles in a group), D and SA the group roles,
 * CA, PA the ones at or below their rank.
 *
 * @param actor Role of the current user.
 * @param area Area where the user is created or edited.
 */
export function assignableRoles(actor: Role, area: UserArea): Role[] {
  if (area.kind === 'platform') {
    return actor === 'PSA' ? ['PSA', 'D'] : [];
  }
  switch (actor) {
    case 'PSA':
    case 'D':
    case 'SA':
      return ['SA', 'CA', 'PA', 'E'];
    case 'CA':
      return ['CA', 'PA', 'E'];
    case 'PA':
      return ['PA', 'E'];
    case 'E':
      return [];
  }
}

/** An empty matrix (nothing granted). */
export function emptyMatrix(): PermissionMatrix {
  return {
    modules: Object.fromEntries(
      PERMISSION_MODULES.map((module) => [module, { r: false, w: false }]),
    ) as Record<PermissionModule, ModuleFlags>,
    canManagePermissions: false,
  };
}

/** Matrix of a stored user; modules or flags missing from the response count as not granted. */
export function matrixOf(user: UserRecord): PermissionMatrix {
  const matrix = emptyMatrix();
  for (const module of PERMISSION_MODULES) {
    matrix.modules[module] = {
      r: user.permissions.modules?.[module]?.r === true,
      w: module !== 'logs' && user.permissions.modules?.[module]?.w === true,
    };
  }
  matrix.canManagePermissions = user.permissions.canManagePermissions === true;
  return matrix;
}

/** Area a stored user belongs to: its group, or the platform when it has none. */
export function areaOf(user: Pick<UserRecord, 'groupId'>): UserArea {
  return user.groupId === null ? { kind: 'platform' } : { kind: 'group', groupId: user.groupId };
}

/** Router commands of a user's detail page. */
export function userRoute(user: Pick<UserRecord, 'id' | 'groupId'>): string[] {
  return user.groupId === null
    ? ['/platform', 'users', user.id]
    : ['/groups', user.groupId, 'users', user.id];
}

/** Display name of a user: "First Last", or `null` when neither is set. */
export function fullName(user: Pick<UserRecord, 'firstName' | 'lastName'>): string | null {
  const name = [user.firstName, user.lastName].filter((part) => part).join(' ');
  return name === '' ? null : name;
}

/**
 * Permissions of the actor that stand for the flags of the modules the backend turns into
 * permissions (the other modules are plain data of the matrix: the client cannot tell what the
 * actor holds there and leaves the decision to the server).
 */
const MODULE_PERMISSIONS: Partial<Record<PermissionModule, { r: string; w: readonly string[] }>> = {
  groups: {
    r: 'groups:read',
    w: ['groups:create', 'groups:update', 'groups:suspend', 'groups:trash'],
  },
  users: { r: 'users:read', w: ['users:create', 'users:update', 'users:trash', 'users:delete'] },
  companies: {
    r: 'companies:read',
    w: ['companies:create', 'companies:update', 'companies:trash'],
  },
  places: { r: 'places:read', w: ['places:create', 'places:update', 'places:trash'] },
  products: { r: 'products:read', w: ['products:update'] },
  fidelity: { r: 'fidelity:read', w: ['fidelity:update'] },
  logs: { r: 'activityLog:read', w: [] },
};

/**
 * Whether the actor may grant a flag of a module (an aid: the server enforces "only what you
 * hold"). The PSA and D hold everything; for modules the client cannot check, the answer is yes.
 *
 * @param actor Role of the actor.
 * @param can Whether the actor holds a permission.
 * @param module Module of the flag.
 * @param flag `r` or `w`.
 */
export function canGrantFlag(
  actor: Role,
  can: (permission: string) => boolean,
  module: PermissionModule,
  flag: 'r' | 'w',
): boolean {
  const known = MODULE_PERMISSIONS[module];
  if (actor === 'PSA' || actor === 'D' || known === undefined) {
    return true;
  }
  return flag === 'r' ? can(known.r) : known.w.length > 0 && known.w.every(can);
}
