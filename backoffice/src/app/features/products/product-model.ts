import { LogoModel } from '../companies/company-model';
import { fromLocalInput, numberIssue, numberOrNull, numberText, textOrNull, toLocalInput } from '../groups/catalogs/catalog-fields';
import { changedTexts, filled, logoOf } from '../product-catalog/catalog-item-model';
import { StationsModel, stationsBody, stationsPatch } from '../product-categories/category-model';
import { PriceRow, priceBody, priceRowOf } from './product-prices';
import {
  ChoicePriceRule,
  DeliveryUnit,
  ModifierType,
  ModularPriceRule,
  Product,
  ProductFeatures,
  ProductType,
  PRODUCT_LIMITS,
} from './product.types';

/** A barcode as the form edits it. */
export interface BarcodeRow {
  readonly value: string;
  /** Pieces one reading loads (`warehouse`), as typed. */
  readonly loadQuantity: string;
  /** Pieces one reading sells, as typed. */
  readonly saleQuantity: string;
}

/** A component of the bill of materials as the form edits it. */
export interface ComponentRow {
  readonly productId: string;
  readonly quantity: string;
  readonly waste: string;
}

/** A group of choices of a menu as the form edits it. */
export interface MenuRow {
  readonly categoryId: string;
  readonly quantity: string;
  readonly course: string;
  readonly productIds: readonly string[];
}

/** A group of choices of modifiers as the form edits it. */
export interface ChoiceRow {
  readonly categoryId: string;
  readonly freeQuantity: string;
  readonly priceRule: ChoicePriceRule;
  readonly productIds: readonly string[];
}

/** A price list of a supplier as the form edits it. */
export interface SupplierListRow {
  readonly id: string;
  readonly price: string;
  readonly discount1: string;
  readonly discount2: string;
  readonly discount3: string;
}

/** A supplier as the form edits it. */
export interface SupplierRow {
  readonly contactId: string;
  readonly code: string;
  readonly name: string;
  readonly minQuantity: string;
  readonly deliveryTime: string;
  readonly deliveryTimeUnit: DeliveryUnit | '';
  readonly favorite: boolean;
  readonly priceLists: readonly SupplierListRow[];
}

/** A store of the availability as the form edits it. */
export interface ProductPlaceRow {
  readonly placeId: string;
  readonly favorite: boolean;
  readonly favoriteHandheld: boolean;
  /** As typed. */
  readonly position: string;
  /** Id of the production center, `''` for none. */
  readonly productionCenterId: string;
}

/** The limits of a storage of a store as the form edits them (the quantity is the warehouse's). */
export interface StockRow {
  readonly placeId: string;
  readonly storageId: string;
  readonly min: string;
  readonly max: string;
  readonly location: string;
}

/** The fields of the form that only a caller who may change the whole product can edit. */
export interface CoreModel {
  type: ProductType;
  enabled: boolean;
  favorite: boolean;
  favoriteHandheld: boolean;
  generic: boolean;
  toCheck: boolean;
  noDiscount: boolean;
  featured: boolean;
  availability: { pos: boolean; warehouse: boolean; scales: boolean; ecommerce: boolean };
  integrations: { floodOrders: boolean; yellgo: boolean; leggimenu: boolean };
  code: string;
  /** As typed: up to six digits, no leading zeros. */
  plu: string;
  name: Record<string, string>;
  shortName: Record<string, string>;
  description: Record<string, string>;
  shortDescription: Record<string, string>;
  /** Id of the brand, `''` for none. */
  brandId: string;
  position: string;
  productionValue: string;
  /** `HH:mm` or `''`. */
  duration: string;
  maxConcurrent: string;
  /** `datetime-local` values or `''`. */
  validFrom: string;
  validTo: string;
  modifier: {
    type: ModifierType;
    pricePercentagePlus: string;
    pricePercentageMinus: string;
    description: Record<string, string>;
  };
  loadUnit: string;
  unloadUnit: string;
  conversionRatio: string;
  scaleType: 'weight' | 'piece';
  colors: { text: string; background: string };
  dining: {
    halfPortion: boolean;
    feePercentage: string;
    hiddenOnHandheld: boolean;
    affiliatedMenu: boolean;
    reversePrint: boolean;
  };
  barcodes: BarcodeRow[];
  prices: PriceRow[];
  categoryIds: string[];
  attributeIds: string[];
  requiredModifierIds: string[];
  modifierIds: string[];
  excludedModifierIds: string[];
  modifierCategoryIds: string[];
  components: ComponentRow[];
  menu: MenuRow[];
  modifierChoices: ChoiceRow[];
  /** `''` for none. */
  modularPriceRule: ModularPriceRule | '';
  image: LogoModel | null;
  gallery: LogoModel[];
  internalFileName: string;
  externalUrl: string;
  simpleCost: string;
  suppliers: SupplierRow[];
  shipping: { width: string; height: string; depth: string; weight: string };
}

