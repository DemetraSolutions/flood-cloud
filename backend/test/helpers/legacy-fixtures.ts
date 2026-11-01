import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';

/** Throw-away key of the fixtures that mimic the legacy HMAC-SHA512 password hashes. */
const FIXTURE_HMAC_KEY = randomBytes(16);

/** Kinds of fixture documents; the kind is the first byte of their ids. */
export type FixtureKind = 'user' | 'group' | 'company' | 'place' | 'country';

const KIND_BYTE: Record<FixtureKind, string> = { user: '01', group: '02', company: '03', place: '04', country: '05' };

/**
 * Deterministic id of a fixture document (`kind` byte followed by `n` in hex).
 *
 * @param kind Kind of document.
 * @param n Ordinal, at least 1.
 */
export function fixtureId(kind: FixtureKind, n: number): ObjectId {
  return ObjectId.createFromHexString(`${KIND_BYTE[kind]}${n.toString(16).padStart(22, '0')}`);
}

/** @returns A random 32-byte key for {@link encryptLegacy}. */
export function legacyEncryptionKey(): Buffer {
  return randomBytes(32);
}

/**
 * Encrypts a string like the legacy platform does for personal data: AES-256-CBC, stored as
 * `<ciphertext hex>$<iv hex, 32 characters>`.
 *
 * @param plain Text to encrypt.
 * @param key 32-byte key.
 */
export function encryptLegacy(plain: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return `${Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex')}$${iv.toString('hex')}`;
}

