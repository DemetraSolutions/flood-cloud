import { FEATURES } from '../modules/groups/features.ts';
import { COMPANY_BLOCK_PATHS, COMPANY_WHOLE_KEYS } from '../shared/legacy-write/company-paths.ts';
import { PLACE_BLOCK_PATHS, PLACE_TOP_KEYS } from '../shared/legacy-write/place-paths.ts';
import { PROVIDERS } from '../modules/groups/group.types.ts';
import { LEGACY_MODULES, READ_ONLY_MODULE } from '../shared/security/rbac/permission-matrix.ts';
import { POS_OWNED_FIELDS, POS_PRICE_LISTS_PATH } from '../modules/users/pos.catalog.ts';
import { SHIFT_SPECIAL_PATH, SHIFT_TIME_OWNED_FIELDS } from '../modules/users/shift-time.ts';
import { API_KEYS_INDEXES, API_USAGE_INDEXES } from './api-keys-schema.ts';
import { ACTIVITY_EVENTS_INDEXES } from './activity-events-schema.ts';
import { BILLING_CLOSURES_INDEXES } from './billing-closures-schema.ts';
import { DEALERS_INDEXES } from './dealers-schema.ts';
import { SETTINGS_INDEXES } from './settings-schema.ts';
import { SESSIONS_INDEXES } from './sessions-schema.ts';
import { STORE_ACTIVATION_CODES_INDEXES, STORE_KEYS_INDEXES } from './store-keys-schema.ts';
import { COMPANIES_MIRROR_INDEXES, PLACES_MIRROR_INDEXES, SYNC_ISSUES_INDEXES } from './mirror-schema.ts';

/**
 * Who owns a collection and may therefore shape its documents and indexes.
 *
 * `mirror` marks the collections of the common database that hold exact copies of documents of the group databases
 * (`doc/Tasks.md` D-20): written only by the copy block, with `replaceOne` of the whole document. They admit
 * non-unique indexes only and no TTL, so a copy can never be refused or expire.
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
}

/** The kinds of database that hold the data of this backend (the common database and the group databases). */
export type DatabaseKind = 'common' | 'group';

/**
 * Registry shape: database kind, then collection name. `queue` is the legacy send queue database (read only, never indexed):
 * optional, because only the real registry declares it.
 */
export type CollectionRegistry = Readonly<Record<DatabaseKind, Readonly<Record<string, CollectionSpec>>>> & { readonly queue?: Readonly<Record<string, CollectionSpec>> };

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
  'settings.theme',
  'settings.hiddenInStats',
  'status',
  'trash',
  'trashDate',
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
 * The leaves of the top-level `publicApi` field of a `groups` document (the switch of the public API and the default limits of the keys of the group, step 9A): written only by the PSA, one leaf at
 * a time. It is a top-level key of its own, not part of `settings`, because the legacy update of a group writes `settings` as a whole and would erase it; it writes only named top-level keys, so this one survives.
 */
export const GROUPS_PUBLIC_API_FIELDS: readonly string[] = Object.freeze(['publicApi.enabled', 'publicApi.defaultRateLimitPerMinute', 'publicApi.defaultDailyQuota', 'publicApi.groupRateLimitPerMinute', 'publicApi.groupDailyQuota']);

/**
 * Fields of the shared legacy `groups` documents this backend may write (`$set`/`$unset` only): name, description,
 * the state flags (`demo`, `status`, `trash`, and `trashDate`, the informational date of the trash), the feature flags, the languages, the statistics settings, the
 * enabled state and the key (set only, never read back) of each integration, the catalogs of {@link GROUPS_OWNED_CATALOGS}, the leaves of {@link GROUPS_PUBLIC_API_FIELDS} and
 * `updateDate`. Everything else (`apiKey`, `databaseHost`, `filesHost`, `type`, `plan`, `expirationDate`, `places`) belongs to the legacy.
 * The management of the group (and its catalogs) writes only these: the registry adds {@link GROUPS_PLACES_FIELD} for the write service of places.
 */
