import { FEATURES } from '../modules/groups/features.ts';
import { COMPANY_BLOCK_PATHS, COMPANY_WHOLE_KEYS } from '../shared/legacy-write/company-paths.ts';
import { PROVIDERS } from '../modules/groups/group.types.ts';
import { LEGACY_MODULES, READ_ONLY_MODULE } from '../shared/security/rbac/permission-matrix.ts';
import { POS_OWNED_FIELDS, POS_PRICE_LISTS_PATH } from '../modules/users/pos.catalog.ts';
import { SHIFT_SPECIAL_PATH, SHIFT_TIME_OWNED_FIELDS } from '../modules/users/shift-time.ts';
import { ACTIVITY_EVENTS_INDEXES } from './activity-events-schema.ts';
import { DEALERS_INDEXES, DEALERS_VALIDATOR } from './dealers-schema.ts';
import { SESSIONS_INDEXES, SESSIONS_VALIDATOR } from './sessions-schema.ts';
import { USER_CREDENTIALS_VALIDATOR } from './user-credentials-schema.ts';
import { COMPANIES_MIRROR_INDEXES, PLACES_MIRROR_INDEXES, SYNC_ISSUES_INDEXES } from './mirror-schema.ts';

/**
 * Who owns a collection and may therefore shape its documents and indexes.
 *
 * `mirror` marks the collections of the common database that hold exact copies of documents of the group databases
 * (`doc/Tasks.md` D-20): written only by the copy block, with `replaceOne` of the whole document. They admit
 * non-unique indexes only, no validator and no TTL, so a copy can never be refused or expire.
 */
export type Ownership = 'new' | 'legacy-read' | 'legacy-write' | 'mirror';

/** Specification of an index, with an explicit name. */
export interface IndexSpec {
  /** Explicit index name (never left to the server). */
  readonly name: string;
  /** Indexed fields with direction. */
  readonly key: Readonly<Record<string, 1 | -1>>;
  /** Unique constraint; forbidden on legacy collections. */
  readonly unique?: boolean;
  /** TTL in seconds; forbidden on legacy collections. */
  readonly expireAfterSeconds?: number;
  /** Partial index: only the documents that match this filter are indexed (a unique one then constrains only those). */
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
}

/** Registry entry of one collection. */
export interface CollectionSpec {
  /** `new`: ours. `legacy-read`: shared, read only. `legacy-write`: shared, only `ownedFields` are written. `mirror`: copies of group documents, common database only. */
  readonly ownership: Ownership;
  /** Fields this backend may write on a `legacy-write` collection (`$set`/`$unset` only). */
  readonly ownedFields?: readonly string[];
  /** Indexes to create at startup. */
  readonly indexes?: readonly IndexSpec[];
  /** Names of indexes this backend created in the past and replaced; dropped after the new ones exist (`new` collections only). */
  readonly obsoleteIndexes?: readonly string[];
  /** `$jsonSchema` applied at startup (strict, errors on violation); allowed only on `new` collections. */
  readonly validator?: Readonly<Record<string, unknown>>;
}

/** The two kinds of database. */
export type DatabaseKind = 'common' | 'group';

/** Registry shape: database kind, then collection name. */
export type CollectionRegistry = Readonly<Record<DatabaseKind, Readonly<Record<string, CollectionSpec>>>>;

/**
 * Fields of the shared legacy `users` documents this backend may write (`$set`/`$unset` only): profile
 * (`description`, `avatar`, `pin`, `servicesId` included), status, scope, `permissions.<module>.r|w` of every module of the
 * legacy matrix (`logs` has only `r`), `permissions.status`, the POS values `permissions.apps.cash.*` one by one, the shifts
 * (`shiftTime.status|weeksGeneric|daySpecial`) and, for the legacy coexistence, `password`, `tokens` and `userName`. The
 * containers (`permissions`, `permissions.apps`, `shiftTime`…) are never replaced as a whole, so the keys the backend does
 * not manage (`sub.productsStatus`, `options.service`, `permissions.hiddenInStats`…) stay.
 */