/** The fields of the form a caller who only manages their own stores can edit as well. */
export interface LocalModel {
  places: ProductPlaceRow[];
  stations: StationsModel;
  stock: StockRow[];
}

/** What the form of a product edits. The names are the ones of the server, so that its errors land on the right field. */
export interface ProductModel {
  core: CoreModel;
  local: LocalModel;
}

/** What a new product starts with. */
export interface ModelDefaults {
  /** Type of a new product of the family. */
  readonly type: ProductType;
  /** A rule for each price list of the group. */
  readonly prices: readonly PriceRow[];
  /** The stores a company or store administrator starts with (their own). */
  readonly places: readonly ProductPlaceRow[];
}

/** What the builders of the bodies need to know besides the form. */
export interface BodyContext {
  readonly features: ProductFeatures;
  /** The product is a modifier (it has no menu, no modifiers of its own and the settings of a modifier). */
  readonly modifier: boolean;
}

/** Every language of the form with its text (`''` where the product has none). */
function textsOf(source: Readonly<Record<string, string>> | undefined, languages: readonly string[]): Record<string, string> {
  return Object.fromEntries(languages.map((code) => [code, source?.[code] ?? '']));
}

/** The form row of a store of the availability. */
export function placeRowOf(place: Product['places'][number]): ProductPlaceRow {
  return {
    placeId: place.placeId,
    favorite: place.favorite,
    favoriteHandheld: place.favoriteHandheld,
    position: numberText(place.position),
    productionCenterId: place.productionCenterId ?? '',
  };
}

/** The stations of a map, without the stores that have none. */
function chosen(map: Readonly<Record<string, readonly string[]>> | undefined): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, ids]) => ids.length > 0));
}

/** The default color of the buttons of the cash app. */
export const DEFAULT_BUTTON_COLOR = '#000000';

/**
 * The form model of a product.
 *
 * @param item The product; `null` for the defaults of a new one.
 * @param languages The languages of the form (the ones of the group and the ones the product has).
 * @param defaults What a new product starts with.
 */
