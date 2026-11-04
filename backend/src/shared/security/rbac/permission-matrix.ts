import { PERMISSIONS as P, isRole } from './permissions.ts';
import type { Permission, Role } from './permissions.ts';

/** Read and write flags of one legacy permission module. */
export interface ModuleFlags {
  readonly r: boolean;
  readonly w: boolean;
}

/**
 * The legacy per-user permission matrix, normalized: only flags that are strictly `true` grant
 * anything (absent means no permission); modules with an explicit boolean flag are all kept.
 */
export interface PermissionMatrix {
  /** Legacy `permissions.status`: may manage other users' matrix. */
  readonly status: boolean;
  /** Module name to flags, core and non-core modules alike (null-prototype object). */
  readonly modules: Readonly<Record<string, ModuleFlags>>;
}

/** The permissions a core legacy module grants with its `r` and `w` flags. */
export interface CoreModule {
  readonly read: readonly Permission[];
  readonly write: readonly Permission[];
}

/** Core modules of the legacy matrix and what they map to. Other modules are kept as data only. */
export const CORE_MODULES: Readonly<Record<string, CoreModule>> = Object.freeze({
  groups: { read: [P.GROUPS_READ], write: [P.GROUPS_CREATE, P.GROUPS_UPDATE, P.GROUPS_SUSPEND, P.GROUPS_TRASH] },
  users: { read: [P.USERS_READ], write: [P.USERS_CREATE, P.USERS_UPDATE, P.USERS_TRASH, P.USERS_DELETE] },
  companies: { read: [P.COMPANIES_READ], write: [P.COMPANIES_CREATE, P.COMPANIES_UPDATE, P.COMPANIES_TRASH] },
  places: { read: [P.PLACES_READ], write: [P.PLACES_CREATE, P.PLACES_UPDATE, P.PLACES_TRASH] },
  logs: { read: [P.ACTIVITY_LOG_READ], write: [] },
});

/** Reads a plain data property: getters are never executed, inherited properties never seen. */
function dataField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
}

function freezeModules(entries: Iterable<[string, ModuleFlags]>): Readonly<Record<string, ModuleFlags>> {
  const modules: Record<string, ModuleFlags> = Object.create(null) as Record<string, ModuleFlags>;
  for (const [name, flags] of entries) {
    modules[name] = Object.freeze({ ...flags });
  }
  return Object.freeze(modules);
}

/** A matrix granting nothing. */
export const EMPTY_MATRIX: PermissionMatrix = Object.freeze({ status: false, modules: freezeModules([]) });

/**
 * Normalizes the legacy `permissions` value of unknown shape. Only own data properties whose
 * value is exactly `true` grant anything; getters are not run; arrays, scalars and nulls give
 * nothing. A module that carries a boolean `r` or `w` is represented even when both are false, so
 * a change in either direction is always visible. Anything else (for example `apps.cash.*`, which
 * has no `r`/`w`) is not part of the matrix and is left untouched.
 *
 * Constraint for the user area (area 3): the matrix is written only with targeted `$set` of
 * `permissions.<module>.r|w` and `permissions.status`, with modules from an allowlist, keeping the
 * rest of `permissions` (`apps.cash.*` included); `/v1` rejects with 422 any change to `apps`.
 *
 * @param raw The legacy `permissions` value.
 * @returns The normalized matrix.
 */
export function normalizeMatrix(raw: unknown): PermissionMatrix {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return EMPTY_MATRIX;
  }
  const entries: Array<[string, ModuleFlags]> = [];
  for (const name of Object.keys(raw)) {
    if (name === 'status') {
      continue;
    }
    const entry = dataField(raw, name);
    const r = dataField(entry, 'r');
    const w = dataField(entry, 'w');
    // A module is represented as soon as it carries a boolean flag, also when both are false.
    if (typeof r === 'boolean' || typeof w === 'boolean') {
      entries.push([name, { r: r === true, w: w === true }]);
    }
  }
  return Object.freeze({ status: dataField(raw, 'status') === true, modules: freezeModules(entries) });
}

/** Flags of a module in a matrix (`false`/`false` when absent). */
export function flagsOf(matrix: PermissionMatrix, module: string): ModuleFlags {
  return Object.hasOwn(matrix.modules, module) ? matrix.modules[module]! : { r: false, w: false };
}

/**
 * Compares two matrices by flags, with absent modules equal to all-false modules.
 *
 * @returns `true` when they grant exactly the same.
 */
export function matricesEqual(a: PermissionMatrix, b: PermissionMatrix): boolean {
  if (a.status !== b.status) {
    return false;
  }
  const names = new Set([...Object.keys(a.modules), ...Object.keys(b.modules)]);
  return [...names].every((name) => flagsOf(a, name).r === flagsOf(b, name).r && flagsOf(a, name).w === flagsOf(b, name).w);
}

const RW: ModuleFlags = { r: true, w: true };
const R: ModuleFlags = { r: true, w: false };

/**
 * Default matrix of a role, from the legacy defaults: PSA, D and SA get groups, users,
 * companies, places (read and write) and logs (read); CA the same without groups; PA users and
 * places and logs; E nothing. `status` (permission management) is always false.
 *
 * @param role Role of the user; an invalid role gets nothing.
 */
export function defaultMatrix(role: Role): PermissionMatrix {
  if (!isRole(role) || role === 'E') {
    return EMPTY_MATRIX;
  }
  const modules: Array<[string, ModuleFlags]> = [];
  if (role === 'PSA' || role === 'D' || role === 'SA') {
    modules.push(['groups', RW]);
  }
  modules.push(['users', RW]);
  if (role !== 'PA') {
    modules.push(['companies', RW]);
  }
  modules.push(['places', RW], ['logs', R]);
  return Object.freeze({ status: false, modules: freezeModules(modules) });
}
