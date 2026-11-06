import type { GroupCatalogName } from '../../../shared/activity-log/catalog.ts';
import type { Permission } from '../../../shared/security/rbac/permissions.ts';
import type { Schema } from '../../../shared/validation/schema.ts';
import { SAFE_ID, conflict, equal, invalid, isRecord, mergePatch, notFound } from './kit.ts';
import type { CatalogAnomaly, Raw } from './kit.ts';

/** The collections of the group database a catalog may refer to: ids are verified there (`places`, `products`, `products_categories`, `contacts`, `contacts_groups`). */
export type ReferenceCollection = 'places' | 'products' | 'categories' | 'contacts' | 'contactGroups';

/** Ids of one field of a request that must exist in a collection of the group database. */
export interface ReferenceCheck {
  /** Field of the request, for the error (`placeIds`); the error names the missing id as `<field>.<index><suffix>`. */
  readonly field: string;
  /** What follows the index in the name of the field, for a list of objects (`.productId`). */
  readonly suffix?: string;
  readonly collection: ReferenceCollection;
  readonly ids: readonly string[];
}

/** How a catalog is stored: a map keyed by the id of the element (`priceLists`), or an array of elements with an `id` (`taxes`). */
export type CatalogKind = 'map' | 'array';

/** The new value of a stored container, with the one it replaces. */
export interface ContainerChange {
  /** Stored path of the container, for example `priceLists` or `fidelity.cardsTypes`. */
  readonly path: string;
  readonly kind: CatalogKind;
  /** The value read (anything: it is only compared and used to find what changed). */
  readonly old: unknown;
  /** The whole new container, as stored. */
  readonly next: unknown;
}

/** The stored containers of the group, read in one query, and the generator of ids. */
export interface CatalogState {
  /** The stored value at a path (`undefined` when the group does not have it). */
  raw(path: string): unknown;
  /** A new element id. */
  newId(): string;
}

/** One stored element of a container: its id (the key of a map, the `id` of an array element; `null` when it has none) and what is stored. */
export interface Item {
  readonly id: string | null;
  readonly raw: unknown;
}

/** What a write does: the element before and after, the containers to write and the references to verify first. */
export interface Outcome<E> {
  readonly before: E | undefined;
  readonly after: E | undefined;
  /** Only the containers that really change; empty when the request changes nothing. */
  readonly changes: readonly ContainerChange[];
  readonly references: readonly ReferenceCheck[];
}

/** What a check of the resulting element can look at. */
export interface CheckContext<E, B> {
  readonly op: 'create' | 'patch';
  /** The element as it will be. */
  readonly element: E;
  /** The element as it is (patch only). */
  readonly current: E | undefined;
  /** The validated body: references are verified only for the fields it carries, so an old stale reference never blocks an unrelated change. */
  readonly body: B;
  /** The other elements of the catalog. */
  readonly others: readonly E[];
  readonly state: CatalogState;
}

/** The places an element applies to: the field of the request that holds them, and their ids. An empty list means every place of the group (as in the legacy). */
export interface ElementPlaces {
  /** Field of the request, for the error (`conditions.placeIds`); a refused id is named `<field>.<index>`. */
  readonly field: string;
  readonly ids: readonly string[];
}