export function toModel(item: Product | null, languages: readonly string[], defaults: ModelDefaults): ProductModel {
  return {
    core: {
      type: item?.type ?? defaults.type,
      enabled: item?.enabled ?? true,
      favorite: item?.favorite ?? false,
      favoriteHandheld: item?.favoriteHandheld ?? false,
      generic: item?.generic ?? false,
      toCheck: item?.toCheck ?? false,
      noDiscount: item?.noDiscount ?? false,
      featured: item?.featured ?? false,
      availability: {
        pos: item === null ? true : (item.availability?.pos ?? false),
        warehouse: item?.availability?.warehouse ?? false,
        scales: item?.availability?.scales ?? false,
        ecommerce: item?.availability?.ecommerce ?? false,
      },
      integrations: {
        floodOrders: item?.integrations.floodOrders ?? false,
        yellgo: item?.integrations.yellgo ?? false,
        leggimenu: item?.integrations.leggimenu ?? false,
      },
      code: item?.code ?? '',
      plu: item?.plu ?? '',
      name: textsOf(item?.name, languages),
      shortName: textsOf(item?.shortName, languages),
      description: textsOf(item?.description, languages),
      shortDescription: textsOf(item?.shortDescription, languages),
      brandId: item?.brandId ?? '',
      position: numberText(item?.position ?? null),
      productionValue: numberText(item?.productionValue ?? null),
      duration: item?.duration ?? '',
      maxConcurrent: numberText(item?.maxConcurrent ?? null),
      validFrom: toLocalInput(item?.validFrom ?? null),
      validTo: toLocalInput(item?.validTo ?? null),
      modifier: {
        type: item?.modifier?.type ?? 'addRemove',
        pricePercentagePlus: numberText(item?.modifier?.pricePercentagePlus ?? null),
        pricePercentageMinus: numberText(item?.modifier?.pricePercentageMinus ?? null),
        description: textsOf(item?.modifier?.description, languages),
      },
      loadUnit: item?.loadUnit ?? '',
      unloadUnit: item?.unloadUnit ?? '',
      conversionRatio: item === null ? '1' : numberText(item.conversionRatio ?? null),
      scaleType: item?.scaleType ?? 'weight',
      colors: {
        text: item?.colors?.text ?? DEFAULT_BUTTON_COLOR,
        background: item?.colors?.background ?? DEFAULT_BUTTON_COLOR,
      },
      dining: {
        halfPortion: item?.dining?.halfPortion ?? false,
        feePercentage: numberText(item?.dining?.feePercentage ?? null),
        hiddenOnHandheld: item?.dining?.hiddenOnHandheld ?? false,
        affiliatedMenu: item?.dining?.affiliatedMenu ?? false,
        reversePrint: item?.dining?.reversePrint ?? false,
      },
      barcodes: (item?.barcodes ?? []).map((barcode) => ({
        value: barcode.value,
        loadQuantity: numberText(barcode.loadQuantity ?? null),
        saleQuantity: numberText(barcode.saleQuantity),
      })),
      prices: item === null ? [...defaults.prices] : item.prices.map(priceRowOf),
      categoryIds: [...(item?.categoryIds ?? [])],
      attributeIds: [...(item?.attributeIds ?? [])],
      requiredModifierIds: [...(item?.requiredModifierIds ?? [])],
      modifierIds: [...(item?.modifierIds ?? [])],
      excludedModifierIds: [...(item?.excludedModifierIds ?? [])],
      modifierCategoryIds: [...(item?.modifierCategoryIds ?? [])],
      components: (item?.components ?? []).map((component) => ({
        productId: component.productId,
        quantity: numberText(component.quantity),
        waste: numberText(component.waste),
      })),
      menu: (item?.menu ?? []).map((group) => ({
        categoryId: group.categoryId ?? '',
        quantity: numberText(group.quantity),
        course: numberText(group.course ?? null),
        productIds: [...group.productIds],
      })),
      modifierChoices: (item?.modifierChoices ?? []).map((group) => ({
        categoryId: group.categoryId ?? '',
        freeQuantity: numberText(group.freeQuantity),
        priceRule: group.priceRule ?? 'highest',
        productIds: [...group.productIds],
      })),
      modularPriceRule: item?.modularPriceRule ?? '',
      image: logoOf(item?.image),
      gallery: (item?.gallery ?? []).flatMap((image) => logoOf(image) ?? []),
      internalFileName: item?.internalFileName ?? '',
      externalUrl: item?.externalUrl ?? '',
      simpleCost: numberText(item?.simpleCost ?? null),
      suppliers: (item?.suppliers ?? []).map((supplier) => ({
        contactId: supplier.contactId ?? '',
        code: supplier.code ?? '',
        name: supplier.name ?? '',
        minQuantity: numberText(supplier.minQuantity),
        deliveryTime: numberText(supplier.deliveryTime),
        deliveryTimeUnit: supplier.deliveryTimeUnit ?? '',
        favorite: supplier.favorite,
        priceLists: supplier.priceLists.map((list) => ({
          id: list.id ?? '',
          price: numberText(list.price),
          discount1: numberText(list.discount1),
          discount2: numberText(list.discount2),
          discount3: numberText(list.discount3),
        })),
      })),
      shipping: {
        width: numberText(item?.shipping.width ?? null),
        height: numberText(item?.shipping.height ?? null),
        depth: numberText(item?.shipping.depth ?? null),
        weight: numberText(item?.shipping.weight ?? null),
      },
    },
    local: {
      places: item === null ? [...defaults.places] : item.places.map(placeRowOf),
      stations: { rooms: chosen(item?.printStations), counter: chosen(item?.counterPrintStations) },
      stock: Object.entries(item?.stock ?? {}).flatMap(([placeId, storages]) =>
        Object.entries(storages).map(([storageId, entry]) => ({
          placeId,
          storageId,
          min: numberText(entry.min),
          max: numberText(entry.max),
          location: entry.location ?? '',
        })),
      ),
    },
  };
}

