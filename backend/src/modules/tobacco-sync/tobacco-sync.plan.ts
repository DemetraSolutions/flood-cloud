import { ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, Document } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { isRecord, recordsOf, textOf, valueAt } from '../groups/catalogs/kit.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { placesDocument } from '../product-categories/categories.availability.ts';
import { applyChange, categoryLoggable, newCategoryDocument } from '../product-categories/categories.document.ts';
import { createCategoryBody } from '../product-categories/categories.schemas.ts';
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH } from '../product-catalog/texts.ts';
import { PRODUCT_LIMITS } from '../products/products.schemas.ts';
import { validate } from '../../shared/validation/schema.ts';
import { blankProduct, productLoggable } from '../products/products.document.ts';
import { productPlacesDocument } from '../products/products.availability.ts';
import { priceDocument } from '../products/products.pricing.ts';
import type { SyncParams } from './tobacco-sync.schemas.ts';

/** The currency of the prices of the national price list (the list is in euros). */
export const SYNC_CURRENCY = 'EUR';

/** Longest code and barcode, in characters (the limit of the catalog). */
export const MAX_CODE_LENGTH = 64;

/** Largest price of the price list the catalog accepts. */
export const MAX_PRICE = 1_000_000_000;

/** Largest quantity of a barcode (pieces in the pack), as the price list itself allows. */
export const MAX_BARCODE_QUANTITY = 100_000;

/** What no code, barcode, name or category may hold: control characters. */
const CONTROL = /[\u0000-\u001F\u007F]/;

/** What a description may not hold: control characters other than tab, carriage return and line feed. */
const DESCRIPTION_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** What the synchronization takes from a product of the national price list, checked: the list holds whatever the legacy wrote. */
export interface ListEntry {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** The category (trimmed), `null` when the entry has none. */
  readonly category: string | null;
  /** The price of the pack, the gross price of every price list. */
  readonly price: number;
  readonly barcodes: ReadonlyArray<{ readonly value: string; readonly qtSale: number | null }>;
}

/** A text of the list that is a name of the catalog: trimmed, 1 to {@link MAX_NAME_LENGTH} characters, no control character; `null` otherwise. */
function nameOf(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text === '' || text.length > MAX_NAME_LENGTH || CONTROL.test(text) ? null : text;
}

/**
 * The entry of a stored product of the price list, or `null` when it is outside the limits of the catalog and is skipped: a code that is not 1 to {@link MAX_CODE_LENGTH} characters without control characters,
 * a name that is not one ({@link MAX_NAME_LENGTH}), a category that is not empty and is not a name, a price that is not a finite number from 0 to {@link MAX_PRICE}, a barcode that is not 1 to
 * {@link MAX_CODE_LENGTH} characters without control characters, more than {@link PRODUCT_LIMITS} barcodes (the same value twice counts once), a quantity above {@link MAX_BARCODE_QUANTITY}. Everything is
 * external data. A description that is not valid is empty; a barcode that is empty or not a text is left out, as in the legacy; the quantity of a barcode is an integer above zero or `null`.
 *
 * @param raw The stored document.
 */
export function entryOf(raw: Document): ListEntry | null {
  const code: unknown = raw['code'];
  const name = nameOf(raw['name']);
  const price: unknown = raw['price'];
  const rawCategory: unknown = raw['category'];
  const noCategory = rawCategory === undefined || rawCategory === null || (typeof rawCategory === 'string' && rawCategory.trim() === '');
  const category = noCategory ? null : nameOf(rawCategory);
  if (typeof code !== 'string' || code === '' || code.length > MAX_CODE_LENGTH || CONTROL.test(code) || name === null || (!noCategory && category === null)) {
    return null;
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
    return null;
  }
  const barcodes = new Map<string, number | null>();
  for (const item of recordsOf(raw['barcodes'])) {
    const value = textOf(item['barcode'])?.trim();
    if (value === undefined || value === '') {
      continue;
    }
    const quantity = item['quantity'];
    const sale = typeof quantity === 'number' && Number.isFinite(quantity) && Math.trunc(quantity) > 0 ? Math.trunc(quantity) : null;
    if (value.length > MAX_CODE_LENGTH || CONTROL.test(value) || (sale !== null && sale > MAX_BARCODE_QUANTITY)) {
      return null;
    }
    if (!barcodes.has(value)) {
      barcodes.set(value, sale);
    }
  }
  if (barcodes.size > PRODUCT_LIMITS.barcodes) {
    return null;
  }
  const description = typeof raw['description'] === 'string' && raw['description'].length <= MAX_DESCRIPTION_LENGTH && !DESCRIPTION_CONTROL.test(raw['description']) ? raw['description'] : '';
  return { code, name, description, category, price, barcodes: [...barcodes].map(([value, qtSale]) => ({ value, qtSale })) };
}

