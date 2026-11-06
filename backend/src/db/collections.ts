import { FEATURES } from '../modules/groups/features.ts';
import { PROVIDERS } from '../modules/groups/group.types.ts';
import { LEGACY_MODULES, READ_ONLY_MODULE } from '../shared/security/rbac/permission-matrix.ts';
import { POS_OWNED_FIELDS, POS_PRICE_LISTS_PATH } from '../modules/users/pos.catalog.ts';
import { SHIFT_SPECIAL_PATH, SHIFT_TIME_OWNED_FIELDS } from '../modules/users/shift-time.ts';
import { ACTIVITY_EVENTS_INDEXES } from './activity-events-schema.ts';
import { DEALERS_INDEXES, DEALERS_VALIDATOR } from './dealers-schema.ts';
import { SESSIONS_INDEXES, SESSIONS_VALIDATOR } from './sessions-schema.ts';
import { USER_CREDENTIALS_VALIDATOR } from './user-credentials-schema.ts';

/** Who owns a collection and may therefore shape its documents and indexes. */
export type Ownership = 'new' | 'legacy-read' | 'legacy-write';

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
  /** `new`: ours. `legacy-read`: shared, read only. `legacy-write`: shared, only `ownedFields` are written. */
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
    groups: { ownership: 'legacy-write', ownedFields: GROUPS_OWNED_FIELDS },
    countries: { ownership: 'legacy-read' },
    rateLimits: { ownership: 'new', indexes: [{ name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 }] },
    activityEvents: { ownership: 'new', indexes: ACTIVITY_EVENTS_INDEXES },
    dealers: { ownership: 'new', indexes: DEALERS_INDEXES, validator: DEALERS_VALIDATOR },
    userCredentials: { ownership: 'new', validator: USER_CREDENTIALS_VALIDATOR },
    sessions: { ownership: 'new', indexes: SESSIONS_INDEXES, validator: SESSIONS_VALIDATOR },
  },
  group: {
    companies: { ownership: 'legacy-read' },
    places: { ownership: 'legacy-read' },
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
      if (spec.validator !== undefined && spec.ownership !== 'new') {
        problems.push(`${where}: a validator is allowed only on new collections`);
      }
      for (const index of spec.indexes ?? []) {
        if (index.name.trim() === '') {
          problems.push(`${where}: every index needs an explicit name`);
        }
        if (spec.ownership !== 'new' && (index.unique === true || index.expireAfterSeconds !== undefined)) {
          problems.push(`${where}: unique and TTL indexes are forbidden on legacy collections (${index.name})`);
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