// ---- Issues of the rows (the names are the ones of the backend) ----

/** The issues of a field of a row, by field. */
export type RowIssues<F extends string> = Partial<Record<F, string>>;

/** Drops the fields without an issue. */
function found<F extends string>(issues: Record<F, string | undefined>): RowIssues<F> {
  return Object.fromEntries(Object.entries(issues).filter(([, issue]) => issue !== undefined)) as RowIssues<F>;
}

const AMOUNT = { min: 0, max: PRODUCT_LIMITS.number, optional: true } as const;

/** Issues of a barcode: a value (up to 64 characters, no control character) and the quantities. */
export function barcodeIssues(row: BarcodeRow): RowIssues<'value' | 'loadQuantity' | 'saleQuantity'> {
  const value = row.value.trim();
  return found({
    value: value === '' ? 'required' : value.length > PRODUCT_LIMITS.barcode ? 'maxLength' : /[\u0000-\u001F\u007F]/.test(value) ? 'pattern' : undefined,
    loadQuantity: numberIssue(row.loadQuantity, AMOUNT),
    saleQuantity: numberIssue(row.saleQuantity, AMOUNT),
  });
}

/** Issues of a component: a product, a quantity above zero and a waste from 0 to 100. */
export function componentIssues(row: ComponentRow): RowIssues<'productId' | 'quantity' | 'waste'> {
  const quantity = numberIssue(row.quantity, { min: 0, max: PRODUCT_LIMITS.number });
  return found({
    productId: row.productId === '' ? 'required' : undefined,
    quantity: quantity ?? (Number(row.quantity) <= 0 ? 'minimum' : undefined),
    waste: numberIssue(row.waste, { min: 0, max: PRODUCT_LIMITS.percentage, optional: true }),
  });
}

/** Issues of a group of choices of a menu: a category and a quantity from 1 to 100, and a course from 0 to 99. */
export function menuIssues(row: MenuRow): RowIssues<'categoryId' | 'quantity' | 'course'> {
  return found({
    categoryId: row.categoryId === '' ? 'required' : undefined,
    quantity: numberIssue(row.quantity, { min: 1, max: PRODUCT_LIMITS.menuQuantity, integer: true }),
    course: numberIssue(row.course, { min: 0, max: PRODUCT_LIMITS.course, integer: true, optional: true }),
  });
}

/** Issues of a group of choices of modifiers: a category and a number of free choices from 0 to 100. */
export function choiceIssues(row: ChoiceRow): RowIssues<'categoryId' | 'freeQuantity'> {
  return found({
    categoryId: row.categoryId === '' ? 'required' : undefined,
    freeQuantity: numberIssue(row.freeQuantity, { min: 0, max: PRODUCT_LIMITS.percentage }),
  });
}

/** Issues of a supplier: a contact id and the numbers. */
export function supplierIssues(
  row: SupplierRow,
): RowIssues<'contactId' | 'code' | 'name' | 'minQuantity' | 'deliveryTime'> {
  return found({
    contactId: /^[0-9a-f]{24}$/.test(row.contactId.trim()) ? undefined : row.contactId.trim() === '' ? 'required' : 'format',
    code: row.code.trim().length > PRODUCT_LIMITS.supplierCode ? 'maxLength' : undefined,
    name: row.name.trim().length > PRODUCT_LIMITS.supplierName ? 'maxLength' : undefined,
    minQuantity: numberIssue(row.minQuantity, AMOUNT),
    deliveryTime: numberIssue(row.deliveryTime, AMOUNT),
  });
}