/** A legacy HMAC-SHA512 hex password hash of a throw-away value. */
export function legacyPasswordHash(n: number): string {
  return createHmac('sha512', FIXTURE_HMAC_KEY).update(`password-${n}`).digest('hex');
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

const DATE = new Date('2024-01-15T10:00:00.000Z');

/** Roles found in production data; `API` and others exist only as anomalous variants. */
export type LegacyRole = 'PSA' | 'D' | 'SA' | 'CA' | 'PA' | 'E';

/** Enum values seen in production for `places.plan` (including the empty string and a non-string). */
export const PLACE_PLANS: readonly unknown[] = ['advanced', 'basic', 'professional', 'desk-secondary', 'tgm-secondary', 'enterprice', '', 7];

/** Values seen in production for `places.devices[].type`. */
export const DEVICE_TYPES: readonly string[] = [
  'desk', 'handheld', 'selfordering', 'room-handheld', 'palmare', 'external-display', 'kiosk', 'waiting-list', 'tgm', 'ordering',
];

/** Values seen in production for `groups.type` (null, empty or `basic`) and `groups.plan`. */
export const GROUP_TYPES: readonly unknown[] = ['basic', null, '', 7];
export const GROUP_PLANS: readonly unknown[] = ['advanced', 'basic', 'enterprice', null];

/** Personal data as often found in production: absent or empty. */
export const PII_GAPS: Document = { email: '', telephone: undefined, name: undefined, surname: '' };

/** Scope fields a role should not have but often does ("dirty" scopes), by role. */
export function dirtyScope(role: 'SA' | 'E' | 'PA' | 'CA', ids: { companyId: ObjectId; placeId: ObjectId }): Document {
  switch (role) {
    case 'SA':
      return { companyId: ids.companyId, placeId: ids.placeId, placesId: [ids.placeId] };
    case 'E':
      return { placeId: ids.placeId, placesId: [ids.placeId] };
    case 'PA':
      return { placeId: ids.placeId, placesId: [ids.placeId] };
    case 'CA':
      return { companyId: ids.companyId, placeId: ids.placeId };
  }
}

/**
 * A legacy user in its normal shape (HMAC password, plain PIN, plain personal data, ObjectId references).
 *
 * @param n Ordinal; names are `user-<n>`.
 * @param overrides Fields to add or change.
 */
export function legacyUser(n: number, overrides: Document = {}): Document {
  return {
    _id: fixtureId('user', n),
    userName: `user-${pad(n)}`,
    email: `user-${pad(n)}@example.test`,
    telephone: `+39000000${pad(n)}`,
    name: `Name${pad(n)}`,
    surname: `Surname${pad(n)}`,
    description: `Fixture user ${pad(n)}`,
    password: legacyPasswordHash(n),
    pin: '1234',
    role: 'E',
    dealerId: null,
    groupId: null,
    companyId: null,
    placeId: null,
    placesId: [],
    servicesId: [],
    permissions: { status: true, products: { r: true, w: false }, apps: { cash: { status: true, sub: { discounts: true }, options: { receipts: false } } } },
    settings: { language: 'it', hiddenInStats: false },
    shiftTime: 0,
    status: true,
    trash: false,
    tokens: [{ token: `token-${pad(n)}`, ip: '127.0.0.1', ips: ['127.0.0.1'], userAgent: 'fixture', date: DATE }],
    insertDate: DATE,
    updateDate: DATE,
    ...overrides,
  };
}

/**
 * A legacy group in its normal shape.
 *
 * @param n Ordinal; names are `group-<n>`.
 * @param overrides Fields to add or change.
 */
export function legacyGroup(n: number, overrides: Document = {}): Document {
  return {
    _id: fixtureId('group', n),
    apiKey: `plain-key-${pad(n)}`,
    dealerId: null,
    name: `group-${pad(n)}`,
    description: `Fixture group ${pad(n)}`,
    databaseHost: 'db.example.test',
    filesHost: 'files.example.test',
    type: 'basic',
    plan: 'basic',
    status: true,
    demo: false,
    trash: false,
    settings: {
      languages: true,
      warehouse: true,
      cash: true,
      services: false,
      tobaccosGamesMonopoly: false,
      appointments: false,
      rooms: false,
      delivery: false,
      media: false,
      productsVariants: false,
      scales: false,
      customersApp: false,
      ordering: false,
      email: { host: 'smtp.example.test', password: 'fixture-secret' },
      stats: { daily: true },
      integrations: { satispay: { status: true, apiKey: 'integration-key' } },
    },
    priceLists: { [fixtureId('group', 900 + n).toHexString()]: { name: 'list' } },
    taxes: [{ id: 1, value: 22 }],
    currencies: ['EUR'],
    measureUnits: ['kg'],
    warehouseRules: { [fixtureId('group', 800 + n).toHexString()]: { type: 'D', cashD: true, cashL: false } },
    places: [],
    insertDate: DATE,
    updateDate: DATE,
    ...overrides,
  };
}

/**
 * A legacy country.
 *
 * @param n Ordinal.
 * @param overrides Fields to add or change.
 */
export function legacyCountry(n: number, overrides: Document = {}): Document {
  return { _id: fixtureId('country', n), code: n === 1 ? 'IT' : `X${n}`, name: `country-${pad(n)}`, areas: [{ code: 'A' }], insertDate: DATE, updateDate: DATE, ...overrides };
}

/**
 * A legacy company of a group.
 *
 * @param n Ordinal.
 * @param groupId Group the company belongs to.
 * @param overrides Fields to add or change.
 */
export function legacyCompany(n: number, groupId: ObjectId, overrides: Document = {}): Document {
  return {
    _id: fixtureId('company', n),
    groupId,
    name: `company-${pad(n)}`,
    code: `C${pad(n)}`,
    code2: `D${pad(n)}`,
    address: 'Via Fixture 1',
    postcode: '00100',
    city: 'Fixtureville',
    countryAreaCode: 'RM',
    countryCode: 'IT',
    currencyCode: 'EUR',
    email: `company-${pad(n)}@example.test`,
    telephone: `+39111000${pad(n)}`,
    invoicesPS: false,
    invoicesPSValues: [],
    fattura_elettronica: { username: 'fixture-user', password: 'fixture-secret', settings: { enabled: true } },
    ticketsSuppliers: [],
    banks: [],
    settings: {},
    medias: {},
    status: true,
    trash: false,
    expirationDate: null,
    insertDate: DATE,
    updateDate: DATE,
    ...overrides,
  };
}

/**
 * A legacy place of a company.
 *
 * @param n Ordinal.
 * @param groupId Group the place belongs to.
 * @param companyId Company the place belongs to.
 * @param overrides Fields to add or change.
 */
export function legacyPlace(n: number, groupId: ObjectId, companyId: ObjectId, overrides: Document = {}): Document {
  return {
    _id: fixtureId('place', n),
    groupId,
    companyId,
    listId: null,
    ecommerceListId: null,
    name: `place-${pad(n)}`,
    address: 'Via Fixture 2',
    postcode: '00100',
    city: 'Fixtureville',
    countryAreaCode: 'RM',
    countryCode: 'IT',
    contact: 'fixture contact',
    email: `place-${pad(n)}@example.test`,
    telephone: `+39222000${pad(n)}`,
    invoicePS: false,
    timezone: 'Europe/Rome',
    devices: [{ type: 'cash' }, { type: 'printer' }],
    rooms: [],
    storages: [{ id: fixtureId('place', 700 + n), cash: true, ecommerce: false }],
    openingTime: { monday: { open: '09:00' } },
    platform: 'web',
    server: { ip: '10.0.0.1' },
    plan: 'basic',
    integrations: { dojo: { status: true, apiKey: 'fixture-integration-secret' } },
    status: true,
    trash: false,
    expirationDate: null,
    insertDate: DATE,
    updateDate: DATE,
    ...overrides,
  };
}

/** Options of {@link seedLegacyCluster}. */
export interface SeedOptions {
  /** Number of groups (at least 2 are always created). */
  readonly groups?: number;
  /** Add the anomalous documents seen in the legacy data (encrypted PII, string references, ...). */
  readonly anomalies?: boolean;
  /**
   * Shape of the aggregated production profile: dirty scopes per role, PIN and personal-data gaps,
   * tokens of every length (some old-format strings), duplicated e-mails, telephones, case-insensitive
   * user names and company codes (also inside one group), varied group types/plans and place plans/devices,
   * one group without database and two databases without group.
   */
  readonly productionShape?: boolean;
  /** Also create the extra indexes (sparse unique, TTL, partial) used to test index reporting. */
  readonly extraIndexes?: boolean;
  /** Applied to every document before it is stored (the PII test uses it to inject sentinels). */
  readonly transform?: (collection: string, document: Document) => Document;
}

/** What {@link seedLegacyCluster} created. */
export interface SeededCluster {
  readonly groupIds: ObjectId[];
  readonly dealerId: ObjectId;
  /** Throw-away key used for the encrypted personal data of the anomalous users. */
  readonly encryptionKey: Buffer;
}

/**
 * Creates a synthetic legacy cluster in the test MongoDB: the common database (`users`, `groups`,
 * `countries`) and one database per group (`companies`, `places`), with a few fixture indexes.
 * No real data is involved. With `anomalies`, adds documents shaped like the legacy irregularities:
 * encrypted and plain personal data, a non-hash password, references stored as strings, an orphan
 * group, a `groupId` that differs from the database, string tokens, duplicate user names and company codes. With `productionShape`, the shape seen in the production profile
 * (see {@link SeedOptions.productionShape}).
 *
 * @param databases Accessor over a throw-away test prefix.
 * @param options Number of groups, anomalies and document transform.
 * @returns The ids needed to assert on the result.
 */
export async function seedLegacyCluster(databases: Databases, options: SeedOptions = {}): Promise<SeededCluster> {
  const groupCount = Math.max(options.groups ?? 2, 2);
  const transform = options.transform ?? ((_collection: string, document: Document) => document);
  const encryptionKey = legacyEncryptionKey();
  const groupIds = Array.from({ length: groupCount }, (_unused, index) => fixtureId('group', index + 1));
  const dealerId = fixtureId('user', 1);

  const users: Document[] = [legacyUser(1, { role: 'D' }), legacyUser(2, { role: 'PSA' })];
  const groups: Document[] = [];
  let userNumber = 3;
  let companyNumber = 1;
  let placeNumber = 1;
  const perGroup = new Map<string, { companies: Document[]; places: Document[] }>();

  groupIds.forEach((groupId, index) => {
    groups.push(
      legacyGroup(
        index + 1,
        options.productionShape === true
          ? { dealerId, type: GROUP_TYPES[index % GROUP_TYPES.length], plan: GROUP_PLANS[index % GROUP_PLANS.length] }
          : { dealerId },
      ),
    );
    const companies = [legacyCompany(companyNumber, groupId), legacyCompany(companyNumber + 1, groupId)];
    const places = [
      legacyPlace(placeNumber, groupId, companies[0]!['_id'] as ObjectId),
      legacyPlace(placeNumber + 1, groupId, companies[1]!['_id'] as ObjectId),
    ];
    perGroup.set(groupId.toHexString(), { companies, places });
    const base = { dealerId, groupId };
    users.push(
      legacyUser(userNumber, { ...base, role: 'SA' }),
      legacyUser(userNumber + 1, { ...base, role: 'CA', companyId: companies[0]!['_id'] }),
      legacyUser(userNumber + 2, { ...base, role: 'PA', companyId: companies[0]!['_id'], placeId: places[0]!['_id'], placesId: [places[0]!['_id']] }),
      legacyUser(userNumber + 3, { ...base, role: 'E', companyId: companies[1]!['_id'], placeId: places[1]!['_id'], placesId: [places[1]!['_id']] }),
    );
    userNumber += 4;
    companyNumber += 2;
    placeNumber += 2;
  });

  if (options.anomalies === true) {
    const [first, second] = groupIds as [ObjectId, ObjectId];
    const firstScope = perGroup.get(first.toHexString())!;
    const unknownGroup = fixtureId('group', 999);
    users.push(
      legacyUser(userNumber, {
        groupId: first,
        role: 'SA',
        userName: 'User-003',
        email: encryptLegacy('legacy-mail@example.test', encryptionKey),
        telephone: encryptLegacy('+390000000', encryptionKey),
        name: encryptLegacy('Legacy', encryptionKey),
        surname: '',
      }),
      legacyUser(userNumber + 1, {
        role: 'PA',
        groupId: first.toHexString(),
        companyId: (firstScope.companies[0]!['_id'] as ObjectId).toHexString(),
        placeId: fixtureId('place', 555),
        placesId: [firstScope.places[0]!['_id'], fixtureId('place', 556), 'not-an-id'],
        dealerId: fixtureId('user', 777),
        password: 'plain-text-pass',
        pin: 'abc',
        tokens: ['Bearer fixture-1', 'Bearer fixture-2'],
      }),
      legacyUser(userNumber + 2, { role: 'CA', groupId: unknownGroup, companyId: fixtureId('company', 888), password: null, pin: null, tokens: undefined, telephone: 12345 }),
      legacyUser(userNumber + 3, { role: 'weird', groupId: 'zzz', placesId: undefined, password: '', email: null, tokens: [] }),
      legacyUser(userNumber + 4, {
        role: 'E',
        groupId: second,
        companyId: fixtureId('company', 999),
        placesId: 'single',
        tokens: Array.from({ length: 12 }, (_unused, i) => ({ token: `t${i}` })),
        password: 'x'.repeat(40),
        trash: true,
        userName: 'USER-003',
      }),
      legacyUser(userNumber + 5, { role: undefined, tokens: [{ token: 'a' }, { token: 'b' }, { token: 'c' }, { token: 'd' }, { token: 'e' }, { token: 'f' }, { token: 'g' }], password: 'y'.repeat(100) }),
    );
    groups.push(
      legacyGroup(groupCount + 1, {
        apiKey: encryptLegacy('group-api-key', encryptionKey),
        dealerId: fixtureId('user', 778),
        plan: null,
        settings: { integrations: { stripe: { status: true, apiKey: encryptLegacy('x', encryptionKey) }, other: { status: false }, bad: 'text' } },
      }),
      legacyGroup(groupCount + 2, { settings: 'none', apiKey: undefined }),
    );
    const secondScope = perGroup.get(second.toHexString())!;
    firstScope.companies.push(legacyCompany(companyNumber, first, { code: 'C001' }), legacyCompany(companyNumber + 1, second, { groupId: second, code: 'DUP' }));
    firstScope.companies.push(legacyCompany(companyNumber + 2, first, { groupId: first.toHexString(), code: 'DUP' }), legacyCompany(companyNumber + 3, first, { groupId: undefined, code: 'DUP' }));
    firstScope.places.push(legacyPlace(placeNumber, first, fixtureId('company', 4242), { groupId: second }), legacyPlace(placeNumber + 1, first, firstScope.companies[0]!['_id'] as ObjectId, { groupId: 7 }));
    secondScope.companies.push(legacyCompany(companyNumber + 4, second, { code: 'C001' }), legacyCompany(companyNumber + 5, second, { code: ['x'] }));
    secondScope.companies.push(legacyCompany(companyNumber + 6, second, { code: 'DUP' }));
    // Databases whose group does not exist: one with only companies, one with only places.
    const withoutGroup = fixtureId('group', 50);
    const withoutCompanies = fixtureId('group', 51);
    perGroup.set(withoutGroup.toHexString(), { companies: [legacyCompany(companyNumber + 7, withoutGroup)], places: [] });
    perGroup.set(withoutCompanies.toHexString(), { companies: [], places: [legacyPlace(placeNumber + 2, withoutCompanies, fixtureId('company', 1))] });
  }

  if (options.productionShape === true) {
    const [first, second] = groupIds as [ObjectId, ObjectId];
    const scope = (groupId: ObjectId) => perGroup.get(groupId.toHexString())!;
    const ids = (groupId: ObjectId) => ({ companyId: scope(groupId).companies[0]!['_id'] as ObjectId, placeId: scope(groupId).places[0]!['_id'] as ObjectId });
    const base = { dealerId, groupId: first };
    let n = 2000;
    users.push(
      legacyUser(n++, { ...base, role: 'SA', ...dirtyScope('SA', ids(first)) }),
      legacyUser(n++, { ...base, role: 'E', ...dirtyScope('E', ids(first)), pin: null }),
      legacyUser(n++, { ...base, role: 'PA', ...dirtyScope('PA', ids(first)), pin: 'abcd' }),
      legacyUser(n++, { ...base, role: 'PA', placeId: ids(first).placeId, pin: '12' }),
      legacyUser(n++, { ...base, role: 'CA', ...dirtyScope('CA', ids(first)) }),
      legacyUser(n++, { ...base, role: 'CA', placeId: ids(first).placeId, ...PII_GAPS }),
      legacyUser(n++, { ...base, role: 'E', email: 'shared@example.test', telephone: '+390000999', tokens: [] }),
      legacyUser(n++, { ...base, role: 'E', email: 'shared@example.test', telephone: '+390000999', tokens: ['Bearer old-1', 'Bearer old-2'] }),
      legacyUser(n++, { ...base, role: 'E', userName: 'DUP-name', pin: undefined, tokens: Array.from({ length: 10 }, (_unused, i) => ({ token: `t${i}` })) }),
      legacyUser(n++, { ...base, role: 'E', userName: 'dup-NAME', tokens: [{ token: 'a' }, 'Bearer mixed'] }),
    );
    // Company codes duplicated across groups and inside one group; place plans and device types.
    scope(first).companies.push(legacyCompany(2000, first, { code: 'SHARED' }));
    scope(second).companies.push(legacyCompany(2001, second, { code: 'SHARED' }), legacyCompany(2002, second, { code: 'TWICE' }), legacyCompany(2003, second, { code: 'TWICE' }));
    PLACE_PLANS.forEach((plan, index) => {
      scope(first).places.push(
        legacyPlace(2000 + index, first, ids(first).companyId, {
          plan,
          devices: DEVICE_TYPES.slice(index, index + 3).map((type) => ({ type })),
        }),
      );
    });
    // One group without database, two databases without group.
    groups.push(legacyGroup(2000, { type: null, plan: null }));
    for (const number of [2001, 2002]) {
      const orphan = fixtureId('group', number);
      perGroup.set(orphan.toHexString(), { companies: [legacyCompany(2010 + number, orphan)], places: [legacyPlace(2010 + number, orphan, fixtureId('company', 2010 + number))] });
    }
  }

  const common = databases.common();
  const insert = async (db: ReturnType<Databases['common']>, name: string, documents: Document[]): Promise<void> => {
    if (documents.length === 0) {
      return;
    }
    // `undefined` would be stored as null: drop it so that "missing" really is missing.
    const clean = (document: Document): Document => Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined));
    await db.collection(name).insertMany(documents.map((document) => clean(transform(name, document))));
  };
  await insert(common, 'users', users);
  await insert(common, 'groups', groups);
  await insert(common, 'countries', [legacyCountry(1), legacyCountry(2)]);
  // As in production: users has only _id_ and a unique userName_1.
  await common.collection('users').createIndex({ userName: 1 }, { name: 'userName_1', unique: true });
  if (options.extraIndexes === true) {
    await common.collection('users').createIndex({ avatar: 1 }, { name: 'avatar_unique', unique: true, sparse: true });
    await common.collection('countries').createIndex({ insertDate: 1 }, { name: 'insertDate_ttl', expireAfterSeconds: 3600 });
  }
  for (const [hex, { companies, places }] of perGroup) {
    const db = databases.group(ObjectId.createFromHexString(hex));
    await insert(db, 'companies', companies);
    await insert(db, 'places', places);
    if (options.extraIndexes === true && companies.length > 0) {
      await db.collection('companies').createIndex({ code: 1 }, { name: 'code_partial', partialFilterExpression: { trash: false } });
    }
    if (options.extraIndexes === true && places.length > 0) {
      await db.collection('places').createIndex({ groupId: 1, companyId: 1 }, { name: 'group_company' });
    }
  }
  return { groupIds, dealerId, encryptionKey };
}
