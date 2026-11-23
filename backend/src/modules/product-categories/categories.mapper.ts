import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { logo } from '../companies/company.mapper.ts';
import type { FeatureFlags } from '../groups/features.ts';
import { dateOf, flagOf, isRecord, numberOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { imageOf } from '../product-catalog/image.ts';
import type { Texts } from '../product-catalog/texts.ts';
import { textsOf } from '../product-catalog/texts.ts';
import { isWritableCategory, shownPlaces } from './categories.availability.ts';
import type { PlaceEntry } from './categories.availability.ts';

/** The kinds of category of a restaurant, `roomsSettings.type`. */
export const DINING_TYPES = Object.freeze(['other', 'food', 'beverage'] as const);

/** A kind of category of a restaurant. */
export type DiningType = (typeof DINING_TYPES)[number];

/** The prefix of the keys of the maps of print stations: `__<placeId>`. */
export const PLACE_KEY_PREFIX = '__';

/** The settings of a category in a restaurant (`roomsSettings`), in the domain form. */
export interface Dining {
  /** `endMeal`: the category is served at the end of the meal. */
  readonly endOfMeal: boolean;
  /** `handheldHidden`: hidden on the handheld terminals. */
  readonly hiddenOnHandheld: boolean;
  /** `percentageFee`: the incentive percentage, `null` for none. */
  readonly feePercentage: number | null;
  /** `printGroup`: the print group, `null` for none. */
  readonly printGroup: number | null;
  /** `alwaysFirstExit`: always in the first course. */
  readonly alwaysFirstCourse: boolean;
  /** `notAffiliatedMenu`: not part of the affiliated menu. */
  readonly notAffiliatedMenu: boolean;
  readonly type: DiningType;
}

/** The print stations of a category by place: the ids of the stations of the place. */
export type StationsByPlace = Readonly<Record<string, readonly string[]>>;

/** What every category shows apart from its place in the tree. The fields of a function of the group the group does not have are left out. */
export interface CategoryView {
  readonly id: string;
  readonly name: Texts;
  readonly description: Texts;
  readonly enabled: boolean;
  readonly position: number | null;
  readonly productionValue: number | null;
  /** Where the category is available; only the switches of the functions the group has (`pos` with `cash`, `ecommerce` with `customersApp`); not at all when it has neither. */
  readonly availability?: { readonly pos?: boolean; readonly ecommerce?: boolean };
  readonly noDiscount: boolean;
  /** `requiresGreaterAge`: the products of the category are sold only to adults. */
  readonly requiresLegalAge: boolean;
  /** Only with `tobaccosGamesMonopoly`. */
  readonly secondaryFiscalPrinter?: boolean;
  /** Only with `customersApp`. */
  readonly featured?: boolean;
  /** The switches of the publication on the integrations the group has not to be asked about (`floodOrders`, `yellgo`, `leggimenu`); `easyappear` is kept and never shown. */
  readonly integrations: { readonly floodOrders: boolean; readonly yellgo: boolean; readonly leggimenu: boolean };
  /** Only with `rooms`. */
  readonly dining?: Dining;
  /** `tgm.type`: a category of tobaccos, games and monopoly; only with `tobaccosGamesMonopoly`. */
  readonly tobacco?: boolean;
  /** Only with `cash`; `#RRGGBB`, `null` when the document holds something else. */
  readonly backgroundColor?: string | null;
  readonly textColor: string | null;
  /** The modifier products of the category (`variants`); only with `productsVariants`. */
  readonly modifierIds?: readonly string[];
  /** The categories of modifiers of the category (`variantsCategories`); only with `productsVariants`. */
  readonly modifierCategoryIds?: readonly string[];
  /** The print stations of the orders in the rooms, by place; only with `ordering`. A company or place administrator is shown only the places of his perimeter. */
  readonly printStations?: StationsByPlace;
  /** The print stations of the orders at the counter, by place; only with `ordering`. */
  readonly counterPrintStations?: StationsByPlace;
  /** The places the category is for, empty for every place. A company or place administrator is shown only the ones of his perimeter. */
  readonly places: readonly PlaceEntry[];
  /** Whether the caller may modify and delete the category (computed by the server). */
  readonly editable: boolean;
  /** Only with `media`. */
  readonly image?: MediaLogo | null;
  readonly icon?: MediaLogo | null;
  readonly internalFileName?: string | null;
  readonly externalUrl?: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** A number as `Int32`/`Double` wrapper (a document this backend has just built) or plain number (one read from the database), read as a plain one. */
export function plainOf(raw: unknown): unknown {
  return raw instanceof Int32 || raw instanceof Double ? raw.valueOf() : raw;
}

/** A finite number, `null` for `NaN`, a text, a missing value: what the legacy left in the numbers of a category. */
export function numberValue(raw: unknown): number | null {
  return numberOf(plainOf(raw));
}

/** A whole number, `null` for `NaN`, a fraction, a text, a missing value. */
export function wholeValue(raw: unknown): number | null {
  const value = numberValue(raw);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

/** The `ObjectId`s of a stored list as hexadecimal text; the other elements of the list are left out. */
export function objectIdsValue(raw: unknown): string[] {
  return (Array.isArray(raw) ? (raw as unknown[]) : []).flatMap((item) => (item instanceof ObjectId ? [item.toHexString()] : []));
}

const COLOR = /^#[0-9A-Fa-f]{6}$/;

/** A colour as `#RRGGBB`, `null` for anything else. */
export function colorValue(raw: unknown): string | null {
  return typeof raw === 'string' && COLOR.test(raw) ? raw : null;
}

/** The kind of category of a restaurant, `other` for anything the document holds that is not a known kind. */
export function diningTypeOf(raw: unknown): DiningType {
  return (DINING_TYPES as readonly unknown[]).includes(raw) ? (raw as DiningType) : 'other';
}

/** The settings of a category in a restaurant, read tolerantly (a missing flag is off, a number that is not one is `null`, a kind that is not known is `other`). */
export function diningOf(document: Document): Dining {
  const settings = (path: string): unknown => valueAt(document, `roomsSettings.${path}`);
  return {
    endOfMeal: flagOf(settings('endMeal')),
    hiddenOnHandheld: flagOf(settings('handheldHidden')),
    feePercentage: numberValue(settings('percentageFee')),
    printGroup: wholeValue(settings('printGroup')),
    alwaysFirstCourse: flagOf(settings('alwaysFirstExit')),
    notAffiliatedMenu: flagOf(settings('notAffiliatedMenu')),
    type: diningTypeOf(settings('type')),
  };
}

/**
 * The print stations by place of a stored map `{ "__<placeId>": [stationId] }`, read tolerantly: the keys that are `__` and a place id, the elements that are texts. When a perimeter is given only
 * its places are returned (the other ones are stored and kept, never shown).
 *
 * @param raw The stored map, of any type.
 * @param allowed The places the caller may see, `null` for all of them.
 */
export function stationsOf(raw: unknown, allowed: ReadonlySet<string> | null): StationsByPlace {
  const entries = Object.entries(isRecord(raw) ? raw : {}).flatMap(([key, value]) => {
    const placeId = key.startsWith(PLACE_KEY_PREFIX) ? key.slice(PLACE_KEY_PREFIX.length) : '';
    if (!/^[0-9a-f]{24}$/.test(placeId) || (allowed !== null && !allowed.has(placeId))) {
      return [];
    }
    return [[placeId, (Array.isArray(value) ? (value as unknown[]) : []).filter((item): item is string => typeof item === 'string')] as const];
  });
  return Object.fromEntries(entries);
}

/**
 * Reads a stored category into its domain form for a caller.
 *
 * @param document The stored document, read with every owned field.
 * @param principal The caller, whose perimeter decides the places and print stations shown and whether the category is editable.
 * @param features The features of the group: a field of a function the group does not have is left out.
 * @param reachable The categories the caller reaches, `null` when nothing is held back: of the categories of modifiers only these are shown.
 */
export function categoryView(document: Document, principal: AuthPrincipal, features: FeatureFlags, reachable: ReadonlySet<string> | null = null): CategoryView {
  const allowed = perimeterOf(principal);
  const switches = {
    ...(features.cash ? { pos: flagOf(valueAt(document, 'availability.pos')) } : {}),
    ...(features.customersApp ? { ecommerce: flagOf(valueAt(document, 'availability.ecommerce')) } : {}),
  };
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: textsOf(document['name']),
    description: textsOf(document['description']),
    enabled: document['status'] === true,
    position: wholeValue(document['position']),
    productionValue: wholeValue(document['productionValue']),
    ...(Object.keys(switches).length === 0 ? {} : { availability: switches }),
    noDiscount: flagOf(document['noDiscount']),
    requiresLegalAge: flagOf(document['requiresGreaterAge']),
    ...(features.tobaccosGamesMonopoly ? { secondaryFiscalPrinter: flagOf(document['secondaryFiscalPrinter']) } : {}),
    ...(features.customersApp ? { featured: flagOf(document['featured']) } : {}),
    integrations: {
      floodOrders: flagOf(valueAt(document, 'integrations.floodOrders')),
      yellgo: flagOf(valueAt(document, 'integrations.yellgo')),
      leggimenu: flagOf(valueAt(document, 'integrations.leggimenu')),
    },
    ...(features.rooms ? { dining: diningOf(document) } : {}),
    ...(features.tobaccosGamesMonopoly ? { tobacco: flagOf(valueAt(document, 'tgm.type')) } : {}),
    ...(features.cash ? { backgroundColor: colorValue(document['backgroundColor']) } : {}),
    textColor: colorValue(document['textColor']),
    ...(features.productsVariants ? { modifierIds: objectIdsValue(document['variants']), modifierCategoryIds: objectIdsValue(document['variantsCategories']).filter((id) => reachable === null || reachable.has(id)) } : {}),
    ...(features.ordering ? { printStations: stationsOf(document['printStations'], allowed), counterPrintStations: stationsOf(document['printStationsNoRooms'], allowed) } : {}),
    places: shownPlaces(principal, document['placesAvailability']),
    editable: isWritableCategory(principal, document['placesAvailability']),
    ...(features.media
      ? {
          image: imageOf(document),
          icon: logo.read(valueAt(document, 'medias.images.icon')) as MediaLogo | null,
          internalFileName: textOf(valueAt(document, 'medias.images.internalFileName')),
          externalUrl: textOf(valueAt(document, 'medias.images.externalUrl')),
        }
      : {}),
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}
