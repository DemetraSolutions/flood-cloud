import type { Db } from 'mongodb';
import { classifyPii, emptyPasswordProfile, emptyPinProfile, emptyPiiCounts, emptyRefProfile, tallyPassword, tallyPin, tallyRef } from './classify.ts';
import type { PasswordProfile, PiiCounts, PinProfile, RefProfile } from './classify.ts';
import { countDuplicates } from './duplicates.ts';
import type { DuplicateCount } from './duplicates.ts';
import { createFieldProfiler } from './fields.ts';
import type { FieldProfile } from './fields.ts';
import { listIndexInfo } from './indexes.ts';
import type { IndexInfo } from './indexes.ts';
import { streamDocuments } from './read.ts';
import type { TenancyIndex } from './tenants.ts';

/** Roles of the legacy platform; any other value is reported as `<other>`. */
export const KNOWN_ROLES: ReadonlySet<string> = new Set(['PSA', 'D', 'SA', 'CA', 'PA', 'E', 'API']);

/** Personal-data fields of `users` classified as encrypted or plain. */
export const USER_PII_FIELDS = ['email', 'telephone', 'name', 'surname'] as const;

/** How many scope references the users of one role carry. */
export interface RoleScope {
  users: number;
  withGroupId: number;
  withCompanyId: number;
  withPlaceId: number;
  /** Users whose `placesId` is a non-empty array. */
  withPlacesId: number;
}

/** Shape of `tokens[]` across users; the tokens themselves are never read into the report. */
export interface TokensProfile {
  /** Users by length of `tokens`. */
  lengths: Record<'0' | '1-5' | '6-10' | '>10' | 'missingOrNotArray', number>;
  /** Elements that are plain strings (old format) instead of objects. */
  stringElements: number;
}

/** Duplicate counts on `users`. */
export interface UserDuplicates {
  userNameExact: DuplicateCount;
  userNameCaseInsensitive: DuplicateCount;
  userNameCaseInsensitiveNotTrashed: DuplicateCount;
  email: DuplicateCount;
  telephone: DuplicateCount;
}

/** Result of profiling `users`. */
export interface UsersProfile {
  fields: FieldProfile;
  indexes: IndexInfo[];
  password: PasswordProfile;
  pin: PinProfile;
  personalData: Record<(typeof USER_PII_FIELDS)[number], PiiCounts>;
  tokens: TokensProfile;
  /** Keyed by role (`<missing>` and `<other>` for values outside the legacy list). */
  roleScope: Record<string, RoleScope>;
  references: Record<'users.groupId' | 'users.companyId' | 'users.placeId' | 'users.placesId' | 'users.dealerId', RefProfile>;
  duplicates: UserDuplicates;
}

function roleKey(role: unknown): string {
  if (typeof role === 'string') {
    return KNOWN_ROLES.has(role) ? role : '<other>';
  }
  return '<missing>';
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function tokenBand(length: number): keyof TokensProfile['lengths'] {
  if (length === 0) {
    return '0';
  }
  if (length <= 5) {
    return '1-5';
  }
  return length <= 10 ? '6-10' : '>10';
}

/**
 * Ids of the users with role `D` (dealers), as lowercase hex.
 *
 * @param common The common database.
 * @returns The ids.
 */
export async function readDealerIds(common: Db): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const document of streamDocuments(common.collection('users'), { role: 'D' }, { _id: 1 })) {
    ids.add(String(document['_id']));
  }
  return ids;
}

/**
 * Profiles `users`: field inventory, enums, password and PIN formats, personal-data encryption,
 * `tokens[]` shape, role/scope coherence, references and duplicates. Read-only; no value is reported.
 *
 * @param common The common database.
 * @param tenancy Existing groups, dealers and per-group companies/places.
 * @returns Counts only.
 */
export async function profileUsers(common: Db, tenancy: TenancyIndex): Promise<UsersProfile> {
  const users = common.collection('users');
  const fields = createFieldProfiler({
    enums: ['role', 'settings.language'],
    booleans: ['status', 'trash', 'permissions.status', 'permissions.*.r', 'permissions.*.w', 'permissions.apps.cash.status'],
  });
  const password = emptyPasswordProfile();
  const pin = emptyPinProfile();
  const personalData = {
    email: emptyPiiCounts(),
    telephone: emptyPiiCounts(),
    name: emptyPiiCounts(),
    surname: emptyPiiCounts(),
  };
  const tokens: TokensProfile = {
    lengths: { '0': 0, '1-5': 0, '6-10': 0, '>10': 0, missingOrNotArray: 0 },
    stringElements: 0,
  };
  const roleScope: Record<string, RoleScope> = {};
  const references: UsersProfile['references'] = {
    'users.groupId': emptyRefProfile(),
    'users.companyId': emptyRefProfile(),
    'users.placeId': emptyRefProfile(),
    'users.placesId': emptyRefProfile(),
    'users.dealerId': emptyRefProfile(),
  };

  for await (const user of streamDocuments(users, {}, { _id: 0 })) {
    fields.add(user);
    tallyPassword(password, user['password']);
    tallyPin(pin, user['pin']);
    for (const name of USER_PII_FIELDS) {
      personalData[name][classifyPii(user[name])] += 1;
    }

    const userTokens = user['tokens'];
    if (Array.isArray(userTokens)) {
      tokens.lengths[tokenBand(userTokens.length)] += 1;
      tokens.stringElements += userTokens.filter((token) => typeof token === 'string').length;
    } else {
      tokens.lengths.missingOrNotArray += 1;
    }

    const placesId = user['placesId'];
    const scope = (roleScope[roleKey(user['role'])] ??= {
      users: 0,
      withGroupId: 0,
      withCompanyId: 0,
      withPlaceId: 0,
      withPlacesId: 0,
    });
    scope.users += 1;
    scope.withGroupId += present(user['groupId']) ? 1 : 0;
    scope.withCompanyId += present(user['companyId']) ? 1 : 0;
    scope.withPlaceId += present(user['placeId']) ? 1 : 0;
    scope.withPlacesId += Array.isArray(placesId) && placesId.length > 0 ? 1 : 0;

    const group = tallyRef(references['users.groupId'], user['groupId'], tenancy.groupHexes);
    const groupScope = group.hex === null ? undefined : tenancy.perGroup.get(group.hex);
    tallyRef(references['users.companyId'], user['companyId'], groupScope?.companies);
    tallyRef(references['users.placeId'], user['placeId'], groupScope?.places);
    tallyRef(references['users.dealerId'], user['dealerId'], tenancy.dealerHexes);
    if (Array.isArray(placesId)) {
      for (const place of placesId) {
        tallyRef(references['users.placesId'], place, groupScope?.places);
      }
    } else {
      tallyRef(references['users.placesId'], placesId, groupScope?.places);
    }
  }

  return {
    fields: fields.result(),
    indexes: await listIndexInfo(common, users),
    password,
    pin,
    personalData,
    tokens,
    roleScope,
    references,
    duplicates: {
      userNameExact: await countDuplicates(users, 'userName'),
      userNameCaseInsensitive: await countDuplicates(users, 'userName', { caseInsensitive: true }),
      userNameCaseInsensitiveNotTrashed: await countDuplicates(users, 'userName', { caseInsensitive: true, skipTrashed: true }),
      email: await countDuplicates(users, 'email', { caseInsensitive: true }),
      telephone: await countDuplicates(users, 'telephone'),
    },
  };
}