/** Issues of a price list of a supplier: the price and the three discounts from 0 to 100. */
export function supplierListIssues(row: SupplierListRow): RowIssues<'price' | 'discount1' | 'discount2' | 'discount3'> {
  const discount = (text: string) => numberIssue(text, { min: 0, max: PRODUCT_LIMITS.percentage, optional: true });
  return found({
    price: numberIssue(row.price, AMOUNT),
    discount1: discount(row.discount1),
    discount2: discount(row.discount2),
    discount3: discount(row.discount3),
  });
}

/** Issues of a store of the availability: the position. */
export function placeIssues(row: ProductPlaceRow): RowIssues<'position'> {
  return found({ position: numberIssue(row.position, { min: 0, max: PRODUCT_LIMITS.position, integer: true, optional: true }) });
}

/** Issues of the limits of a storage. */
export function stockIssues(row: StockRow): RowIssues<'min' | 'max' | 'location'> {
  return found({
    min: numberIssue(row.min, AMOUNT),
    max: numberIssue(row.max, AMOUNT),
    location: row.location.trim().length > PRODUCT_LIMITS.location ? 'maxLength' : undefined,
  });
}

/** Whether any row of a list has an issue. */
export function anyIssue<T>(rows: readonly T[], issues: (row: T) => object): boolean {
  return rows.some((row) => Object.keys(issues(row)).length > 0);
}

// ---- Bodies ----

/** The body of a barcode. */
function barcodeBody(row: BarcodeRow): Record<string, unknown> {
  return {
    value: row.value.trim(),
    loadQuantity: numberOrNull(row.loadQuantity),
    saleQuantity: numberOrNull(row.saleQuantity),
  };
}

/** The body of a supplier. */
function supplierBody(row: SupplierRow): Record<string, unknown> {
  return {
    contactId: row.contactId.trim(),
    code: textOrNull(row.code),
    name: textOrNull(row.name),
    minQuantity: numberOrNull(row.minQuantity),
    deliveryTime: numberOrNull(row.deliveryTime),
    deliveryTimeUnit: row.deliveryTimeUnit === '' ? null : row.deliveryTimeUnit,
    favorite: row.favorite,
    priceLists: row.priceLists.map((list) => ({
      id: list.id,
      price: numberOrNull(list.price),
      discount1: numberOrNull(list.discount1),
      discount2: numberOrNull(list.discount2),
      discount3: numberOrNull(list.discount3),
    })),
  };
}

/** The body of a store of the availability. */
function placeBody(row: ProductPlaceRow, rooms: boolean): Record<string, unknown> {
  return {
    placeId: row.placeId,
    favorite: row.favorite,
    ...(rooms ? { favoriteHandheld: row.favoriteHandheld } : {}),
    position: numberOrNull(row.position),
    productionCenterId: row.productionCenterId === '' ? null : row.productionCenterId,
  };
}