export const GROUPS_OWNED_FIELDS: readonly string[] = Object.freeze([
  'name',
  'description',
  'demo',
  'status',
  'trash',
  'trashDate',
  ...FEATURES.map((feature) => `settings.${feature}`),
  'settings.languages',
  'settings.stats.openingTime',
  'settings.stats.compressProductsCategories',
  'settings.stats.timeSlots',
  ...PROVIDERS.flatMap((provider) => [`settings.integrations.${provider}.status`, `settings.integrations.${provider}.apiKey`]),
  ...GROUPS_OWNED_CATALOGS,
  ...GROUPS_PUBLIC_API_FIELDS,
  'updateDate',
]);

/**
 * The fields of a `groups` document that are written only when the whole document of a new customer is inserted (area 8, `POST /v1/groups`) and never changed by a `$set`: they are not in
 * {@link GROUPS_OWNED_FIELDS}. `apiKey` is the key of the group that the legacy POS and integrations use: it is generated by the server, written once, and no code ever sets, reads or returns it.
 * The other fields of the new document (the catalogs, the features, `name`…) are owned fields written whole by the same insertion.
 */
export const GROUPS_INSERT_ONLY_FIELDS: readonly string[] = Object.freeze(['apiKey', 'databaseHost', 'filesHost', 'type', 'expirationDate', 'insertDate', 'places']);

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
 * `medias`) are never written whole, so the keys the legacy or a later release adds to them survive every write. `trash` and `trashDate` are written by trash and
 * restore only (`trashDate` is set when the company goes to the trash and removed when it comes back); `updateDate` by every write.
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
  'trashDate',
  'expirationDate',
  ...COMPANY_WHOLE_KEYS,
  ...COMPANY_BLOCK_PATHS,
  'updateDate',
]);

/**
 * Fields of the legacy `places` documents of a group database this backend may `$set` (`doc/Tasks.md` 5.6.3 and area 7, steps 7A, 7B and 7F): the registry data, the license
 * (`plan`, `expirationDate`, `status`) and the state of the place, the timezone, and the leaf paths listed in `PLACE_BLOCK_PATHS`: `general.priceLists`, the hours, the settings of the
 * tabs (7B), `integrations.*` key by key (credentials included, write-only), the dealer settings (`platform.sentry`, `server.ip`, `connectorAddress`) and the five lists of items
 * (`devices`, `printStations`, `productionCenter`, `rooms`, `storages`). A list is written as a whole array but item by item over the stored items inside the transaction (`mergeList`),
 * and only if every stored item has a distinct id, so what the POS writes in an item (`devices[i].info|status`, `rooms[].view.subtables`) and every key of an item the backend does not own survive.
 * The blocks themselves (`general`, `openingTime`, `delivery`, `platform`, `server`, `integrations`) are never written whole, and every unknown key is never written.
 * `trash` and `trashDate` are written by trash and restore only.
 */
export const PLACES_OWNED_FIELDS: readonly string[] = Object.freeze([...PLACE_TOP_KEYS, 'trash', 'trashDate', ...PLACE_BLOCK_PATHS, 'updateDate']);

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
 * Fields of the legacy `email_templates` documents of a group database (the e-mail templates of the group: the legacy writes `name`, `text`, `html`, `insertDate` and `updateDate`, and
 * nothing else; there is no `trash`) this backend writes: whole new documents inserted by the template routes, and `$set` of `name`, `text`, `html` and `updateDate`. There is no copy in the
 * common database, no `groupId` and no index (the legacy creates none and neither does this backend).
 */
export const EMAIL_TEMPLATES_OWNED_FIELDS: readonly string[] = Object.freeze(['name', 'text', 'html', 'insertDate', 'updateDate']);

/**
 * Fields of the legacy `products_departments` documents of a group database (the departments the POS reads with the tax of each) this backend writes: whole new documents inserted by the onboarding
 * of a customer, one per tax rate (`doc/Tasks.md` area 8), and by `POST /v1/groups/{groupId}/product-departments` (step C1), and `$set`/`$unset` of the fields below from the department routes and from
 * the realignment of the tax copy when a tax rate of the group changes. `medias` is written only below `medias.images.main` (the image chosen from the library). `groupId` and `trash` are keys of the
 * onboarding, additive: the legacy ignores them, and the department routes never write them. The legacy creates no index on the collection and neither does this backend.
 */
