import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { emptyRefProfile, tallyKind, tallyRef } from './classify.ts';
import type { RefProfile } from './classify.ts';
import { numericValue } from './catalog-paths.ts';
import { bsonTypeName, isPlainObject } from './walk.ts';

/** An enum value seen in fewer documents than this is summed under {@link RARE_ENUM_KEY}. */
export const MIN_ENUM_COUNT = 3;

/** Key under which the rare enum values are summed. */
export const RARE_ENUM_KEY = '<rare>';

/** Label of a document in which an inspected field is absent. */
export const MISSING_LABEL = 'missing';

const SHORT_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const SMALL_INTEGER = 99;

/** The ids that exist in the group a document lives in, as lowercase hex or as stored text. */
export interface GroupContext {
  /** `_id` of `products`. */
  readonly products: ReadonlySet<string>;
  /** `_id` of `products_categories`. */
  readonly categories: ReadonlySet<string>;
  /** `_id` of `products_brands`. */
  readonly brands: ReadonlySet<string>;
  /** `_id` of `places`. */
  readonly places: ReadonlySet<string>;
  /** Keys of `groups.priceLists`, or `undefined` when the group has no document in the common database. */
  readonly priceLists: ReadonlySet<string> | undefined;
  /** Current taxes of the group by `id`, or `undefined` when the group has no document in the common database. */
  readonly taxes: ReadonlyMap<string, Document> | undefined;
  /** Ids of the current taxes of the group, or `undefined` when the group has no document in the common database. */
  readonly taxIds: ReadonlySet<string> | undefined;
}

/**
 * The value of a key of a plain object.
 *
 * @param value Anything.
 * @param key Key to read.
 * @returns The value, or `undefined` when `value` is not a plain object or lacks the key.
 */
export function field(value: unknown, key: string): unknown {
  return isPlainObject(value) ? value[key] : undefined;
}

/** @returns The elements of an array, or the value itself as the only element (an absent field counts once as missing). */
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** The value found following a path of plain-object keys. */
function valueAt(document: Document, path: readonly string[]): unknown {
  let current: unknown = document;
  for (const key of path) {
    current = field(current, key);
  }
  return current;
}

/** Histogram of upper-bounded bands (`0`, `1`, `2-10`, … `10001+`). */
export class BandTally {
  readonly #uppers: readonly number[];
  readonly #counts: number[];

  /**
   * @param uppers Ascending inclusive upper bounds of the bands; a last open band follows them.
   */
  constructor(uppers: readonly number[]) {
    this.#uppers = uppers;
    this.#counts = new Array<number>(uppers.length + 1).fill(0);
  }

  /** Counts one value in its band. */
  add(value: number): void {
    const index = this.#uppers.findIndex((upper) => value <= upper);
    const slot = index === -1 ? this.#uppers.length : index;
    this.#counts[slot] = (this.#counts[slot] as number) + 1;
  }

  /** @returns The count of every band, in order, empty bands included. */
  result(): Record<string, number> {
    const bands: Record<string, number> = {};
    let lower = 0;
    for (const [slot, upper] of this.#uppers.entries()) {
      bands[lower === upper ? `${upper}` : `${lower}-${upper}`] = this.#counts[slot] as number;
      lower = upper + 1;
    }
    bands[`${lower}+`] = this.#counts[this.#uppers.length] as number;
    return bands;
  }
}

/** Histogram of the BSON types of a field, `missing` for a document that lacks it. */
export class TypeTally {
  readonly #counts = new Map<string, number>();

  /** Counts the type of one value (`undefined` is `missing`). */
  add(value: unknown): void {
    const label = value === undefined ? MISSING_LABEL : bsonTypeName(value);
    this.#counts.set(label, (this.#counts.get(label) ?? 0) + 1);
  }

