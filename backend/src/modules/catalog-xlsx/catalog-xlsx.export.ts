import type { Document } from 'mongodb';
import { flagOf, recordsOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { colorValue, objectIdsValue, plainOf, stationsOf, wholeValue } from '../product-categories/categories.mapper.ts';
import { placesOf } from '../product-categories/categories.availability.ts';
import { pricesOf } from '../products/products.pricing.ts';
import { productPlacesOf } from '../products/products.availability.ts';
import { idsOf, MODIFIER_CODES, MODIFIER_TYPES } from '../products/products.mapper.ts';
import { FIXED_COLUMNS, PLACE_KINDS, PRICE_SLOTS, placeHeader } from './catalog-xlsx.columns.ts';
import type { SheetKind } from './catalog-xlsx.columns.ts';
import { representedPrices } from './catalog-xlsx.prices.ts';
import type { CatalogPlace } from './catalog-xlsx.repository.ts';
import type { Named, RateOption } from './catalog-xlsx.rules.ts';

/** How the references of the file are written: by id (the default) or by name (a tax rate by its percentage). */
export type ReferenceMode = 'ids' | 'names';

/** What the references of a row are written from: the categories the caller reaches, the price lists and the tax rates of the group, and the points of sale of the perimeter. */
export interface Refs {
  readonly categories: readonly Named[];
  readonly priceLists: readonly Named[];
  readonly taxes: readonly RateOption[];
  readonly places: readonly CatalogPlace[];
}

/** The headers of a sheet: the fixed columns, then the columns of the points of sale (for the categories: the dining room stations of every place, then the counter stations, then the availability). */
export function sheetHeaders(kind: SheetKind, places: readonly CatalogPlace[]): string[] {
  return [...FIXED_COLUMNS[kind].map((column) => column.header), ...PLACE_KINDS[kind].flatMap((placeKind) => places.map((place) => placeHeader(placeKind, place.name)))];
}

const flag = (value: unknown): string => (flagOf(value) ? 'X' : '');
const number = (value: unknown): string => {
  const whole = wholeValue(value);
  return whole === null ? '' : String(whole);
};

/** A reference written as an id or as the name it has (the id when the name is not known). */
function reference(id: string, items: readonly Named[], mode: ReferenceMode): string {
  return mode === 'ids' ? id : (items.find((item) => item.id === id)?.name ?? id);
}

/** The cells of the products and variants sheets, in the order of {@link sheetHeaders}. */
export function productRow(kind: 'products' | 'variants', document: Document, refs: Refs, mode: ReferenceMode): string[] {
  const prices = representedPrices(pricesOf(document['prices']));
  const scale = plainOf(valueAt(document, 'scaleType'));
  const variantType = MODIFIER_TYPES.find((type) => MODIFIER_CODES[type] === valueAt(document, 'variant.type'));
  const values = new Map<string, string>([
    ['id', (document['_id'] as { toHexString(): string }).toHexString()],
    ['type', variantType === undefined ? '' : MODIFIER_CODES[variantType]],
    ['position', number(document['position'])],
    ['name', textOf(valueAt(document, 'name.it')) ?? ''],
    ['shortName', textOf(valueAt(document, 'shortName.it')) ?? ''],
    ['categories', idsOf(document['categories']).map((id) => reference(id, refs.categories, mode)).join(' | ')],
    ['pos', flag(valueAt(document, 'availability.pos'))],
    ['favorite', flag(document['favorite'])],
    ['favoriteHandheld', flag(document['favoriteHandheld'])],
    ['warehouse', flag(valueAt(document, 'availability.warehouse'))],
    ['scales', flag(valueAt(document, 'availability.scales'))],
    ['plu', textOf(document['plu']) ?? ''],
    ['scaleType', scale === 0 ? 'w' : scale === 1 ? 'p' : ''],
    ['ecommerce', flag(valueAt(document, 'availability.ecommerce'))],
    ['description', textOf(valueAt(document, 'description.it')) ?? ''],
    ['shortDescription', textOf(valueAt(document, 'shortDescription.it')) ?? ''],
    ['code', textOf(document['code']) ?? ''],
    ['barcode', textOf(recordsOf(document['barcode'])[0]?.['value']) ?? ''],
    ['delete', ''],
  ]);
  for (let slot = 1; slot <= PRICE_SLOTS; slot += 1) {
    const price = prices[slot - 1];
    values.set(`list${String(slot)}`, price?.priceListId == null ? '' : reference(price.priceListId, refs.priceLists, mode));
    values.set(`price${String(slot)}`, price?.gross == null ? '' : String(price.gross));
    values.set(`tax${String(slot)}`, price?.taxId == null ? '' : mode === 'ids' ? price.taxId : String(price.tax?.rate ?? price.taxId));
  }
  const entries = new Set(productPlacesOf(document['placesAvailability']).entries.map((entry) => entry.placeId));
  return [...FIXED_COLUMNS[kind].map((column) => values.get(column.key)!), ...refs.places.map((place) => (entries.has(place.id) ? 'X' : ''))];
}

/** The names of the print stations a category has for a place, separated by `|`. */
function stationNames(map: Record<string, readonly string[]>, place: CatalogPlace): string {
  const ids = map[place.id] ?? [];
  return place.stations
    .filter((station) => ids.includes(station.id))
    .map((station) => station.name)
    .join('|');
}

/** The cells of the categories sheet, in the order of {@link sheetHeaders}. */
export function categoryRow(document: Document, refs: Refs, mode: ReferenceMode): string[] {
  const parent = document['parentId'];
  const parentId = parent !== null && typeof parent === 'object' && 'toHexString' in parent ? (parent as { toHexString(): string }).toHexString() : '';
  const values = new Map<string, string>([
    ['id', (document['_id'] as { toHexString(): string }).toHexString()],
    ['position', number(document['position'])],
    ['name', textOf(valueAt(document, 'name.it')) ?? ''],
    ['parent', parentId === '' ? '' : reference(parentId, refs.categories, mode)],
    ['pos', flag(valueAt(document, 'availability.pos'))],
    ['modifierCategories', objectIdsValue(document['variantsCategories']).map((id) => reference(id, refs.categories, mode)).join(' | ')],
    ['description', textOf(valueAt(document, 'description.it')) ?? ''],
    ['color', colorValue(document['backgroundColor']) ?? ''],
    ['delete', ''],
  ]);
  const dining = stationsOf(document['printStations'], null);
  const counter = stationsOf(document['printStationsNoRooms'], null);
  const entries = new Set(placesOf(document['placesAvailability']).entries.map((entry) => entry.placeId));
  return [
    ...FIXED_COLUMNS.categories.map((column) => values.get(column.key)!),
    ...refs.places.map((place) => stationNames(dining, place)),
    ...refs.places.map((place) => stationNames(counter, place)),
    ...refs.places.map((place) => (entries.has(place.id) ? 'X' : '')),
  ];
}