export const PRODUCTS_DEPARTMENTS_OWNED_FIELDS: readonly string[] = Object.freeze([
  'groupId',
  'code',
  'tax',
  'name',
  'description',
  'noDiscount',
  'secondaryFiscalPrinter',
  'medias',
  'placesAvailability',
  'status',
  'trash',
  'insertDate',
  'updateDate',
]);

/**
 * Fields of the legacy `products_brands` documents of a group database (step C1) this backend writes: whole new documents inserted by `POST /v1/groups/{groupId}/product-brands`, and `$set`/`$unset`
 * of the fields below from the brand routes. `medias` is written only below `medias.images.main`. No field of a brand is ever written by anything else, and the collection has no index.
 */
export const PRODUCTS_BRANDS_OWNED_FIELDS: readonly string[] = Object.freeze(['name', 'description', 'placesAvailability', 'medias', 'status', 'insertDate', 'updateDate']);

/**
 * Fields of the legacy `products_attributes` documents of a group database, the groups of attributes (step C1), this backend writes: whole new documents inserted by
 * `POST /v1/groups/{groupId}/product-attribute-groups`, and `$set` of the fields below from the attribute group routes. The attributes are the elements of `attributes`, replaced as a whole.
 * The collection has no index.
 */
export const PRODUCTS_ATTRIBUTES_OWNED_FIELDS: readonly string[] = Object.freeze(['name', 'attributes', 'insertDate', 'updateDate']);

/**
 * The maps of the legacy `products_categories` documents whose keys are made at run time (`printStations.__<placeId>`, `printStationsNoRooms.__<placeId>`, a list of print station ids for each
 * place): the backend owns every path below them, so a write may set or unset the entry of one place and nothing else of the map.
 */
export const PRODUCTS_CATEGORIES_OWNED_TREES: readonly string[] = Object.freeze(['printStations', 'printStationsNoRooms']);

/**
 * Fields of the legacy `products_categories` documents of a group database, the product categories (step C2), this backend writes: whole new documents inserted by
 * `POST /v1/groups/{groupId}/product-categories` in the shape the legacy writes, and `$set`/`$unset` of the fields below from the category routes. The containers `availability`,
 * `integrations`, `roomsSettings` and `tgm` are owned leaf by leaf (`integrations.easyappear` is written, as `false`, only in a new document: the key `easyAppear` some documents have and any other
 * key the legacy or a later release adds stay untouched), `medias` is written only at `medias.images.main|icon|internalFileName|externalUrl` (or, when it is missing or has no `images`, as the smallest container that holds the
 * path: `medias.images` or `medias`, which is why those two are listed), and only the {@link PRODUCTS_CATEGORIES_OWNED_TREES} are owned with everything below them: every other field is owned by exact equality. `trash`, which 22 real documents have and nothing reads, is never read nor written. No index.
 */
export const PRODUCTS_CATEGORIES_OWNED_FIELDS: readonly string[] = Object.freeze([
  'parentId',
  'name',
  'description',
  'position',
  'productionValue',
  'availability.pos',
  'availability.ecommerce',
  'noDiscount',
  'requiresGreaterAge',
  'secondaryFiscalPrinter',
  'featured',
  'backgroundColor',
  'textColor',
  'integrations.floodOrders',
  'integrations.easyappear',
  'integrations.yellgo',
  'integrations.leggimenu',
  'roomsSettings.endMeal',
  'roomsSettings.handheldHidden',
  'roomsSettings.percentageFee',
  'roomsSettings.printGroup',
  'roomsSettings.alwaysFirstExit',
  'roomsSettings.notAffiliatedMenu',
  'roomsSettings.type',
  'tgm.type',
  'medias',
  'medias.images',
  'medias.images.main',
  'medias.images.icon',
  'medias.images.internalFileName',
  'medias.images.externalUrl',
  'placesAvailability',
  'variants',
  'variantsCategories',
  ...PRODUCTS_CATEGORIES_OWNED_TREES,
  'status',
  'insertDate',
  'updateDate',
]);

/**
 * The maps of the legacy `products` documents whose keys are made at run time (`printStations.__<placeId>`, `printStationsNoRooms.__<placeId>`, a list of print station ids for each place): the
 * backend owns every path below them, so a write may set or unset the entry of one place and nothing else of the map.
 */