  /** @returns The counts, sorted by type. */
  result(): Record<string, number> {
    return Object.fromEntries([...this.#counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** A label for an enum value and whether it is a value that must reach the threshold to be listed. */
interface EnumLabel {
  label: string;
  /** `true` for a short word or a small integer: listed only from {@link MIN_ENUM_COUNT} documents. */
  word: boolean;
}

function enumLabel(value: unknown): EnumLabel {
  if (value === undefined) {
    return { label: `<${MISSING_LABEL}>`, word: false };
  }
  if (value === null || typeof value === 'boolean') {
    return { label: String(value), word: false };
  }
  if (typeof value === 'string') {
    return SHORT_WORD.test(value) ? { label: value, word: true } : { label: '<text>', word: false };
  }
  const number = numericValue(value);
  if (number === undefined) {
    return { label: `<${bsonTypeName(value)}>`, word: false };
  }
  if (Number.isInteger(number) && Math.abs(number) <= SMALL_INTEGER) {
    return { label: String(number), word: true };
  }
  return { label: Number.isFinite(number) ? '<number>' : String(number), word: false };
}

/**
 * Value counts of an allowlisted field, one value per document. Words and small integers are listed
 * only from {@link MIN_ENUM_COUNT} documents on (the others are summed under {@link RARE_ENUM_KEY});
 * any other value is only counted by kind (`true`, `null`, `<text>`, `<number>`, `<objectId>`…).
 */
export class EnumTally {
  readonly #fixed = new Map<string, number>();
  readonly #words = new Map<string, number>();

  /** Counts the value of one document (`undefined` when the field is absent). */
  add(value: unknown): void {
    const { label, word } = enumLabel(value);
    const target = word ? this.#words : this.#fixed;
    target.set(label, (target.get(label) ?? 0) + 1);
  }

  /** @returns The counts, sorted by value. */
  result(): Record<string, number> {
    const counts = new Map(this.#fixed);
    let rare = 0;
    for (const [label, count] of this.#words) {
      if (count >= MIN_ENUM_COUNT) {
        counts.set(label, count);
      } else {
        rare += count;
      }
    }
    if (rare > 0) {
      counts.set(RARE_ENUM_KEY, rare);
    }
    return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

/** Duplicates of a value among the documents of the same group; the values are never reported. */
export interface DuplicateReport {
  /** Groups in which at least one value occurs in more than one document. */
  groupsWithDuplicates: number;
  /** Values that occur in more than one document (a value counts once per group). */
  duplicateValues: number;
  /** Documents that carry a duplicated value (a document counts once per duplicated value). */
  documentsInvolved: number;
}

/** Counts duplicates per group with a map of the current group only. */
export class DuplicateTally {
  readonly #counts = new Map<string, number>();
  readonly #report: DuplicateReport = { groupsWithDuplicates: 0, duplicateValues: 0, documentsInvolved: 0 };

  /** Counts one value of one document of the current group. */
  add(value: string): void {
    this.#counts.set(value, (this.#counts.get(value) ?? 0) + 1);
  }

  /** Closes the current group: folds its duplicates into the report and forgets its values. */
  endGroup(): void {
    let found = false;
    for (const count of this.#counts.values()) {
      if (count > 1) {
        found = true;
        this.#report.duplicateValues += 1;
        this.#report.documentsInvolved += count;
      }
    }
    if (found) {
      this.#report.groupsWithDuplicates += 1;
    }
    this.#counts.clear();
  }

  /** @returns The report. */
  result(): DuplicateReport {
    return { ...this.#report };
  }
}

/** A non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Tallies a reference that may be an identifier or a key of a map (such as a price list id).
 *
 * @param profile Profile to feed.
 * @param value The stored reference.
 * @param existing Keys that exist, or `undefined` when they cannot be known (then it is `unverifiable`).
 * @returns The identity of the reference (the text, or the hex of an ObjectId), or `undefined`.
 */
export function tallyKeyRef(profile: RefProfile, value: unknown, existing: ReadonlySet<string> | undefined): string | undefined {
  const ref = tallyKind(profile.kinds, value);
  const identity = typeof value === 'string' ? value : (ref.hex ?? undefined);
  if (identity !== undefined) {
    if (existing === undefined) {
      profile.unverifiable += 1;
    } else if (!existing.has(identity)) {
      profile.orphans += 1;
    }
  }
  return identity;
}

/** Tallies every element of a list of references (an absent field counts once as missing). */
function tallyList(profile: RefProfile, value: unknown, existing: ReadonlySet<string>): void {
  for (const element of items(value)) {
    tallyRef(profile, element, existing);
  }
}

/** Shapes of the elements of `placesAvailability`. */
export interface PlacesShapes {
  objectWithId: number;
  string: number;
  objectId: number;
  other: number;
}

/** Report of one `placesAvailability`. */
export interface PlacesAvailabilityReport {
  /** Elements by shape. */
  shapes: PlacesShapes;
  /** Documents in which the field is absent, not an array or empty (available everywhere). */
  documentsEmptyOrAbsent: number;
  /** Type of the referenced place ids and orphans (ids that are not in `places` of the same group). */
  references: RefProfile;
}

/** Shapes and references of the `placesAvailability` of a collection. */
export class PlacesTally {
  readonly #shapes: PlacesShapes = { objectWithId: 0, string: 0, objectId: 0, other: 0 };
  readonly #references = emptyRefProfile();
  #emptyOrAbsent = 0;

  /** Adds the field of one document. */
  add(value: unknown, places: ReadonlySet<string>): void {
    if (!Array.isArray(value) || value.length === 0) {
      this.#emptyOrAbsent += 1;
      return;
    }
    for (const element of value) {
      const withId = isPlainObject(element) && element['id'] !== undefined;
      if (withId) {
        this.#shapes.objectWithId += 1;
      } else if (typeof element === 'string') {
        this.#shapes.string += 1;
      } else if (element instanceof ObjectId) {
        this.#shapes.objectId += 1;
      } else {
        this.#shapes.other += 1;
      }
      tallyRef(this.#references, withId ? field(element, 'id') : element, places);
    }
  }

  /** @returns The report. */
  result(): PlacesAvailabilityReport {
    return { shapes: { ...this.#shapes }, documentsEmptyOrAbsent: this.#emptyOrAbsent, references: this.#references };
  }
}

/** Fields of a tax copied into a price and compared with the current tax of the group. */
const TAX_FIELDS = ['value', 'department', 'description', 'natura'] as const;

/**
 * Compares two stored values: numbers by value whatever their BSON type, objects and arrays deeply.
 *
 * @param left A stored value.
 * @param right Another stored value.
 * @returns `true` when they hold the same data.
 */
export function sameValue(left: unknown, right: unknown): boolean {
  const a = numericValue(left);
  const b = numericValue(right);
  if (a !== undefined || b !== undefined) {
    return Object.is(a, b) || a === b;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((element, index) => sameValue(element, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
  }
  return left === right;
}

/** Report of `products.prices[]`. */
export interface PricesReport {
  /** Prices per product, in bands. */
  perProduct: Record<string, number>;
  /** Products with more than one price for the same list. */
  documentsWithRepeatedList: number;
  /** Elements of `prices` that are not objects. */
  nonObjectElements: number;
  /** BSON type of `startDate` of the prices (`missing` included). */
  startDate: Record<string, number>;
  /** BSON type of `endDate` of the prices (`missing` included). */
  endDate: Record<string, number>;
  /** Prices whose `taxed` has more than 2 decimals, and the products that have one. */
  taxedOver2Decimals: { prices: number; documents: number };
  /** `taxData` absent or not an object, and `taxData` that differs from the current tax of the group with the same id. */
  taxData: { absent: number; differsFromCurrent: number };
  /** Type and orphans of `listId` against the keys of `groups.priceLists`. */
  listId: RefProfile;
  /** Type and orphans of `taxData.id` against the ids of `groups.taxes`. */
  taxDataId: RefProfile;
}

const PRICES_PER_PRODUCT_BANDS = [0, 1, 2, 5, 10, 50] as const;

/** Shapes and consistency of the prices of the products. */
export class PricesTally {
  readonly #perProduct = new BandTally(PRICES_PER_PRODUCT_BANDS);
  readonly #startDate = new TypeTally();
  readonly #endDate = new TypeTally();
  readonly #listId = emptyRefProfile();
  readonly #taxDataId = emptyRefProfile();
  #repeatedList = 0;
  #nonObject = 0;
  #taxedPrices = 0;
  #taxedDocuments = 0;
  #taxDataAbsent = 0;
  #taxDataDiffers = 0;

  /** Adds the `prices` of one product. */
  add(value: unknown, context: GroupContext): void {
    const prices = Array.isArray(value) ? value : [];
    this.#perProduct.add(prices.length);
    const lists = new Set<string>();
    let repeated = false;
    let taxed = 0;
    for (const price of prices) {
      if (!isPlainObject(price)) {
        this.#nonObject += 1;
        continue;
      }
      const list = tallyKeyRef(this.#listId, price['listId'], context.priceLists);
      if (list !== undefined) {
        repeated = repeated || lists.has(list);
        lists.add(list);
      }
      this.#startDate.add(price['startDate']);
      this.#endDate.add(price['endDate']);
      const amount = numericValue(price['taxed']);
      if (amount !== undefined && Number.isFinite(amount) && Math.round(amount * 100) / 100 !== amount) {
        taxed += 1;
      }
      const taxData = price['taxData'];
      if (!isPlainObject(taxData)) {
        this.#taxDataAbsent += 1;
      }
      const taxId = tallyKeyRef(this.#taxDataId, field(taxData, 'id'), context.taxIds);
      const current = taxId === undefined ? undefined : context.taxes?.get(taxId);
      if (current !== undefined && !TAX_FIELDS.every((name) => sameValue(field(taxData, name), current[name]))) {
        this.#taxDataDiffers += 1;
      }
    }
    this.#repeatedList += repeated ? 1 : 0;
    this.#taxedPrices += taxed;
    this.#taxedDocuments += taxed > 0 ? 1 : 0;
  }

  /** @returns The report. */
  result(): PricesReport {
    return {
      perProduct: this.#perProduct.result(),
      documentsWithRepeatedList: this.#repeatedList,
      nonObjectElements: this.#nonObject,
      startDate: this.#startDate.result(),
      endDate: this.#endDate.result(),
      taxedOver2Decimals: { prices: this.#taxedPrices, documents: this.#taxedDocuments },
      taxData: { absent: this.#taxDataAbsent, differsFromCurrent: this.#taxDataDiffers },
      listId: this.#listId,
      taxDataId: this.#taxDataId,
    };
  }
}

/** Value paths whose values are counted in `products`. */
export const PRODUCT_ENUMS = [
  'type',
  'variant.type',
  'variant.status',
  'status',
  'trash',
  'scaleType',
  'modularBundle.priceRule',
] as const;

/** Everything the checks learned about `products`. */
export interface ProductsChecks {
  enums: Record<string, Record<string, number>>;
  types: { plu: Record<string, number>; code: Record<string, number> };
  /** Documents with `time`, `code` or `plu` stored as `null` (a write defect), and with all three. */
  nullDefects: { time: number; code: number; plu: number; allThree: number };
  duplicates: { code: DuplicateReport; plu: DuplicateReport; barcode: DuplicateReport };
  references: Record<string, RefProfile>;
  placesAvailability: PlacesAvailabilityReport;
  prices: PricesReport;
}

/** Checks of the documents of `products`, one group at a time. */
export class ProductsAnalyzer {
  readonly #enums = new Map<string, EnumTally>(PRODUCT_ENUMS.map((path) => [path, new EnumTally()]));
  readonly #plu = new TypeTally();
  readonly #code = new TypeTally();
  readonly #nulls = { time: 0, code: 0, plu: 0, allThree: 0 };
  readonly #codes = new DuplicateTally();
  readonly #plus = new DuplicateTally();
  readonly #barcodes = new DuplicateTally();
  readonly #places = new PlacesTally();
  readonly #prices = new PricesTally();
  readonly #refs = {
    categories: emptyRefProfile(),
    variantsRequired: emptyRefProfile(),
    variants: emptyRefProfile(),
    variantsExcluded: emptyRefProfile(),
    variantsCategories: emptyRefProfile(),
    bundleProducts: emptyRefProfile(),
    selectableBundleProducts: emptyRefProfile(),
    selectableBundleCategories: emptyRefProfile(),
    selectableVariants: emptyRefProfile(),
    selectableVariantsCategories: emptyRefProfile(),
    brandId: emptyRefProfile(),
  };

  /** Adds one product of the current group. */
  add(product: Document, context: GroupContext): void {
    for (const path of PRODUCT_ENUMS) {
      (this.#enums.get(path) as EnumTally).add(valueAt(product, path.split('.')));
    }
    this.#plu.add(product['plu']);
    this.#code.add(product['code']);
    const nulls = [product['time'] === null, product['code'] === null, product['plu'] === null];
    this.#nulls.time += nulls[0] ? 1 : 0;
    this.#nulls.code += nulls[1] ? 1 : 0;
    this.#nulls.plu += nulls[2] ? 1 : 0;
    this.#nulls.allThree += nulls.every(Boolean) ? 1 : 0;

    if (product['trash'] !== true) {
      const code = text(product['code']);
      const plu = text(product['plu']);
      const barcodes = new Set<string>();
      for (const barcode of Array.isArray(product['barcode']) ? product['barcode'] : []) {
        const value = text(field(barcode, 'value'));
        if (value !== undefined) {
          barcodes.add(value);
        }
      }
      if (code !== undefined) {
        this.#codes.add(code);
      }
      if (plu !== undefined) {
        this.#plus.add(plu);
      }
      for (const value of barcodes) {
        this.#barcodes.add(value);
      }
    }

    const refs = this.#refs;
    tallyList(refs.categories, product['categories'], context.categories);
    tallyList(refs.variantsRequired, product['variantsRequired'], context.products);
    tallyList(refs.variants, product['variants'], context.products);
    tallyList(refs.variantsExcluded, product['variantsExcluded'], context.products);
    tallyList(refs.variantsCategories, product['variantsCategories'], context.categories);
    for (const component of items(product['bundleProducts'])) {
      tallyRef(refs.bundleProducts, field(component, '_id'), context.products);
    }
    for (const group of items(product['selectableBundleProducts'])) {
      tallyRef(refs.selectableBundleCategories, field(group, 'categoryId'), context.categories);
      for (const choice of items(field(group, 'products'))) {
        tallyRef(refs.selectableBundleProducts, field(choice, '_id'), context.products);
      }
    }
    for (const group of items(product['selectableVariantsBundleProducts'])) {
      tallyRef(refs.selectableVariantsCategories, field(group, 'categoryId'), context.categories);
      for (const choice of items(field(group, 'products'))) {
        tallyRef(refs.selectableVariants, field(choice, '_id'), context.products);
      }
    }
    tallyRef(refs.brandId, product['brandId'], context.brands);
    this.#places.add(product['placesAvailability'], context.places);
    this.#prices.add(product['prices'], context);
  }

  /** Closes the current group. */
  endGroup(): void {
    this.#codes.endGroup();
    this.#plus.endGroup();
    this.#barcodes.endGroup();
  }

  /** @returns The checks. */
  result(): ProductsChecks {
    const refs = this.#refs;
    return {
      enums: Object.fromEntries([...this.#enums].map(([path, tally]) => [`products.${path}`, tally.result()])),
      types: { plu: this.#plu.result(), code: this.#code.result() },
      nullDefects: { ...this.#nulls },
      duplicates: { code: this.#codes.result(), plu: this.#plus.result(), barcode: this.#barcodes.result() },
      references: {
        'products.categories[] -> products_categories': refs.categories,
        'products.variantsRequired[] -> products': refs.variantsRequired,
        'products.variants[] -> products': refs.variants,
        'products.variantsExcluded[] -> products': refs.variantsExcluded,
        'products.variantsCategories[] -> products_categories': refs.variantsCategories,
        'products.bundleProducts[]._id -> products': refs.bundleProducts,
        'products.selectableBundleProducts[].categoryId -> products_categories': refs.selectableBundleCategories,
        'products.selectableBundleProducts[].products[]._id -> products': refs.selectableBundleProducts,
        'products.selectableVariantsBundleProducts[].categoryId -> products_categories': refs.selectableVariantsCategories,
        'products.selectableVariantsBundleProducts[].products[]._id -> products': refs.selectableVariants,
        'products.brandId -> products_brands': refs.brandId,
      },
      placesAvailability: this.#places.result(),
      prices: this.#prices.result(),
    };
  }
}

/** Everything the checks learned about `products_categories`. */
export interface CategoriesChecks {
  /** Categories with the same `name.it` under the same parent. */
  duplicateNames: DuplicateReport;
  /** Type and orphans of `parentId` against `products_categories._id`. */
  parentId: RefProfile;
  /** Groups in which a category is its own ancestor (self-parent included). */
  groupsWithCycle: number;
  placesAvailability: PlacesAvailabilityReport;
}

/** Tells whether following `parent` links from some category leads back to a category already on the path. */
function hasCycle(parents: ReadonlyMap<string, string>): boolean {
  const state = new Map<string, 'open' | 'done'>();
  for (const start of parents.keys()) {
    if (state.has(start)) {
      continue;
    }
    const walked: string[] = [];
    let node: string | undefined = start;
    while (node !== undefined && !state.has(node)) {
      state.set(node, 'open');
      walked.push(node);
      node = parents.get(node);
    }
    const cycle = node !== undefined && state.get(node) === 'open';
    for (const visited of walked) {
      state.set(visited, 'done');
    }
    if (cycle) {
      return true;
    }
  }
  return false;
}

/** Checks of the documents of `products_categories`, one group at a time. */
export class CategoriesAnalyzer {
  readonly #names = new DuplicateTally();
  readonly #parentId = emptyRefProfile();
  readonly #places = new PlacesTally();
  readonly #parents = new Map<string, string>();
  #groupsWithCycle = 0;

  /** Adds one category of the current group. */
  add(category: Document, context: GroupContext): void {
    const ref = tallyRef(this.#parentId, category['parentId'], context.categories);
    if (ref.hex !== null) {
      this.#parents.set(String(category['_id']), ref.hex);
    }
    const name = text(field(category['name'], 'it'));
    if (name !== undefined) {
      this.#names.add(`${ref.hex ?? ref.kind}\u0000${name}`);
    }
    this.#places.add(category['placesAvailability'], context.places);
  }

  /** Closes the current group. */
  endGroup(): void {
    this.#names.endGroup();
    this.#groupsWithCycle += hasCycle(this.#parents) ? 1 : 0;
    this.#parents.clear();
  }

  /** @returns The checks. */
  result(): CategoriesChecks {
    return {
      duplicateNames: this.#names.result(),
      parentId: this.#parentId,
      groupsWithCycle: this.#groupsWithCycle,
      placesAvailability: this.#places.result(),
    };
  }
}

/** Everything the checks learned about `products_departments`. */
export interface DepartmentsChecks {
  /** Type of `code` and of `tax` (`missing` included). */
  types: { code: Record<string, number>; tax: Record<string, number> };
  /** Departments, not in the trash, with the same code (strings and numbers compare by their text). */
  duplicateCodes: DuplicateReport;
  placesAvailability: PlacesAvailabilityReport;
}

/** Checks of the documents of `products_departments`, one group at a time. */
export class DepartmentsAnalyzer {
  readonly #code = new TypeTally();
  readonly #tax = new TypeTally();
  readonly #codes = new DuplicateTally();
  readonly #places = new PlacesTally();

  /** Adds one department of the current group. */
  add(department: Document, context: GroupContext): void {
    this.#code.add(department['code']);
    this.#tax.add(department['tax']);
    const number = numericValue(department['code']);
    const code = number === undefined ? text(department['code']) : Number.isFinite(number) ? String(number) : undefined;
    if (code !== undefined && department['trash'] !== true) {
      this.#codes.add(code);
    }
    this.#places.add(department['placesAvailability'], context.places);
  }

  /** Closes the current group. */
  endGroup(): void {
    this.#codes.endGroup();
  }

  /** @returns The checks. */
  result(): DepartmentsChecks {
    return { types: { code: this.#code.result(), tax: this.#tax.result() }, duplicateCodes: this.#codes.result(), placesAvailability: this.#places.result() };
  }
}

/** Checks of the documents of `products_brands`. */
export class BrandsAnalyzer {
  readonly #places = new PlacesTally();

  /** Adds one brand. */
  add(brand: Document, context: GroupContext): void {
    this.#places.add(brand['placesAvailability'], context.places);
  }

  /** @returns The `placesAvailability` report. */
  result(): { placesAvailability: PlacesAvailabilityReport } {
    return { placesAvailability: this.#places.result() };
  }
}
