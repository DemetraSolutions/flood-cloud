import { ObjectId } from 'mongodb';
import { effectivePermissionsOf, hasWholeCeiling } from '../../shared/security/rbac/effective-permissions.ts';
import { LEGACY_MODULES, READ_ONLY_MODULE, flagsOf, normalizeMatrix } from '../../shared/security/rbac/permission-matrix.ts';
import type { ModuleFlags } from '../../shared/security/rbac/permission-matrix.ts';
import { isRole } from '../../shared/security/rbac/permissions.ts';
import { legacyScopeIds } from '../../shared/security/scope/legacy-scope.ts';
import { isDisplayableAvatar } from './avatar.ts';
import { posDocument, posSetPaths, readPos } from './pos.mapper.ts';
import { readShiftTime, shiftTimeSetPaths, toLegacyShiftTime } from './shift-time.ts';
import { INVALID_ROLE } from './user.types.ts';
import type {
  LegacyUserDocument,
  LegacyUserUpdate,
  MappedUser,
  ModuleFlagsResponse,
  NewUser,
  User,
  UserAnomaly,
  UserChanges,
  UserPermissions,
  UserResponse,
  UserRole,
} from './user.types.ts';

/** Names of the permission modules this backend maps and may write (`permissions.<module>.r|w`): the whole legacy matrix. */
export const OWNED_PERMISSION_MODULES: readonly string[] = LEGACY_MODULES;

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

/**
 * Reads the stored matrix into the domain permissions with every module of the legacy matrix present. A flag that is missing or not a
 * boolean (`fidelity` is missing in about 950 production users, `stats.w` in 33) counts as `false` and is reported. For a PSA or a dealer
 * the values are the effective ones (D-10): every flag, `status` and `canManagePermissions` true, whatever the document stores (it is
 * left as it is, and the anomalies of the stored flags are still reported).
 */
function readPermissions(raw: unknown, role: UserRole, anomalies: UserAnomaly[]): UserPermissions {
  const matrix = normalizeMatrix(raw);
  // D-10: what a PSA or a dealer holds is everything, so that is what is shown, not the stored matrix that limits nothing.
  const whole = isRole(role) && hasWholeCeiling(role);
  const stored = isRecord(raw) ? raw : {};
  const modules: Record<string, ModuleFlags> = {};
  for (const name of OWNED_PERMISSION_MODULES) {
    const entry = stored[name];
    for (const flag of name === READ_ONLY_MODULE ? (['r'] as const) : (['r', 'w'] as const)) {
      if (!isRecord(entry) || typeof entry[flag] !== 'boolean') {
        anomalies.push({ kind: 'invalidPermission', field: `permissions.${name}.${flag}` });
      }
    }
    // `logs` has no write flag in the legacy: whatever a document holds there, the domain has none.
    modules[name] = whole ? { r: true, w: name !== READ_ONLY_MODULE } : name === READ_ONLY_MODULE ? { r: flagsOf(matrix, name).r, w: false } : { ...flagsOf(matrix, name) };
  }
  return { status: whole || matrix.status, modules, canManagePermissions: isRole(role) && effectivePermissionsOf(role, matrix).canManagePermissions };
}

/** The service ids of a user, as hexadecimal strings without duplicates; what is not an ObjectId is reported and left out. */
function readServiceIds(raw: unknown, anomalies: UserAnomaly[]): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const ids = Array.isArray(raw) ? (raw as unknown[]) : [];
  if (!Array.isArray(raw) || ids.some((id) => !(id instanceof ObjectId))) {
    anomalies.push({ kind: 'invalidReference', field: 'servicesId' });
  }
  return [...new Set(ids.filter((id): id is ObjectId => id instanceof ObjectId).map((id) => id.toHexString()))];
}

