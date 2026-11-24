import { localizedName } from '../../db/localized-name.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { array, boolean, enumOf, integer, integerString, nullable, number, object, optional, record, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { SAFE_ID } from '../groups/catalogs/kit.ts';
import { atLeastOne, imageSchema } from '../product-catalog/entity.schemas.ts';
import { descriptionTexts, descriptionTextsPatch, nameTexts, nameTextsPatch } from '../product-catalog/texts.ts';
import { MAX_CATEGORY_PLACES } from './categories.availability.ts';
import { DINING_TYPES } from './categories.mapper.ts';

/** Largest page of a list of categories. */
export const MAX_CATEGORIES_PAGE = 100;

/** Most modifier products one category may have, and most categories of modifiers. */
export const MAX_MODIFIERS = 1000;
export const MAX_MODIFIER_CATEGORIES = 200;

/** Most places the print stations of one category may name (the places of a group), and most stations of one place. */
export const MAX_STATION_PLACES = 200;
export const MAX_STATIONS = 100;

/** Largest body of a write of a category: the texts in twenty languages, a thousand modifiers and two hundred places fit with a wide margin. */
export const CATEGORY_BODY_LIMIT = '128kb';

/** Largest number a position, a production value or a print group may have. */
const MAX_NUMBER = 1_000_000;

const HEX_ID = /^[0-9a-f]{24}$/;
const hexId = () => string({ min: 24, max: 24, pattern: HEX_ID });

/**
 * How the categories are sorted and searched: by name (the text in the language of the caller, or the first one the category has) by default, or by position (a position that is not a number, `NaN` included,
 * sorts first); `q` is looked for in the name, in every language, as literal text. The fields below name what is sorted; {@link categoriesListFor} gives the expression of the language of the caller.
 */
export const CATEGORIES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
    position: Object.freeze({ field: 'position', kind: 'number' as const }),
  }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});

/**
 * The sorts of the categories for the language of the caller.
 *
 * @param language The language of the caller.
 */
export function categoriesListFor(language: string): ListConfig {
  return { ...CATEGORIES_LIST, sorts: { name: { field: 'name', kind: 'string', expression: localizedName(language) }, position: CATEGORIES_LIST.sorts['position']! } };
}

/** How a download of the changes of the categories is ordered: by the date of the last change, oldest first; no search and no other sort. */
export const CATEGORY_CHANGES_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }) }),
  defaultSort: 'updatedAt',
  searchFields: Object.freeze([]),
});

/** What a read of the changes of the categories asks: the page and the instant the changes are counted from (every category when left out). */
export interface CategoryChangesQuery {
  readonly limit?: number;
  readonly cursor?: string;
  /** An instant, normalized ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  readonly updatedSince?: string;
  /** Only the enabled categories, with or without `updatedSince` (what an integration lists when it asks for no instant). */
  readonly activeOnly?: boolean;
}

/** The `true`/`false` of a query string. */
const flag = () => transform(enumOf(['true', 'false']), (value) => value === 'true', 'enum');

/** Query of the list of the categories: the standard parameters, the state, and the parent (an id, or `null` for the roots). */
export const categoriesQuery = object({
  ...listQueryShape(CATEGORIES_LIST),
  limit: optional(integerString({ min: 1, max: MAX_CATEGORIES_PAGE })),
  enabled: optional(flag()),
  parentId: optional(string({ min: 4, max: 24, pattern: /^(null|[0-9a-f]{24})$/ })),
});

/** The validated query of the list of categories. */
export type CategoriesQuery = Infer<typeof categoriesQuery>;