export const USERS_OWNED_FIELDS: readonly string[] = Object.freeze([
  'name',
  'surname',
  'email',
  'telephone',
  'settings.language',
  'settings.hiddenInStats',
  'status',
  'trash',
  'role',
  'groupId',
  'dealerId',
  'companyId',
  'placeId',
  'placesId',
  'description',
  'avatar',
  'pin',
  'servicesId',
  ...LEGACY_MODULES.flatMap((module) => (module === READ_ONLY_MODULE ? [`permissions.${module}.r`] : [`permissions.${module}.r`, `permissions.${module}.w`])),
  'permissions.status',
  ...POS_OWNED_FIELDS,
  ...SHIFT_TIME_OWNED_FIELDS,
  'password',
  'tokens',
  'userName',
  'insertDate',
  'updateDate',
]);

/**
 * The maps of the `users` documents whose keys are made at run time (price list ids, dates): the backend owns every path
 * below them, so a new document can carry them.
 */
export const USERS_OWNED_TREES: readonly string[] = Object.freeze([POS_PRICE_LISTS_PATH, SHIFT_SPECIAL_PATH]);

/**
 * The catalogs of the `groups` documents the backend owns as a whole: every path below one of them (`priceLists.<id>.name`,
 * `fidelity.cardsTypes`…) may be written, because the keys of the maps are ids made at run time.
 */
export const GROUPS_OWNED_CATALOGS: readonly string[] = Object.freeze([
  'priceLists',
  'taxes',
  'currencies',
  'measureUnits',
  'warehouseRules',
  'fidelityCardRules',
  'fidelity.cardsTypes',
  'fidelity.pointsCollections',
  'fidelity.prizeCatalogues',
  'productsFavorites',
  'promotions',
]);

/**
 * Fields of the shared legacy `groups` documents this backend may write (`$set`/`$unset` only): name, description,
 * the state flags (`demo`, `status`, `trash`), the feature flags, the languages, the statistics settings, the
 * enabled state and the key (set only, never read back) of each integration, the catalogs of {@link GROUPS_OWNED_CATALOGS} and
 * `updateDate`. Everything else (`apiKey`, `databaseHost`, `filesHost`, `type`, `plan`, `expirationDate`, `places`) belongs to the legacy.
 * The management of the group (and its catalogs) writes only these: the registry adds {@link GROUPS_PLACES_FIELD} for the write service of places.
 */
export const GROUPS_OWNED_FIELDS: readonly string[] = Object.freeze([
  'name',
  'description',
  'demo',
  'status',
  'trash',
  ...FEATURES.map((feature) => `settings.${feature}`),
  'settings.languages',
  'settings.stats.openingTime',
  'settings.stats.compressProductsCategories',
  'settings.stats.timeSlots',
  ...PROVIDERS.flatMap((provider) => [`settings.integrations.${provider}.status`, `settings.integrations.${provider}.apiKey`]),
  ...GROUPS_OWNED_CATALOGS,
  'updateDate',
]);

/**
 * The list `[{ _id, insertDate }]` of the places of the group in the `groups` document, which the write service of companies and places
 * recalculates in full on every write of a place (`doc/Tasks.md` 5.6.2). It is registered as owned, but it is not in {@link GROUPS_OWNED_FIELDS}:
 * the management of the group and its catalogs can never write it.
 */
export const GROUPS_PLACES_FIELD = 'places';

/**
 * Fields of the legacy `companies` documents of a group database this backend may `$set` (`doc/Tasks.md` 5.6.3, area 6 and the legacy
 * analysis of the company): the registry data and the state of the company, and every key of its blocks as a **leaf dotted path**
 * (`fattura_elettronica.<16 keys>`, `settings.global.<5 keys>`, `settings.api.cerved`, `settings.ecommerce.<27 keys>`, `medias.images.<4 keys>`) or a
 * whole array (`banks`, `ticketsSuppliers`, `invoicesPSValues`) or value (`invoicesPS`). The blocks themselves (`settings`, `fattura_elettronica`,
 * `medias`) are never written whole, so the keys the legacy or a later release adds to them survive every write. `trash` is written by trash and
 * restore only; `updateDate` by every write.
 */
export const COMPANIES_OWNED_FIELDS: readonly string[] = Object.freeze([
  'name',
  'code',
  'code2',
  'address',
  'postcode',
  'city',
  'countryAreaCode',
  'countryCode',
  'currencyCode',
  'email',
  'telephone',
  'status',
  'trash',
  'expirationDate',
  ...COMPANY_WHOLE_KEYS,
  ...COMPANY_BLOCK_PATHS,
  'updateDate',
]);

