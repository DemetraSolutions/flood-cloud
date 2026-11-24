import { isDeepStrictEqual } from 'node:util';
import { Int32, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { PRODUCTS_CATEGORIES_OWNED_FIELDS } from '../../db/collections.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { actorOfCaller, languageOfCaller, operatorMetadata } from '../product-catalog/caller.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { legacyLogoDescriptor, logo } from '../companies/company.mapper.ts';
import { flagOf, isRecord, textOf, valueAt } from '../groups/catalogs/kit.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { promotions } from '../groups/catalogs/promotions.ts';
import type { Feature } from '../groups/features.ts';
import type { ReferencesRepository } from '../groups/catalogs/references.repository.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { entityVersion } from '../product-catalog/entity.service.ts';
import type { EntityPage, EntityService } from '../product-catalog/entity.service.ts';
import type { GroupLanguages } from '../product-catalog/group-languages.ts';
import { imageOf } from '../product-catalog/image.ts';
import type { ProductReferences } from '../product-catalog/product-references.ts';
import { languageIssues, mergeTexts, nameSearch, requiredLanguage, textsOf } from '../product-catalog/texts.ts';
import { assertPlacesInPerimeter, assertWritableCategory, modernPlaces, placesDocument, placesOf } from './categories.availability.ts';
import type { PlaceEntry } from './categories.availability.ts';
import { LEAF_CONTAINERS, applyChange, categoryLoggable, mediaWrites, newCategoryDocument, placeKey, storedNumber } from './categories.document.ts';
import type { MediaKey } from './categories.document.ts';
import { categoryView, colorValue, objectIdsValue, plainOf, wholeValue } from './categories.mapper.ts';
import type { CategoryView } from './categories.mapper.ts';
import type { CategoryPlaces } from './categories.places.ts';
import type { CategoriesRepository } from './categories.repository.ts';
import { CATEGORY_CHANGES_LIST, MAX_STATION_PLACES, categoriesListFor } from './categories.schemas.ts';
import type { CategoriesQuery, CategoryChangesQuery, CreateCategoryBody, PatchCategoryBody } from './categories.schemas.ts';
import { MAX_CATEGORIES, MAX_LEVELS, isWithin, onCycle, shapeOf } from './categories.tree.ts';
import type { TreeNode, TreeShape } from './categories.tree.ts';

/** A category as the API shows it: its fields and its place in the tree. */
export type Category = CategoryView & {
  /** The parent the category is read with: `null` for a root, for a parent that does not exist and for the category that closes a cycle of the stored parents. */
  readonly parentId: string | null;
  /** Whether the category has a parent the caller does not reach (a company or place administrator): `parentId` is then `null` and the category is a root of what he reaches. Always `false` for the other roles. */
  readonly parentHidden: boolean;
  /** Level below the roots of what the caller reaches, 0 for a root; `null` in a group that has more than {@link MAX_CATEGORIES} categories (the tree is not read). */
  readonly depth: number | null;
  /** Whether the category closes a cycle of the stored parents (the legacy never checked them): it is read as a root. */
  readonly cyclic: boolean;
};

/** A category in the compact tree. */
export interface CategoryTreeNode {
  readonly id: string;
  /** The name in the language of the caller (else the first language the category has), `null` when it has none. */
  readonly name: string | null;
  /** The parent, `null` for a root and for a parent the caller does not reach. */
  readonly parentId: string | null;
  /** Whether the category has a parent the caller does not reach: it is then a root of the answer. */
  readonly parentHidden: boolean;
  readonly position: number | null;
  readonly enabled: boolean;
  readonly children: CategoryTreeNode[];
}

/** The operations on the categories of a group. */
export interface CategoriesService extends EntityService<Category, CreateCategoryBody, PatchCategoryBody> {
  /**
   * The whole tree of the categories the caller reaches, compact, in the language of the caller: the roots with their children, ordered by position (a missing one last), name and id. A category whose
   * parent the caller does not reach is a root of the answer.
   *
   * @throws {AppError} `CONFLICT` (`categories`/`tooMany`) in a group that has more than {@link MAX_CATEGORIES} categories; `NOT_FOUND` if the caller disappeared since the authentication.
   */
  tree(principal: CatalogCaller, access: GroupAccess): Promise<CategoryTreeNode[]>;
  /**
   * A page of the categories the caller reaches, oldest change first, for a client that keeps a copy of the catalog: with `updatedSince` every category changed from that instant, without it all of them (`activeOnly` keeps only the enabled ones).
   *
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit.
   */
  listChanges(principal: CatalogCaller, access: GroupAccess, query: CategoryChangesQuery): Promise<EntityPage<Category>>;
}

/** Collaborators of {@link createCategoriesService}. */
export interface CategoriesServiceDeps {
  readonly repository: CategoriesRepository;
  /** The print stations, the production centers and the references of the places. */
  readonly places: CategoryPlaces;
  /** Which of some ids exist in the group (and are not in the trash): places and categories. */
  readonly references: Pick<ReferencesRepository, 'missing'>;
  /** Reads the promotions of the group. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly products: Pick<ProductReferences, 'inCategory' | 'withModifierCategory' | 'withBundleCategory' | 'notModifiers'>;
  /** The descriptor of an image of the library, `null` when the caller may not use it. */
  readonly images: { imageSource(principal: CatalogCaller, access: GroupAccess, imageId: ObjectId): Promise<MediaLogo | null> };
  readonly languages: GroupLanguages;
  readonly users: Pick<UsersRepository, 'findById'>;
  readonly activityLog: ActivityLog;
  /** Where a write that could not be undone is reported (`error`, ids only). */
  readonly logger: Logger;
  /** Secret key of the versions (`VERSION_HMAC_KEY`). */
  readonly versionKey: Buffer;
  readonly now: () => number;
  /** Generator of the ids of new categories. */
  readonly newId?: () => ObjectId;
}

/** The function of the group each field needs (otherwise `422` `notAllowed`, and the field is never shown). */
const FEATURE_OF: Readonly<Record<string, Feature>> = Object.freeze({
  'availability.pos': 'cash',
  'availability.ecommerce': 'customersApp',
  featured: 'customersApp',
  secondaryFiscalPrinter: 'tobaccosGamesMonopoly',
  tobacco: 'tobaccosGamesMonopoly',
  backgroundColor: 'cash',
  modifierIds: 'productsVariants',
  modifierCategoryIds: 'productsVariants',
  printStations: 'ordering',
  counterPrintStations: 'ordering',
  image: 'media',
  icon: 'media',
  internalFileName: 'media',
  externalUrl: 'media',
});

/** The objects of a body whose fields each need their own function. */
const NESTED = new Set(['availability', 'dining', 'integrations']);

/** Most references of one kind a refused deletion lists. */
const MAX_REPORTED = 20;

/** `409` for a group that has too many categories to be read as a tree (or for creating one more). */
const tooMany = (): AppError => new AppError('CONFLICT', { details: [{ field: 'categories', issue: 'tooMany' }] });

/** The functions of the group the fields of a request need and the group lacks, as `notAllowed` problems. */
function featureIssues(access: GroupAccess, body: object): ErrorDetail[] {
  const paths = Object.entries(body).flatMap(([key, value]) => (NESTED.has(key) && isRecord(value) ? Object.keys(value).map((leaf) => `${key}.${leaf}`) : [key]));
  return paths.flatMap((path) => {
    const feature: Feature | undefined = path.startsWith('dining.') ? 'rooms' : FEATURE_OF[path];
    return feature === undefined || access.features[feature] ? [] : [{ field: path, issue: 'notAllowed' }];
  });
}

/** A text compared by code unit, the order of the database. */
const compareText = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/** Order of the compact tree: position (a missing one last), then name, then id. */
function compareNodes(a: CategoryTreeNode, b: CategoryTreeNode): number {
  const byPosition = a.position === b.position ? 0 : a.position === null ? 1 : b.position === null ? -1 : a.position - b.position;
  return byPosition || compareText(a.name ?? '', b.name ?? '') || compareText(a.id, b.id);
}

/** The text of a name in a language, else the first one it has: what `localizedName` gives the database. */
function nameIn(raw: unknown, language: string): string | null {
  const names = isRecord(raw) ? raw : {};
  const picked = Object.hasOwn(names, language) ? names[language] : Object.values(names)[0];
  return typeof picked === 'string' ? picked : null;
}

/** The tree as read for one request: the stored parents of every category and the shape they make. */
interface Tree {
  readonly nodes: readonly TreeNode[];
  /** The shape of the whole tree: what the rules (cycles, depth) are judged on, whoever the caller is. */
  readonly shape: TreeShape;
  /** The categories the caller reaches, `null` for the roles that are not limited to places. */
  readonly reachable: ReadonlySet<string> | null;
  /** The shape of what the caller reaches: a category whose parent he does not reach is a root, and the depth counts only what he reaches. The same as `shape` when nothing is held back. */
  readonly view: TreeShape;
}

/**
 * Builds the service of the categories of a group: texts by language, the tree (parent, depth, cycles), the places and who may touch which, the print stations, the modifiers, the images of the
 * library and the functions of the group, versions and the activity log.
 *
 * @param deps The repository and the collaborators.
 */
export function createCategoriesService(deps: CategoriesServiceDeps): CategoriesService {
  const { repository, activityLog, versionKey } = deps;
  const newId = deps.newId ?? (() => new ObjectId());
  const hex = (id: ObjectId): string => id.toHexString();

  const loadTree = async (principal: CatalogCaller, access: GroupAccess): Promise<Tree | null> => {
    const nodes = await repository.nodes(principal, access);
    if (nodes === null) {
      return null;
    }
    const reachable = perimeterOf(principal) === null ? null : await repository.reachableIds(principal, access);
    const shape = shapeOf(nodes);
    return { nodes, shape, reachable, view: reachable === null ? shape : shapeOf(nodes.filter((node) => reachable.has(node.id))) };
  };
  const requireTree = async (principal: CatalogCaller, access: GroupAccess): Promise<Tree> => {
    const tree = await loadTree(principal, access);
    if (tree === null) {
      throw tooMany();
    }
    return tree;
  };
  const viewOf = (principal: CatalogCaller, access: GroupAccess, document: Document, tree: Tree | null): Category => {
    const id = hex(document['_id'] as ObjectId);
    const stored = document['parentId'] instanceof ObjectId ? hex(document['parentId']) : null;
    const full = tree?.shape.parentOf.get(id);
    const restricted = perimeterOf(principal) !== null;
    // A parent the caller does not reach is never named: he gets `null` and `parentHidden`. When the tree is not known (or does not know the category) a company or place administrator cannot tell, so he gets the same.
    const hidden = full === undefined ? restricted && stored !== null : tree!.reachable !== null && full !== null && !tree!.reachable.has(full);
    return {
      ...categoryView(document, principal, access.features, restricted ? (tree?.reachable ?? new Set<string>()) : null),
      // The parent is the one of the caller's own view, so the parent, the depth, the filter and the tree tell the same story (a cycle of the legacy through a category he does not reach included).
      parentId: hidden ? null : full === undefined ? stored : (tree!.view.parentOf.get(id) ?? null),
      parentHidden: hidden,
      depth: tree?.view.depthOf.get(id) ?? null,
      cyclic: tree?.view.cyclic.has(id) ?? false,
    };
  };
  const resultOf = (principal: CatalogCaller, access: GroupAccess, document: Document, tree: Tree | null) => ({
    entity: viewOf(principal, access, document, tree),
    version: entityVersion(document, PRODUCTS_CATEGORIES_OWNED_FIELDS, versionKey),
  });
  const record = async (principal: CatalogCaller, access: GroupAccess, client: ClientContext, id: ObjectId, action: DataAction, before: Document | undefined, after: Document | undefined) => {
    const reachable = perimeterOf(principal) === null ? null : await repository.reachableIds(principal, access);
    await recordDataChange(activityLog, {
      actor: actorOfCaller(principal),
      groupId: access.groupId,
      resource: { type: 'productCategory', id: hex(id) },
      action,
      before: before === undefined ? undefined : categoryLoggable(principal, before, reachable),
      after: after === undefined ? undefined : categoryLoggable(principal, after, reachable),
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      metadata: operatorMetadata(principal),
    });
  };
  const languageOf = (principal: CatalogCaller, access: GroupAccess): Promise<string> => languageOfCaller(deps, principal, access.groupId);
  const found = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document> => {
    const document = await repository.findById(principal, access, id);
    if (document === null) {
      throw new AppError('NOT_FOUND');
    }
    return document;
  };
  const refuse = (issues: readonly ErrorDetail[]): void => {
    if (issues.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: issues.slice(0, MAX_REPORTED) });
    }
  };
  /** The descriptor of an image of the library (`null` for none, or when it is not usable: a problem is added to `issues`). */
  const imageOfRequest = async (principal: CatalogCaller, access: GroupAccess, image: { readonly imageId: string } | null, field: string, issues: ErrorDetail[]): Promise<MediaLogo | null> => {
    if (image === null) {
      return null;
    }
    const source = await deps.images.imageSource(principal, access, ObjectId.createFromHexString(image.imageId));
    if (source === null) {
      issues.push({ field, issue: 'incorrect' });
    }
    return source;
  };
  /** The positions, in `ids`, of the places that do not exist in the group (or are in the trash). */
  const missingPlaces = (principal: CatalogCaller, access: GroupAccess, field: string, ids: readonly string[]): Promise<number[]> =>
    ids.length === 0 ? Promise.resolve([]) : deps.references.missing(principal, access, { field, collection: 'places', ids });

  /** The problems of a new parent: it does not exist or is not reached, it is the category itself or one of its descendants, or the tree would be too deep. */
  const parentIssue = (tree: Tree, parent: string, self: string | null): ErrorDetail | null => {
    const { shape } = tree;
    if (!shape.parentOf.has(parent) || (tree.reachable !== null && !tree.reachable.has(parent))) {
      return { field: 'parentId', issue: 'incorrect' };
    }
    if (self !== null && isWithin(shape, parent, self)) {
      return { field: 'parentId', issue: 'incorrect' };
    }
    const lowest = shape.depthOf.get(parent)! + 1 + (self === null ? 0 : shape.heightOf.get(self)!);
    return lowest > MAX_LEVELS - 1 ? { field: 'parentId', issue: 'tooDeep' } : null;
  };

  /** Checks the places of a request (create: all of them; modify: the ones the category did not have) and the production centers it names. */
  const placesIssues = async (principal: CatalogCaller, access: GroupAccess, stored: unknown, requested: readonly PlaceEntry[], issues: ErrorDetail[]): Promise<void> => {
    assertPlacesInPerimeter(principal, requested.map((entry) => entry.placeId), 'places');
    const current = new Map(placesOf(stored).entries.map((entry) => [entry.placeId, entry]));
    const added = requested.filter((entry) => !current.has(entry.placeId));
    const missing = new Set((await missingPlaces(principal, access, 'places', added.map((entry) => entry.placeId))).map((position) => added[position]!.placeId));
    for (const [index, entry] of requested.entries()) {
      if (missing.has(entry.placeId)) {
        issues.push({ field: `places.${String(index)}.placeId`, issue: 'incorrect' });
      }
    }
    const centers = requested.filter((entry) => entry.productionCenterId !== null && !missing.has(entry.placeId) && current.get(entry.placeId)?.productionCenterId !== entry.productionCenterId);
    const setups = await deps.places.setupOf(principal, access, centers.map((entry) => entry.placeId));
    for (const entry of centers) {
      if (!setups.get(entry.placeId)!.centerIds.has(entry.productionCenterId!)) {
        issues.push({ field: `places.${String(requested.indexOf(entry))}.productionCenterId`, issue: 'incorrect' });
      }
    }
  };

  /**
   * Checks the print stations of a request: a company or place administrator names only places of his perimeter (`403`); a place that is given stations exists in the group, and each station is
   * one the place has (only the ones the category did not have for that place are judged, so an old station that is gone never blocks an unrelated change).
   */
  const stationsIssues = async (
    principal: CatalogCaller,
    access: GroupAccess,
    field: 'printStations' | 'counterPrintStations',
    requested: Readonly<Record<string, readonly string[] | null>>,
    stored: unknown,
    issues: ErrorDetail[],
  ): Promise<void> => {
    const allowed = perimeterOf(principal);
    const outside = Object.keys(requested).filter((placeId) => allowed !== null && !allowed.has(placeId));
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED).map((placeId) => ({ field: `${field}.${placeId}`, issue: 'notAllowed' })) });
    }
    const current = (placeId: string): unknown => (isRecord(stored) ? stored[placeKey(placeId)] : undefined);
    // Every place the request adds to the map (an empty list included) must exist in the group; a key the category already has is not asked about again (its place may be gone, and the
    // administrator of the group may still change its stations). The stations are judged only where they change.
    const given = Object.entries(requested).flatMap(([placeId, ids]) => (ids === null ? [] : [[placeId, ids] as const]));
    const fresh = given.filter(([placeId]) => !(isRecord(stored) && Object.hasOwn(stored, placeKey(placeId))));
    const missing = new Set((await missingPlaces(principal, access, field, fresh.map(([placeId]) => placeId))).map((position) => fresh[position]![0]));
    const changed = given.filter(([placeId, ids]) => ids.length > 0 && !missing.has(placeId) && !isDeepStrictEqual(current(placeId), ids));
    const setups = await deps.places.setupOf(principal, access, changed.map(([placeId]) => placeId));
    for (const [placeId, ids] of given) {
      if (missing.has(placeId)) {
        issues.push({ field: `${field}.${placeId}`, issue: 'incorrect' });
      } else if (changed.some(([changedId]) => changedId === placeId)) {
        const had = new Set(Array.isArray(current(placeId)) ? (current(placeId) as unknown[]) : []);
        ids.forEach((id, index) => !had.has(id) && !setups.get(placeId)!.stationIds.has(id) && issues.push({ field: `${field}.${placeId}.${String(index)}`, issue: 'incorrect' }));
      }
    }
    // The map never holds more places than a request may name: the keys it ends up with are counted.
    const keys = new Set(isRecord(stored) ? Object.keys(stored) : []);
    const before = keys.size;
    for (const [placeId, ids] of Object.entries(requested)) {
      if (ids === null) {
        keys.delete(placeKey(placeId));
      } else if (keys.has(placeKey(placeId)) || ids.length > 0) {
        keys.add(placeKey(placeId));
      }
    }
    // Only a map that grows is refused: one the legacy left over the limit can still be changed, and shrunk.
    if (keys.size > MAX_STATION_PLACES && keys.size > before) {
      issues.push({ field, issue: 'tooMany' });
    }
  };

  /** The modifiers and the categories of modifiers of a request that cannot be used (only the ones the category did not have are judged). */
  const modifierIssues = async (principal: CatalogCaller, access: GroupAccess, body: { modifierIds?: readonly string[] | undefined; modifierCategoryIds?: readonly string[] | undefined }, stored: Document | undefined, issues: ErrorDetail[]): Promise<void> => {
    const had = (path: string): Set<string> => new Set(Array.isArray(stored?.[path]) ? (stored[path] as unknown[]).flatMap((id) => (id instanceof ObjectId ? [hex(id)] : [])) : []);
    const check = async (field: 'modifierIds' | 'modifierCategoryIds', path: string, missing: (ids: readonly string[]) => Promise<number[]>): Promise<void> => {
      const requested = body[field];
      if (requested === undefined) {
        return;
      }
      const known = had(path);
      const added = requested.filter((id) => !known.has(id));
      if (added.length > 0) {
        for (const position of await missing(added)) {
          issues.push({ field: `${field}.${String(requested.indexOf(added[position]!))}`, issue: 'incorrect' });
        }
      }
    };
    await check('modifierIds', 'variants', (ids) => deps.products.notModifiers(principal, access, ids));
    // A company or place administrator can use only the categories he reaches: another one is judged exactly like one that does not exist (no oracle, and no reference to a category he cannot see
    // that would block its deletion). The modifier products are checked by `deps.products.notModifiers`, which judges only the ones the caller reaches.
    await check('modifierCategoryIds', 'variantsCategories', async (ids) => {
      const missing = await deps.references.missing(principal, access, { field: 'modifierCategoryIds', collection: 'categories', ids });
      if (perimeterOf(principal) === null) {
        return missing;
      }
      const reachable = await repository.reachableIds(principal, access);
      return ids.flatMap((id, index) => (missing.includes(index) || !reachable.has(id) ? [index] : []));
    });
  };

  /**
   * Refuses the deletion of a category that is still referred to. The kinds of reference are looked for one after the other, from the cheapest, and the search stops at the first kind found: the
   * `409` lists (at most 20 of) that kind only, so a refusal never repeats the three scans of the products. A company or place administrator is named only what he reaches (the rest is one anonymous detail).
   */
  const guardRemove = async (principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<void> => {
    const allowed = perimeterOf(principal);
    const wanted = hex(id);
    const reachable = async (): Promise<((item: string) => boolean) | null> => {
      const set = allowed === null ? null : await repository.reachableIds(principal, access);
      return set === null ? null : (item) => set.has(item);
    };
    const promoted = async (): Promise<string[]> =>
      (await deps.catalogs.list(promotions, access) as Array<{ id: string; conditions: { categories: { categoryIds: readonly string[] } }; actions: { categoryIds: readonly string[] } }>)
        .filter((promotion) => promotion.conditions.categories.categoryIds.includes(wanted) || promotion.actions.categoryIds.includes(wanted))
        .map((promotion) => promotion.id);
    const kinds: ReadonlyArray<readonly [string, () => Promise<readonly string[]>, (() => Promise<((item: string) => boolean) | null>) | null]> = [
      ['subcategories', () => repository.subcategories(principal, access, id), reachable],
      ['categoryModifierCategories', () => repository.modifierCategoryUsers(principal, access, id), reachable],
      ['promotions', promoted, null],
      ['places', () => deps.places.using(principal, access, id), async () => (allowed === null ? null : (item) => allowed.has(item))],
      ['products', () => deps.products.inCategory(principal, access, id), null],
      ['productModifierCategories', () => deps.products.withModifierCategory(principal, access, id), null],
      ['productBundles', () => deps.products.withBundleCategory(principal, access, id), null],
    ];
    for (const [kind, read, reaches] of kinds) {
      const ids = await read();
      if (ids.length === 0) {
        continue;
      }
      const test = reaches === null ? null : await reaches();
      const shown = ids.filter((item) => item !== '' && (test === null || test(item))).slice(0, MAX_REPORTED);
      const hidden = ids.some((item) => item === '' || (test !== null && !test(item)));
      throw new AppError('CONFLICT', { details: [...shown.map((item) => ({ field: `${kind}.${item}`, issue: 'referenced' })), ...(hidden ? [{ field: kind, issue: 'referenced' }] : [])] });
    }
  };

  return {
    list: async (principal, access, query: CategoriesQuery) => {
      const config = categoriesListFor(await languageOf(principal, access));
      const params = listParamsOf(query, config);
      const tree = await loadTree(principal, access);
      let parentFilter: Filter<Document> = {};
      if (query.parentId !== undefined) {
        if (tree === null) {
          throw tooMany();
        }
        const wanted = query.parentId === 'null' ? null : query.parentId;
        parentFilter = { _id: { $in: [...tree.view.parentOf].filter(([, parent]) => parent === wanted).map(([id]) => ObjectId.createFromHexString(id)) } };
      }
      const filter: Filter<Document> = {
        ...(params.q === null ? {} : nameSearch(params.q)),
        ...(query.enabled === undefined ? {} : { status: query.enabled ? true : { $ne: true } }),
        ...parentFilter,
      };
      const { items, page } = await repository.list(principal, access, filter, params, config);
      return { items: items.map((document) => viewOf(principal, access, document, tree)), page };
    },

    listChanges: async (principal, access, query) => {
      const params = listParamsOf(query, CATEGORY_CHANGES_LIST);
      const tree = await loadTree(principal, access);
      const filter: Filter<Document> = { ...(query.updatedSince === undefined ? {} : { updateDate: { $gte: new Date(query.updatedSince) } }), ...(query.activeOnly === true ? { status: true } : {}) };
      const { items, page } = await repository.list(principal, access, filter, params, CATEGORY_CHANGES_LIST);
      return { items: items.map((document) => viewOf(principal, access, document, tree)), page };
    },

    get: async (principal, access, id) => {
      const document = await found(principal, access, id);
      return resultOf(principal, access, document, await loadTree(principal, access));
    },

    tree: async (principal, access) => {
      const language = await languageOf(principal, access);
      const { shape, view, reachable } = await requireTree(principal, access);
      const nodes = new Map<string, CategoryTreeNode>();
      for (const document of await repository.treeDocuments(principal, access)) {
        const id = hex(document['_id'] as ObjectId);
        const parent = view.parentOf.get(id) ?? null;
        const full = shape.parentOf.get(id) ?? null;
        nodes.set(id, { id, name: nameIn(document['name'], language), parentId: parent, parentHidden: reachable !== null && full !== null && !reachable.has(full), position: wholeValue(document['position']), enabled: document['status'] === true, children: [] });
      }
      const roots: CategoryTreeNode[] = [];
      for (const node of nodes.values()) {
        // A parent that is not among the categories read (one that appeared meanwhile) leaves the node a root.
        const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
        (parent === undefined ? roots : parent.children).push(node);
      }
      for (const node of nodes.values()) {
        node.children.sort(compareNodes);
      }
      return roots.sort(compareNodes);
    },

    create: async (principal, access, body, client) => {
      const issues = featureIssues(access, body);
      const groupLanguages = await deps.languages.of(access.groupId);
      const languages = new Set(groupLanguages);
      const required = requiredLanguage(await languageOf(principal, access), groupLanguages);
      issues.push(...languageIssues('name', body.name, undefined, languages), ...languageIssues('description', body.description ?? {}, undefined, languages));
      if (body.name[required] === undefined) {
        issues.push({ field: `name.${required}`, issue: 'required' });
      }
      const before = await requireTree(principal, access);
      if (body.parentId != null) {
        const problem = parentIssue(before, body.parentId, null);
        if (problem !== null) {
          issues.push(problem);
        }
      }
      const requestedPlaces: PlaceEntry[] = (body.places ?? []).map((entry) => ({ placeId: entry.placeId, position: entry.position ?? null, productionCenterId: entry.productionCenterId ?? null }));
      await placesIssues(principal, access, undefined, requestedPlaces, issues);
      await stationsIssues(principal, access, 'printStations', body.printStations ?? {}, undefined, issues);
      await stationsIssues(principal, access, 'counterPrintStations', body.counterPrintStations ?? {}, undefined, issues);
      await modifierIssues(principal, access, body, undefined, issues);
      const images: { main?: MediaLogo; icon?: MediaLogo } = {};
      if (access.features.media) {
        for (const field of ['image', 'icon'] as const) {
          const descriptor = body[field] === undefined ? null : await imageOfRequest(principal, access, body[field], field, issues);
          if (descriptor !== null) {
            images[field === 'image' ? 'main' : 'icon'] = descriptor;
          }
        }
      }
      refuse(issues);
      if (before.nodes.length >= MAX_CATEGORIES) {
        throw tooMany();
      }
      const now = new Date(deps.now());
      const document = newCategoryDocument({
        id: newId(),
        body,
        language: required,
        parentId: body.parentId == null ? null : ObjectId.createFromHexString(body.parentId),
        places: placesDocument(undefined, requestedPlaces),
        images,
        now,
      });
      await repository.insert(principal, access, document);
      // The count above and the insert are not atomic: count again, and when the group went over the limit take back this one (and only this one), so concurrent requests never leave the group over it.
      const takeBack = async (): Promise<void> => {
        if (!(await repository.remove(principal, access, document['_id'] as ObjectId, document['updateDate'], document['placesAvailability']))) {
          deps.logger.error('product category write could not be undone', { id: hex(document['_id'] as ObjectId), groupId: hex(access.groupId) });
        }
      };
      let tree: Tree | null;
      try {
        tree = await loadTree(principal, access);
      } catch (error) {
        // The read after the insert failed (a `503` for the time limit, for one): nobody has the answer or the event, so the category is taken back and the error is the one the caller gets.
        await takeBack();
        throw error;
      }
      if (tree === null) {
        await takeBack();
        throw tooMany();
      }
      await record(principal, access, client, document['_id'] as ObjectId, 'productCategory.created', undefined, document);
      return resultOf(principal, access, document, tree);
    },

    update: async (principal, access, id, expected, body, client) => {
      const stored = await found(principal, access, id);
      assertWritableCategory(principal, stored['placesAvailability']);
      if (entityVersion(stored, PRODUCTS_CATEGORIES_OWNED_FIELDS, versionKey) !== expected) {
        throw new AppError('PRECONDITION_FAILED');
      }
      const issues = featureIssues(access, body);
      const set: Document = {};
      const unset: Document = {};
      /** Sets a flag when it differs from the stored one (a flag the document lacks is off). */
      const setFlag = (path: string, requested: boolean | undefined): void => {
        if (requested !== undefined && flagOf(valueAt(stored, path)) !== requested) {
          set[path] = requested;
        }
      };
      /** Sets a whole number (or `null`) when it is not exactly what is stored: a stored `NaN` is not `null`. */
      const setNumber = (path: string, requested: number | null | undefined, write: (value: number) => unknown): void => {
        const current = plainOf(valueAt(stored, path));
        if (requested !== undefined && (requested === null ? current !== null : current !== requested)) {
          set[path] = requested === null ? null : write(requested);
        }
      };
      /** Sets a colour when it differs from the stored one. */
      const setColor = (path: string, requested: string | undefined): void => {
        if (requested !== undefined && colorValue(stored[path])?.toLowerCase() !== requested) {
          set[path] = requested;
        }
      };
      if (body.name !== undefined || body.description !== undefined) {
        const groupLanguages = await deps.languages.of(access.groupId);
        const languages = new Set(groupLanguages);
        if (body.name !== undefined) {
          const merged = mergeTexts(stored['name'], body.name);
          issues.push(...languageIssues('name', body.name, stored['name'], languages));
          const required = requiredLanguage(await languageOf(principal, access), groupLanguages);
          // A name keeps a text in the required language it already had, and never ends up with none.
          if (Object.keys(textsOf(merged)).length === 0 || (textsOf(stored['name'])[required] !== undefined && textsOf(merged)[required] === undefined)) {
            issues.push({ field: `name.${required}`, issue: 'required' });
          }
          if (!isDeepStrictEqual(stored['name'], merged)) {
            set['name'] = merged;
          }
        }
        if (body.description !== undefined) {
          const merged = mergeTexts(stored['description'], body.description);
          issues.push(...languageIssues('description', body.description, stored['description'], languages));
          if (!isDeepStrictEqual(stored['description'], merged)) {
            set['description'] = merged;
          }
        }
      }
      setFlag('status', body.enabled);
      setNumber('position', body.position, (value) => new Int32(value));
      setNumber('productionValue', body.productionValue, (value) => new Int32(value));
      setFlag('availability.pos', body.availability?.pos);
      setFlag('availability.ecommerce', body.availability?.ecommerce);
      setFlag('noDiscount', body.noDiscount);
      setFlag('requiresGreaterAge', body.requiresLegalAge);
      setFlag('secondaryFiscalPrinter', body.secondaryFiscalPrinter);
      setFlag('featured', body.featured);
      setFlag('integrations.floodOrders', body.integrations?.floodOrders);
      setFlag('integrations.yellgo', body.integrations?.yellgo);
      setFlag('integrations.leggimenu', body.integrations?.leggimenu);
      setFlag('roomsSettings.endMeal', body.dining?.endOfMeal);
      setFlag('roomsSettings.handheldHidden', body.dining?.hiddenOnHandheld);
      setFlag('roomsSettings.alwaysFirstExit', body.dining?.alwaysFirstCourse);
      setFlag('roomsSettings.notAffiliatedMenu', body.dining?.notAffiliatedMenu);
      setNumber('roomsSettings.percentageFee', body.dining?.feePercentage, storedNumber);
      setNumber('roomsSettings.printGroup', body.dining?.printGroup, (value) => new Int32(value));
      if (body.dining?.type !== undefined && valueAt(stored, 'roomsSettings.type') !== body.dining.type) {
        set['roomsSettings.type'] = body.dining.type;
      }
      setFlag('tgm.type', body.tobacco);
      setColor('backgroundColor', body.backgroundColor);
      setColor('textColor', body.textColor);
      for (const [field, path] of [['modifierIds', 'variants'], ['modifierCategoryIds', 'variantsCategories']] as const) {
        const requested = body[field];
        if (requested === undefined) {
          continue;
        }
        // A company or place administrator sees, and so changes, only the categories of modifiers he reaches: the stored ones he does not reach are kept.
        const reachable = field === 'modifierCategoryIds' && perimeterOf(principal) !== null ? await repository.reachableIds(principal, access) : null;
        const storedIds = objectIdsValue(stored[path]);
        if (!isDeepStrictEqual(requested, storedIds.filter((item) => reachable === null || reachable.has(item)))) {
          const kept = reachable === null ? [] : storedIds.filter((item) => !reachable.has(item));
          set[path] = [...requested, ...kept].map((item) => ObjectId.createFromHexString(item));
        }
      }
      await modifierIssues(principal, access, body, stored, issues);
      if (body.parentId !== undefined) {
        const read = stored['parentId'] instanceof ObjectId ? hex(stored['parentId']) : null;
        // A company or place administrator always has the parent he names judged when it is not what the API shows him: a hidden parent sent back as it is would otherwise be an oracle, and `null`
        // (what he is shown for a hidden parent) changes nothing: to move the category he chooses a parent he reaches.
        if (body.parentId !== read || (perimeterOf(principal) !== null && read !== null)) {
          const tree = await requireTree(principal, access);
          const hiddenParent = tree.reachable !== null && read !== null && !tree.reachable.has(read);
          if (body.parentId === null) {
            if (!hiddenParent) {
              set['parentId'] = null;
            }
          } else if (body.parentId !== read || hiddenParent) {
            const problem = parentIssue(tree, body.parentId, hex(id));
            if (problem === null) {
              set['parentId'] = ObjectId.createFromHexString(body.parentId);
            } else {
              issues.push(problem);
            }
          }
        }
      }
      if (body.places !== undefined) {
        const requested: PlaceEntry[] = body.places.map((entry) => ({ placeId: entry.placeId, position: entry.position ?? null, productionCenterId: entry.productionCenterId ?? null }));
        await placesIssues(principal, access, stored['placesAvailability'], requested, issues);
        const before = placesOf(stored['placesAvailability']);
        if (before.length !== requested.length || before.historical || !isDeepStrictEqual(before.entries, requested)) {
          set['placesAvailability'] = placesDocument(stored['placesAvailability'], requested);
        }
      }
      for (const [field, path] of [['printStations', 'printStations'], ['counterPrintStations', 'printStationsNoRooms']] as const) {
        const requested = body[field];
        if (requested === undefined) {
          continue;
        }
        await stationsIssues(principal, access, field, requested, stored[path], issues);
        const map = stored[path];
        for (const [placeId, ids] of Object.entries(requested)) {
          const key = placeKey(placeId);
          const exists = isRecord(map) && Object.hasOwn(map, key);
          if (ids === null) {
            if (exists) {
              unset[`${path}.${key}`] = '';
            }
          } else if (exists ? !isDeepStrictEqual(map[key], ids) : ids.length > 0) {
            set[`${path}.${key}`] = ids;
          }
        }
      }
      const media: Partial<Record<MediaKey, Document | string | null>> = {};
      if (access.features.media) {
        for (const [field, key, path] of [['image', 'main', 'medias.images.main'], ['icon', 'icon', 'medias.images.icon']] as const) {
          if (body[field] === undefined) {
            continue;
          }
          const descriptor = await imageOfRequest(principal, access, body[field], field, issues);
          const current = (logo.read(valueAt(stored, path)) as MediaLogo | null)?._id ?? null;
          if (issues.length === 0 && (descriptor?._id ?? null) !== current) {
            media[key] = descriptor === null ? null : legacyLogoDescriptor(descriptor);
          }
        }
        for (const field of ['internalFileName', 'externalUrl'] as const) {
          if (body[field] !== undefined && body[field] !== (textOf(valueAt(stored, `medias.images.${field}`)) ?? null)) {
            media[field] = body[field];
          }
        }
      }
      refuse(issues);
      const written = mediaWrites(stored['medias'], media);
      Object.assign(set, written.set);
      Object.assign(unset, written.unset);
      if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
        return resultOf(principal, access, stored, await loadTree(principal, access));
      }
      // Saving a category that has the historical availability (a list of place ids) rewrites it in the current form.
      if (set['placesAvailability'] === undefined && placesOf(stored['placesAvailability']).historical) {
        set['placesAvailability'] = modernPlaces(stored['placesAvailability'] as unknown[]);
      }
      const readDate: unknown = stored['updateDate'];
      const clock = new Date(deps.now());
      // Strictly after the date read, so that two changes within the same millisecond still have different versions.
      const updateDate = readDate instanceof Date && readDate.getTime() >= clock.getTime() ? new Date(readDate.getTime() + 1) : clock;
      const touched = [...Object.keys(set), ...Object.keys(unset)];
      const intact = [...new Set(touched.flatMap((path) => (path.includes('.') && (LEAF_CONTAINERS as readonly string[]).includes(path.split('.')[0]!) ? [path.split('.')[0]!] : [])))];
      // A write holds only while the places are what was read too: the legacy writes them without touching `updateDate`.
      if ((await repository.update(principal, access, id, { set, unset, updateDate, readPlaces: stored['placesAvailability'], intact }, readDate)) === 'conflict') {
        throw new AppError('CONFLICT');
      }
      const next: Document = { ...applyChange(stored, set, unset), updateDate };
      const tree = await loadTree(principal, access);
      // Without a transaction two requests can each move a category under the other one. The write that finds the cycle undoes itself, so the cycle never stays.
      if (touched.includes('parentId') && tree !== null && onCycle(tree.nodes, hex(id))) {
        const restore = {
          set: Object.fromEntries(touched.filter((path) => valueAt(stored, path) !== undefined).map((path) => [path, valueAt(stored, path)])),
          unset: Object.fromEntries(touched.filter((path) => valueAt(stored, path) === undefined).map((path) => [path, ''])),
        };
        const undone = await repository.update(principal, access, id, { ...restore, updateDate: new Date(updateDate.getTime() + 1), readPlaces: next['placesAvailability'] }, updateDate);
        if (undone === 'conflict') {
          deps.logger.error('product category write could not be undone', { id: hex(id), groupId: hex(access.groupId) });
        }
        throw new AppError('CONFLICT', { details: [{ field: 'parentId', issue: 'incorrect' }] });
      }
      await record(principal, access, client, id, 'productCategory.updated', stored, next);
      return resultOf(principal, access, next, tree);
    },

    remove: async (principal, access, id, client) => {
      const stored = await found(principal, access, id);
      assertWritableCategory(principal, stored['placesAvailability']);
      await guardRemove(principal, access, id);
      // The deletion holds only while the category is as it was read.
      if (!(await repository.remove(principal, access, id, stored['updateDate'], stored['placesAvailability']))) {
        throw new AppError('CONFLICT');
      }
      await record(principal, access, client, id, 'productCategory.deleted', stored, undefined);
    },
  };
}