/** How many entries of the log one synchronization writes in detail: the rest is counted in the summary. */
export const MAX_LOGGED_ENTRIES = 500;

/** One entry of the activity log the synchronization asks for, written after the commit. */
export interface LogDraft {
  readonly resource: 'product' | 'productCategory';
  readonly id: ObjectId;
  readonly action: 'product.created' | 'product.updated' | 'productCategory.created';
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown>;
}

/** The counts of a synchronization. */
export interface SyncCounts {
  readonly products: { inserted: number; updated: number; disabled: number; reactivated: number; unchanged: number; skipped: number };
  readonly categories: { inserted: number; duplicateNames: number };
  readonly duplicateCodes: number;
  /** The tobaccos of the group that are enabled before the synchronization and whether disabling the ones that left the list exceeds {@link MASS_DISABLE_PERCENT} of them. */
  readonly massDisable: { readonly active: number; readonly exceeded: boolean };
}

/** The share of the enabled tobaccos of a group the synchronization may disable without an explicit confirmation, in percent. */
export const MASS_DISABLE_PERCENT = 20;

/** What {@link planSync} needs. */
export interface PlanInput {
  readonly principal: CatalogCaller;
  /** The documents of the national price list, in the order of their ids. */
  readonly list: readonly Document[];
  /** The products of the group of the types tobaccos, games and monopoly, in the order of their ids, with the fields below read. */
  readonly products: readonly Document[];
  /** The categories of the group (`_id`, `name`), in the order of their ids. */
  readonly categories: readonly Document[];
  /** The ids of the price lists of the group, all of them. */
  readonly priceListIds: readonly string[];
  /** The tax rate of 0 % the prices carry. */
  readonly tax: Tax;
  readonly params: SyncParams;
  readonly now: Date;
  readonly newId: () => ObjectId;
  readonly newElementId: () => string;
}

/** The writes and the counts of a synchronization. */
export interface SyncPlan {
  readonly categoryOps: AnyBulkWriteOperation<Document>[];
  readonly productOps: AnyBulkWriteOperation<Document>[];
  readonly counts: SyncCounts;
  readonly drafts: LogDraft[];
  /** The entries of the log that were not drafted (above {@link MAX_LOGGED_ENTRIES}). */
  readonly omitted: number;
}

/** The fields of a stored product the plan reads. */
export const PLAN_PRODUCT_FIELDS = Object.freeze(['type', 'code', 'trash', 'status', 'noDiscount', 'availability', 'name', 'shortName', 'description', 'shortDescription', 'categories', 'prices', 'barcode', 'placesAvailability'] as const);

/** A value reduced to what can be compared: ids as text, numbers as numbers. */
function plain(value: unknown): unknown {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map(plain);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}

const keyOf = (name: string): string => name.trim().toLowerCase();

/**
 * Works out the whole synchronization without writing anything: the categories to create, and for every entry of the list the insertion, the update or nothing of the product, then the products that left the list.
 * The rules are the ones of the legacy synchronization (the entry is matched by the exact code, an update rewrites the name, the description, the categories, the prices and the barcodes and clears the short
 * texts), with these decisions: the product with the lowest id wins among equal codes; every product that is written gets the availability of the request, whole; a product that is disabled and is in the list is enabled
 * again, and a product that is no longer in the list is disabled; a product that would not change is not written.
 *
 * @param input The list, the group, the request.
 */