/**
 * Fields of the legacy `places` documents of a group database this backend may `$set`: the registry data of the place and its state
 * (`doc/Tasks.md` 5.6.3 and the legacy analysis §3.2). `devices`, `rooms`, `storages`, `printStations`, `productionCenter`, the
 * configuration blocks (`general`, `receipt`, `ordering`, `roomsSettings`, `openingTime`…), `integrations` and every unknown key are
 * never written: the POS and the legacy replace them whole, so writing them from here would corrupt them. `plan` is not included
 * (only PSA may set it in the legacy: left out until a route needs it). `trash` is written by trash and restore only.
 */
export const PLACES_OWNED_FIELDS: readonly string[] = Object.freeze([
  'name',
  'address',
  'postcode',
  'city',
  'countryAreaCode',
  'countryCode',
  'contact',
  'email',
  'telephone',
  'companyId',
  'listId',
  'ecommerceListId',
  'invoicePS',
  'timezone',
  'status',
  'trash',
  'expirationDate',
  'updateDate',
]);

/**
 * Fields of the legacy `files` documents of a group database (the images of the media manager) this backend writes (`doc/Tasks.md` area 6, step 6B): only whole
 * new documents, inserted by the image upload (`createdBy` and `companyId` are keys of this backend, additive: the legacy ignores them); no field of an existing document is ever changed from here (editing, trash and deletion of files come with the media
 * domain). There is no copy of this collection in the common database (D-20 covers companies and places only). The legacy creates no index on it and neither does this backend.
 */
export const FILES_OWNED_FIELDS: readonly string[] = Object.freeze([
  'groupId',
  'basename',
  'name',
  'extension',
  'dirname',
  'type',
  'mimetype',
  'filectime',
  'alt',
  'title',
  'trash',
  'insertDate',
  'updateDate',
  'createdBy',
  'companyId',
]);

/**
 * Fields of the `reserve_with_google` documents of the common database (the feed of Reserve with Google, read by the legacy
 * integration service) this backend may `$set`: the whole record, written only when a place is restored with the integration
 * active and complete. The record is removed (`deleteOne` on `{ groupId, placeId }`) when the place is trashed or deleted.
 */
export const RESERVE_WITH_GOOGLE_OWNED_FIELDS: readonly string[] = Object.freeze([
  'groupId',
  'companyId',
  'placeId',
  'category',
  'name',
  'telephone',
  'url',
  'geo.latitude',
  'geo.longitude',
  'geo.address.streetAddress',
  'geo.address.locality',
  'geo.address.postalCode',
  'geo.address.country',
]);

/**
 * Ownership registry of every collection the backend touches (`doc/Tasks.md` 0.1 and 0.2).
 * A new collection must be registered here before any code can use it.
 */
