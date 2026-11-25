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
  // The dealer registry (`dealers:*`), the tobacco price list (`tobaccos:*`) the management of the countries (`countries:manage`), the emptying of the trash (`trash:empty`), the read of the electronic documents in error (`errorDocuments:read`, the legacy page of the PSA and the dealers, whose default matrix has `groups` and not `documents`) and the activations and the billing of the dealers (`activations:read`, `activations:manage`) ride on the `groups` module: only the PSA's ceiling contains most of those permissions (`errorDocuments:read` and `activations:read` are in the PSA and D ceilings), so for the other roles they never become effective.
  groups: {
    read: [P.GROUPS_READ, P.DEALERS_READ, P.TOBACCOS_READ, P.ERROR_DOCUMENTS_READ, P.ACTIVATIONS_READ],
    write: [P.GROUPS_CREATE, P.GROUPS_UPDATE, P.GROUPS_SUSPEND, P.GROUPS_TRASH, P.DEALERS_CREATE, P.DEALERS_UPDATE, P.TOBACCOS_IMPORT, P.COUNTRIES_MANAGE, P.TRASH_EMPTY, P.ACTIVATIONS_MANAGE, P.SECURITY_POLICY_MANAGE],
  },
  users: { read: [P.USERS_READ], write: [P.USERS_CREATE, P.USERS_UPDATE, P.USERS_TRASH, P.USERS_DELETE] },
  companies: { read: [P.COMPANIES_READ], write: [P.COMPANIES_CREATE, P.COMPANIES_UPDATE, P.COMPANIES_TRASH, P.COMPANIES_DELETE] },
  places: { read: [P.PLACES_READ], write: [P.PLACES_CREATE, P.PLACES_UPDATE, P.PLACES_TRASH, P.PLACES_DELETE] },
  // Group-wide loyalty and catalog data kept in the group document (card types, points collections, prize catalogues; favorites and promotions): the legacy menus are governed by these two modules.
  // `fidelityCards:export` and `fidelityCards:import` (step K3, the XLSX workbook of the advanced cards) follow `fidelity.r` and `fidelity.w`, inside the ceiling of PSA, D and SA only.
  fidelity: { read: [P.FIDELITY_READ, P.FIDELITY_CARDS_EXPORT], write: [P.FIDELITY_UPDATE, P.FIDELITY_CARDS_IMPORT] },
  // `tobaccos:sync` (step C7, the synchronization of the tobacco price list into the products of the group): it follows `products.w`, inside the ceiling of the roles that have it (PSA, D, SA).
  products: { read: [P.PRODUCTS_READ], write: [P.PRODUCTS_UPDATE, P.TOBACCOS_SYNC] },
  // The contacts of the group and their groups (step K1): the contacts are of the whole group, shared by every place, so the module is not limited to a perimeter.
  // `contacts:export` and `contacts:import` (step K3, the XLSX workbook of the contacts) follow `contacts.r` and `contacts.w`, inside the ceiling of PSA, D and SA only.
  contacts: { read: [P.CONTACTS_READ, P.CONTACTS_EXPORT], write: [P.CONTACTS_WRITE, P.CONTACTS_IMPORT] },
  // The sales of the group are documents of the legacy matrix (step V1, decision of the user): `documents.r` grants `sales:read`, the module has no write permission yet (a flag with an empty list grants nothing).
  documents: { read: [P.SALES_READ], write: [] },
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
const NONE: ModuleFlags = { r: false, w: false };

/**
 * Every module of the legacy matrix, in the order of the legacy form: the core ones (see {@link CORE_MODULES}) produce permissions, the others
 * (`calendar`, `warehouse`, `settings`, `stats`) are data of the matrix that this backend stores and shows but that no
 * permission of the catalog follows yet. `logs` has only the read flag in the legacy documents.
 */
export const LEGACY_MODULES: readonly string[] = Object.freeze([
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
]);

/** The one module of the legacy matrix without a write flag. */
export const READ_ONLY_MODULE = 'logs';

/** Default flags of a module, by role: `[PSA and D, SA, CA, PA, E]`, as the legacy form (`setDefaultPermissions`) sets them when the role is chosen. */
const MODULE_DEFAULTS: Readonly<Record<string, readonly [ModuleFlags, ModuleFlags, ModuleFlags, ModuleFlags, ModuleFlags]>> = Object.freeze({
  groups: [RW, RW, NONE, NONE, NONE],
  users: [RW, RW, RW, RW, NONE],
  companies: [RW, RW, RW, NONE, NONE],
  places: [RW, RW, RW, RW, R],
  documents: [NONE, RW, RW, RW, NONE],
  products: [NONE, RW, RW, RW, R],
  calendar: [NONE, RW, RW, RW, NONE],
  warehouse: [NONE, RW, RW, RW, NONE],
  contacts: [NONE, RW, RW, RW, RW],
  fidelity: [NONE, RW, NONE, NONE, NONE],
  settings: [NONE, RW, NONE, NONE, NONE],
  stats: [NONE, R, R, R, NONE],
  logs: [R, R, R, R, NONE],
});

/**
 * Default matrix of a role, from the legacy form (`setDefaultPermissions`, A3 of the legacy analysis). Every module of
 * {@link LEGACY_MODULES} is present. `status` (permission management) is always false. `stats.w` is never on, and `logs` has only
 * the read flag.
 *
 * | Module | PSA, D | SA | CA | PA | E |
 * |---|---|---|---|---|---|
 * | groups | rw | rw | - | - | - |
 * | users | rw | rw | rw | rw | - |
 * | companies | rw | rw | rw | - | - |
 * | places | rw | rw | rw | rw | r |
 * | documents, calendar, warehouse | - | rw | rw | rw | - |
 * | products | - | rw | rw | rw | r |
 * | contacts | - | rw | rw | rw | rw |
 * | fidelity, settings | - | rw | - | - | - |
 * | stats | - | r | r | r | - |
 * | logs | r | r | r | r | - |
 *
 * @param role Role of the user; an invalid role gets nothing.
 */
export function defaultMatrix(role: Role): PermissionMatrix {
  if (!isRole(role)) {
    return EMPTY_MATRIX;
  }
  const column = role === 'PSA' || role === 'D' ? 0 : role === 'SA' ? 1 : role === 'CA' ? 2 : role === 'PA' ? 3 : 4;
  return Object.freeze({ status: false, modules: freezeModules(LEGACY_MODULES.map((name): [string, ModuleFlags] => [name, MODULE_DEFAULTS[name]![column]!])) });
}