export function planSync(input: PlanInput): SyncPlan {
  const { principal, params, now, tax } = input;
  const counts: { -readonly [K in keyof SyncCounts]: SyncCounts[K] } = { products: { inserted: 0, updated: 0, disabled: 0, reactivated: 0, unchanged: 0, skipped: 0 }, categories: { inserted: 0, duplicateNames: 0 }, duplicateCodes: 0, massDisable: { active: 0, exceeded: false } };
  const categoryOps: AnyBulkWriteOperation<Document>[] = [];
  const productOps: AnyBulkWriteOperation<Document>[] = [];
  const drafts: LogDraft[] = [];
  let changes = 0;
  const log = (draft: () => LogDraft): void => {
    changes += 1;
    if (drafts.length < MAX_LOGGED_ENTRIES) {
      drafts.push(draft());
    }
  };

  const places = params.placeIds.map((id) => id.toHexString());
  const productPlaces = (): Document[] => productPlacesDocument(principal, undefined, places.map((placeId) => ({ placeId, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null })));
  const categoryPlaces = (): Document[] => placesDocument(undefined, places.map((placeId) => ({ placeId, position: null, productionCenterId: null })));

  // The categories of the group by name, the first one by id.
  const byName = new Map<string, { id: ObjectId; extra: number }>();
  for (const category of input.categories) {
    const name = textOf(valueAt(category, 'name.it'));
    if (name === null) {
      continue;
    }
    const key = keyOf(name);
    const known = byName.get(key);
    if (known === undefined) {
      byName.set(key, { id: category['_id'] as ObjectId, extra: 0 });
    } else {
      known.extra += 1;
    }
  }
  // The products of the group by code: every one that is not in the trash is a target of the update (so no product keeps an old price); when all of them are in the trash, the first one by id (the legacy).
  const byCode = new Map<string, { live: Document[]; trashed: Document | undefined; total: number }>();
  for (const product of input.products) {
    const code = textOf(product['code']);
    if (code === null || code === '') {
      continue;
    }
    const group = byCode.get(code) ?? { live: [], trashed: undefined, total: 0 };
    byCode.set(code, group);
    group.total += 1;
    if (product['trash'] === true) {
      group.trashed ??= product;
    } else {
      group.live.push(product);
    }
  }

  const entries = new Map<string, ListEntry>();
  const listed = new Set<string>();
  const usedNames = new Set<string>();
  for (const raw of input.list) {
    const code = textOf(raw['code']);
    if (code !== null && code !== '') {
      listed.add(code);
    }
    const entry = entryOf(raw);
    if (entry === null) {
      counts.products.skipped += 1;
    } else if (!entries.has(entry.code)) {
      entries.set(entry.code, entry);
    }
  }

  // Categories first, so the products can name them.
  for (const entry of entries.values()) {
    if (entry.category === null) {
      continue;
    }
    const key = keyOf(entry.category);
    usedNames.add(key);
    if (!byName.has(key)) {
      const id = input.newId();
      const body = validate(createCategoryBody, { name: { it: entry.category }, secondaryFiscalPrinter: true, tobacco: true, noDiscount: params.noDiscount, availability: { pos: true } }, '(category)');
      const document = newCategoryDocument({ id, body, language: 'it', parentId: null, places: categoryPlaces(), images: {}, now });
      byName.set(key, { id, extra: 0 });
      categoryOps.push({ insertOne: { document } });
      counts.categories.inserted += 1;
      log(() => ({ resource: 'productCategory', id, action: 'productCategory.created', before: undefined, after: categoryLoggable(principal, document) }));
    }
  }
  counts.categories.duplicateNames = [...usedNames].reduce((sum, key) => sum + byName.get(key)!.extra, 0);
  counts.duplicateCodes = [...entries.keys()].reduce((sum, code) => sum + Math.max(0, (byCode.get(code)?.total ?? 0) - 1), 0);

  const desiredPlaces = productPlaces();
  for (const entry of entries.values()) {
    const categoryId = entry.category === null ? null : byName.get(keyOf(entry.category))!.id;
    const group = byCode.get(entry.code);
    const targets = group === undefined ? [] : group.live.length > 0 ? group.live : [group.trashed!];
    const pricesFor = (reuse: unknown): Document[] => {
      const old = new Map<string, string>();
      for (const rule of recordsOf(reuse)) {
        const listId = textOf(rule['listId']);
        const id = textOf(rule['id']);
        if (listId !== null && id !== null) {
          old.set(listId, id);
        }
      }
      return input.priceListIds.map((priceListId) => priceDocument({ priceListId, currency: SYNC_CURRENCY, taxId: tax.id, gross: entry.price }, tax, old.get(priceListId) ?? input.newElementId(), undefined));
    };
    const barcodes = entry.barcodes.map(({ value, qtSale }) => ({ value, qtLoad: null, qtSale }));

    if (targets.length === 0) {
      const id = input.newId();
      const document: Document = {
        ...blankProduct({ id, type: 'tobaccos', isModifier: false, now }),
        code: entry.code,
        barcode: barcodes,
        name: { it: entry.name },
        shortName: { it: '' },
        description: { it: entry.description },
        shortDescription: { it: '' },
        noDiscount: params.noDiscount,
        availability: { pos: true, warehouse: params.warehouse, scales: false, ecommerce: false },
        categories: categoryId === null ? [] : [categoryId],
        placesAvailability: desiredPlaces,
        prices: pricesFor(undefined),
      };
      productOps.push({ insertOne: { document } });
      counts.products.inserted += 1;
      log(() => ({ resource: 'product', id, action: 'product.created', before: undefined, after: productLoggable(principal, document) }));
      continue;
    }

    for (const stored of targets) {
      const set: Document = {};
      const text = (container: 'name' | 'shortName' | 'description' | 'shortDescription', value: string): void => {
        const current: unknown = stored[container];
        if (!isRecord(current)) {
          set[container] = { it: value };
        } else if (current['it'] !== value) {
          set[`${container}.it`] = value;
        }
      };
      if (stored['noDiscount'] !== params.noDiscount) {
        set['noDiscount'] = params.noDiscount;
      }
      if (!isRecord(stored['availability'])) {
        set['availability'] = { pos: true, warehouse: params.warehouse, scales: false, ecommerce: false };
      } else if (stored['availability']['warehouse'] !== params.warehouse) {
        set['availability.warehouse'] = params.warehouse;
      }
      text('name', entry.name);
      text('shortName', '');
      text('description', entry.description);
      text('shortDescription', '');
      const wantedCategories = categoryId === null ? [] : [categoryId.toHexString()];
      if (!isDeepStrictEqual(plain(stored['categories']), wantedCategories)) {
        set['categories'] = categoryId === null ? [] : [categoryId];
      }
      const prices = pricesFor(stored['prices']);
      if (!isDeepStrictEqual(plain(stored['prices']), plain(prices))) {
        set['prices'] = prices;
      }
      if (barcodes.length > 0 && !isDeepStrictEqual(plain(stored['barcode']), barcodes)) {
        set['barcode'] = barcodes;
      }
      if (!isDeepStrictEqual(plain(stored['placesAvailability']), plain(desiredPlaces))) {
        set['placesAvailability'] = desiredPlaces;
      }
      const reactivated = stored['type'] === 'tobaccos' && stored['trash'] !== true && stored['status'] !== true;
      if (reactivated) {
        set['status'] = true;
      }
      if (Object.keys(set).length === 0) {
        counts.products.unchanged += 1;
        continue;
      }
      set['updateDate'] = now;
      const id = stored['_id'] as ObjectId;
      productOps.push({ updateOne: { filter: { _id: id }, update: { $set: set } } });
      counts.products[reactivated ? 'reactivated' : 'updated'] += 1;
      log(() => ({ resource: 'product', id, action: 'product.updated', before: productLoggable(principal, stored), after: productLoggable(principal, applyChange(stored, set, {})) }));
    }
  }

  // The tobaccos that left the list are disabled (games and monopoly are not touched).
  for (const product of input.products) {
    const code = textOf(product['code']);
    if (product['type'] !== 'tobaccos' || product['trash'] === true || code === null || code === '' || listed.has(code) || product['status'] === false) {
      continue;
    }
    const id = product['_id'] as ObjectId;
    const set: Document = { status: false, updateDate: now };
    productOps.push({ updateOne: { filter: { _id: id }, update: { $set: set } } });
    counts.products.disabled += 1;
    log(() => ({ resource: 'product', id, action: 'product.updated', before: productLoggable(principal, product), after: productLoggable(principal, applyChange(product, set, {})) }));
  }
  const active = input.products.filter((product) => product['type'] === 'tobaccos' && product['trash'] !== true && product['status'] === true).length;
  counts.massDisable = { active, exceeded: counts.products.disabled * 100 > active * MASS_DISABLE_PERCENT };
  return { categoryOps, productOps, counts, drafts, omitted: changes - drafts.length };
}
