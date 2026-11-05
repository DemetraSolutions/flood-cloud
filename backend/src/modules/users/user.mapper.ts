import { ObjectId } from 'mongodb';
import { effectivePermissionsOf } from '../../shared/security/rbac/effective-permissions.ts';
import { CORE_MODULES, flagsOf, normalizeMatrix } from '../../shared/security/rbac/permission-matrix.ts';
import type { ModuleFlags } from '../../shared/security/rbac/permission-matrix.ts';
import { isRole } from '../../shared/security/rbac/permissions.ts';
import { legacyScopeIds } from '../../shared/security/scope/legacy-scope.ts';
import { INVALID_ROLE } from './user.types.ts';
import type { LegacyUserDocument, LegacyUserUpdate, MappedUser, NewUser, User, UserAnomaly, UserChanges, UserPermissions, UserResponse, UserRole } from './user.types.ts';

/** Names of the permission modules this backend maps and may write (`permissions.<module>.r|w`). */
export const OWNED_PERMISSION_MODULES: readonly string[] = Object.freeze(Object.keys(CORE_MODULES));

/** Language of a user without one. */
export const DEFAULT_LANGUAGE = 'it';

/** Format of a personal value encrypted by the legacy platform: `<ciphertext hex, 32 hex per block>$<iv hex, 32 characters>`. */
const LEGACY_ENCRYPTED = /^([0-9a-f]{32})+\$[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A reference stored as an ObjectId; `null` and absent mean "none". Anything else is an anomaly
 * and also gives no reference.
 */
function readReference(raw: unknown, field: string, anomalies: UserAnomaly[]): string | null {
  if (raw instanceof ObjectId) {
    return raw.toHexString();
  }
  if (raw !== null && raw !== undefined) {
    anomalies.push({ kind: 'invalidReference', field });
  }
  return null;
}

/**
 * A personal text value in clear (D-05). Empty or absent gives `null`; a value still encrypted with
 * the legacy format is not decrypted: it gives `null` and an anomaly, so it never reaches a client.
 */
function readPersonal(raw: unknown, field: string, anomalies: UserAnomaly[]): string | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  if (typeof raw !== 'string') {
    anomalies.push({ kind: 'invalidType', field });
    return null;
  }
  if (LEGACY_ENCRYPTED.test(raw)) {
    anomalies.push({ kind: 'encryptedPersonalData', field });
    return null;
  }
  return raw;
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** The six roles; absent means `E`; anything else is marked invalid and reported. */
function readRole(raw: unknown, anomalies: UserAnomaly[]): UserRole {
  if (raw === null || raw === undefined) {
    return 'E';
  }
  if (isRole(raw)) {
    return raw;
  }
  anomalies.push({ kind: 'invalidRole', field: 'role' });
  return INVALID_ROLE;
}

function readDate(raw: unknown): Date | null {
  return raw instanceof Date ? raw : null;
}

/** Reads the core modules of the stored matrix into the domain permissions, with every core module present. */
function readPermissions(raw: unknown, role: UserRole): UserPermissions {
  const matrix = normalizeMatrix(raw);
  const modules: Record<string, ModuleFlags> = {};
  for (const name of OWNED_PERMISSION_MODULES) {
    modules[name] = { ...flagsOf(matrix, name) };
  }
  return { status: matrix.status, modules, canManagePermissions: isRole(role) && effectivePermissionsOf(role, matrix).canManagePermissions };
}

/**
 * Reads a legacy `users` document into the domain model, tolerantly (`doc/Tasks.md` 0.2 rule 5):
 * an irregular document is read with its sound fields and every problem is returned as an anomaly,
 * never thrown.
 *
 * - `username` comes from `userName`, in second place `username`.
 * - A missing role is `E`; an unknown one (`API` included) is marked {@link INVALID_ROLE}, which gives no access.
 * - `status` and `trash` are booleans in the legacy; a non-boolean `status` means `disabled`.
 * - Scope ids follow D-08. References that are not ObjectIds are reported and ignored.
 * - Personal data are in clear (D-05); values in the legacy encrypted format become `null` with an anomaly.
 * - `password`, `pin`, `tokens`, `avatar`, `servicesId`, `shiftTime` and `permissions.apps` are never mapped.
 *
 * @param document The stored document.
 * @returns The user and the anomalies found.
 */
export function fromLegacy(document: LegacyUserDocument): MappedUser {
  const raw: Readonly<Record<string, unknown>> = document;
  const anomalies: UserAnomaly[] = [];

  const username = nonEmptyString(raw['userName']) ?? nonEmptyString(raw['username']) ?? '';
  if (username === '') {
    anomalies.push({ kind: 'missingUsername', field: 'userName' });
  }
  const role = readRole(raw['role'], anomalies);

  const status = raw['status'];
  if (typeof status !== 'boolean') {
    anomalies.push({ kind: 'invalidStatus', field: 'status' });
  }
  const trash = raw['trash'];
  if (trash !== undefined && trash !== null && typeof trash !== 'boolean') {
    anomalies.push({ kind: 'invalidType', field: 'trash' });
  }

  const scope = legacyScopeIds(document);
  const placesRaw = raw['placesId'];
  readReference(raw['companyId'], 'companyId', anomalies);
  readReference(raw['placeId'], 'placeId', anomalies);
  if (placesRaw !== null && placesRaw !== undefined && (!Array.isArray(placesRaw) || placesRaw.some((id: unknown) => !(id instanceof ObjectId)))) {
    anomalies.push({ kind: 'invalidReference', field: 'placesId' });
  }
  if ((role === 'CA' && scope.companyIds.length === 0) || ((role === 'PA' || role === 'E') && scope.placeIds.length === 0)) {
    anomalies.push({ kind: 'missingScope', field: role === 'CA' ? 'companyId' : 'placesId' });
  }

  const settings = isRecord(raw['settings']) ? raw['settings'] : {};
  const hiddenInStats = settings['hiddenInStats'];
  if (hiddenInStats !== undefined && typeof hiddenInStats !== 'boolean') {
    anomalies.push({ kind: 'invalidType', field: 'settings.hiddenInStats' });
  }

  const user: User = {
    id: document._id.toHexString(),
    username,
    firstName: readPersonal(raw['name'], 'name', anomalies),
    lastName: readPersonal(raw['surname'], 'surname', anomalies),
    email: readPersonal(raw['email'], 'email', anomalies),
    phone: readPersonal(raw['telephone'], 'telephone', anomalies),
    role,
    groupId: readReference(raw['groupId'], 'groupId', anomalies),
    dealerId: readReference(raw['dealerId'], 'dealerId', anomalies),
    companyIds: scope.companyIds.map((id) => id.toHexString()),
    placeIds: scope.placeIds.map((id) => id.toHexString()),
    status: status === true ? 'active' : 'disabled',
    trashed: trash === true,
    language: nonEmptyString(settings['language']) ?? DEFAULT_LANGUAGE,
    hiddenInStats: hiddenInStats === true,
    permissions: readPermissions(raw['permissions'], role),
    createdAt: readDate(raw['insertDate']),
    updatedAt: readDate(raw['updateDate']),
  };
  return { user, anomalies };
}

/** Converts a hexadecimal id of the domain into the ObjectId stored by the legacy. */
function toObjectId(id: string): ObjectId {
  return ObjectId.createFromHexString(id);
}

/**
 * Translates domain changes into a legacy update (`doc/Tasks.md` 3.1.3). Only `$set` and `$unset`
 * of fields the backend owns are produced, never a replacement document, and `updateDate` is always
 * set. The legacy field names are `name`, `surname`, `telephone`, `settings.language`,
 * `settings.hiddenInStats`, `status` and `trash` (booleans), `userName`; the scope follows D-08
 * (`companyId` = first company or `null`, `placeId` = first place or `null`, `placesId` = all places);
 * the matrix is written with targeted `permissions.<module>.r|w` and `permissions.status`, so
 * `permissions.apps` is never touched. A null personal value removes the field (most documents do
 * not have it).
 *
 * @param changes What to change; absent fields are left alone.
 * @param now Value of `updateDate`.
 * @returns The update document.
 * @throws {Error} For a role that is not one of the six (`API` included), a permission module outside
 * the core allowlist, or an id that is not hexadecimal: callers validate input first, so these are bugs.
 */
export function toLegacyUpdate(changes: UserChanges, now: Date = new Date()): LegacyUserUpdate {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  const text = (field: string, value: string | null | undefined): void => {
    if (value === null) {
      unset[field] = '';
    } else if (value !== undefined) {
      set[field] = value;
    }
  };
  if (changes.username !== undefined) {
    set['userName'] = changes.username;
  }
  text('name', changes.firstName);
  text('surname', changes.lastName);
  text('email', changes.email);
  text('telephone', changes.phone);
  if (changes.role !== undefined) {
    if (!isRole(changes.role)) {
      throw new Error('Refusing to write a role that is not one of the six roles');
    }
    set['role'] = changes.role;
  }
  if (changes.groupId !== undefined) {
    set['groupId'] = changes.groupId === null ? null : toObjectId(changes.groupId);
  }
  if (changes.dealerId !== undefined) {
    set['dealerId'] = changes.dealerId === null ? null : toObjectId(changes.dealerId);
  }
  if (changes.companyIds !== undefined) {
    set['companyId'] = changes.companyIds[0] === undefined ? null : toObjectId(changes.companyIds[0]);
  }
  if (changes.placeIds !== undefined) {
    set['placeId'] = changes.placeIds[0] === undefined ? null : toObjectId(changes.placeIds[0]);
    set['placesId'] = changes.placeIds.map(toObjectId);
  }
  if (changes.status !== undefined) {
    set['status'] = changes.status === 'active';
  }
  if (changes.trashed !== undefined) {
    set['trash'] = changes.trashed;
  }
  if (changes.language !== undefined) {
    set['settings.language'] = changes.language;
  }
  if (changes.hiddenInStats !== undefined) {
    set['settings.hiddenInStats'] = changes.hiddenInStats;
  }
  if (changes.password === null) {
    unset['password'] = '';
  } else if (changes.password !== undefined) {
    set['password'] = changes.password;
  }
  if (changes.permissions?.status !== undefined) {
    set['permissions.status'] = changes.permissions.status;
  }
  for (const [module, flags] of Object.entries(changes.permissions?.modules ?? {})) {
    if (!OWNED_PERMISSION_MODULES.includes(module)) {
      throw new Error(`Refusing to write the permission module "${module}": not in the core allowlist`);
    }
    for (const flag of ['r', 'w'] as const) {
      if (flags[flag] !== undefined) {
        set[`permissions.${module}.${flag}`] = flags[flag];
      }
    }
  }
  set['updateDate'] = now;
  return Object.keys(unset).length === 0 ? { $set: set } : { $set: set, $unset: unset };
}

/**
 * Builds the legacy `users` document of a new user: the fields the backend owns, in the types the
 * legacy writes (`status` and `trash` booleans, ObjectId references, `settings.language`, the
 * `permissions.<module>.{r,w}` matrix and `permissions.status`, an empty `tokens[]`). Personal values
 * that are `null` are left out, as in most legacy documents; scope follows D-08 (`companyId` = first
 * company or `null`, `placeId` = first place or `null`, `placesId` = all places); `password` is present
 * only while the legacy coexists. Never `apps`, `pin`, `avatar`, `servicesId` or `shiftTime`.
 *
 * @param user The new user.
 * @param now Value of `insertDate` and `updateDate`.
 * @returns The document to insert, with `_id`.
 * @throws {Error} For a role that is not one of the six (`API` included), a permission module outside
 * the core allowlist, or an id that is not hexadecimal: callers validate input first, so these are bugs.
 */
export function toLegacyDocument(user: NewUser, now: Date): Record<string, unknown> {
  if (!isRole(user.role)) {
    throw new Error('Refusing to write a role that is not one of the six roles');
  }
  const permissions: Record<string, unknown> = { status: user.permissions.status };
  for (const [module, flags] of Object.entries(user.permissions.modules)) {
    if (!OWNED_PERMISSION_MODULES.includes(module)) {
      throw new Error(`Refusing to write the permission module "${module}": not in the core allowlist`);
    }
    permissions[module] = { r: flags.r, w: flags.w };
  }
  const personal = (field: string, value: string | null): Record<string, string> => (value === null ? {} : { [field]: value });
  return {
    _id: user.id,
    userName: user.username,
    ...personal('name', user.firstName),
    ...personal('surname', user.lastName),
    ...personal('email', user.email),
    ...personal('telephone', user.phone),
    ...(user.legacyPasswordHash === null ? {} : { password: user.legacyPasswordHash }),
    role: user.role,
    groupId: user.groupId === null ? null : toObjectId(user.groupId),
    dealerId: user.dealerId === null ? null : toObjectId(user.dealerId),
    companyId: user.companyIds[0] === undefined ? null : toObjectId(user.companyIds[0]),
    placeId: user.placeIds[0] === undefined ? null : toObjectId(user.placeIds[0]),
    placesId: user.placeIds.map(toObjectId),
    permissions,
    settings: { language: user.language, hiddenInStats: false },
    status: user.status === 'active',
    trash: false,
    tokens: [],
    insertDate: now,
    updateDate: now,
  };
}

/**
 * The representation of a user on `/v1`: an explicit allowlist of fields. Nothing of the legacy
 * document (password, PIN, tokens, cash permissions, picture…) can appear, because the {@link User}
 * does not hold it, and dates are ISO 8601 strings.
 *
 * @param user The user.
 */
export function toResponse(user: User): UserResponse {
  const modules: Record<string, ModuleFlags> = {};
  for (const [name, flags] of Object.entries(user.permissions.modules)) {
    modules[name] = { r: flags.r, w: flags.w };
  }
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    groupId: user.groupId,
    dealerId: user.dealerId,
    companyIds: [...user.companyIds],
    placeIds: [...user.placeIds],
    status: user.status,
    trashed: user.trashed,
    language: user.language,
    hiddenInStats: user.hiddenInStats,
    permissions: { status: user.permissions.status, modules, canManagePermissions: user.permissions.canManagePermissions },
    createdAt: user.createdAt === null ? null : user.createdAt.toISOString(),
    updatedAt: user.updatedAt === null ? null : user.updatedAt.toISOString(),
  };
}
