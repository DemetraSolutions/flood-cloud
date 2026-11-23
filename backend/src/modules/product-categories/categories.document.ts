import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { legacyLogoDescriptor, logo } from '../companies/company.mapper.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { flagOf, isRecord, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { imageOf } from '../product-catalog/image.ts';
import { textsOf } from '../product-catalog/texts.ts';
import { shownPlaces } from './categories.availability.ts';
import { PLACE_KEY_PREFIX, diningOf, objectIdsValue, plainOf, stationsOf, wholeValue } from './categories.mapper.ts';
import type { CreateCategoryBody } from './categories.schemas.ts';

/** The keys of `medias.images` this backend writes. */
export const MEDIA_KEYS = Object.freeze(['main', 'icon', 'internalFileName', 'externalUrl'] as const);

/** A key of `medias.images` this backend writes. */
export type MediaKey = (typeof MEDIA_KEYS)[number];

/** The containers whose leaves are written one by one (`$set` of a leaf fails when the container is not an object). */
export const LEAF_CONTAINERS = Object.freeze(['availability', 'integrations', 'roomsSettings', 'tgm', 'printStations', 'printStationsNoRooms'] as const);

/**
 * A number the way the legacy stores it: an integer as `Int32`, a number with decimals as `Double`.
 *
 * @param value A finite number.
 */
export function storedNumber(value: number): Int32 | Double {
  return Number.isInteger(value) ? new Int32(value) : new Double(value);
}

/** The key of a place in the maps of print stations: `__<placeId>`. */
export const placeKey = (placeId: string): string => `${PLACE_KEY_PREFIX}${placeId}`;

/** A map of print stations as the legacy stores it: `{ "__<placeId>": [stationId] }`. */
function stationsDocument(map: Readonly<Record<string, readonly string[]>> | undefined): Document {
  return Object.fromEntries(Object.entries(map ?? {}).map(([placeId, ids]) => [placeKey(placeId), [...ids]]));
}

/** What a new category is made of besides the fields of its body. */
export interface NewCategory {
  readonly id: ObjectId;
  readonly body: CreateCategoryBody;
  /** The language the description is created in when the body has none. */
  readonly language: string;
  readonly parentId: ObjectId | null;
  /** `placesAvailability`, in the current form. */
  readonly places: readonly Document[];
  /** The images chosen from the library. */
  readonly images: Readonly<Partial<Record<'main' | 'icon', MediaLogo>>>;
  readonly now: Date;
}

/**
 * Builds a whole new category in the shape the legacy writes, with the legacy defaults for what the request does not say, and no key the legacy does not have.
 *
 * @param input The body and what the service worked out.
 */
export function newCategoryDocument(input: NewCategory): Document {
  const { body, images } = input;
  const dining = body.dining ?? {};
  const mediaImages: Document = {
    ...(images.main === undefined ? {} : { main: legacyLogoDescriptor(images.main) }),
    ...(images.icon === undefined ? {} : { icon: legacyLogoDescriptor(images.icon) }),
    ...(body.internalFileName == null ? {} : { internalFileName: body.internalFileName }),
    ...(body.externalUrl == null ? {} : { externalUrl: body.externalUrl }),
  };
  return {
    _id: input.id,
    parentId: input.parentId,
    name: body.name,
    description: body.description ?? { [input.language]: '' },
    position: body.position == null ? null : new Int32(body.position),
    productionValue: body.productionValue == null ? null : new Int32(body.productionValue),
    availability: { pos: body.availability?.pos ?? false, ecommerce: body.availability?.ecommerce ?? false },
    noDiscount: body.noDiscount ?? false,
    requiresGreaterAge: body.requiresLegalAge ?? false,
    secondaryFiscalPrinter: body.secondaryFiscalPrinter ?? false,
    featured: body.featured ?? false,
    backgroundColor: body.backgroundColor ?? '#000000',
    textColor: body.textColor ?? '#000000',
    medias: { images: mediaImages },
    placesAvailability: [...input.places],
    variants: (body.modifierIds ?? []).map((id) => ObjectId.createFromHexString(id)),
    variantsCategories: (body.modifierCategoryIds ?? []).map((id) => ObjectId.createFromHexString(id)),
    printStations: stationsDocument(body.printStations),
    printStationsNoRooms: stationsDocument(body.counterPrintStations),
    roomsSettings: {
      endMeal: dining.endOfMeal ?? false,
      handheldHidden: dining.hiddenOnHandheld ?? false,
      percentageFee: dining.feePercentage == null ? null : storedNumber(dining.feePercentage),
      printGroup: dining.printGroup == null ? null : new Int32(dining.printGroup),
      alwaysFirstExit: dining.alwaysFirstCourse ?? false,
      notAffiliatedMenu: dining.notAffiliatedMenu ?? false,
      type: dining.type ?? 'other',
    },
    tgm: { type: body.tobacco ?? false },
    integrations: { floodOrders: body.integrations?.floodOrders ?? false, easyappear: false, yellgo: body.integrations?.yellgo ?? false, leggimenu: body.integrations?.leggimenu ?? false },
    status: body.enabled ?? true,
    insertDate: input.now,
    updateDate: input.now,
  };
}

/** What a write of the media keys does. */
export interface MediaWrites {
  /** The `$set`. */
  readonly set: Document;
  /** The `$unset`. */
  readonly unset: Document;
}