/** The fields of the form that are sent whole when they change, with their value in the body (the texts, the media and the fields of the stores are not among them). */
function payload(model: ProductModel, ctx: BodyContext): Record<string, unknown> {
  const c = model.core;
  const f = ctx.features;
  const body: Record<string, unknown> = {
    type: c.type,
    enabled: c.enabled,
    code: c.code.trim(),
    favorite: c.favorite,
    generic: c.generic,
    toCheck: c.toCheck,
    noDiscount: c.noDiscount,
    integrations: { ...c.integrations },
    brandId: c.brandId === '' ? null : c.brandId,
    position: numberOrNull(c.position),
    productionValue: numberOrNull(c.productionValue),
    validFrom: fromLocalInput(c.validFrom),
    validTo: fromLocalInput(c.validTo),
    categoryIds: c.categoryIds,
    attributeIds: c.attributeIds,
    barcodes: c.barcodes.map(barcodeBody),
    prices: c.prices.map(priceBody),
    simpleCost: numberOrNull(c.simpleCost),
    suppliers: c.suppliers.map(supplierBody),
    shipping: {
      width: numberOrNull(c.shipping.width),
      height: numberOrNull(c.shipping.height),
      depth: numberOrNull(c.shipping.depth),
      weight: numberOrNull(c.shipping.weight),
    },
    components: c.components.map((component) => ({
      productId: component.productId,
      quantity: Number(component.quantity),
      waste: numberOrNull(component.waste),
    })),
  };
  const availability = {
    ...(f.cash ? { pos: c.availability.pos } : {}),
    ...(f.warehouse ? { warehouse: c.availability.warehouse } : {}),
    ...(f.scales ? { scales: c.availability.scales } : {}),
    ...(f.customersApp ? { ecommerce: c.availability.ecommerce } : {}),
  };
  if (Object.keys(availability).length > 0) {
    body['availability'] = availability;
  }
  if (f.rooms) {
    body['favoriteHandheld'] = c.favoriteHandheld;
    body['dining'] = {
      halfPortion: c.dining.halfPortion,
      feePercentage: numberOrNull(c.dining.feePercentage),
      hiddenOnHandheld: c.dining.hiddenOnHandheld,
      affiliatedMenu: c.dining.affiliatedMenu,
      reversePrint: c.dining.reversePrint,
    };
  }
  if (f.customersApp) {
    body['featured'] = c.featured;
  }
  if (f.cash) {
    body['colors'] = { text: c.colors.text, background: c.colors.background };
  }
  if (f.scales) {
    body['plu'] = textOrNull(c.plu);
    body['scaleType'] = c.scaleType;
  }
  if (f.services) {
    body['duration'] = textOrNull(c.duration);
    body['maxConcurrent'] = numberOrNull(c.maxConcurrent);
  }
  if (f.warehouse) {
    body['loadUnit'] = textOrNull(c.loadUnit);
    body['unloadUnit'] = textOrNull(c.unloadUnit);
    if (c.conversionRatio.trim() !== '') {
      body['conversionRatio'] = Number(c.conversionRatio);
    }
  }
  if (f.productsVariants) {
    if (ctx.modifier) {
      body['modifier'] = {
        type: c.modifier.type,
        pricePercentagePlus: numberOrNull(c.modifier.pricePercentagePlus),
        pricePercentageMinus: numberOrNull(c.modifier.pricePercentageMinus),
      };
    } else {
      body['requiredModifierIds'] = c.requiredModifierIds;
      body['modifierIds'] = c.modifierIds;
      body['excludedModifierIds'] = c.excludedModifierIds;
      body['modifierCategoryIds'] = c.modifierCategoryIds;
      body['modifierChoices'] = c.modifierChoices.map((group) => ({
        categoryId: group.categoryId,
        freeQuantity: Number(group.freeQuantity),
        priceRule: group.priceRule,
        productIds: group.productIds,
      }));
    }
  }
  if (!ctx.modifier) {
    body['menu'] = c.menu.map((group) => ({
      categoryId: group.categoryId,
      quantity: Number(group.quantity),
      ...(f.rooms ? { course: numberOrNull(group.course) } : {}),
      productIds: group.productIds,
    }));
    body['modularPriceRule'] = c.modularPriceRule === '' ? null : c.modularPriceRule;
  }
  if (f.media) {
    body['gallery'] = c.gallery.map((logo) => ({ imageId: logo.imageId ?? logo.descriptor?._id }));
    body['internalFileName'] = textOrNull(c.internalFileName);
    body['externalUrl'] = textOrNull(c.externalUrl);
  }
  return body;
}

/** The `{ imageId }` of an image the user picked from the library, `undefined` for one already stored or none. */
function pickedId(logo: LogoModel | null): { imageId: string } | undefined {
  return logo?.imageId ? { imageId: logo.imageId } : undefined;
}