const position = () => nullable(integer({ min: 0, max: MAX_NUMBER }));
const color = () => transform(string({ min: 7, max: 7, pattern: /^#[0-9A-Fa-f]{6}$/ }), (value) => value.toLowerCase(), 'pattern');
const stationId = () => string({ min: 1, max: 64, pattern: SAFE_ID });
const stations = () => array(stationId(), { max: MAX_STATIONS, unique: true });

/** A place of the availability: the place, the position of the category in it and the production center of the place. */
const placeEntry = () => object({ placeId: hexId(), position: optional(position()), productionCenterId: optional(nullable(stationId())) });

/** The availability: the places, without repetitions (`places.<index>.placeId` `incorrect` for a place named twice). */
const places = () =>
  refine(
    array(placeEntry(), { max: MAX_CATEGORY_PLACES }),
    (value) => value.flatMap((entry, index) => (value.findIndex((other) => other.placeId === entry.placeId) === index ? [] : [`${String(index)}.placeId`])),
    'incorrect',
  );

/** The text of a file name or of a URL: one line, no control characters. */
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;

/** An external URL: `https` only, no user or password, at most 2048 characters. */
const externalUrl = () =>
  transform(
    string({ min: 1, max: 2048, trim: true, pattern: NO_CONTROL }),
    (value) => {
      const url = URL.canParse(value) ? new URL(value) : null;
      return url !== null && url.protocol === 'https:' && url.username === '' && url.password === '' ? value : undefined;
    },
    'format',
  );

const internalFileName = () => string({ min: 1, max: 255, trim: true, pattern: NO_CONTROL });

/** Settings of a category in a restaurant: all optional, a change sets only what it names. */
const dining = () =>
  object({
    endOfMeal: optional(boolean()),
    hiddenOnHandheld: optional(boolean()),
    feePercentage: optional(nullable(number({ min: 0, max: 100 }))),
    printGroup: optional(nullable(integer({ min: 0, max: MAX_NUMBER }))),
    alwaysFirstCourse: optional(boolean()),
    notAffiliatedMenu: optional(boolean()),
    type: optional(enumOf(DINING_TYPES)),
  });

/** What a creation and a modification have in common: every field optional but the name of a creation. */
export function commonShape() {
  return {
    parentId: optional(nullable(hexId())),
    enabled: optional(boolean()),
    position: optional(position()),
    productionValue: optional(position()),
    availability: optional(object({ pos: optional(boolean()), ecommerce: optional(boolean()) })),
    noDiscount: optional(boolean()),
    requiresLegalAge: optional(boolean()),
    secondaryFiscalPrinter: optional(boolean()),
    featured: optional(boolean()),
    integrations: optional(object({ floodOrders: optional(boolean()), yellgo: optional(boolean()), leggimenu: optional(boolean()) })),
    dining: optional(dining()),
    tobacco: optional(boolean()),
    backgroundColor: optional(color()),
    textColor: optional(color()),
    modifierIds: optional(array(hexId(), { max: MAX_MODIFIERS, unique: true })),
    modifierCategoryIds: optional(array(hexId(), { max: MAX_MODIFIER_CATEGORIES, unique: true })),
    places: optional(places()),
    image: optional(imageSchema()),
    icon: optional(imageSchema()),
    internalFileName: optional(nullable(internalFileName())),
    externalUrl: optional(nullable(externalUrl())),
  };
}

/** The print stations of a creation: for each place, the ids of its stations. */
const stationsByPlace = () => record(stations(), { max: MAX_STATION_PLACES, key: HEX_ID });

/** The print stations of a modification: for each place named, its stations, or `null` to take the place away; the places not named stay. */
const stationsByPlacePatch = () => record(nullable(stations()), { max: MAX_STATION_PLACES, key: HEX_ID });

/** The fields of a creation, over the common ones. */
export const createFields = <S extends Parameters<typeof object>[0]>(shape: S) => ({
  ...shape,
  name: nameTexts(),
  description: optional(descriptionTexts()),
  printStations: optional(stationsByPlace()),
  counterPrintStations: optional(stationsByPlace()),
});

/** The fields of a modification, over the common ones. */
export const patchFields = <S extends Parameters<typeof object>[0]>(shape: S) => ({
  ...shape,
  name: optional(nameTextsPatch()),
  description: optional(descriptionTextsPatch()),
  printStations: optional(stationsByPlacePatch()),
  counterPrintStations: optional(stationsByPlacePatch()),
});

/** The common fields without the ones the server of a point of sale never writes: `image` and `icon` (the library of images is not its to use). Such a key is `422` `unknown` and nothing is written. */
export const STORE_EXCLUDED_CATEGORY_FIELDS = Object.freeze(['image', 'icon'] as const);
function storeShape() {
  const { image: _image, icon: _icon, ...rest } = commonShape();
  return rest;
}

/** Body of `POST /v1/groups/{groupId}/product-categories`: only the name is required. Nothing else is accepted. */
export const createCategoryBody = object(createFields(commonShape()));

/** Validated body of a creation. */
export type CreateCategoryBody = Infer<typeof createCategoryBody>;

/** Body of `PATCH /v1/groups/{groupId}/product-categories/{id}`: any of the fields, at least one (`required` on the body otherwise). */
export const patchCategoryBody = atLeastOne(object(patchFields(commonShape())));

/** Body of `POST /v1/store-context/catalog/categories`: the one of the backoffice without {@link STORE_EXCLUDED_CATEGORY_FIELDS}. */
export const storeCreateCategoryBody = object(createFields(storeShape())) as unknown as typeof createCategoryBody;

/** Body of `PATCH /v1/store-context/catalog/categories/{id}`: the one of the backoffice without {@link STORE_EXCLUDED_CATEGORY_FIELDS}. */
export const storePatchCategoryBody = atLeastOne(object(patchFields(storeShape()))) as unknown as typeof patchCategoryBody;

/** Validated body of a modification. */
export type PatchCategoryBody = Infer<typeof patchCategoryBody>;