/** The free text of the user; a non-string value is reported and read as none. */
function readDescription(raw: unknown, anomalies: UserAnomaly[]): string | null {
  if (typeof raw === 'string') {
    return raw === '' ? null : raw;
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidType', field: 'description' });
  }
  return null;
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
 * - Every module of the legacy matrix is read; a missing or non-boolean flag is `false` and reported.
 * - The POS data (`permissions.apps.cash`), the shifts (`shiftTime`, with the older `ststus` and `weekGeneric` spellings), `servicesId` and the
 *   free text are read; the PIN is not: only whether it is set (`pinSet`). The picture is read unless `summary` is set (the lists never load it)
 *   and only when it is a PNG, JPEG or WebP data URL (anything else is `null` and reported); `hasAvatar` tells whether one is stored in any case.
 * - `password` and `tokens` are never mapped.
 *
 * @param document The stored document.
 * @param options `summary`: the document was read for a list, without the picture.
 * @returns The user and the anomalies found.
 */
export function fromLegacy(document: LegacyUserDocument, options: { readonly summary?: boolean } = {}): MappedUser {
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
  // The leftover of the old form: used only when the current setting is missing.
  const leftoverHidden = isRecord(raw['permissions']) ? raw['permissions']['hiddenInStats'] : undefined;
  const avatar = raw['avatar'];
  const hasAvatar = raw['__hasAvatar'] === true || (typeof avatar === 'string' && avatar !== '');
  // A stored picture that is not a PNG, JPEG or WebP data URL (the legacy validated nothing) is never returned: it stays stored and is reported.
  const shownAvatar = typeof avatar === 'string' && isDisplayableAvatar(avatar) ? avatar : null;
  if (avatar !== undefined && avatar !== null && (typeof avatar !== 'string' || (avatar !== '' && shownAvatar === null))) {
    anomalies.push({ kind: 'invalidType', field: 'avatar' });
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
    hiddenInStats: typeof hiddenInStats === 'boolean' ? hiddenInStats : leftoverHidden === true,
    description: readDescription(raw['description'], anomalies),
    ...(options.summary === true ? {} : { avatar: shownAvatar }),
    hasAvatar,
    pinSet: raw['__pinSet'] === true || (typeof raw['pin'] === 'string' && raw['pin'] !== ''),
    serviceIds: readServiceIds(raw['servicesId'], anomalies),
    permissions: readPermissions(raw['permissions'], role, anomalies),
    pos: readPos(raw['permissions'], anomalies),
    shiftTime: readShiftTime(raw['shiftTime'], anomalies),
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
 * the matrix is written with targeted `permissions.<module>.r|w` and `permissions.status`, the POS with one path per value
 * (`permissions.apps.cash.sub.discount`…) and the shifts with `shiftTime.status|weeksGeneric|daySpecial`, so the keys of those objects that the
 * backend does not manage stay. A null personal value removes the field (most documents do not have it); a null `description`, `avatar` or `pin` is
 * written as `null`, as the legacy form does.
 *
 * @param changes What to change; absent fields are left alone.
 * @param now Value of `updateDate`.
 * @returns The update document.
 * @throws {Error} For a role that is not one of the six (`API` included), a permission module outside
 * the legacy matrix, a write flag of `logs`, or an id that is not hexadecimal: callers validate input first, so these are bugs.
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
  for (const field of ['description', 'avatar', 'pin'] as const) {
    if (changes[field] !== undefined) {
      set[field] = changes[field];
    }
  }
  if (changes.serviceIds !== undefined) {
    set['servicesId'] = changes.serviceIds.map(toObjectId);
  }
  if (changes.pos !== undefined) {
    Object.assign(set, posSetPaths(changes.pos));
  }
  if (changes.shiftTime !== undefined) {
    Object.assign(set, shiftTimeSetPaths(changes.shiftTime));
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
      throw new Error(`Refusing to write the permission module "${module}": not in the legacy matrix`);
    }
    if (module === READ_ONLY_MODULE && flags.w !== undefined) {
      throw new Error(`Refusing to write permissions.${module}.w: the module has no write flag`);
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
 * Builds the complete legacy `users` document of a new user, with every key the legacy form emits (`prepareData`), so that a user created here is
 * indistinguishable from one created by the old backoffice: the personal values (`null` when empty), `description`, `avatar`, `pin`, the scope
 * (`companyId` = first company or `null`, `placeId` = first place or `null`, `placesId` = all places, D-08), `servicesId`, the whole matrix
 * (`permissions.status`, every module, `logs` with the read flag only), the POS data (`permissions.apps.cash`, every grant and every device flag
 * present, off or `null`), `settings`, `shiftTime`, an empty `tokens[]` and the dates. `password` is present only while the legacy coexists.
 *
 * @param user The new user.
 * @param now Value of `insertDate` and `updateDate`.
 * @returns The document to insert, with `_id`.
 * @throws {Error} For a role that is not one of the six (`API` included), a permission module outside
 * the legacy matrix, or an id that is not hexadecimal: callers validate input first, so these are bugs.
 */
export function toLegacyDocument(user: NewUser, now: Date): Record<string, unknown> {
  if (!isRole(user.role)) {
    throw new Error('Refusing to write a role that is not one of the six roles');
  }
  const permissions: Record<string, unknown> = { status: user.permissions.status };
  for (const [module, flags] of Object.entries(user.permissions.modules)) {
    if (!OWNED_PERMISSION_MODULES.includes(module)) {
      throw new Error(`Refusing to write the permission module "${module}": not in the legacy matrix`);
    }
    permissions[module] = module === READ_ONLY_MODULE ? { r: flags.r } : { r: flags.r, w: flags.w };
  }
  permissions['apps'] = { cash: posDocument(user.pos) };
  return {
    _id: user.id,
    avatar: user.avatar,
    userName: user.username,
    ...(user.legacyPasswordHash === null ? {} : { password: user.legacyPasswordHash }),
    name: user.firstName,
    surname: user.lastName,
    email: user.email,
    telephone: user.phone,
    description: user.description,
    pin: user.pin,
    role: user.role,
    groupId: user.groupId === null ? null : toObjectId(user.groupId),
    dealerId: user.dealerId === null ? null : toObjectId(user.dealerId),
    companyId: user.companyIds[0] === undefined ? null : toObjectId(user.companyIds[0]),
    placeId: user.placeIds[0] === undefined ? null : toObjectId(user.placeIds[0]),
    placesId: user.placeIds.map(toObjectId),
    servicesId: user.serviceIds.map(toObjectId),
    permissions,
    settings: { language: user.language, hiddenInStats: user.hiddenInStats },
    shiftTime: toLegacyShiftTime(user.shiftTime),
    status: user.status === 'active',
    trash: false,
    tokens: [],
    insertDate: now,
    updateDate: now,
  };
}

/**
 * The representation of a user on `/v1`: an explicit allowlist of fields. Nothing of the legacy
 * document (password, PIN, tokens…) can appear, because the {@link User} does not hold it: the PIN is only
 * `pinSet`. The picture is there when it was loaded (the detail), never in a list. Dates are ISO 8601 strings. The permissions of a PSA or
 * a dealer are the effective ones, all granted (D-10), not the stored matrix.
 *
 * @param user The user.
 */
export function toResponse(user: User): UserResponse {
  const modules: Record<string, ModuleFlagsResponse> = {};
  for (const [name, flags] of Object.entries(user.permissions.modules)) {
    modules[name] = name === READ_ONLY_MODULE ? { r: flags.r } : { r: flags.r, w: flags.w };
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
    description: user.description,
    ...(user.avatar === undefined ? {} : { avatar: user.avatar }),
    hasAvatar: user.hasAvatar,
    pinSet: user.pinSet,
    serviceIds: [...user.serviceIds],
    permissions: { status: user.permissions.status, modules, canManagePermissions: user.permissions.canManagePermissions },
    pos: { enabled: user.pos.enabled, grants: structuredClone(user.pos.grants), options: structuredClone(user.pos.options) },
    shiftTime: {
      enabled: user.shiftTime.enabled,
      weeks: user.shiftTime.weeks.map((week) => ({
        from: week.from === null ? null : week.from.toISOString(),
        to: week.to === null ? null : week.to.toISOString(),
        days: structuredClone(week.days),
      })),
      specialDays: structuredClone(user.shiftTime.specialDays),
    },
    createdAt: user.createdAt === null ? null : user.createdAt.toISOString(),
    updatedAt: user.updatedAt === null ? null : user.updatedAt.toISOString(),
  };
}