export const PRODUCTS_OWNED_TREES: readonly string[] = Object.freeze(['printStations', 'printStationsNoRooms']);

/**
 * The only leaves of the stock of a product (`quantity.__<placeId>.__<storageId>.<leaf>`) the catalog writes: the minimum, the maximum and the location. The quantity itself (`value`) belongs to the
 * warehouse, which moves it with `$inc`, and is never written from here.
 */
export const PRODUCTS_STOCK_LEAVES: readonly string[] = Object.freeze(['min', 'max', 'location']);

/**
 * Keys of a legacy `products` document that a new document has and a modification never writes (`quantity` is the empty stock of a new document, of which a modification writes only the {@link PRODUCTS_STOCK_LEAVES} leaves; `lastAveragePrice` is the zeroed cost the legacy writes in an insert and the warehouse then maintains;
 * `tags`, `related` and `parentId` are always empty and nothing reads them; `integrations.easyappear` is written as `false` and never touched again). Apart from `quantity` and `lastAveragePrice`, which are shown but never written as a whole, they are never read, and none of them is part of the
 * version of a product.
 */
export const PRODUCTS_INSERT_ONLY_FIELDS: readonly string[] = Object.freeze(['quantity', 'lastAveragePrice', 'tags', 'related', 'parentId', 'integrations.easyappear']);

/**
 * Fields of the legacy `products` documents of a group database (step C3) this backend writes: whole new documents inserted by `POST /v1/groups/{groupId}/products` in the shape the legacy writes, and
 * `$set`/`$unset` of the fields below from the product routes and, for the prices, from the realignment of the tax copy when a tax rate of the group changes (a pipeline update of `prices` and
 * `updateDate`). The containers (`availability`, `variant`, `modularBundle`, `colors.pos`, `shippingInfo`, `roomsSettings`, `integrations`) are owned leaf by leaf, `medias` below
 * `medias.images` (the two containers are listed for a document that has neither), the {@link PRODUCTS_OWNED_TREES} are owned with everything below them, and `quantity` only at the
 * {@link PRODUCTS_STOCK_LEAVES} of a storage of a place: the warehouse owns the quantities and the cost, and no write of the catalog reaches them. The keys of {@link PRODUCTS_INSERT_ONLY_FIELDS} are written in
 * a new document only. Every key a document has that is not listed (the unknown ones of the POS and of the integrations) stays untouched. No index.
 */
