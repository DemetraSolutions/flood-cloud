import { Role } from '../../core/session/session.types';

/** Account status of a user. */
export type UserStatus = 'active' | 'disabled';

/** Permission modules of the matrix, in display order. */
export const PERMISSION_MODULES = ['groups', 'users', 'companies', 'places', 'logs'] as const;

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
    modules: {
      groups: { r: false, w: false },
      users: { r: false, w: false },
      companies: { r: false, w: false },
      places: { r: false, w: false },
      logs: { r: false, w: false },
    },
    canManagePermissions: false,
  };
}

/** Matrix of a stored user; modules or flags missing from the response count as not granted. */
export function matrixOf(user: UserRecord): PermissionMatrix {
  const matrix = emptyMatrix();
  for (const module of PERMISSION_MODULES) {
    matrix.modules[module] = {
      r: user.permissions.modules?.[module]?.r === true,
      w: user.permissions.modules?.[module]?.w === true,
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

/** Write permissions that "write" on a module stands for (the actor must hold them all). */
const MODULE_WRITES: Record<PermissionModule, readonly string[]> = {
  groups: ['groups:create', 'groups:update', 'groups:suspend', 'groups:trash'],
  users: ['users:create', 'users:update', 'users:trash', 'users:delete'],
  companies: ['companies:create', 'companies:update', 'companies:trash'],
  places: ['places:create', 'places:update', 'places:trash'],
  logs: [],
};
const MODULE_READS: Record<PermissionModule, string> = {
  groups: 'groups:read',
  users: 'users:read',
  companies: 'companies:read',
  places: 'places:read',
  logs: 'activityLog:read',
};

/** Default matrix of a role, as the backend applies it (the operator `E` gets nothing). */
function defaultMatrixOf(role: Role): PermissionMatrix {
  const matrix = emptyMatrix();
  if (!['PSA', 'D', 'SA', 'CA', 'PA'].includes(role)) {
    return matrix;
  }
  const platform = role === 'PSA' || role === 'D' || role === 'SA';
  matrix.modules.groups = { r: platform, w: platform };
  matrix.modules.users = { r: true, w: true };
  matrix.modules.companies = { r: role !== 'PA', w: role !== 'PA' };
  matrix.modules.places = { r: true, w: true };
  matrix.modules.logs = { r: true, w: false };
  return matrix;
}

/**
 * What a new user gets when nobody chose a matrix: the default of the role limited to the flags
 * the creating user holds (as the backend does), with "manages permissions" off.
 *
 * @param role Role of the new user (an empty or unknown role gets nothing).
 * @param can Whether the creating user holds a permission.
 */
export function inheritedMatrix(
  role: Role,
  can: (permission: string) => boolean,
): PermissionMatrix {
  const base = defaultMatrixOf(role);
  for (const module of PERMISSION_MODULES) {
    const writes = MODULE_WRITES[module];
    base.modules[module] = {
      r: base.modules[module].r && can(MODULE_READS[module]),
      w: base.modules[module].w && writes.length > 0 && writes.every(can),
    };
  }
  return base;
}
