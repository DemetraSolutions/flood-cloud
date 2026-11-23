import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { logo } from '../companies/company.mapper.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { flagOf, isRecord, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { imageOf } from '../product-catalog/image.ts';
import { textsOf } from '../product-catalog/texts.ts';
import { stationsOf } from '../product-categories/categories.mapper.ts';
import { shownProductPlaces } from './products.availability.ts';
import {
  MODULAR_PRICE_RULES,
  barcodesOf,
  componentsOf,
  familyOf,
  idOf,
  idsOf,
  isModifierProduct,
  menuOf,
  modifierChoicesOf,
  modifierTypeOf,
  stockOf,
  suppliersOf,
  typeOf,
} from './products.mapper.ts';
import { instantOf, pricesOf } from './products.pricing.ts';

/** The keys of `medias.images` this backend writes. */
export const MEDIA_WRITE_KEYS = Object.freeze(['main', 'gallery', 'internalFileName', 'externalUrl'] as const);

/** A key of `medias.images` this backend writes. */
export type MediaWriteKey = (typeof MEDIA_WRITE_KEYS)[number];

/** What a write of the media keys does. */
export interface MediaWrites {
  /** The `$set`. */
  readonly set: Document;
  /** The `$unset`. */
  readonly unset: Document;
}

/**
 * Works out how the keys of `medias.images` are stored or removed while every other key of `medias` stays: a leaf each (`medias.images.gallery`); when `medias.images` is missing or is not an object the
 * smallest container that holds the leaves is written instead, so the write never fails on a document the legacy left in a strange shape. A removal from a place that is not there writes nothing.
 *
 * @param stored The stored `medias`, of any type.
 * @param changes The keys to set (a descriptor, a list of descriptors or a text) or to remove (`null`).
 */