/** The fields of the stores of a creation. */
function localBody(model: ProductModel, ctx: BodyContext): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (model.local.places.length > 0) {
    body['places'] = model.local.places.map((row) => placeBody(row, ctx.features.rooms));
  }
  if (ctx.features.ordering) {
    body['printStations'] = stationsBody(model.local.stations.rooms);
    body['counterPrintStations'] = stationsBody(model.local.stations.counter);
  }
  if (ctx.features.warehouse) {
    const stock = stockBody(model.local.stock.filter((row) => row.min.trim() !== '' || row.max.trim() !== '' || row.location.trim() !== ''));
    if (Object.keys(stock).length > 0) {
      body['stock'] = stock;
    }
  }
  return body;
}

/** The `stock` of a body from some rows. */
function stockBody(rows: readonly StockRow[]): Record<string, Record<string, Record<string, unknown>>> {
  const stock: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const row of rows) {
    (stock[row.placeId] ??= {})[row.storageId] = {
      min: numberOrNull(row.min),
      max: numberOrNull(row.max),
      location: textOrNull(row.location),
    };
  }
  return stock;
}

/**
 * The body of a creation: everything the user filled in, limited to the fields of the features
 * the group has (the server refuses the others with `notAllowed`).
 *
 * @param model The form model.
 * @param ctx What the group has and whether the product is a modifier.
 */
export function createBody(model: ProductModel, ctx: BodyContext): Record<string, unknown> {
  const c = model.core;
  const body: Record<string, unknown> = { ...payload(model, ctx), name: filled(c.name), ...localBody(model, ctx) };
  for (const key of ['shortName', 'description', 'shortDescription'] as const) {
    const texts = filled(c[key]);
    if (Object.keys(texts).length > 0) {
      body[key] = texts;
    }
  }
  if (ctx.modifier) {
    body['isModifier'] = true;
    if (ctx.features.productsVariants) {
      const description = filled(c.modifier.description);
      body['modifier'] = {
        ...(body['modifier'] as object),
        ...(Object.keys(description).length > 0 ? { description } : {}),
      };
    }
  }
  if (ctx.features.media) {
    const image = pickedId(c.image);
    if (image !== undefined) {
      body['image'] = image;
    }
  }
  return body;
}

/** The leaves of an object of settings that differ, with their new value; `undefined` when none does. */
function leafChanges(now: unknown, before: unknown): Record<string, unknown> | undefined {
  const a = now as Record<string, unknown>;
  const b = before as Record<string, unknown>;
  const changes = Object.fromEntries(Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).map((key) => [key, a[key]]));
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** The settings of the product written leaf by leaf (the server merges them). */
const MERGED = ['availability', 'integrations', 'colors', 'dining', 'shipping', 'modifier'] as const;

/** The changes of the fields of the stores: the availability whole, the stations and the limits of the storages that changed. */
function localPatch(now: LocalModel, before: LocalModel, ctx: BodyContext): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const places = (rows: readonly ProductPlaceRow[]) => JSON.stringify(rows.map((row) => placeBody(row, ctx.features.rooms)).sort((a, b) => String(a['placeId']).localeCompare(String(b['placeId']))));
  if (places(now.places) !== places(before.places)) {
    body['places'] = now.places.map((row) => placeBody(row, ctx.features.rooms));
  }
  if (ctx.features.ordering) {
    const rooms = stationsPatch(now.stations.rooms, before.stations.rooms);
    const counter = stationsPatch(now.stations.counter, before.stations.counter);
    if (rooms !== undefined) {
      body['printStations'] = rooms;
    }
    if (counter !== undefined) {
      body['counterPrintStations'] = counter;
    }
  }
  if (ctx.features.warehouse) {
    const key = (row: StockRow) => `${row.placeId}/${row.storageId}`;
    const stored = new Map(before.stock.map((row) => [key(row), JSON.stringify([row.min.trim(), row.max.trim(), row.location.trim()])]));
    const changed = now.stock.filter((row) => (stored.get(key(row)) ?? JSON.stringify(['', '', ''])) !== JSON.stringify([row.min.trim(), row.max.trim(), row.location.trim()]));
    if (changed.length > 0) {
      body['stock'] = stockBody(changed);
    }
  }
  return body;
}

