import { CatalogImage, LocalizedText } from '../product-catalog/product-catalog.types';

/** Path segment of the categories under `/v1/groups/{groupId}` and under `/groups/:groupId` in the router. */
export const CATEGORIES_SEGMENT = 'product-categories';

/** Limits of the server (`doc/API.md`, "Catalogo: categorie di prodotto"). */
export const CATEGORY_LIMITS = Object.freeze({
  /** Largest position and production value. */
  number: 1_000_000,
  /** Largest incentive percentage. */
  percentage: 100,
  internalFileName: 255,
  externalUrl: 2048,
});

/** The twelve quick colors of the legacy form of the buttons of the cash app. */
export const QUICK_COLORS: readonly string[] = Object.freeze([
  '#ff8064',
  '#ffbf77',
  '#c69aff',
  '#f7bed3',
  '#ff7c9f',
  '#a2624e',
  '#c6a599',
  '#ac9879',
  '#b0b279',
  '#91bcb4',
  '#407674',
  '#5c98b1',
]);

/** Color of the buttons when the document has none. */
export const DEFAULT_COLOR = '#000000';

/** Kind of a category of a restaurant. */
export type DiningType = 'other' | 'food' | 'beverage';

/** The kinds of a category of a restaurant, in the order of the legacy form. */
export const DINING_TYPES: readonly DiningType[] = Object.freeze(['other', 'food', 'beverage']);

/** The settings of a category in a restaurant (only for the groups with the `rooms` feature). */
export interface Dining {
  readonly endOfMeal: boolean;
  readonly hiddenOnHandheld: boolean;
  readonly feePercentage: number | null;
  readonly printGroup: number | null;
  readonly alwaysFirstCourse: boolean;
  readonly notAffiliatedMenu: boolean;
  readonly type: DiningType;
}

/** A store a category is available in. */
export interface CategoryPlace {
  readonly placeId: string;
  readonly position: number | null;
  readonly productionCenterId: string | null;
}

/** Print stations by store: the ids of the stations of the store. */
export type StationsByPlace = Readonly<Record<string, readonly string[]>>;

/** A category as the server returns it (list and detail). Fields of a feature the group does not have are absent. */
export interface Category {
  readonly id: string;
  readonly parentId: string | null;
  /** The parent exists but the caller cannot see it (company and store administrators): `parentId` is then `null`. */
  readonly parentHidden?: boolean;
  /** Level below the roots (below the perimeter of the caller); `null` in a group with too many categories. */
  readonly depth: number | null;
  /** The category closes a cycle of parents of the old system. */
  readonly cyclic: boolean;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly enabled: boolean;
  readonly position: number | null;
  readonly productionValue: number | null;
  readonly availability?: { readonly pos?: boolean; readonly ecommerce?: boolean };
  readonly noDiscount: boolean;
  readonly requiresLegalAge: boolean;
  readonly secondaryFiscalPrinter?: boolean;
  readonly featured?: boolean;
  readonly integrations: {
    readonly floodOrders: boolean;
    readonly yellgo: boolean;
    readonly leggimenu: boolean;
  };
  readonly dining?: Dining;
  readonly tobacco?: boolean;
  readonly backgroundColor?: string | null;
  readonly textColor: string | null;
  readonly modifierIds?: readonly string[];
  readonly modifierCategoryIds?: readonly string[];
  readonly printStations?: StationsByPlace;
  readonly counterPrintStations?: StationsByPlace;
  /** Empty means every store. */
  readonly places: readonly CategoryPlace[];
  /** Whether the caller may change and delete the category (absent means yes). */
  readonly editable?: boolean;
  readonly image?: CatalogImage | null;
  readonly icon?: CatalogImage | null;
  readonly internalFileName?: string | null;
  readonly externalUrl?: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A node of the compact tree (`GET …/product-categories/tree`). */
export interface CategoryNode {
  readonly id: string;
  /** In the language of the user; `null` when the category has no text. */
  readonly name: string | null;
  readonly parentId: string | null;
  /** See {@link Category.parentHidden}. */
  readonly parentHidden?: boolean;
  readonly position: number | null;
  readonly enabled: boolean;
  readonly children: readonly CategoryNode[];
}

/** A node of the tree with its level, in reading order. */
export interface FlatNode {
  readonly node: CategoryNode;
  /** Level below the roots, from 0. */
  readonly level: number;
}

/** The features of the group that decide which fields and tabs a category has. */
export interface CategoryFeatures {
  readonly cash: boolean;
  readonly customersApp: boolean;
  readonly tobaccosGamesMonopoly: boolean;
  readonly productsVariants: boolean;
  readonly ordering: boolean;
  readonly rooms: boolean;
  readonly media: boolean;
}

/** The features a category depends on (names of the features of the group). */
export const CATEGORY_FEATURES = Object.freeze([
  'cash',
  'customersApp',
  'tobaccosGamesMonopoly',
  'productsVariants',
  'ordering',
  'rooms',
  'media',
] as const);

/** The categories of the tree in reading order (each one before its children), with their level. */
export function flatten(nodes: readonly CategoryNode[], level = 0): FlatNode[] {
  return nodes.flatMap((node) => [{ node, level }, ...flatten(node.children, level + 1)]);
}

/** The ids of a category and of every category below it (what a category cannot be the child of). */
export function selfAndDescendants(nodes: readonly CategoryNode[], id: string): ReadonlySet<string> {
  const found = flatten(nodes).find((entry) => entry.node.id === id);
  return new Set(found === undefined ? [id] : flatten([found.node]).map((entry) => entry.node.id));
}

/** The text of a node: its name, the empty-name text for none. */
export function nodeName(node: CategoryNode, empty: string): string {
  return node.name === null || node.name === '' ? empty : node.name;
}

/** Whether the parent of a category exists but is not visible to the caller (the only place that names the field). */
export function hasHiddenParent(category: { readonly parentHidden?: boolean }): boolean {
  return category.parentHidden === true;
}

/** Whether the server lets the caller change and delete a category (`true` when it does not say otherwise). */
export function isCategoryEditable(category: { readonly editable?: boolean }): boolean {
  return category.editable !== false;
}

/**
 * Router link of the list of the categories, of one category or of the page of a new one.
 *
 * @param groupId Group of the categories.
 * @param categoryId The category; `null` for the page of a new one, omitted for the list.
 */
export function categoryRoute(groupId: string, categoryId?: string | null): string[] {
  const base = ['/groups', groupId, CATEGORIES_SEGMENT];
  return categoryId === undefined ? base : [...base, categoryId === null ? 'new' : categoryId];
}