export const PRODUCTS_OWNED_FIELDS: readonly string[] = Object.freeze([
  'type',
  'time',
  'max',
  'code',
  'barcode',
  'brandId',
  'name',
  'shortName',
  'description',
  'shortDescription',
  'favorite',
  'favoriteHandheld',
  'generic',
  'toCheck',
  'noDiscount',
  ...PRODUCTS_OWNED_TREES,
  'availability.pos',
  'availability.warehouse',
  'availability.scales',
  'availability.ecommerce',
  'plu',
  'scaleType',
  'variant.status',
  'variant.type',
  'variant.pricePercentagePlus',
  'variant.pricePercentageMinus',
  'variant.description',
  'variantsRequired',
  'variants',
  'variantsExcluded',
  'variantsCategories',
  'bundleProducts',
  'selectableBundleProducts',
  'selectableVariantsBundleProducts',
  'modularBundle.priceRule',
  'measureLoad',
  'measureDownload',
  'measureConversionRatio',
  'simpleCost',
  'colors.pos.text',
  'colors.pos.background',
  'startDate',
  'endDate',
  'categories',
  'placesAvailability',
  'medias',
  'medias.images',
  'medias.images.main',
  'medias.images.gallery',
  'medias.images.internalFileName',
  'medias.images.externalUrl',
  'shippingInfo.width',
  'shippingInfo.height',
  'shippingInfo.depth',
  'shippingInfo.weight',
  'attributes',
  'suppliers',
  'prices',
  'position',
  'productionValue',
  'roomsSettings.halfPortion',
  'roomsSettings.percentageFee',
  'roomsSettings.handheldHidden',
  'roomsSettings.affiliatedMenu',
  'roomsSettings.reversePrint',
  'integrations.floodOrders',
  'integrations.yellgo',
  'integrations.leggimenu',
  'featured',
  'status',
  'trash',
  'trashDate',
  'insertDate',
  'updateDate',
  ...PRODUCTS_INSERT_ONLY_FIELDS,
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
 * Fields of the legacy `tobaccos` documents of the common database (the national tobacco price list: the legacy replaces the whole collection with the official file, and its catalog synchronization
 * reads it) this backend writes (`doc/Tasks.md` 9-bis, step T3): only whole new documents, inserted by the import of the list inside the transaction that deletes the previous ones; no field of an
 * existing document is ever changed. The names are the legacy's, and the documents carry nothing else. The legacy creates no index on the collection; this backend adds non-unique ones for the search and the sort.
 */
export const TOBACCOS_OWNED_FIELDS: readonly string[] = Object.freeze(['category', 'code', 'name', 'shortName', 'priceKg', 'price', 'unitWeight', 'numPieces', 'description', 'barcodes']);

/**
 * Fields of the legacy `countries` documents of the common database (the countries and, in `areas`, their provinces: the legacy POS downloads the whole list and looks a country up by `code`) this backend
 * writes (`doc/Tasks.md` 9-ter): whole new documents inserted by `POST /v1/countries` in the legacy shape (`areas: []`, `insertDate`, `updateDate: null`), and `$set`/`$push`/`$pull` of `name`, `areas` and `updateDate`.
 * The `code` of a country or of an area is never changed once written. Every other key of a country or of an area is the legacy's and is never touched. There is no unique index on `code` yet (the count in production has not been done):
 * the writes enforce the uniqueness.
 */
export const COUNTRIES_OWNED_FIELDS: readonly string[] = Object.freeze(['code', 'name', 'areas', 'insertDate', 'updateDate']);

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
    // The countries and their provinces (step 9-ter): read by everybody, written by the PSA; no unique index until the count of duplicates in production is done.
    countries: { ownership: 'legacy-write', ownedFields: COUNTRIES_OWNED_FIELDS },
    // The Reserve with Google feed of the places: only the write service of places touches it (restore: upsert; trash and delete: deleteOne).
    reserve_with_google: { ownership: 'legacy-write', ownedFields: RESERVE_WITH_GOOGLE_OWNED_FIELDS },
    // The keys of the idempotent creations (`Idempotency-Key`): unique per user, route and key; a finished response is kept 24 hours.
    idempotencyKeys: {
      ownership: 'new',
      indexes: [
        { name: 'principal_1_route_1_key_1', key: { principal: 1, route: 1, key: 1 }, unique: true },
        { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ],
    },
    rateLimits: { ownership: 'new', indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 }] },
    activityEvents: { ownership: 'new', indexes: ACTIVITY_EVENTS_INDEXES },
    dealers: { ownership: 'new', indexes: DEALERS_INDEXES },
    // The settings of the platform, one document per key (now only the price list of the activations), and the closures of the billing of the dealers (frozen renewal bases and invoice months). Ours alone.
    settings: { ownership: 'new', indexes: SETTINGS_INDEXES },
    billingClosures: { ownership: 'new', indexes: BILLING_CLOSURES_INDEXES },
    // Exact copies of the documents of the group databases (D-20).
    companies: { ownership: 'mirror', indexes: COMPANIES_MIRROR_INDEXES },
    places: { ownership: 'mirror', indexes: PLACES_MIRROR_INDEXES },
    // Discrepancies found by the reconciliation; ids only (no personal data), TTL of 180 days.
    syncIssues: { ownership: 'new', indexes: SYNC_ISSUES_INDEXES },
    userCredentials: { ownership: 'new' },
    sessions: { ownership: 'new', indexes: SESSIONS_INDEXES },
    // The server of a point of sale (D-24): the pending activation code of a place and its store keys, hashes only. Ours alone: the legacy knows nothing of them.
    storeActivationCodes: { ownership: 'new', indexes: STORE_ACTIVATION_CODES_INDEXES },
    storeKeys: { ownership: 'new', indexes: STORE_KEYS_INDEXES },
    // The public API keys of the groups (step 9A), hashes only, and the daily usage counters of each key and route. Ours alone: the legacy knows nothing of them.
    apiKeys: { ownership: 'new', indexes: API_KEYS_INDEXES },
    apiUsage: { ownership: 'new', indexes: API_USAGE_INDEXES },
    // The national tobacco price list (step T3): replaced as a whole by the import, read by the list; the legacy writes it too (same documents), so no unique index.
    tobaccos: {
      ownership: 'legacy-write',
      ownedFields: TOBACCOS_OWNED_FIELDS,
      indexes: [
        { name: 'name_1', key: { name: 1 } },
        { name: 'code_1', key: { code: 1 } },
      ],
    },
  },
  group: {
    // Written only by the write service of companies and places (`shared/legacy-write`, `$set` of the owned fields, plus insert and delete of
    // whole documents, decided in `doc/Tasks.md` 5.6) in a transaction with the copy in the common database; read by the tools (sync:copies,
    // profile:legacy). The application reads companies and places from the copies in the common database.
    companies: { ownership: 'legacy-write', ownedFields: COMPANIES_OWNED_FIELDS },
    places: { ownership: 'legacy-write', ownedFields: PLACES_OWNED_FIELDS },
    // The images of the media manager: the upload inserts whole documents (`FILES_OWNED_FIELDS`), the lists read them; the objects live in the storage bucket.
    files: { ownership: 'legacy-write', ownedFields: FILES_OWNED_FIELDS },
    // The departments of the group: those of a new customer (one per tax rate, inserted by the onboarding inside the transaction that creates the group) and the ones of the department routes (step C1).
    products_departments: { ownership: 'legacy-write', ownedFields: PRODUCTS_DEPARTMENTS_OWNED_FIELDS },
    // The e-mail templates of the group (step T2): created, changed and deleted by the template routes; also read to check the ids the reservations and the appointments of a place refer to.
    email_templates: { ownership: 'legacy-write', ownedFields: EMAIL_TEMPLATES_OWNED_FIELDS },
    // The products of the group (step C3): created, changed, trashed and deleted by the product routes; the prices also by the realignment of the tax copy; read to check what the catalogs refer to.
    products: { ownership: 'legacy-write', ownedFields: PRODUCTS_OWNED_FIELDS },
    // The product categories of the group (step C2): created, changed and deleted by the category routes; also read by the lookups, the catalogs and the catalog profile of the legacy tool.
    products_categories: { ownership: 'legacy-write', ownedFields: PRODUCTS_CATEGORIES_OWNED_FIELDS },
    // The brands and the groups of attributes of the catalog (step C1): created, changed and deleted by their routes; also read by the catalog profile of the legacy tool.
    products_brands: { ownership: 'legacy-write', ownedFields: PRODUCTS_BRANDS_OWNED_FIELDS },
    products_attributes: { ownership: 'legacy-write', ownedFields: PRODUCTS_ATTRIBUTES_OWNED_FIELDS },
    contacts: { ownership: 'legacy-read' },
    contacts_groups: { ownership: 'legacy-read' },
  },
  // The legacy send queue (`<prefix><env>_queue`, step 9-ter/3): written only by the legacy services and by its `CronEngine`; read here, only by the error documents repository, through `Databases.queue()`.
  // No index: this backend never creates anything in that database.
  queue: {
    documents: { ownership: 'legacy-read' },
  },
} as const satisfies CollectionRegistry;

/**
 * Checks a registry against the coexistence rules.
 *
 * - `legacy-write` needs a non-empty `ownedFields`; the other kinds must not declare it.
 * - Legacy collections cannot have unique or TTL indexes.
 * - Every index has a non-empty explicit name.
 * - The `queue` database (legacy send queue) holds `legacy-read` collections with no index.
 * - `mirror` collections live in the common database only, take no `ownedFields` and only non-unique,
 *   non-TTL indexes: a copy must always be writable and never expire.
 *
 * @param registry Registry to validate (the real one by default).
 * @throws {Error} Listing every violation, as `<database>.<collection>: <reason>`.
 */
export function validateRegistry(registry: CollectionRegistry = COLLECTIONS): void {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(registry.queue ?? {})) {
    if (spec.ownership !== 'legacy-read' || spec.indexes !== undefined) {
      problems.push(`queue.${name}: the legacy send queue is read only: legacy-read and no index`);
    }
  }
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
  return new Set([...Object.keys(registry.common), ...Object.keys(registry.group), ...Object.keys(registry.queue ?? {})]);
}