/**
 * The body of a modification: only what differs from the stored product (the texts language by
 * language, the settings leaf by leaf, the lists whole). A caller who manages only their own
 * stores (`scope: 'local'`) sends nothing but the fields of the stores.
 *
 * @param model The form model.
 * @param before The form model of the product as the server has it.
 * @param ctx What the group has and whether the product is a modifier.
 * @param scope `full` for a caller who may change the whole product, `local` for one who may change only their own stores.
 */
export function patchBody(model: ProductModel, before: ProductModel, ctx: BodyContext, scope: 'full' | 'local'): Record<string, unknown> {
  const body = localPatch(model.local, before.local, ctx);
  if (scope === 'local') {
    return body;
  }
  const now = payload(model, ctx);
  const was = payload(before, ctx);
  for (const key of Object.keys(now)) {
    if (!(MERGED as readonly string[]).includes(key) && JSON.stringify(now[key]) !== JSON.stringify(was[key])) {
      body[key] = now[key];
    }
  }
  for (const key of MERGED) {
    const changes = key in now ? leafChanges(now[key], was[key]) : undefined;
    if (changes !== undefined) {
      body[key] = changes;
    }
  }
  const c = model.core;
  const b = before.core;
  for (const key of ['name', 'shortName', 'description', 'shortDescription'] as const) {
    const texts = changedTexts(c[key], b[key]);
    if (texts !== undefined) {
      body[key] = texts;
    }
  }
  if (ctx.modifier && ctx.features.productsVariants) {
    const description = changedTexts(c.modifier.description, b.modifier.description);
    if (description !== undefined) {
      body['modifier'] = { ...(body['modifier'] as object | undefined), description };
    }
  }
  if (ctx.features.media) {
    if (c.image === null && b.image !== null) {
      body['image'] = null;
    } else if (pickedId(c.image) !== undefined) {
      body['image'] = pickedId(c.image);
    }
  }
  return body;
}

/**
 * Whether the form differs from the stored product: the stored model for a product, the model of
 * a new one for the page of a creation.
 */
export function modelChanged(model: ProductModel, original: ProductModel): boolean {
  return JSON.stringify(model) !== JSON.stringify(original);
}

/** The limits of the texts of a product (names are in `catalog-item-texts`). */
export function shortNameIssue(text: string): 'maxLength' | 'pattern' | undefined {
  const value = text.trim();
  return value.length > PRODUCT_LIMITS.shortName ? 'maxLength' : /[\u0000-\u001F\u007F]/.test(value) ? 'pattern' : undefined;
}

/** The issue of a code: not longer than the server accepts and without control characters. */
export function codeIssue(text: string): 'maxLength' | 'pattern' | undefined {
  const value = text.trim();
  return value.length > PRODUCT_LIMITS.code ? 'maxLength' : /[\u0000-\u001F\u007F]/.test(value) ? 'pattern' : undefined;
}

/** The issue of a PLU: up to six digits without leading zeros (`0` is a valid one). */
export function pluIssue(text: string): 'format' | undefined {
  return text.trim() === '' || /^(0|[1-9][0-9]{0,5})$/.test(text.trim()) ? undefined : 'format';
}

/** The issue of a link: `https` only, no user or password, as long as the server accepts. */
export function urlIssue(value: string): 'maxLength' | 'format' | undefined {
  const text = value.trim();
  if (text === '') {
    return undefined;
  }
  if (text.length > PRODUCT_LIMITS.externalUrl) {
    return 'maxLength';
  }
  const url = URL.canParse(text) ? new URL(text) : null;
  return url !== null && url.protocol === 'https:' && url.username === '' && url.password === '' ? undefined : 'format';
}

/** The issue of an internal file name: one line, not longer than the server accepts. */
export function fileNameIssue(value: string): 'maxLength' | 'pattern' | undefined {
  const text = value.trim();
  if (text.length > PRODUCT_LIMITS.internalFileName) {
    return 'maxLength';
  }
  return /[\u0000-\u001F\u007F]/.test(text) ? 'pattern' : undefined;
}