/**
 * Works out how the keys of `medias.images` are stored or removed while every other key of `medias` stays: a leaf each (`medias.images.icon`); when `medias.images` is missing or is not an object
 * the smallest container that holds the leaves is written instead, so the write never fails on a document the legacy left in a strange shape. A removal from a place that is not there writes nothing.
 *
 * @param stored The stored `medias`, of any type.
 * @param changes The keys to set (a descriptor or a text) or to remove (`null`).
 */
export function mediaWrites(stored: unknown, changes: Readonly<Partial<Record<MediaKey, Document | string | null>>>): MediaWrites {
  const entries = Object.entries(changes) as Array<[MediaKey, Document | string | null]>;
  const images = isRecord(stored) ? stored['images'] : undefined;
  const sets = entries.flatMap(([key, value]) => (value === null ? [] : [[key, value] as const]));
  if (!isRecord(images)) {
    // Nothing is there to remove; what is set goes in the smallest container that holds it.
    if (sets.length === 0) {
      return { set: {}, unset: {} };
    }
    const written = Object.fromEntries(sets);
    return isRecord(stored) ? { set: { 'medias.images': written }, unset: {} } : { set: { medias: { images: written } }, unset: {} };
  }
  return {
    set: Object.fromEntries(sets.map(([key, value]) => [`medias.images.${key}`, value])),
    unset: Object.fromEntries(entries.filter(([key, value]) => value === null && Object.hasOwn(images, key)).map(([key]) => [`medias.images.${key}`, ''])),
  };
}

/**
 * The document after a write: the paths set and unset applied to a copy of the stored one, along the path (every object on it is copied, nothing is shared with the stored document). The numbers
 * written as `Int32`/`Double` are read back as plain numbers, as the database gives them, so a version computed on the result is the one a later read gives.
 *
 * @param stored The stored document.
 * @param set The `$set` of the write, dotted paths.
 * @param unset The `$unset` of the write, dotted paths.
 */
export function applyChange(stored: Document, set: Document, unset: Document): Document {
  const next: Document = { ...stored };
  const put = (path: string, value: unknown): void => {
    const segments = path.split('.');
    const last = segments[segments.length - 1]!;
    let target = next;
    for (const segment of segments.slice(0, -1)) {
      const current = target[segment] as unknown;
      target[segment] = isRecord(current) ? { ...current } : {};
      target = target[segment] as Document;
    }
    if (value === undefined) {
      delete target[last];
    } else {
      target[last] = value instanceof Int32 || value instanceof Double ? value.valueOf() : value;
    }
  };
  for (const [path, value] of Object.entries(set)) {
    put(path, value);
  }
  for (const path of Object.keys(unset)) {
    put(path, undefined);
  }
  return next;
}

/**
 * What the activity log keeps of a category: its fields, never anything the backend does not own; of the places and of the print stations only the ones the actor may see. (The switches of the
 * integrations are logged as `publishing`: the log hides every field named `integrations`.)
 *
 * @param principal The actor.
 * @param document The stored category.
 * @param reachable The categories the actor reaches, `null` when nothing is held back: of the categories of modifiers only these are logged.
 */
export function categoryLoggable(principal: AuthPrincipal, document: Document, reachable: ReadonlySet<string> | null = null): Record<string, unknown> {
  const allowed = perimeterOf(principal);
  const places = shownPlaces(principal, document['placesAvailability']);
  const parent = document['parentId'];
  return {
    parentId: parent instanceof ObjectId ? parent.toHexString() : null,
    name: textsOf(document['name']),
    description: textsOf(document['description']),
    enabled: document['status'] === true,
    position: wholeValue(document['position']),
    productionValue: wholeValue(document['productionValue']),
    availability: { pos: flagOf(valueAt(document, 'availability.pos')), ecommerce: flagOf(valueAt(document, 'availability.ecommerce')) },
    noDiscount: flagOf(document['noDiscount']),
    requiresLegalAge: flagOf(document['requiresGreaterAge']),
    secondaryFiscalPrinter: flagOf(document['secondaryFiscalPrinter']),
    featured: flagOf(document['featured']),
    publishing: { floodOrders: flagOf(valueAt(document, 'integrations.floodOrders')), yellgo: flagOf(valueAt(document, 'integrations.yellgo')), leggimenu: flagOf(valueAt(document, 'integrations.leggimenu')) },
    dining: diningOf(document),
    tobacco: flagOf(valueAt(document, 'tgm.type')),
    backgroundColor: textOf(plainOf(document['backgroundColor'])),
    textColor: textOf(plainOf(document['textColor'])),
    modifierIds: objectIdsValue(document['variants']),
    modifierCategoryIds: objectIdsValue(document['variantsCategories']).filter((id) => reachable === null || reachable.has(id)),
    printStations: stationsOf(document['printStations'], allowed),
    counterPrintStations: stationsOf(document['printStationsNoRooms'], allowed),
    placeIds: places.map((entry) => entry.placeId),
    placeDetails: places,
    imageId: imageOf(document)?._id ?? null,
    iconId: (logo.read(valueAt(document, 'medias.images.icon')) as MediaLogo | null)?._id ?? null,
    internalFileName: textOf(valueAt(document, 'medias.images.internalFileName')),
    // The address without its query string: it may carry a token.
    externalUrl: textOf(valueAt(document, 'medias.images.externalUrl'))?.split(/[?#]/)[0] ?? null,
  };
}