/** The definition of one catalog of the group document. */
export interface CatalogConfig<E extends object, C extends object, P extends object> {
  /** Name in the activity log (`group.<name>.created`). */
  readonly name: GroupCatalogName;
  /** URL segment under `/groups/{groupId}`. */
  readonly segment: string;
  /** Stored path of the container. */
  readonly path: string;
  readonly kind: CatalogKind;
  /** Most elements a catalog may have: a creation beyond it is `422`; a stored catalog above it is read anyway (an anomaly). */
  readonly limit: number;
  /** Other containers the operations read (to check references, or to keep two containers consistent). */
  readonly extraPaths?: readonly string[];
  /** Field of the element that is its id in the URL. */
  readonly idKey: keyof E & string;
  /** Size limit of the JSON body of the writes (body-parser syntax); the default of the API when absent. */
  readonly bodyLimit?: string;
  readonly readPermission: Permission;
  readonly updatePermission: Permission;
  /** Which writes exist: `create` (POST), `patch` (the method of the modification), `remove` (DELETE). */
  readonly operations: { readonly create?: true; readonly patch?: 'PATCH' | 'PUT'; readonly remove?: true };
  readonly createSchema?: Schema<C>;
  readonly patchSchema?: Schema<P>;
  /** Reads one stored element, tolerantly; it never throws. */
  toElement(id: string, raw: Raw, anomalies: CatalogAnomaly[], state: CatalogState): E;
  /** Replaces the default list (the elements stored in the container). */
  list?(state: CatalogState, anomalies: CatalogAnomaly[]): E[];
  /** The id of a new element when the client chooses it (a currency code); a generated one otherwise. */
  idOf?(body: C): string;
  /** The element a creation starts from, before the body is applied. */
  defaults?(id: string, body: C, state: CatalogState): E;
  /** Applies a body to an element (default: JSON Merge Patch). */
  merge?(current: E, body: C | P, state: CatalogState): E;
  /** The stored form of an element; `raw` is the stored element it replaces, whose keys this backend does not manage are kept. */
  toRaw(element: E, raw: Raw | undefined): Raw;
  /** Integrity rules of the resulting element; returns the ids to verify in the group database. Throws an {@link AppError} on a violation. */
  check?(context: CheckContext<E, C | P>): ReferenceCheck[];
  /** Changes the other stored elements as a consequence of the element (the default flag moves from one price list to another). */
  adjust?(items: readonly Item[], element: E): Item[];
  /** Refuses a deletion (the default list, an element others refer to). */
  guardRemove?(element: E, others: readonly E[], state: CatalogState): void;
  /** Changes in other containers that go with a write (a currency has its loyalty rule). */
  extra?(op: 'create' | 'patch' | 'remove', before: E | undefined, after: E | undefined, state: CatalogState): ContainerChange[];
  /**
   * The places an element applies to, for the catalogs whose elements are limited to some places (card types, promotions): a company or place
   * administrator writes only elements that apply to places of his own scope.
   */
  places?(element: E): ElementPlaces;
  /** Replaces the whole modification (the loyalty rules, whose elements exist because the currencies do). */
  patchOverride?(id: string, body: P, state: CatalogState): Outcome<E>;
}

/** A catalog ready to use: its identity, the schemas of its bodies and the operations on the stored containers (bodies are `unknown` here: the schemas validated them). */
export interface Catalog<E extends object = object> {
  readonly name: GroupCatalogName;
  readonly segment: string;
  readonly path: string;
  readonly limit: number;
  readonly bodyLimit: string | undefined;
  readonly readPermission: Permission;
  readonly updatePermission: Permission;
  readonly operations: CatalogConfig<E, object, object>['operations'];
  readonly createSchema: Schema<unknown> | undefined;
  readonly patchSchema: Schema<unknown> | undefined;
  /** Every stored path the operations read. */
  readonly paths: readonly string[];
  /** The places an element applies to, for the catalogs whose elements are limited to some places; absent for the others. */
  places?(element: E): ElementPlaces;
  /** The elements stored, each read tolerantly. */
  /** The id of an element in the URL. */
  idOf(element: E): string;
  list(state: CatalogState, anomalies: CatalogAnomaly[]): E[];
  create(body: unknown, state: CatalogState): Outcome<E>;
  patch(id: string, body: unknown, state: CatalogState): Outcome<E>;
  remove(id: string, state: CatalogState): Outcome<E>;
}

/** The elements of a stored container, with their ids. */
function itemsOf(config: CatalogConfig<object, object, object>, state: CatalogState): Item[] {
  const stored = state.raw(config.path);
  if (config.kind === 'array') {
    return Array.isArray(stored) ? stored.map((raw: unknown) => ({ id: isRecord(raw) && (typeof raw['id'] === 'string' || typeof raw['id'] === 'number') ? String(raw['id']) : null, raw })) : [];
  }
  return isRecord(stored) ? Object.entries(stored).map(([id, raw]) => ({ id, raw })) : [];
}

/** The container as stored once its elements are the given ones. */
function containerOf(config: CatalogConfig<object, object, object>, items: readonly Item[]): ContainerChange['next'] {
  return config.kind === 'array' ? items.map((item) => item.raw) : Object.fromEntries(items.map((item) => [item.id as string, item.raw]));
}

/**
 * Builds a catalog from its definition. The same code handles every catalog: the differences are in the definitions.
 *
 * @param config The catalog definition: storage kind, fields and rules.
 * @returns The catalog built from the definition.
 */