export function mediaWrites(stored: unknown, changes: Readonly<Partial<Record<MediaWriteKey, unknown>>>): MediaWrites {
  const entries = Object.entries(changes) as Array<[MediaWriteKey, unknown]>;
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

/** What the legacy writes in `lastAveragePrice` when a product is inserted: no supplier and every cost at zero. The warehouse maintains it from then on. */
function zeroCosts(): Document {
  return {
    lastSupplierId: null,
    total: { year: null, lastPrice: 0, totalN: 0, totalCost: 0, averagePrice: 0, totalQuantity: 0, totalCostQt: 0, weightedAveragePrice: 0 },
    suppliers: {},
  };
}

/** What a blank product starts from. */
export interface BlankProduct {
  readonly id: ObjectId;
  readonly type: string;
  readonly isModifier: boolean;
  readonly now: Date;
}

/**
 * The document a creation starts from: every key the legacy backoffice writes in an insert, with the defaults of its form and the arrays always present; the request is then applied on it like a modification. The
 * keys the legacy never fills (`tags`, `related`, `parentId`) are empty, `lastAveragePrice` is zeroed, and `variant.pricePercentagePlus` and `variant.pricePercentageMinus` are kept (the legacy insert lost them).
 *
 * @param input The id, the type, whether the product is a modifier and the date.
 */
export function blankProduct(input: BlankProduct): Document {
  return {
    _id: input.id,
    type: input.type,
    time: '',
    max: null,
    code: '',
    barcode: [],
    brandId: null,
    name: {},
    shortName: {},
    description: {},
    shortDescription: {},
    favorite: false,
    favoriteHandheld: false,
    generic: false,
    toCheck: false,
    noDiscount: false,
    printStations: {},
    printStationsNoRooms: {},
    availability: { pos: true, warehouse: false, scales: false, ecommerce: false },
    plu: '',
    scaleType: new Int32(0),
    variant: { status: input.isModifier, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: {} },
    variantsRequired: [],
    variants: [],
    variantsExcluded: [],
    variantsCategories: [],
    bundleProducts: [],
    selectableBundleProducts: [],
    selectableVariantsBundleProducts: [],
    modularBundle: { priceRule: null },
    measureLoad: null,
    measureDownload: null,
    measureConversionRatio: new Int32(1),
    quantity: {},
    lastAveragePrice: zeroCosts(),
    simpleCost: null,
    colors: { pos: { text: '#000000', background: '#000000' } },
    startDate: null,
    endDate: null,
    categories: [],
    placesAvailability: [],
    medias: { images: {} },
    shippingInfo: { width: null, height: null, depth: null, weight: null },
    tags: [],
    related: [],
    attributes: [],
    suppliers: [],
    parentId: null,
    prices: [],
    position: null,
    productionValue: null,
    roomsSettings: { halfPortion: false, percentageFee: null, handheldHidden: false, affiliatedMenu: false, reversePrint: false },
    integrations: { floodOrders: false, easyappear: false, yellgo: false, leggimenu: false },
    featured: false,
    status: true,
    trash: false,
    insertDate: input.now,
    updateDate: input.now,
  };
}

/** The suffix the name of a duplicate gets, in every language. */
export const COPY_SUFFIX = ' (Copy)';

/**
 * The stock of a duplicate: every storage keeps its minimum, its maximum and its location and starts with no quantity.
 *
 * @param raw The stored `quantity`.
 */
function emptiedStock(raw: unknown): Document {
  const places: Document = {};
  for (const [placeKey, storages] of Object.entries(isRecord(raw) ? raw : {})) {
    if (!isRecord(storages)) {
      continue;
    }
    places[placeKey] = Object.fromEntries(
      Object.entries(storages).flatMap(([storageKey, entry]) => (isRecord(entry) ? [[storageKey, { value: 0, min: entry['min'] ?? null, max: entry['max'] ?? null, location: entry['location'] ?? null }]] : [])),
    );
  }
  return places;
}

/**
 * The document of a duplicate of a product: everything the product has, with the name of every language marked as a copy, no code, no PLU and no barcode, no quantity in stock and no cost, a new id and new dates,
 * out of the trash. It is built from the owned fields only (the unknown keys of the POS and of the integrations are not copied).
 *
 * @param stored The stored product, read with every owned field.
 * @param id Id of the copy.
 * @param now Date of the copy.
 */
export function duplicateProduct(stored: Document, id: ObjectId, now: Date): Document {
  const { trashDate: _trashDate, ...rest } = stored;
  return {
    ...rest,
    _id: id,
    name: Object.fromEntries(Object.entries(textsOf(stored['name'])).map(([language, text]) => [language, `${text}${COPY_SUFFIX}`])),
    code: '',
    plu: '',
    barcode: [],
    quantity: emptiedStock(stored['quantity']),
    lastAveragePrice: zeroCosts(),
    integrations: { floodOrders: flagOf(valueAt(stored, 'integrations.floodOrders')), easyappear: false, yellgo: flagOf(valueAt(stored, 'integrations.yellgo')), leggimenu: flagOf(valueAt(stored, 'integrations.leggimenu')) },
    tags: [],
    related: [],
    parentId: null,
    trash: false,
    insertDate: now,
    updateDate: now,
  };
}

/** The most elements of a list the activity log keeps (the rest is counted). */
export const MAX_LOGGED_ITEMS = 20;

/** A list as the activity log keeps it: how many elements it has and the first ones. */
const bounded = (list: readonly unknown[]): { readonly count: number; readonly first: readonly unknown[] } => ({ count: list.length, first: list.slice(0, MAX_LOGGED_ITEMS) });

/**
 * What the activity log keeps of a product: its fields, never anything the backend does not own, with every list cut to {@link MAX_LOGGED_ITEMS} elements and counted, and of the places, the print
 * stations and the stock only the ones the actor may see. The ids of other products, categories, suppliers and of the brand are replaced by their count (or by whether there is a brand) for a company or place administrator, who may not reach all of them. The
 * switches of the integrations are logged as `publishing`: the log hides every field named `integrations`.
 *
 * @param principal The actor.
 * @param document The stored product.
 */
export function productLoggable(principal: AuthPrincipal, document: Document): Record<string, unknown> {
  const allowed = perimeterOf(principal);
  const references = (list: readonly string[]): unknown => (allowed === null ? bounded(list) : { count: list.length });
  const stock = Object.entries(stockOf(document['quantity'], allowed)).flatMap(([placeId, storages]) => Object.entries(storages).map(([storageId, entry]) => ({ placeId, storageId, min: entry.min, max: entry.max, location: entry.location })));
  const stations = (path: 'printStations' | 'printStationsNoRooms'): unknown[] => Object.entries(stationsOf(document[path], allowed)).map(([placeId, stationIds]) => ({ placeId, stationIds }));
  const gallery = valueAt(document, 'medias.images.gallery');
  return {
    type: typeOf(document['type']),
    family: familyOf(document),
    enabled: document['status'] === true,
    code: textOf(document['code']),
    plu: textOf(document['plu']),
    name: textsOf(document['name']),
    shortName: textsOf(document['shortName']),
    description: textsOf(document['description']),
    shortDescription: textsOf(document['shortDescription']),
    favorite: flagOf(document['favorite']),
    favoriteHandheld: flagOf(document['favoriteHandheld']),
    generic: flagOf(document['generic']),
    toCheck: flagOf(document['toCheck']),
    noDiscount: flagOf(document['noDiscount']),
    featured: flagOf(document['featured']),
    availability: { pos: flagOf(valueAt(document, 'availability.pos')), warehouse: flagOf(valueAt(document, 'availability.warehouse')), scales: flagOf(valueAt(document, 'availability.scales')), ecommerce: flagOf(valueAt(document, 'availability.ecommerce')) },
    publishing: { floodOrders: flagOf(valueAt(document, 'integrations.floodOrders')), yellgo: flagOf(valueAt(document, 'integrations.yellgo')), leggimenu: flagOf(valueAt(document, 'integrations.leggimenu')) },
    ...(allowed === null ? { brandId: idOf(document['brandId']) } : { hasBrand: idOf(document['brandId']) !== null }),
    categories: references(idsOf(document['categories'])),
    attributes: bounded(Array.isArray(document['attributes']) ? (document['attributes'] as unknown[]) : []),
    validFrom: instantOf(document['startDate']),
    validTo: instantOf(document['endDate']),
    modifier: isModifierProduct(document) ? { type: modifierTypeOf(valueAt(document, 'variant.type')), plus: valueAt(document, 'variant.pricePercentagePlus') ?? null, minus: valueAt(document, 'variant.pricePercentageMinus') ?? null } : null,
    requiredModifiers: references(idsOf(document['variantsRequired'])),
    modifiers: references(idsOf(document['variants'])),
    excludedModifiers: references(idsOf(document['variantsExcluded'])),
    modifierCategories: references(idsOf(document['variantsCategories'])),
    barcodes: bounded(barcodesOf(document['barcode'], { warehouse: true }).map((barcode) => barcode.value)),
    prices: bounded(pricesOf(document['prices']).map(({ tax: _tax, ...price }) => price)),
    places: bounded(shownProductPlaces(principal, document['placesAvailability'])),
    printStations: bounded(stations('printStations')),
    counterPrintStations: bounded(stations('printStationsNoRooms')),
    stock: bounded(stock),
    suppliers: allowed === null ? bounded(suppliersOf(document['suppliers']).map((supplier) => ({ contactId: supplier.contactId, code: supplier.code }))) : { count: suppliersOf(document['suppliers']).length },
    components: allowed === null ? bounded(componentsOf(document['bundleProducts'])) : { count: componentsOf(document['bundleProducts']).length },
    menu: allowed === null ? bounded(menuOf(document['selectableBundleProducts'], { rooms: true })) : { count: menuOf(document['selectableBundleProducts'], { rooms: true }).length },
    modifierChoices: allowed === null ? bounded(modifierChoicesOf(document['selectableVariantsBundleProducts'])) : { count: modifierChoicesOf(document['selectableVariantsBundleProducts']).length },
    modularPriceRule: (Object.keys(MODULAR_PRICE_RULES) as Array<keyof typeof MODULAR_PRICE_RULES>).find((rule) => MODULAR_PRICE_RULES[rule] === valueAt(document, 'modularBundle.priceRule')) ?? null,
    imageId: imageOf(document)?._id ?? null,
    gallery: bounded((Array.isArray(gallery) ? (gallery as unknown[]) : []).flatMap((item) => ((logo.read(item) as MediaLogo | null)?._id ?? []))),
    internalFileName: textOf(valueAt(document, 'medias.images.internalFileName')),
    // The address without its query string: it may carry a token.
    externalUrl: textOf(valueAt(document, 'medias.images.externalUrl'))?.split(/[?#]/)[0] ?? null,
    trashed: document['trash'] === true,
  };
}
