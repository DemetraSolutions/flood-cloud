import { Role } from '../../core/session/session.types';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_CHOICE_NAMES,
  POS_FLAGS,
} from '../../core/users/pos.catalog';
import {
  emptyShiftTime,
  ShiftTimeModel,
  specialDaysBody,
  weeksBody,
} from '../../core/users/shift-time';
import { percentOrNull } from './percent';
import {
  PosModel,
  posModelOf,
  PosOptionsModel,
  toUserFormModel,
  UserFormModel,
} from './user-model';
import {
  matrixOf,
  PERMISSION_MODULES,
  PermissionMatrix,
  PermissionsPatch,
  PosPatch,
  scopeKindOf,
  ShiftTimePatch,
  UserCreate,
  UserRecord,
  UserStatus,
  UserWrite,
} from './user.types';

const TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;
const PERCENT_FIELDS = ['discountMaxPercentage', 'servicePercentage'] as const;

/** Which parts of the form the current user can write, and so which parts a body may carry. */
export interface WriteScope {
  /** The permission matrix is included (the actor may change it, the target is not PSA or D). */
  readonly matrix: boolean;
  /** The POS section applies (feature, role and area). */
  readonly pos: boolean;
  /** The actor may give POS permissions (`pos.enabled` and `pos.grants`). */
  readonly posPermissions: boolean;
  /** Services apply (feature, role and area). */
  readonly services: boolean;
}

/** Structural equality of plain data (objects, arrays and primitives). */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

/** Perimeter fields of a body for a role (empty object for roles without perimeter). */
function scopeOf(model: UserFormModel): Pick<UserWrite, 'companyIds' | 'placeIds'> {
  switch (scopeKindOf(model.role as Role)) {
    case 'companies':
      return { companyIds: model.companyIds };
    case 'places':
      return { placeIds: model.placeIds };
    case 'none':
      return {};
  }
}

/** Whole matrix as a request body (`logs` has the read flag only). */
function fullMatrix(matrix: PermissionMatrix): PermissionsPatch {
  return {
    modules: Object.fromEntries(
      PERMISSION_MODULES.map((module) => [
        module,
        module === 'logs' ? { r: matrix.modules[module].r } : { ...matrix.modules[module] },
      ]),
    ),
    canManagePermissions: matrix.canManagePermissions,
  };
}