export function defineCatalog<E extends object, C extends object, P extends object>(config: CatalogConfig<E, C, P>): Catalog<E> {
  const generic = config as unknown as CatalogConfig<E, object, object>;
  const paths = [config.path, ...(config.extraPaths ?? [])];
  const merge = (generic.merge ?? ((current: E, body: object) => mergePatch(current, body))) as (current: E, body: object, state: CatalogState) => E;

  const readElements = (items: readonly Item[], state: CatalogState, anomalies: CatalogAnomaly[]): E[] =>
    items.flatMap((item) => {
      if (item.id === null || !isRecord(item.raw)) {
        anomalies.push({ kind: 'invalidElement', field: config.path });
        return [];
      }
      return [generic.toElement(item.id, item.raw, anomalies, state)];
    });

  const changesOf = (items: readonly Item[], state: CatalogState, extra: ContainerChange[]): ContainerChange[] =>
    [{ path: config.path, kind: config.kind, old: state.raw(config.path), next: containerOf(generic as never, items) }, ...extra].filter((change) => !equal(change.old, change.next));

  const find = (items: readonly Item[], id: string): { item: Item; raw: Raw } => {
    const item = SAFE_ID.test(id) ? items.find((candidate) => candidate.id === id) : undefined;
    if (item === undefined || !isRecord(item.raw)) {
      throw notFound();
    }
    return { item, raw: item.raw };
  };

  return {
    name: config.name,
    segment: config.segment,
    path: config.path,
    limit: config.limit,
    bodyLimit: config.bodyLimit,
    readPermission: config.readPermission,
    updatePermission: config.updatePermission,
    operations: config.operations,
    createSchema: config.createSchema,
    patchSchema: config.patchSchema,
    paths,
    ...(config.places === undefined ? {} : { places: config.places }),
    idOf: (element) => String(element[config.idKey]),

    list: (state, anomalies) => {
      if (generic.list !== undefined) {
        return generic.list(state, anomalies);
      }
      const items = itemsOf(generic as never, state);
      const stored = state.raw(config.path);
      if (stored !== undefined && stored !== null && !(config.kind === 'array' ? Array.isArray(stored) : isRecord(stored))) {
        anomalies.push({ kind: 'invalidType', field: config.path });
      }
      if (items.length > config.limit) {
        anomalies.push({ kind: 'overLimit', field: config.path });
      }
      return readElements(items, state, anomalies);
    },

    create: (input, state) => {
      const body = input as object;
      const items = itemsOf(generic as never, state);
      if (items.length >= config.limit) {
        throw invalid('(body)', 'tooMany');
      }
      const id = generic.idOf === undefined ? state.newId() : generic.idOf(body);
      if (items.some((item) => item.id === id)) {
        throw conflict(String(config.idKey), 'taken');
      }
      const element = merge(generic.defaults!(id, body, state), body, state);
      const others = readElements(items, state, []);
      const references = generic.check?.({ op: 'create', element, current: undefined, body, others, state }) ?? [];
      const created: Item = { id, raw: generic.toRaw(element, undefined) };
      const next = generic.adjust?.([...items, created], element) ?? [...items, created];
      return { before: undefined, after: element, changes: changesOf(next, state, generic.extra?.('create', undefined, element, state) ?? []), references };
    },

    patch: (id, input, state) => {
      const body = input as object;
      if (generic.patchOverride !== undefined) {
        return generic.patchOverride(id, body, state);
      }
      const items = itemsOf(generic as never, state);
      const { item, raw } = find(items, id);
      const current = generic.toElement(id, raw, [], state);
      const element = merge(current, body, state);
      const others = readElements(items.filter((candidate) => candidate !== item), state, []);
      const references = generic.check?.({ op: 'patch', element, current, body, others, state }) ?? [];
      const before = generic.toRaw(current, raw);
      const after = generic.toRaw(element, raw);
      const written = { ...raw, ...Object.fromEntries(Object.entries(after).filter(([key, value]) => !equal(value, before[key]))) };
      const replaced: Item = { id, raw: written };
      const next = generic.adjust?.(items.map((candidate) => (candidate === item ? replaced : candidate)), element) ?? items.map((candidate) => (candidate === item ? replaced : candidate));
      return { before: current, after: element, changes: changesOf(next, state, generic.extra?.('patch', current, element, state) ?? []), references };
    },

    remove: (id, state) => {
      const items = itemsOf(generic as never, state);
      const { item, raw } = find(items, id);
      const current = generic.toElement(id, raw, [], state);
      const others = readElements(items.filter((candidate) => candidate !== item), state, []);
      generic.guardRemove?.(current, others, state);
      const next = items.filter((candidate) => candidate !== item);
      return { before: current, after: undefined, changes: changesOf(next, state, generic.extra?.('remove', current, undefined, state) ?? []), references: [] };
    },
  };
}
