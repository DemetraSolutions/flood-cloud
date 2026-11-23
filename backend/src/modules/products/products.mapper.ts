import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { logo } from '../companies/company.mapper.ts';
import type { FeatureFlags } from '../groups/features.ts';
import { dateOf, flagOf, isRecord, recordsOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { imageOf } from '../product-catalog/image.ts';
import { textsOf } from '../product-catalog/texts.ts';
import type { Texts } from '../product-catalog/texts.ts';
import { colorValue, numberValue, plainOf, stationsOf, wholeValue } from '../product-categories/categories.mapper.ts';
import type { StationsByPlace } from '../product-categories/categories.mapper.ts';
import { isEditableProduct, shownProductPlaces } from './products.availability.ts';
import type { ProductPlace } from './products.availability.ts';
import { instantOf, listedPrice, pricesOf } from './products.pricing.ts';
import type { PriceView } from './products.pricing.ts';

/** The types a product has. `exempt` is a product sold without tax. */
export const PRODUCT_TYPES = Object.freeze(['product', 'service', 'exempt', 'tobaccos', 'games', 'monopoly'] as const);

/** A type of product. */
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** The four families the catalog is shown in: the products, the services, tobaccos-games-monopoly, and the modifiers (the additions, removals and notes of a product). */
export const PRODUCT_FAMILIES = Object.freeze(['products', 'services', 'tgm', 'modifiers'] as const);

/** A family of products. */
export type ProductFamily = (typeof PRODUCT_FAMILIES)[number];

/** The types of the `tgm` family. */
export const TGM_TYPES: readonly string[] = Object.freeze(['tobaccos', 'games', 'monopoly']);

/** The kinds of modifier (`variant.type`): add and remove (`pm`), only add (`p`), only remove (`m`), information (`i`). */
export const MODIFIER_TYPES = Object.freeze(['addRemove', 'add', 'remove', 'info'] as const);

/** A kind of modifier. */
export type ModifierType = (typeof MODIFIER_TYPES)[number];

/** The way the legacy stores each kind of modifier. */
export const MODIFIER_CODES: Readonly<Record<ModifierType, string>> = Object.freeze({ addRemove: 'pm', add: 'p', remove: 'm', info: 'i' });

/** What the choices of a menu of modifiers charge: the most expensive (`h`) or the cheapest (`l`) ones. */
export const CHOICE_PRICE_RULES = Object.freeze({ highest: 'h', lowest: 'l' } as const);

/** How the price of a composable product is made: the legacy stores the average as `avarage`, which the POS expects and the API spells `average`. */
export const MODULAR_PRICE_RULES = Object.freeze({ average: 'avarage', sum: 'sum', fixed: 'fixed' } as const);

/** The units a supplier delivers in. */
export const DELIVERY_UNITS = Object.freeze(['days', 'months', 'years'] as const);

/** Whether a stored product is a modifier: `variant.status` exactly `true`. */
export const isModifierProduct = (document: Document): boolean => valueAt(document, 'variant.status') === true;

/**
 * The family of a stored product: a modifier whatever its type; otherwise the services, the tobaccos-games-monopoly ones, and the products (which also hold the exempt ones, those with no type and any type
 * this backend does not know).
 *
 * @param document The stored product.
 */
export function familyOf(document: Document): ProductFamily {
  if (isModifierProduct(document)) {
    return 'modifiers';
  }
  const type = document['type'];
  return type === 'service' ? 'services' : typeof type === 'string' && TGM_TYPES.includes(type) ? 'tgm' : 'products';
}

/** The type of a stored product, `null` when it holds none of the known ones. */
export function typeOf(raw: unknown): ProductType | null {
  return (PRODUCT_TYPES as readonly unknown[]).includes(raw) ? (raw as ProductType) : null;
}

/** The ids of a stored list, read tolerantly: an `ObjectId` or the hexadecimal text an older client wrote; any other element is left out. */
export function idsOf(raw: unknown): string[] {
  return (Array.isArray(raw) ? (raw as unknown[]) : []).flatMap((item) => (item instanceof ObjectId ? [item.toHexString()] : typeof item === 'string' && /^[0-9a-f]{24}$/.test(item) ? [item] : []));
}

/** The id a stored reference holds (`ObjectId` or hexadecimal text), `null` for anything else. */
export function idOf(raw: unknown): string | null {
  return idsOf([raw])[0] ?? null;
}

/** A barcode of a product. */
export interface Barcode {
  readonly value: string;
  /** How many pieces one reading loads into the warehouse; only with `warehouse`. */
  readonly loadQuantity?: number | null;
  /** How many pieces one reading sells. */
  readonly saleQuantity: number | null;
}

/** A component of the bill of materials of a product, the stock of which a sale takes from the warehouse. */
export interface Component {
  readonly productId: string;
  /** The quantity, in the load unit of the component. */
  readonly quantity: number | null;
  /** The waste, in percent. */
  readonly waste: number | null;
}

/** A group of choices of a menu: `quantity` choices among the products (or, when none is listed, among the ones of the category). */
export interface MenuChoice {
  readonly categoryId: string | null;
  readonly quantity: number | null;
  /** The course the choice is served in; only with `rooms`. */
  readonly course?: number | null;
  readonly productIds: readonly string[];
}

/** A group of choices of modifiers of a product, with some free ones. */
export interface ModifierChoice {
  readonly categoryId: string | null;
  readonly freeQuantity: number | null;
  readonly priceRule: keyof typeof CHOICE_PRICE_RULES | null;
  readonly productIds: readonly string[];
}

/** A price list of a supplier for a product. */
export interface SupplierPriceList {
  readonly id: string | null;
  readonly price: number | null;
  readonly discount1: number | null;
  readonly discount2: number | null;
  readonly discount3: number | null;
}

/** A supplier of a product, with the code and the name the supplier gives it. */
export interface SupplierView {
  /** Id of the contact (a contact that is a supplier). */
  readonly contactId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly minQuantity: number | null;
  readonly deliveryTime: number | null;
  readonly deliveryTimeUnit: (typeof DELIVERY_UNITS)[number] | null;
  readonly favorite: boolean;
  readonly priceLists: readonly SupplierPriceList[];
}

/** The stock of a product in a storage of a place. */
export interface StockView {
  /** The quantity in stock: read only, moved by the warehouse. */
  readonly quantity: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly location: string | null;
}

/** The stock of a product: for each place, for each storage. */
export type StockByPlace = Readonly<Record<string, Readonly<Record<string, StockView>>>>;

/** The cost of a product in one of its forms: the last price, the average and the weighted average. Read only: maintained by the warehouse. */
export interface CostView {
  readonly last: number | null;
  readonly average: number | null;
  readonly weightedAverage: number | null;
}

/** The costs of a product: the total and the one by supplier. */
export interface CostsView extends CostView {
  /** The last supplier the product was bought from. */
  readonly lastSupplierId: string | null;
  readonly bySupplier: Readonly<Record<string, CostView>>;
}

/** The dimensions and the weight of a product, for the shipment. */
export interface ShippingView {
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  readonly weight: number | null;
}

/** The settings of a product in a restaurant. */
export interface DiningView {
  readonly halfPortion: boolean;
  readonly feePercentage: number | null;
  readonly hiddenOnHandheld: boolean;
  readonly affiliatedMenu: boolean;
  readonly reversePrint: boolean;
}

/** The settings of a modifier. */
export interface ModifierView {
  readonly type: ModifierType | null;
  readonly pricePercentagePlus: number | null;
  readonly pricePercentageMinus: number | null;
  readonly description: Texts;
}

/** A product as the API shows it. The fields of a function of the group the group does not have are left out. */
export interface ProductView {
  readonly id: string;
  readonly family: ProductFamily;
  /** `null` when the stored type is none of the known ones (the legacy left products with none). */
  readonly type: ProductType | null;
  readonly isModifier: boolean;
  readonly enabled: boolean;
  readonly code: string | null;
  /** Only with `scales`. */
  readonly plu?: string | null;
  readonly name: Texts;
  readonly shortName: Texts;
  readonly description: Texts;
  readonly shortDescription: Texts;
  readonly favorite: boolean;
  /** Only with `rooms`. */
  readonly favoriteHandheld?: boolean;
  readonly generic: boolean;
  readonly toCheck: boolean;
  readonly noDiscount: boolean;
  readonly brandId: string | null;
  readonly categoryIds: readonly string[];
  readonly attributeIds: readonly string[];
  readonly position: number | null;
  readonly productionValue: number | null;
  /** The duration of a service, `HH:mm`; only with `services`. */
  readonly duration?: string | null;
  /** How many customers a service serves at the same time; only with `services`. */
  readonly maxConcurrent?: number | null;
  /** Where the product is sold: `pos` with `cash`, `warehouse` (it moves the stock) with `warehouse`, `scales` with `scales`, `ecommerce` with `customersApp`; not at all when the group has none of them. */
  readonly availability?: { readonly pos?: boolean; readonly warehouse?: boolean; readonly scales?: boolean; readonly ecommerce?: boolean };
  /** Only with `customersApp`. */
  readonly featured?: boolean;
  /** The switches of the publication on the integrations; `easyappear` is kept and never shown. */
  readonly integrations: { readonly floodOrders: boolean; readonly yellgo: boolean; readonly leggimenu: boolean };
  /** The start and the end of the period the product is available in. */
  readonly validFrom: string | null;
  readonly validTo: string | null;
  /** The modifier settings; only for a modifier, and only with `productsVariants`. */
  readonly modifier?: ModifierView;
  /** The modifiers a sale requires, proposes and excludes, and the categories of modifiers; only with `productsVariants`, and never for a modifier. */
  readonly requiredModifierIds?: readonly string[];
  readonly modifierIds?: readonly string[];
  readonly excludedModifierIds?: readonly string[];
  readonly modifierCategoryIds?: readonly string[];
  /** Only with `scales`. */
  readonly scaleType?: 'weight' | 'piece' | null;
  /** Only with `warehouse`: the units of the stock and how many of the unload unit make one of the load unit. */
  readonly loadUnit?: string | null;
  readonly unloadUnit?: string | null;
  readonly conversionRatio?: number | null;
  /** Only with `cash`: the colors of the key of the product. */
  readonly colors?: { readonly text: string | null; readonly background: string | null };
  /** Only with `rooms`. */
  readonly dining?: DiningView;
  readonly barcodes: readonly Barcode[];
  readonly prices: readonly PriceView[];
  /** The places the product is for, empty for every place. A company or place administrator is shown only the ones of his perimeter. */
  readonly places: readonly ProductPlace[];
  /** The print stations of the orders in the rooms and at the counter, by place; only with `ordering`. */
  readonly printStations?: StationsByPlace;
  readonly counterPrintStations?: StationsByPlace;
  /** The stock by place and storage; only with `warehouse`. A company or place administrator is shown only the places of his perimeter. */
  readonly stock?: StockByPlace;
  /** The costs; only with `warehouse`. */
  readonly costs?: CostsView;
  readonly simpleCost: number | null;
  readonly suppliers: readonly SupplierView[];
  readonly shipping: ShippingView;
  /** The bill of materials. */
  readonly components: readonly Component[];
  /** The menu choices, the modifier choices and the price rule of a composable product; never for a modifier. */
  readonly menu?: readonly MenuChoice[];
  readonly modifierChoices?: readonly ModifierChoice[];
  readonly modularPriceRule?: keyof typeof MODULAR_PRICE_RULES | null;
  /** Only with `media`. */
  readonly image?: MediaLogo | null;
  readonly gallery?: readonly MediaLogo[];
  readonly internalFileName?: string | null;
  readonly externalUrl?: string | null;
  /** Whether the caller may modify, trash and delete the product as a whole (computed by the server). */
  readonly editable: boolean;
  /** Whether the caller may modify the data of his own places (computed by the server): always for a product that is not in the trash, a company or place administrator included, who reaches only the products that are for every place or for one of his own. */
  readonly placeEditable: boolean;
  readonly trashed: boolean;
  /** When the product was trashed, `null` for one the legacy trashed or that is not in the trash. */
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

/** The fields of a product that are costs or suppliers of the whole group: a caller that has no business with them is never given them, and they are not read from the database for it. */
export const PRODUCT_COST_FIELDS: readonly string[] = Object.freeze(['suppliers', 'simpleCost', 'lastAveragePrice']);

/** A product as {@link ProductView} shows it, without the costs, the suppliers and the simple cost: not assignable from a {@link ProductView}, so the compiler refuses to give one where this is expected. */
export type ProductWithoutCosts = Omit<ProductView, 'costs' | 'suppliers' | 'simpleCost'> & { readonly costs?: never; readonly suppliers?: never; readonly simpleCost?: never };

/**
 * Drops from a product view the costs, the suppliers and the simple cost (field by field: a field added to the view never leaves with them by itself).
 *
 * @param view The view of a product.
 */
export function withoutCosts(view: ProductView): ProductWithoutCosts {
  const { costs: _costs, suppliers: _suppliers, simpleCost: _simpleCost, ...rest } = view;
  return rest;
}

/** The barcodes of a stored document, read tolerantly. */
export function barcodesOf(raw: unknown, features: Pick<FeatureFlags, 'warehouse'>): Barcode[] {
  return recordsOf(raw).flatMap((item) =>
    typeof item['value'] === 'string'
      ? [{ value: item['value'], ...(features.warehouse ? { loadQuantity: numberValue(item['qtLoad']) } : {}), saleQuantity: numberValue(item['qtSale']) }]
      : [],
  );
}

/** The components of a stored bill of materials. */
export function componentsOf(raw: unknown): Component[] {
  return recordsOf(raw).flatMap((item) => {
    const productId = idOf(item['_id']);
    return productId === null ? [] : [{ productId, quantity: numberValue(item['quantity']), waste: numberValue(item['waste']) }];
  });
}

/** The ids of the products of a group of choices (`products[]._id`). */
const choiceProductIds = (raw: unknown): string[] => recordsOf(raw).flatMap((item) => idsOf([item['_id']]));

/** The groups of choices of a stored menu. */
export function menuOf(raw: unknown, features: Pick<FeatureFlags, 'rooms'>): MenuChoice[] {
  return recordsOf(raw).map((item) => ({
    categoryId: idOf(item['categoryId']),
    quantity: wholeValue(item['quantity']),
    ...(features.rooms ? { course: wholeValue(item['exit']) } : {}),
    productIds: choiceProductIds(item['products']),
  }));
}

/** The groups of choices of modifiers of a stored product. */
export function modifierChoicesOf(raw: unknown): ModifierChoice[] {
  return recordsOf(raw).map((item) => ({
    categoryId: idOf(item['categoryId']),
    freeQuantity: numberValue(item['freeQt']),
    priceRule: item['priceType'] === 'h' ? 'highest' : item['priceType'] === 'l' ? 'lowest' : null,
    productIds: choiceProductIds(item['products']),
  }));
}

/** The suppliers of a stored product. A supplier the warehouse added has its id as text and the delivery time under a misspelled key (`delivetyTime`): both are read. */
export function suppliersOf(raw: unknown): SupplierView[] {
  return recordsOf(raw).map((item) => ({
    contactId: idOf(item['id']),
    code: textOf(item['code']),
    name: textOf(item['name']),
    minQuantity: numberValue(item['minQt']),
    deliveryTime: numberValue(item['deliveryTime']) ?? numberValue(item['delivetyTime']),
    deliveryTimeUnit: (DELIVERY_UNITS as readonly unknown[]).includes(item['deliveryTimeUnit']) ? (item['deliveryTimeUnit'] as (typeof DELIVERY_UNITS)[number]) : null,
    favorite: flagOf(item['favorite']),
    priceLists: recordsOf(item['companyLists']).map((list) => ({
      id: textOf(list['id']),
      price: numberValue(list['price']),
      discount1: numberValue(list['discount1']),
      discount2: numberValue(list['discount2']),
      discount3: numberValue(list['discount3']),
    })),
  }));
}

/** The key of a place or of a storage in the stock and in the print stations: `__<id>`. */
const KEY_PREFIX = '__';

/** The id a `__<id>` key holds, `null` when the key is not one or the id is not hexadecimal. */
function keyId(key: string): string | null {
  const id = key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : '';
  return /^[0-9a-f]{24}$/.test(id) ? id : null;
}

/**
 * The stock of a stored `quantity` (`{ "__<placeId>": { "__<storageId>": { value, min, max, location } } }`), read tolerantly: the keys that are `__` and an id, the numbers that are finite. When a perimeter is
 * given only its places are returned (the other ones are stored and kept, never shown).
 *
 * @param raw The stored `quantity`, of any type.
 * @param allowed The places the caller may see, `null` for all of them.
 */
export function stockOf(raw: unknown, allowed: ReadonlySet<string> | null): StockByPlace {
  const places: Record<string, Record<string, StockView>> = {};
  for (const [placeKey, storages] of Object.entries(isRecord(raw) ? raw : {})) {
    const placeId = keyId(placeKey);
    if (placeId === null || (allowed !== null && !allowed.has(placeId)) || !isRecord(storages)) {
      continue;
    }
    const byStorage: Record<string, StockView> = {};
    for (const [storageKey, entry] of Object.entries(storages)) {
      const storageId = keyId(storageKey);
      if (storageId !== null && isRecord(entry)) {
        byStorage[storageId] = { quantity: numberValue(entry['value']), min: numberValue(entry['min']), max: numberValue(entry['max']), location: textOf(entry['location']) };
      }
    }
    places[placeId] = byStorage;
  }
  return places;
}

/**
 * The quantity in stock of a product in the places a caller reaches: the sum of the quantities of every storage, to six decimals (the unit of the warehouse); `null` when no place has a quantity that is a number.
 *
 * @param raw The stored `quantity`.
 * @param allowed The places the caller may see, `null` for all of them.
 */
export function totalStock(raw: unknown, allowed: ReadonlySet<string> | null): number | null {
  const quantities = Object.values(stockOf(raw, allowed)).flatMap((storages) => Object.values(storages).flatMap((entry) => (entry.quantity === null ? [] : [entry.quantity])));
  return quantities.length === 0 ? null : Number(quantities.reduce((sum, quantity) => sum + quantity, 0).toFixed(6));
}

/** One of the three forms of cost (`lastPrice`, `averagePrice`, `weightedAveragePrice`) of a stored cost record. */
function costOf(raw: unknown): CostView {
  const record = isRecord(raw) ? raw : {};
  return { last: numberValue(record['lastPrice']), average: numberValue(record['averagePrice']), weightedAverage: numberValue(record['weightedAveragePrice']) };
}

/** The costs of a stored `lastAveragePrice`, read tolerantly. */
export function costsOf(raw: unknown): CostsView {
  const record = isRecord(raw) ? raw : {};
  const suppliers = isRecord(record['suppliers']) ? record['suppliers'] : {};
  return {
    ...costOf(record['total']),
    lastSupplierId: idOf(record['lastSupplierId']),
    bySupplier: Object.fromEntries(
      Object.entries(suppliers)
        .slice(0, 200)
        .map(([supplierId, cost]) => [supplierId, costOf(cost)]),
    ),
  };
}

/** The settings of a product in a restaurant, read tolerantly. */
function diningOf(document: Document): DiningView {
  const setting = (leaf: string): unknown => valueAt(document, `roomsSettings.${leaf}`);
  return { halfPortion: flagOf(setting('halfPortion')), feePercentage: numberValue(setting('percentageFee')), hiddenOnHandheld: flagOf(setting('handheldHidden')), affiliatedMenu: flagOf(setting('affiliatedMenu')), reversePrint: flagOf(setting('reversePrint')) };
}

/** The kind of modifier a stored `variant.type` holds, `null` for anything else (the legacy left `null`, nothing and other texts). */
export function modifierTypeOf(raw: unknown): ModifierType | null {
  return MODIFIER_TYPES.find((type) => MODIFIER_CODES[type] === raw) ?? null;
}

/** The duration of a service, `HH:mm`, `null` for anything else. */
const durationOf = (raw: unknown): string | null => (typeof raw === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : null);

/** The text of a tolerant read of `scaleType` (`0` weight, `1` piece). */
function scaleTypeOf(raw: unknown): 'weight' | 'piece' | null {
  const value = plainOf(raw);
  return value === 0 ? 'weight' : value === 1 ? 'piece' : null;
}

/**
 * Reads a stored product into its domain form for a caller. Everything is read tolerantly: `NaN`, a value of the wrong type or a missing key gives `null`, `false` or an empty list; the dates are read in both
 * forms; a reference that no longer exists is shown by its id.
 *
 * @param document The stored document, read with every owned field.
 * @param principal The caller, whose perimeter decides the places shown and whether the product is editable.
 * @param features The features of the group: a field of a function the group does not have is left out.
 */
export function productView(document: Document, principal: CatalogCaller, features: FeatureFlags): ProductView {
  const allowed = perimeterOf(principal);
  const modifier = isModifierProduct(document);
  const switches = {
    ...(features.cash ? { pos: flagOf(valueAt(document, 'availability.pos')) } : {}),
    ...(features.warehouse ? { warehouse: flagOf(valueAt(document, 'availability.warehouse')) } : {}),
    ...(features.scales ? { scales: flagOf(valueAt(document, 'availability.scales')) } : {}),
    ...(features.customersApp ? { ecommerce: flagOf(valueAt(document, 'availability.ecommerce')) } : {}),
  };
  const editable = isEditableProduct(principal, document['placesAvailability']);
  const trashed = document['trash'] === true;
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    family: familyOf(document),
    type: typeOf(document['type']),
    isModifier: modifier,
    enabled: document['status'] === true,
    code: textOf(document['code']),
    ...(features.scales ? { plu: textOf(document['plu']) } : {}),
    name: textsOf(document['name']),
    shortName: textsOf(document['shortName']),
    description: textsOf(document['description']),
    shortDescription: textsOf(document['shortDescription']),
    favorite: flagOf(document['favorite']),
    ...(features.rooms ? { favoriteHandheld: flagOf(document['favoriteHandheld']) } : {}),
    generic: flagOf(document['generic']),
    toCheck: flagOf(document['toCheck']),
    noDiscount: flagOf(document['noDiscount']),
    brandId: idOf(document['brandId']),
    categoryIds: idsOf(document['categories']),
    attributeIds: (Array.isArray(document['attributes']) ? (document['attributes'] as unknown[]) : []).filter((id): id is string => typeof id === 'string'),
    position: wholeValue(document['position']),
    productionValue: wholeValue(document['productionValue']),
    ...(features.services ? { duration: durationOf(document['time']), maxConcurrent: wholeValue(document['max']) } : {}),
    ...(Object.keys(switches).length === 0 ? {} : { availability: switches }),
    ...(features.customersApp ? { featured: flagOf(document['featured']) } : {}),
    integrations: {
      floodOrders: flagOf(valueAt(document, 'integrations.floodOrders')),
      yellgo: flagOf(valueAt(document, 'integrations.yellgo')),
      leggimenu: flagOf(valueAt(document, 'integrations.leggimenu')),
    },
    validFrom: instantOf(document['startDate']),
    validTo: instantOf(document['endDate']),
    ...(features.productsVariants
      ? {
          ...(modifier
            ? {
                modifier: {
                  type: modifierTypeOf(valueAt(document, 'variant.type')),
                  pricePercentagePlus: numberValue(valueAt(document, 'variant.pricePercentagePlus')),
                  pricePercentageMinus: numberValue(valueAt(document, 'variant.pricePercentageMinus')),
                  description: textsOf(valueAt(document, 'variant.description')),
                },
              }
            : {
                requiredModifierIds: idsOf(document['variantsRequired']),
                modifierIds: idsOf(document['variants']),
                excludedModifierIds: idsOf(document['variantsExcluded']),
                modifierCategoryIds: idsOf(document['variantsCategories']),
              }),
        }
      : {}),
    ...(features.scales ? { scaleType: scaleTypeOf(document['scaleType']) } : {}),
    ...(features.warehouse ? { loadUnit: textOf(document['measureLoad']), unloadUnit: textOf(document['measureDownload']), conversionRatio: numberValue(document['measureConversionRatio']) } : {}),
    ...(features.cash ? { colors: { text: colorValue(valueAt(document, 'colors.pos.text')), background: colorValue(valueAt(document, 'colors.pos.background')) } } : {}),
    ...(features.rooms ? { dining: diningOf(document) } : {}),
    barcodes: barcodesOf(document['barcode'], features),
    prices: pricesOf(document['prices']),
    places: shownProductPlaces(principal, document['placesAvailability']),
    ...(features.ordering ? { printStations: stationsOf(document['printStations'], allowed), counterPrintStations: stationsOf(document['printStationsNoRooms'], allowed) } : {}),
    ...(features.warehouse ? { stock: stockOf(document['quantity'], allowed), costs: costsOf(document['lastAveragePrice']) } : {}),
    simpleCost: numberValue(document['simpleCost']),
    suppliers: suppliersOf(document['suppliers']),
    shipping: { width: numberValue(valueAt(document, 'shippingInfo.width')), height: numberValue(valueAt(document, 'shippingInfo.height')), depth: numberValue(valueAt(document, 'shippingInfo.depth')), weight: numberValue(valueAt(document, 'shippingInfo.weight')) },
    components: componentsOf(document['bundleProducts']),
    ...(modifier
      ? {}
      : {
          menu: menuOf(document['selectableBundleProducts'], features),
          ...(features.productsVariants ? { modifierChoices: modifierChoicesOf(document['selectableVariantsBundleProducts']) } : {}),
          modularPriceRule: (Object.keys(MODULAR_PRICE_RULES) as Array<keyof typeof MODULAR_PRICE_RULES>).find((rule) => MODULAR_PRICE_RULES[rule] === valueAt(document, 'modularBundle.priceRule')) ?? null,
        }),
    ...(features.media
      ? {
          image: imageOf(document),
          gallery: (Array.isArray(valueAt(document, 'medias.images.gallery')) ? (valueAt(document, 'medias.images.gallery') as unknown[]) : []).flatMap((item) => {
            const descriptor = logo.read(item) as MediaLogo | null;
            return descriptor === null ? [] : [descriptor];
          }),
          internalFileName: textOf(valueAt(document, 'medias.images.internalFileName')),
          externalUrl: textOf(valueAt(document, 'medias.images.externalUrl')),
        }
      : {}),
    editable,
    placeEditable: !trashed,
    trashed,
    trashedAt: dateOf(document['trashDate']),
    createdAt: dateOf(document['insertDate']),
    updatedAt: dateOf(document['updateDate']),
  };
}

/** What a row of the list shows of a product. */
export interface ProductRow {
  readonly id: string;
  readonly family: ProductFamily;
  readonly type: ProductType | null;
  readonly code: string | null;
  /** The name in the language of the caller, else the first one the product has. */
  readonly name: string | null;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly categoryIds: readonly string[];
  /** The stock: the quantity in the places the caller reaches, `null` for a product that does not move the warehouse (or a service, or a group without `warehouse`); `composite` when the product has a bill of materials. */
  readonly stock: { readonly quantity: number | null; readonly composite: boolean };
  /** The price of the default price list of the group, with tax and discount; `null` when there is none. */
  readonly price: number | null;
  readonly lastSupplierId: string | null;
  /** The display name of the last supplier (the contact), `null` when there is none or it cannot be read. */
  readonly lastSupplierName: string | null;
  readonly editable: boolean;
  readonly placeEditable: boolean;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
}

/**
 * The compact row of the list for a stored product (read with the projection of the list: never the whole document).
 *
 * @param document The projected document.
 * @param principal The caller.
 * @param features The features of the group.
 * @param language The language of the caller.
 * @param defaultPriceListId The default price list of the group.
 * @param supplierNames The display names of the last suppliers of the page, by id.
 */
export function productRow(document: Document, principal: CatalogCaller, features: FeatureFlags, language: string, defaultPriceListId: string | null, supplierNames: ReadonlyMap<string, string | null> = new Map()): ProductRow {
  const names = textsOf(document['name']);
  const moves = features.warehouse && valueAt(document, 'availability.warehouse') === true && document['type'] !== 'service';
  const trashed = document['trash'] === true;
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    family: familyOf(document),
    type: typeOf(document['type']),
    code: textOf(document['code']),
    name: names[language] ?? Object.values(names)[0] ?? null,
    enabled: document['status'] === true,
    updatedAt: dateOf(document['updateDate']),
    categoryIds: idsOf(document['categories']),
    stock: { quantity: moves ? totalStock(document['quantity'], perimeterOf(principal)) : null, composite: recordsOf(document['bundleProducts']).length > 0 },
    price: listedPrice(document['prices'], defaultPriceListId),
    lastSupplierId: idOf(valueAt(document, 'lastAveragePrice.lastSupplierId')),
    lastSupplierName: supplierNames.get(idOf(valueAt(document, 'lastAveragePrice.lastSupplierId')) ?? '') ?? null,
    editable: isEditableProduct(principal, document['placesAvailability']),
    placeEditable: !trashed,
    trashed,
    trashedAt: dateOf(document['trashDate']),
  };
}