function diffMatrix(next: PermissionMatrix, current: PermissionMatrix): PermissionsPatch | null {
  const modules: Record<string, { r?: boolean; w?: boolean }> = {};
  for (const module of PERMISSION_MODULES) {
    const change: { r?: boolean; w?: boolean } = {};
    if (next.modules[module].r !== current.modules[module].r) {
      change.r = next.modules[module].r;
    }
    if (module !== 'logs' && next.modules[module].w !== current.modules[module].w) {
      change.w = next.modules[module].w;
    }
    if (Object.keys(change).length > 0) {
      modules[module] = change;
    }
  }
  const patch: PermissionsPatch = {};
  if (Object.keys(modules).length > 0) {
    patch.modules = modules;
  }
  if (next.canManagePermissions !== current.canManagePermissions) {
    patch.canManagePermissions = next.canManagePermissions;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Value of a non-boolean preference as the API wants it (`''` is `null` where `null` exists). */
function optionBody(name: string, value: string): string | number | null {
  switch (name) {
    case 'favoritesId':
    case 'template':
    case 'defaultPriceListId':
      return value === '' ? null : value;
    case 'roomsTablesColumns':
    case 'roomsTablesColumnsHandheld':
    case 'quickDiscount':
      return value === '' ? null : Number(value);
    case 'roomsGridZoomHandheld':
    case 'handheldTextZoom':
    case 'handheldCategoriesRows':
    case 'handheldProductsColumns':
      return Number(value);
    default:
      return value;
  }
}

/**
 * Preferences that differ from the baseline, as a request body (`null` when none).
 *
 * @param model Preferences in the form.
 * @param base Preferences to compare with.
 * @param personal The user's own preferences: price lists are not part of them.
 */
export function optionsPatch(
  model: PosOptionsModel,
  base: PosOptionsModel,
  personal = false,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const name of POS_BOOLEAN_OPTIONS) {
    if (model[name] !== base[name]) {
      patch[name] = model[name];
    }
  }
  const names = [...POS_CHOICE_NAMES, 'favoritesId', 'quickDiscount'] as const;
  for (const name of names) {
    if (model[name] !== base[name]) {
      patch[name] = optionBody(name, model[name]);
    }
  }
  if (!personal) {
    if (model.defaultPriceListId !== base.defaultPriceListId) {
      patch['defaultPriceListId'] = optionBody('defaultPriceListId', model.defaultPriceListId);
    }
    if (!sameData(model.priceLists, base.priceLists)) {
      patch['priceLists'] = model.priceLists.map((list) => ({ ...list }));
    }
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * POS permissions to write: only what differs from the baseline.
 */
function grantsPatch(model: PosModel, base: PosModel): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const flag of POS_FLAGS) {
    if (model.grants[flag] !== base.grants[flag]) {
      patch[flag] = model.grants[flag];
    }
  }
  for (const field of PERCENT_FIELDS) {
    if (model.grants[field] !== base.grants[field]) {
      patch[field] = percentOrNull(model.grants[field]);
    }
  }
  const automatic: Record<string, Record<string, boolean>> = {};
  for (const device of AUTOMATIC_CASH_DEVICES) {
    for (const key of AUTOMATIC_CASH[device]) {
      const value = (model.grants.automaticCash[device] as Record<string, boolean>)[key];
      const before = (base.grants.automaticCash[device] as Record<string, boolean>)[key];
      if (value !== before) {
        automatic[device] = { ...automatic[device], [key]: value };
      }
    }
  }
  if (Object.keys(automatic).length > 0) {
    patch['automaticCash'] = automatic;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** POS part of a write, or `undefined` when nothing changes. */
function posPatch(model: PosModel, base: PosModel, scope: WriteScope): PosPatch | undefined {
  const patch: PosPatch = {};
  if (scope.posPermissions) {
    if (model.enabled !== base.enabled) {
      patch.enabled = model.enabled;
    }
    const grants = grantsPatch(model, base);
    if (grants !== null) {
      patch.grants = grants;
    }
  }
  const options = optionsPatch(model.options, base.options);
  if (options !== null) {
    patch.options = options;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** Shifts part of a write, or `undefined` when nothing changes. */
function shiftPatch(model: ShiftTimeModel, base: ShiftTimeModel): ShiftTimePatch | undefined {
  const patch: ShiftTimePatch = {};
  if (model.enabled !== base.enabled) {
    patch.enabled = model.enabled;
  }
  if (!sameData(model.weeks, base.weeks)) {
    patch.weeks = weeksBody(model.weeks);
  }
  if (!sameData(model.specialDays, base.specialDays)) {
    patch.specialDays = specialDaysBody(model.specialDays);
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/**
 * Body of the creation. The matrix and the POS data are never sent: the server applies the
 * defaults of the role and they are changed afterwards on the record. Optional data are sent only
 * when filled in.
 */
export function buildCreateBody(model: UserFormModel, scope: WriteScope): UserCreate {
  const body: UserCreate = {
    username: model.username.trim(),
    password: model.password,
    role: model.role as Role,
    language: model.language,
    status: model.status as UserStatus,
    ...scopeOf(model),
  };
  for (const field of TEXT_FIELDS) {
    const value = textOrNull(model[field]);
    if (value !== null) {
      body[field] = value;
    }
  }
  const description = textOrNull(model.description);
  if (description !== null) {
    body.description = description;
  }
  if (model.avatar !== '') {
    body.avatar = model.avatar;
  }
  if (model.hiddenInStats) {
    body.hiddenInStats = true;
  }
  if (model.pin !== '') {
    body.pin = model.pin;
  }
  if (scope.services && model.serviceIds.length > 0) {
    body.serviceIds = model.serviceIds;
  }
  const shift = shiftPatch(model.shiftTime, emptyShiftTime());
  if (shift !== undefined) {
    body.shiftTime = shift;
  }
  return body;
}

/**
 * Body of the modification: only what differs from the stored user (an emptied text field
 * becomes `null`). When the role changes the perimeter of the new role is always sent. The PIN
 * is not part of it (it has its own action). Lists the server replaces (`weeks`, `specialDays`,
 * `priceLists`) are sent whole when they differ.
 *
 * @param model Values in the form.
 * @param user The stored user.
 * @param scope Which parts the actor can write.
 */
export function buildPatch(
  model: UserFormModel,
  user: UserRecord | null,
  scope: WriteScope,
): UserWrite {
  const patch: UserWrite = {};
  if (user === null) {
    return patch;
  }
  const base = toUserFormModel(user, user.role);
  if (model.username.trim() !== user.username) {
    patch.username = model.username.trim();
  }
  for (const field of TEXT_FIELDS) {
    const value = textOrNull(model[field]);
    if (value !== user[field]) {
      patch[field] = value;
    }
  }
  if (model.language !== user.language) {
    patch.language = model.language;
  }
  if (model.status !== user.status) {
    patch.status = model.status as UserStatus;
  }
  const description = textOrNull(model.description);
  if (description !== user.description) {
    patch.description = description;
  }
  if (model.avatar !== base.avatar) {
    patch.avatar = model.avatar === '' ? null : model.avatar;
  }
  if (model.hiddenInStats !== user.hiddenInStats) {
    patch.hiddenInStats = model.hiddenInStats;
  }
  const roleChanged = model.role !== user.role;
  if (roleChanged) {
    patch.role = model.role as Role;
  }
  const perimeter = scopeOf(model);
  if (
    perimeter.companyIds !== undefined &&
    (roleChanged || !sameIds(perimeter.companyIds, user.companyIds))
  ) {
    patch.companyIds = perimeter.companyIds;
  }
  if (
    perimeter.placeIds !== undefined &&
    (roleChanged || !sameIds(perimeter.placeIds, user.placeIds))
  ) {
    patch.placeIds = perimeter.placeIds;
  }
  if (scope.services && !sameIds(model.serviceIds, user.serviceIds)) {
    patch.serviceIds = model.serviceIds;
  }
  if (scope.matrix) {
    const permissions = diffMatrix(model.permissions, matrixOf(user));
    if (permissions !== null) {
      patch.permissions = permissions;
    }
  }
  if (scope.pos) {
    const pos = posPatch(model.pos, posModelOf(user.pos), scope);
    if (pos !== undefined) {
      patch.pos = pos;
    }
  }
  const shift = shiftPatch(model.shiftTime, base.shiftTime);
  if (shift !== undefined) {
    patch.shiftTime = shift;
  }
  return patch;
}