export const COLLECTIONS = {
  common: {
    users: {
      ownership: 'legacy-write',
      ownedFields: USERS_OWNED_FIELDS,
      // Non-unique only (approved in doc/Tasks.md 3.1.6); the unique `userName_1` is the legacy's.
      indexes: [
        { name: 'groupId_1_role_1', key: { groupId: 1, role: 1 } },
        { name: 'dealerId_1', key: { dealerId: 1 } },
      ],
    },
    groups: { ownership: 'legacy-write', ownedFields: [...GROUPS_OWNED_FIELDS, GROUPS_PLACES_FIELD] },
    countries: { ownership: 'legacy-read' },
    // The Reserve with Google feed of the places: only the write service of places touches it (restore: upsert; trash and delete: deleteOne).
    reserve_with_google: { ownership: 'legacy-write', ownedFields: RESERVE_WITH_GOOGLE_OWNED_FIELDS },
    rateLimits: { ownership: 'new', indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 }] },
    activityEvents: { ownership: 'new', indexes: ACTIVITY_EVENTS_INDEXES },
    dealers: { ownership: 'new', indexes: DEALERS_INDEXES, validator: DEALERS_VALIDATOR },
    // Exact copies of the documents of the group databases (D-20), without validator (no collMod dependency).
    companies: { ownership: 'mirror', indexes: COMPANIES_MIRROR_INDEXES },
    places: { ownership: 'mirror', indexes: PLACES_MIRROR_INDEXES },
    // Discrepancies found by the reconciliation; no validator, ids only (no personal data), TTL of 180 days.
    syncIssues: { ownership: 'new', indexes: SYNC_ISSUES_INDEXES },
    userCredentials: { ownership: 'new', validator: USER_CREDENTIALS_VALIDATOR },
    sessions: { ownership: 'new', indexes: SESSIONS_INDEXES, validator: SESSIONS_VALIDATOR },
  },
  group: {
    // Written only by the write service of companies and places (`shared/legacy-write`, `$set` of the owned fields, plus insert and delete of
    // whole documents, decided in `doc/Tasks.md` 5.6) in a transaction with the copy in the common database; read by the tools (sync:copies,
    // profile:legacy). The application reads companies and places from the copies in the common database.
    companies: { ownership: 'legacy-write', ownedFields: COMPANIES_OWNED_FIELDS },
    places: { ownership: 'legacy-write', ownedFields: PLACES_OWNED_FIELDS },
    // The images of the media manager: the upload inserts whole documents (`FILES_OWNED_FIELDS`), the lists read them; the objects live in the storage bucket.
    files: { ownership: 'legacy-write', ownedFields: FILES_OWNED_FIELDS },
    // Read only, to check that the ids a catalog of the group refers to exist.
    products: { ownership: 'legacy-read' },
    products_categories: { ownership: 'legacy-read' },
    contacts: { ownership: 'legacy-read' },
    contacts_groups: { ownership: 'legacy-read' },
  },
} as const satisfies CollectionRegistry;

/**
 * Checks a registry against the coexistence rules.
 *
 * - `legacy-write` needs a non-empty `ownedFields`; the other kinds must not declare it.
 * - Legacy collections cannot have unique or TTL indexes.
 * - Every index has a non-empty explicit name.
 * - Only `new` collections can have a validator.
 * - `mirror` collections live in the common database only, take no `ownedFields`, no validator, and only non-unique,
 *   non-TTL indexes: a copy must always be writable and never expire.
 *
 * @param registry Registry to validate (the real one by default).
 * @throws {Error} Listing every violation, as `<database>.<collection>: <reason>`.
 */
export function validateRegistry(registry: CollectionRegistry = COLLECTIONS): void {
  const problems: string[] = [];
  for (const kind of ['common', 'group'] as const) {
    for (const [name, spec] of Object.entries(registry[kind])) {
      const where = `${kind}.${name}`;
      const owned = spec.ownedFields;
      if (spec.ownership === 'legacy-write') {
        if (owned === undefined || owned.length === 0) {
          problems.push(`${where}: legacy-write requires a non-empty ownedFields`);
        }
      } else if (owned !== undefined) {
        problems.push(`${where}: ownedFields is allowed only on legacy-write`);
      }
      if (spec.ownership === 'mirror' && kind !== 'common') {
        problems.push(`${where}: a mirror collection must live in the common database`);
      }
      if (spec.validator !== undefined && spec.ownership !== 'new') {
        problems.push(
          spec.ownership === 'mirror' ? `${where}: a mirror collection takes no validator` : `${where}: a validator is allowed only on new collections`,
        );
      }
      for (const index of spec.indexes ?? []) {
        if (index.name.trim() === '') {
          problems.push(`${where}: every index needs an explicit name`);
        }
        if (spec.ownership !== 'new' && (index.unique === true || index.expireAfterSeconds !== undefined)) {
          problems.push(
            spec.ownership === 'mirror'
              ? `${where}: unique and TTL indexes are forbidden on mirror collections (${index.name})`
              : `${where}: unique and TTL indexes are forbidden on legacy collections (${index.name})`,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid collection registry:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
}

/**
 * All registered collection names, for every database kind.
 *
 * @param registry Registry to read (the real one by default).
 * @returns Names without duplicates.
 */
export function registeredCollectionNames(registry: CollectionRegistry = COLLECTIONS): ReadonlySet<string> {
  return new Set([...Object.keys(registry.common), ...Object.keys(registry.group)]);
}
